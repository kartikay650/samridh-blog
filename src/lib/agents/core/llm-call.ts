// Single LLM-call entry point for the agent system.
//
// EVERY Claude call in lib/agents/* goes through llmCall(). No direct Anthropic
// SDK calls elsewhere. This wrapper handles:
//   - Per-workspace monthly budget enforcement (75% alert, 110% hard halt)
//   - Per-call cost logging to llm_calls table
//   - Anthropic prompt caching when cache_control='static'
//   - Structured output validation via Zod schema (auto-retry on parse failure)
//   - Workspace.llm_spent_this_month_usd atomic updates
//
// SERVER ONLY — never import in client components.

import Anthropic from '@anthropic-ai/sdk'
import { adminClient } from '@/lib/supabase/admin'
import {
  LlmBudgetExceededError,
  LlmCallOptions,
  LlmCallResult,
  LlmModel,
} from './types'

// Per-call timeout 25s. Anthropic SDK default is 10 minutes — way too long for
// our use case. If a single call hasn't returned in 25s, abort so the agent
// runner can retry or fail fast. The Sonnet drain budget is 45s for a batch of
// 5, so 25s per call is a generous ceiling.
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY!,
  timeout: 25_000,
  maxRetries: 0,    // we handle retries ourselves at the agent level
})

// Model IDs locked at the project level. Update here when migrating models.
const MODEL_IDS: Record<LlmModel, string> = {
  haiku: 'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-4-6',
}

// Anthropic pricing (USD per 1M tokens) as of 2026-06.
// Update when Anthropic publishes new pricing.
const PRICING: Record<LlmModel, { input: number; cached_input: number; output: number }> = {
  haiku: { input: 1.0, cached_input: 0.1, output: 5.0 },
  sonnet: { input: 3.0, cached_input: 0.3, output: 15.0 },
}

const STRUCTURED_RETRY_LIMIT = 2

export async function llmCall(opts: LlmCallOptions): Promise<LlmCallResult> {
  await assertBudget(opts.workspace_id)

  const modelId = MODEL_IDS[opts.model]
  const startedAt = Date.now()

  // Build messages array. cache_control='static' marks the system prompt as cacheable
  // (Anthropic prompt cache, 5-min TTL). We always cache the system prompt when requested
  // — the user message varies per call so it's not worth caching.
  const systemBlocks = opts.cache_control === 'static'
    ? [{ type: 'text' as const, text: opts.system_prompt, cache_control: { type: 'ephemeral' as const } }]
    : [{ type: 'text' as const, text: opts.system_prompt }]

  let attempt = 0
  let lastParseError: string | null = null

  while (attempt <= STRUCTURED_RETRY_LIMIT) {
    const userMessage = attempt === 0
      ? opts.user_message
      : `${opts.user_message}\n\n[Previous attempt failed validation: ${lastParseError}. Please return output matching the requested schema exactly.]`

    // Extended thinking: when on, Anthropic requires temperature=1 (unset) and
    // max_tokens must exceed the thinking budget. Give output real room on top.
    const thinkingOn = !!opts.thinking_budget_tokens && opts.thinking_budget_tokens > 0
    const maxTokens = thinkingOn
      ? Math.max(opts.max_tokens ?? 4000, opts.thinking_budget_tokens! + 1024)
      : (opts.max_tokens ?? 4000)

    let response: Anthropic.Message
    try {
      response = await anthropic.messages.create(
        {
          model: modelId,
          max_tokens: maxTokens,
          temperature: thinkingOn ? undefined : opts.temperature,
          ...(thinkingOn
            ? { thinking: { type: 'enabled' as const, budget_tokens: opts.thinking_budget_tokens! } }
            : {}),
          system: systemBlocks,
          messages: [{ role: 'user', content: userMessage }],
        },
        // Per-call timeout override — the client default (25s) is too short for
        // large extraction calls. Falls back to the client default when unset.
        opts.timeout_ms ? { timeout: opts.timeout_ms } : undefined,
      )
    } catch (err) {
      const latencyMs = Date.now() - startedAt
      await logCall(opts, modelId, 0, 0, 0, latencyMs, 0, false, errorMessage(err))
      throw err
    }

    const text = extractText(response)
    const inputTokens = response.usage?.input_tokens ?? 0
    const cachedInputTokens = response.usage?.cache_read_input_tokens ?? 0
    const outputTokens = response.usage?.output_tokens ?? 0
    const costUsd = computeCost(opts.model, inputTokens, cachedInputTokens, outputTokens)
    const latencyMs = Date.now() - startedAt

    // If no schema requested, return immediately.
    if (!opts.schema) {
      await logCall(opts, modelId, inputTokens, cachedInputTokens, outputTokens, latencyMs, costUsd, true, null)
      await chargeWorkspace(opts.workspace_id, costUsd)
      return {
        text,
        input_tokens: inputTokens,
        cached_input_tokens: cachedInputTokens,
        output_tokens: outputTokens,
        cost_usd: costUsd,
        latency_ms: latencyMs,
      }
    }

    // Schema requested — validate.
    try {
      const parsed = validateSchema(text, opts.schema)
      await logCall(opts, modelId, inputTokens, cachedInputTokens, outputTokens, latencyMs, costUsd, true, null)
      await chargeWorkspace(opts.workspace_id, costUsd)
      return {
        text,
        parsed,
        input_tokens: inputTokens,
        cached_input_tokens: cachedInputTokens,
        output_tokens: outputTokens,
        cost_usd: costUsd,
        latency_ms: latencyMs,
      }
    } catch (err) {
      lastParseError = errorMessage(err)
      // Log the failed attempt so we don't lose visibility on retry cost.
      await logCall(
        opts,
        modelId,
        inputTokens,
        cachedInputTokens,
        outputTokens,
        latencyMs,
        costUsd,
        false,
        `Schema validation failed: ${lastParseError}`,
      )
      await chargeWorkspace(opts.workspace_id, costUsd)
      attempt++
      if (attempt > STRUCTURED_RETRY_LIMIT) {
        throw new Error(`LLM output failed schema validation after ${STRUCTURED_RETRY_LIMIT + 1} attempts: ${lastParseError}`)
      }
    }
  }

  // Unreachable — loop always returns or throws.
  throw new Error('llmCall reached unreachable state')
}

// ---------------------------------------------------------------------------
// Budget enforcement
// ---------------------------------------------------------------------------

async function assertBudget(workspaceId: string): Promise<void> {
  const { data, error } = await adminClient
    .from('workspaces')
    .select('llm_spent_this_month_usd, monthly_llm_cap_usd, llm_cap_reset_at')
    .eq('id', workspaceId)
    .single()

  if (error || !data) {
    throw new Error(`Workspace ${workspaceId} not found for budget check`)
  }

  const spent = Number(data.llm_spent_this_month_usd)
  const cap = Number(data.monthly_llm_cap_usd)
  const ceiling = cap * 1.10

  // Roll over only if we've passed the reset timestamp AND spend is below the
  // current month's ceiling. (Resetting a maxed-out workspace because the test
  // clock crossed a month boundary would mask budget bugs.)
  const resetDue = new Date(data.llm_cap_reset_at) <= new Date()
  if (resetDue && spent < ceiling) {
    const nextMonth = new Date()
    nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1)
    nextMonth.setUTCDate(1)
    nextMonth.setUTCHours(0, 0, 0, 0)
    await adminClient
      .from('workspaces')
      .update({ llm_spent_this_month_usd: 0, llm_cap_reset_at: nextMonth.toISOString() })
      .eq('id', workspaceId)
    return
  }

  if (spent >= ceiling) {
    console.warn(`[llm-call] Budget HALT for ${workspaceId}: spent=${spent} >= ceiling=${ceiling} (cap=${cap})`)
    throw new LlmBudgetExceededError(workspaceId, spent, cap)
  }
}

async function chargeWorkspace(workspaceId: string, costUsd: number): Promise<void> {
  // Atomic increment via the increment_workspace_llm_spend SQL function
  // (created in 20260605020000_phase1a_stage_c_queue.sql). Postgres ensures
  // concurrent Stage C calls don't lose updates under contention.
  const { error } = await adminClient.rpc('increment_workspace_llm_spend', {
    workspace_id_arg: workspaceId,
    cost_arg: costUsd,
  })
  if (error) {
    console.error(`[llm-call] increment_workspace_llm_spend RPC failed for ${workspaceId}:`, error.message)
  }
}

// ---------------------------------------------------------------------------
// Cost math
// ---------------------------------------------------------------------------

function computeCost(
  model: LlmModel,
  inputTokens: number,
  cachedInputTokens: number,
  outputTokens: number,
): number {
  const pricing = PRICING[model]
  const uncachedInput = inputTokens - cachedInputTokens
  const usd =
    (uncachedInput * pricing.input) / 1_000_000 +
    (cachedInputTokens * pricing.cached_input) / 1_000_000 +
    (outputTokens * pricing.output) / 1_000_000
  return Math.round(usd * 1_000_000) / 1_000_000 // 6 decimal precision
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

async function logCall(
  opts: LlmCallOptions,
  modelId: string,
  inputTokens: number,
  cachedInputTokens: number,
  outputTokens: number,
  latencyMs: number,
  costUsd: number,
  success: boolean,
  errorMsg: string | null,
): Promise<void> {
  await adminClient.from('llm_calls').insert({
    workspace_id: opts.workspace_id,
    agent_run_id: opts.agent_run_id ?? null,
    model: modelId,
    purpose: opts.purpose,
    input_tokens: inputTokens,
    cached_input_tokens: cachedInputTokens,
    output_tokens: outputTokens,
    cost_usd: costUsd,
    latency_ms: latencyMs,
    success,
    error_message: errorMsg,
  })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractText(response: Anthropic.Message): string {
  const block = response.content.find((c) => c.type === 'text')
  if (!block || block.type !== 'text') {
    throw new Error('Anthropic response contained no text block')
  }
  return block.text
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// Validates LLM output against a Zod schema. Returns parsed object or throws.
// Accepts Zod schemas (`.parse`) or any object with `.parse(text)` — keeps
// dependency surface narrow at this layer.
function validateSchema(text: string, schema: unknown): unknown {
  // Strip common markdown fences before parsing.
  const cleaned = text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim()
  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned)
  } catch {
    throw new Error(`Output is not valid JSON: ${cleaned.slice(0, 200)}`)
  }
  if (schema && typeof schema === 'object' && 'parse' in (schema as object)) {
    return (schema as { parse: (input: unknown) => unknown }).parse(parsed)
  }
  return parsed
}
