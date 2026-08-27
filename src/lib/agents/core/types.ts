// Shared agent contracts. Every agent in lib/agents/* uses these types.
// Do not import anything that pulls in side-effects (DB clients, SDK clients) here —
// this file is meant to be a pure type module.

export type AgentStatus = 'pending' | 'running' | 'paused' | 'completed' | 'failed'

export interface AgentRun {
  id: string
  workspace_id: string
  agent_type: string
  status: AgentStatus
  current_step: string
  state_blob: Record<string, unknown>
  attempts: number
  total_cost_usd: number
  started_at: string
  completed_at: string | null
  error_message: string | null
  created_at: string
  updated_at: string
}

// A Step is a single transition in an agent's state machine.
// run() receives the current state and returns the next step + the new state.
// 'done' is the terminal step name.
export interface Step<S> {
  name: string
  run: (state: S, ctx: AgentContext) => Promise<StepResult<S>>
}

export interface StepResult<S> {
  next: string | 'done'
  state: S
}

// Context passed to every step. Holds workspace identity + the run ID for
// nested LLM-call logging. Pure data — no side-effect handles.
export interface AgentContext {
  workspace_id: string
  agent_run_id: string
  agent_type: string
}

// LLM call options. Every Claude call in the agent system goes through one wrapper.
export type LlmModel = 'haiku' | 'sonnet'

export interface LlmCallOptions {
  workspace_id: string
  agent_run_id?: string                    // optional — non-agent contexts can omit
  purpose: string                          // e.g., 'post.drafter.archetype-3'
  model: LlmModel
  system_prompt: string
  user_message: string
  cache_control?: 'static' | 'none'        // 'static' enables Anthropic prompt caching
  schema?: unknown                         // Zod schema for structured outputs (validated post-call)
  max_tokens?: number
  temperature?: number                     // 0.0-1.0; default 1.0 (Anthropic). Lower = deterministic, higher = diverse.
  timeout_ms?: number                      // per-call request timeout override (default client is 25s — too short for big extractions)
  // Extended thinking. When set, the model reasons before answering (better for
  // nuanced judgment like natural brand-mention placement). budget_tokens is the
  // thinking budget; max_tokens must exceed it. Note: Anthropic forces
  // temperature=1 when thinking is on, so any temperature you pass is ignored.
  thinking_budget_tokens?: number
}

export interface LlmCallResult {
  text: string
  parsed?: unknown                         // populated if schema was provided + validated
  input_tokens: number
  cached_input_tokens: number              // tokens served from prompt cache (cheaper)
  output_tokens: number
  cost_usd: number
  latency_ms: number
}

// Surfaced when a workspace hits its monthly LLM cap (110% hard halt).
export class LlmBudgetExceededError extends Error {
  constructor(
    public workspace_id: string,
    public spent_usd: number,
    public cap_usd: number,
  ) {
    super(`Workspace ${workspace_id} exceeded LLM cap: $${spent_usd} / $${cap_usd}`)
    this.name = 'LlmBudgetExceededError'
  }
}

// Surfaced when an agent step throws unrecoverably. The agent runner catches
// these, marks the run failed, and persists the error for debugging.
export class AgentStepError extends Error {
  constructor(
    public agent_type: string,
    public step: string,
    public cause_message: string,
  ) {
    super(`Agent ${agent_type} failed at step ${step}: ${cause_message}`)
    this.name = 'AgentStepError'
  }
}
