// Brand Truth — the canonical, grounded source every generated asset writes from.
//
// The extractor (lib/agents/brand/extract-brand-context.ts) already populates a
// pile of scraper-facing signals on the workspace (pain_phrases, use_case_slots,
// ingredients, competitors, off_limits_topics, ...). Brand Truth CONSOLIDATES
// those existing columns + the core workspace fields into ONE canonical object
// that content generation reads from, so messaging is consistent across the
// reply, the post, and the blog. That consistency is the corroboration lever
// (AI gains confidence when a claim recurs across independent sources) and the
// anti-hallucination guard (generation is grounded in one confirmed truth).
//
// This is a pure consolidation/rewrite pass: it must NOT invent facts. Every
// field is grounded in the workspace row it's given. If a signal is thin, the
// field stays short or empty.
//
// SERVER ONLY.

import { llmCall } from '@/lib/agents/core/llm-call'
import { adminClient } from '@/lib/supabase/admin'

export interface BrandTruth {
  one_liner: string                                   // one sentence: what it is + who for
  what_it_is: string                                  // 2-4 sentence plain description
  icp: string                                         // who genuinely buys/uses this
  key_facts: string[]                                 // concrete, verifiable claims (grounded)
  differentiators: string[]                           // why choose this over alternatives
  features_or_ingredients: string[]                   // SaaS features / D2C ingredients / service offerings
  positioning: string                                 // the category + the wedge, one short paragraph
  faqs: Array<{ q: string; a: string }>               // real buyer questions → grounded answers (→ FAQPage schema)
  off_limits: string[]                                // topics/claims never to make (legal/brand-unsafe)
}

// Brand Truth consolidates these workspace columns (all already populated: core
// fields + extract-brand-context output). We fetch the whole row (select '*',
// matching getWorkspace) and read the fields below in buildUserMessage:
//   product_name, product_description, icp_description, tone_guide, company_type,
//   keywords, competitors, website_url, pain_phrases, exclusion_categories,
//   off_limits_topics, use_case_slots, trigger_moments, ingredients,
//   certifications, integrations, price_tier, pricing_tier_label, team_size_fit,
//   countries, market_gaps, brand_voice_samples.

const SCHEMA = {
  parse(input: unknown): BrandTruth {
    if (typeof input !== 'object' || input === null) throw new Error('Expected object')
    const o = input as Record<string, unknown>
    const str = (v: unknown, max = 600): string =>
      typeof v === 'string' ? v.trim().slice(0, max) : ''
    const arr = (v: unknown, max = 12): string[] =>
      Array.isArray(v)
        ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
            .map((s) => s.trim())
            .slice(0, max)
        : []
    const faqs = (v: unknown): Array<{ q: string; a: string }> => {
      if (!Array.isArray(v)) return []
      return v
        .map((x) => {
          if (typeof x !== 'object' || x === null) return null
          const xo = x as Record<string, unknown>
          const q = typeof xo.q === 'string' ? xo.q.trim().slice(0, 300) : ''
          const a = typeof xo.a === 'string' ? xo.a.trim().slice(0, 800) : ''
          return q && a ? { q, a } : null
        })
        .filter((x): x is { q: string; a: string } => x !== null)
        .slice(0, 10)
    }
    return {
      one_liner: str(o.one_liner, 300),
      what_it_is: str(o.what_it_is, 800),
      icp: str(o.icp, 500),
      key_facts: arr(o.key_facts, 12),
      differentiators: arr(o.differentiators, 8),
      features_or_ingredients: arr(o.features_or_ingredients, 15),
      positioning: str(o.positioning, 700),
      faqs: faqs(o.faqs),
      off_limits: arr(o.off_limits, 12),
    }
  },
}

function fmt(v: unknown): string {
  if (Array.isArray(v)) {
    const items = v
      .map((x) => {
        if (typeof x === 'string') return x
        if (x && typeof x === 'object' && 'content' in x) return String((x as { content: unknown }).content)
        return ''
      })
      .filter(Boolean)
    return items.length ? items.join(' | ') : '(none)'
  }
  if (v === null || v === undefined || v === '') return '(none)'
  return String(v)
}

function buildSystemPrompt(): string {
  return `You are a brand strategist consolidating a company's scattered brand data into ONE canonical "Brand Truth" object. Downstream, every piece of content beetle generates (Reddit replies, posts, and SEO/GEO blogs) will be grounded in this object, so it must be accurate and consistent.

CRITICAL GROUNDING RULE: Consolidate and rephrase ONLY what the source data supports. Do NOT invent facts, features, ingredients, stats, or claims that are not present in the input. If a field is thin, keep it short or empty. A short accurate object beats a padded invented one. This object becomes the single source of truth — a hallucination here poisons every generated asset.

Output a JSON object with these EXACT keys:

{
  "one_liner": "One sentence: what the product is + who it's for. Plain, specific, no hype.",
  "what_it_is": "2-4 sentences describing what it actually does, in plain language. No marketing adjectives.",
  "icp": "Who genuinely buys/uses this — the specific persona/stage, grounded in the ICP data.",
  "key_facts": ["5-10 concrete, verifiable facts about the product, grounded strictly in the input (e.g. real features, real ingredients, real integrations, price tier, markets served). Each a short factual statement. NEVER invent."],
  "differentiators": ["3-6 honest reasons to choose this over alternatives, grounded in the data. Real tradeoffs allowed. No empty superlatives."],
  "features_or_ingredients": ["The product's real features (SaaS) / ingredients or materials (D2C) / offerings (services), copied from the input. Empty if the input doesn't state them."],
  "positioning": "One short paragraph: the category it sits in + its genuine wedge vs competitors. Grounded in market_gaps + differentiators.",
  "faqs": [{"q": "a real question a buyer would ask", "a": "a grounded, honest answer"}, ... 4-8 items. Questions buyers actually ask before purchasing; answers grounded in the facts above. These become FAQPage schema on generated blogs, so they must be accurate.],
  "off_limits": ["Topics/claims this brand must NEVER make in public content — legal or brand-unsafe (e.g. medical cure claims, competitor bashing, specific financial advice). Ground in off_limits_topics + the category."]
}

QUALITY RULES:
- Plain language over marketing language. "helps founders find Reddit threads" not "revolutionizes GTM".
- Every key_fact and ingredient/feature must trace to the input. If it's not in the data, it doesn't go in.
- FAQ answers must be consistent with key_facts — no contradictions (contradictions reduce AI citation confidence).
- Match the brand's real voice from the voice samples where relevant, but keep the object factual.

Return ONLY the JSON object. No markdown fences. No commentary.`
}

function buildUserMessage(ws: Record<string, unknown>): string {
  return `WORKSPACE DATA (the ONLY source — do not add facts beyond this):

Product name: ${fmt(ws.product_name)}
Description: ${fmt(ws.product_description)}
ICP: ${fmt(ws.icp_description)}
Company type: ${fmt(ws.company_type)}
Tone guide: ${fmt(ws.tone_guide)}
Website: ${fmt(ws.website_url)}

Keywords / buyer language: ${fmt(ws.keywords)}
Pain phrases: ${fmt(ws.pain_phrases)}
Use cases: ${fmt(ws.use_case_slots)}
Trigger moments: ${fmt(ws.trigger_moments)}

Competitors: ${fmt(ws.competitors)}
Market gaps / positioning angles: ${fmt(ws.market_gaps)}

Features / integrations: ${fmt(ws.integrations)}
Ingredients: ${fmt(ws.ingredients)}
Certifications: ${fmt(ws.certifications)}
Price tier: ${fmt(ws.price_tier)} ${fmt(ws.pricing_tier_label)}
Team-size fit: ${fmt(ws.team_size_fit)}
Markets / countries: ${fmt(ws.countries)}

Not-for / exclusion categories: ${fmt(ws.exclusion_categories)}
Off-limits topics: ${fmt(ws.off_limits_topics)}

Brand voice samples: ${fmt(ws.brand_voice_samples)}

Consolidate this into the Brand Truth JSON object. Ground every field in the data above.`
}

/**
 * Build (or rebuild) the canonical Brand Truth for a workspace and persist it.
 * One grounded Sonnet pass over the workspace's existing brand columns.
 * Returns the parsed object. Does NOT flip brand_truth_confirmed — that's set
 * when the founder reviews/edits it in the UI.
 */
export async function buildBrandTruth(workspaceId: string): Promise<BrandTruth> {
  const { data: ws, error } = await adminClient
    .from('workspaces')
    .select('*')
    .eq('id', workspaceId)
    .maybeSingle()

  if (error) throw new Error(`buildBrandTruth: workspace fetch failed: ${error.message}`)
  if (!ws) throw new Error(`buildBrandTruth: workspace ${workspaceId} not found`)

  const result = await llmCall({
    workspace_id: workspaceId,
    purpose: 'brand.build_truth',
    model: 'sonnet',
    system_prompt: buildSystemPrompt(),
    user_message: buildUserMessage(ws as Record<string, unknown>),
    cache_control: 'none',
    schema: SCHEMA,
    max_tokens: 2500,
    timeout_ms: 40_000,
  })

  if (!result.parsed) throw new Error('buildBrandTruth: no parsed object returned')
  const truth = result.parsed as BrandTruth

  const { error: writeErr } = await adminClient
    .from('workspaces')
    .update({
      brand_truth: truth,
      brand_truth_generated_at: new Date().toISOString(),
    })
    .eq('id', workspaceId)

  if (writeErr) throw new Error(`buildBrandTruth: persist failed: ${writeErr.message}`)

  return truth
}

/** Read the stored Brand Truth for a workspace (null if never generated). */
export async function getBrandTruth(workspaceId: string): Promise<BrandTruth | null> {
  const { data, error } = await adminClient
    .from('workspaces')
    .select('brand_truth')
    .eq('id', workspaceId)
    .maybeSingle()
  if (error || !data?.brand_truth) return null
  return data.brand_truth as BrandTruth
}
