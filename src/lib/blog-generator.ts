// Blog generator — M2 step 2 of the GEO blog engine.
//
// One cluster + the workspace's Brand Truth → one publish-ready GEO blog draft
// for the CUSTOMER's site (frontmatter mirrors trybeetle.com's lib/blog.js
// schema so exports drop straight into a markdown pipeline; also portable to
// Shopify/WordPress).
//
// Encodes the geo-blog-writer methodology: answer-first, question H2s,
// FAQPage-ready FAQ pairs, scannable structure. GROUNDED STRICTLY in Brand
// Truth + the cluster's real buyer language — it must NOT invent statistics,
// sources, features, or claims. An ungrounded stat destroys the citation trust
// the whole strategy depends on.
//
// SERVER ONLY.

import Anthropic from '@anthropic-ai/sdk'
import { llmCall } from '@/lib/agents/core/llm-call'
import { humanizeText } from '@/lib/humanizer'
import type { BrandTruth } from '@/lib/brand-truth'
import type { BlogCluster } from '@/lib/blog-clusters'

// Web-search research runs through the Anthropic SDK directly (llmCall has no
// tool support). Native web_search server tool → real, retrieved stats we can
// cite. Longer timeout: the search loop is server-side and can take a while.
const anthropicWeb = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 90_000, maxRetries: 1 })
const WEB_MODEL = 'claude-sonnet-4-6'

/**
 * Retrieve REAL, verifiable statistics for a blog topic via web search. Returns
 * a list of "stat — Source (year), url" lines the generator may cite. This is
 * what makes the stats real instead of invented (the whole reason the LLM can't
 * self-supply them). Fails open to [] — a blog with no stats beats fake ones.
 */
export async function researchTopicStats(question: string, context: string): Promise<string[]> {
  try {
    const resp = await anthropicWeb.messages.create({
      model: WEB_MODEL,
      max_tokens: 1500,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 4 }],
      messages: [{
        role: 'user',
        content: `Search the web for REAL, recent, verifiable statistics relevant to this blog topic: "${question}".
Topic context: ${context}

Find 3-6 concrete data points (a specific number, percentage, or dollar figure) from credible NAMED sources (a named study, report, company, or publication). For EACH, output exactly one line in this format:
<the stat as a sentence with the number> — <Source name>, <year>, <url>

Rules: only include a stat you ACTUALLY found via search from a real, nameable source with a URL. If you cannot verify a stat, do not include it. No preamble, no commentary. Output only the list of lines. If you find nothing verifiable, output nothing.`,
      }],
    })
    const text = resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
    return text
      .split('\n')
      // strip only a leading list marker ("- ", "1. ", "2) "), NOT the stat's own number
      .map((l) => l.replace(/^\s*(?:[-*•]\s+|\d+[.)]\s+)/, '').trim())
      .filter((l) => l.length > 25 && /\d/.test(l) && /https?:\/\//.test(l))
      .slice(0, 6)
  } catch (e) {
    console.error('[researchTopicStats] web search failed, proceeding without stats:', e instanceof Error ? e.message : e)
    return []
  }
}

export interface GeneratedBlogDraft {
  slug: string
  title: string
  description: string
  tldr: string
  tags: string[]
  faq: Array<{ q: string; a: string }>
  body_md: string
  word_count: number
  /** Web-search-verified stats/sources this blog was allowed to cite (for founder verification). */
  sources_used?: string[]
}

export interface BlogGenInput {
  workspace_id: string
  product_name: string
  cluster: BlogCluster
  brand_truth: BrandTruth
  /** Real buyer language for grounding — titles + insights of the cluster's threads. */
  thread_snippets: string[]
  /** Real named competitors/alternatives (from the workspace) for the comparison. */
  competitors?: string[]
  /** Pre-fetched verified stats; when omitted, generateBlog web-searches for them. */
  verified_stats?: string[]
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70) || 'post'
}

function wordCount(md: string): number {
  return md.trim().split(/\s+/).filter(Boolean).length
}

// Humanize markdown WITHOUT destroying structure. humanizeText() collapses
// blank lines (fine for a one-paragraph Reddit reply, fatal for a structured
// blog — headings and paragraphs would merge into one blob and "##" would leak
// as literal text). So we humanize line by line, preserving newlines, headings,
// and list markers.
function humanizeMarkdown(md: string): string {
  return md
    .split('\n')
    .map((line) => (line.trim() ? humanizeText(line).trim() : ''))
    .join('\n')
    // collapse any accidental 3+ newline runs to a clean paragraph break
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const SCHEMA = {
  parse(input: unknown): GeneratedBlogDraft {
    if (typeof input !== 'object' || input === null) throw new Error('Expected object')
    const o = input as Record<string, unknown>
    const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '')
    // Clamp to a max length at a WORD boundary (no mid-word truncation) — used
    // for the meta description so SERP/OG snippets read clean.
    const clampWords = (v: unknown, max: number): string => {
      const s = typeof v === 'string' ? v.trim() : ''
      if (s.length <= max) return s
      const cut = s.slice(0, max)
      const lastSpace = cut.lastIndexOf(' ')
      return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[\s,;:]+$/, '')
    }
    const title = str(o.title, 120)
    const body_md = typeof o.body_md === 'string' ? o.body_md.trim() : ''
    if (!title) throw new Error('missing title')
    if (body_md.length < 400) throw new Error('body too short')
    const tags = Array.isArray(o.tags)
      ? o.tags.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((s) => s.trim()).slice(0, 4)
      : []
    const faq = Array.isArray(o.faq)
      ? o.faq
          .map((x) => {
            if (typeof x !== 'object' || x === null) return null
            const xo = x as Record<string, unknown>
            const q = str(xo.q, 300)
            const a = str(xo.a, 900)
            return q && a ? { q, a } : null
          })
          .filter((x): x is { q: string; a: string } => x !== null)
          .slice(0, 6)
      : []
    return {
      slug: slugify(str(o.slug, 70) || title),
      title,
      description: clampWords(o.description, 160),
      tldr: str(o.tldr, 600),
      tags,
      faq,
      body_md,
      word_count: wordCount(body_md),
    }
  },
}

function buildSystemPrompt(brand: BrandTruth, productName: string): string {
  const faqsHint = brand.faqs.length
    ? brand.faqs.map((f) => `  Q: ${f.q}\n  A: ${f.a}`).join('\n')
    : '(none provided — write FAQ pairs grounded only in the facts above)'

  return `You are a GEO (Generative Engine Optimization) content writer producing a blog post FOR the brand "${productName}". The post publishes on ${productName}'s OWN website. Its job: rank on Google AND get quoted/cited by ChatGPT, Perplexity, and Google AI Overviews when someone asks the target question.

═══ BRAND TRUTH — the ONLY source of facts about ${productName} ═══
One-liner: ${brand.one_liner}
What it is: ${brand.what_it_is}
ICP: ${brand.icp}
Key facts (use ONLY these — do not invent others): ${brand.key_facts.join(' | ') || '(none)'}
Differentiators: ${brand.differentiators.join(' | ') || '(none)'}
Features/ingredients: ${brand.features_or_ingredients.join(', ') || '(none)'}
Positioning: ${brand.positioning}
Existing FAQs:
${faqsHint}
OFF-LIMITS (never make these claims): ${brand.off_limits.join(' | ') || '(none)'}

═══ GROUNDING vs FABRICATION — read carefully ═══
Two different rules, do not confuse them:
- BRAND facts (what ${productName} is, does, its features/ingredients/differentiators): use ONLY the Brand Truth. Never invent a product fact.
- STATISTICS & SOURCES: you SHOULD include real, well-established statistics and cite them to their ACTUAL named source (a named study, org, publication, or expert you genuinely know exists). Stats + named sources are the single biggest driver of AI citation, so a post with 2-4 real, correctly-attributed stats beats one with none.
  - NEVER invent a number, a percentage, a study title, or attribute to a vague "studies show" / "research suggests." If you are not confident a statistic and its source are real, OMIT it.
  - For mechanistic claims you can't source (e.g. how an AI engine weights a thread), frame them as reasoning or observed experience ("in practice, older threads tend to..."), NOT as established fact. Do not state an unsourced mechanism as if it were proven.

═══ GEO RULES (what actually gets cited — in priority order) ═══
1. ANSWER FIRST. The tldr and the first 2-3 sentences of the body must directly, completely answer the target question — self-contained enough for an AI to quote verbatim.
2. STATISTICS — cite ONLY the VERIFIED STATS provided, exactly. The user message includes a "VERIFIED STATISTICS" list retrieved via web search (real figures, real sources). Weave 2-4 in naturally, using the figure and the source name EXACTLY as written (do not round, distort, or restate the number differently). NEVER cite a source name that is not in the verified list, NEVER invent an additional statistic, and never use vague "studies show." If the verified list is empty, include NO statistics at all. Inventing a stat or a source is the one unforgivable error.
3. ONE COMPARISON — category-level, not a fake feature matrix. Contrast APPROACHES the buyer chooses between (e.g. "Reddit-native tools vs general social-listening tools vs doing it manually"), where ${productName} sits, and the honest tradeoffs. You may name real alternatives, but ONLY state a characteristic of a named third-party product if it is genuinely, widely known — never assert specific unverified features (a made-up "No" in a table is a fabrication). When unsure, compare your approach against the generic manual/DIY way instead.
4. EVERY H2 IS A BUYER QUESTION (long-tail, voice-search phrasing). No statement headings — literally phrase each heading as a question. Each section answers ONE question completely.
5. FAQ: 4-6 real buyer questions with complete, SELF-CONTAINED 2-4 sentence answers that restate their topic (an AI must quote the answer without the question) and give a concrete, actionable "how," not just strategy.
6. Introduce ${productName} once, naturally, in the first third (with its one-line what-it-is), then at most once or twice more — as ONE honest option with real tradeoffs, never a hard pitch or brand-stuffing.
7. NO unsourced mechanisms as fact. Claims about how AI engines rank/cite (thread age, upvotes, timing) must be framed as reasoning or observed experience ("in practice, ..."), never as proven fact.
8. Structure for parsing: short paragraphs, bullet/numbered lists. Define terms/entities (like GEO) plainly on first use, in the body.

═══ VOICE ═══
Direct, practical, specific, a little opinionated — an expert talking to a peer. No hype, no "in today's fast-paced world," no fluff, no em-dashes.

═══ LENGTH ═══ 1,000-1,600 words. Complete, never padded.

Return ONLY a JSON object (no markdown fences, no commentary):
{
  "slug": "keyword-first-hyphenated-url",
  "title": "<=60 chars, contains the target question's keywords, compelling not clickbait",
  "description": "150-160 char meta description, keyword early, a real summary",
  "tldr": "2-4 sentence self-contained answer to the target question — this is what AI engines quote",
  "tags": ["2-4 topical tags"],
  "faq": [{"q": "...", "a": "..."}, ... 4-6 pairs],
  "body_md": "the full post in markdown. Starts with the answer-first opener. H2s as questions. No H1 (the title is the H1)."
}`
}

function buildUserMessage(cluster: BlogCluster, snippets: string[], competitors: string[], verifiedStats: string[]): string {
  return `TARGET QUESTION (the post must own this query):
"${cluster.canonical_question}"

VERIFIED STATISTICS (retrieved via web search — REAL, cite with their source names; do NOT invent any others; if empty, use no stats):
${verifiedStats.length ? verifiedStats.map((s) => `- ${s}`).join('\n') : '- (none found — include no statistics)'}

BUYER LANGUAGE — real phrases your ICP uses about this (weave in naturally for SEO/GEO relevance; do not quote as if from named people):
${cluster.pain_phrases.map((p) => `- ${p}`).join('\n') || '- (none)'}

REAL NAMED ALTERNATIVES/COMPETITORS (use these in the comparison; contrast honestly, never invent facts about them):
${competitors.length ? competitors.map((c) => `- ${c}`).join('\n') : '- (none provided — compare against the generic manual/DIY approach instead)'}

REAL DISCUSSION CONTEXT (what people are actually saying in threads on this topic — for grounding the angle, NOT for fabricating quotes):
${snippets.slice(0, 8).map((s) => `- ${s}`).join('\n') || '- (none)'}

Write the GEO blog post that answers the target question better than anything currently ranking. Return the JSON object.`
}

// ── Grounding verification + one auto-revision (spec §6.3: reject/repair if
//    ungrounded). Since the generator now includes real stats + sources, this is
//    the net that keeps them REAL: it flags fabricated stats, fake/vague sources,
//    unsourced mechanisms stated as fact, and brand claims not in the Brand
//    Truth, then does ONE targeted revision to fix them.

const CHECK_SCHEMA = {
  parse(input: unknown): { grounded: boolean; issues: string[] } {
    if (typeof input !== 'object' || input === null) throw new Error('obj')
    const o = input as Record<string, unknown>
    const issues = Array.isArray(o.issues)
      ? o.issues.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).slice(0, 12)
      : []
    return { grounded: o.grounded === true && issues.length === 0, issues }
  },
}

function buildCheckPrompt(brand: BrandTruth, productName: string, verifiedStats: string[]): string {
  const statsBlock = verifiedStats.length
    ? verifiedStats.map((s) => `- ${s}`).join('\n')
    : '(none — the blog must contain NO statistics; flag any statistic present)'
  return `You are a fact-checker for a blog about "${productName}". You get the BRAND TRUTH (the only true facts about the product), the VERIFIED STATISTICS the writer was allowed to cite (the ONLY real stats available), and a BLOG. Find grounding problems ONLY:

Flag as issues:
- Any statistic, number, percentage, or named source in the blog that does NOT appear in the VERIFIED STATISTICS list below (it was invented — the writer had no other real stats).
- Any statistic whose figure or source name has been changed/distorted from the verified version.
- Any statistic attributed vaguely ("studies show", "research suggests") with no named source.
- Any mechanistic claim stated as established fact that isn't sourced (should be framed as reasoning, not fact).
- Any claim ABOUT THE PRODUCT (features, results, ingredients) not supported by the Brand Truth.

Do NOT flag: general reasoning, opinion, brand facts that ARE in the Brand Truth, or a statistic that matches one in the VERIFIED list (any date is fine — treat 2025/2026 as valid current years, not "future").

VERIFIED STATISTICS (the only real stats the writer had):
${statsBlock}

BRAND TRUTH:
${JSON.stringify(brand)}

Return ONLY JSON: {"grounded": <true if zero issues>, "issues": ["specific claim + why it's a problem", ...]}`
}

export async function verifyAndReground(
  workspaceId: string,
  productName: string,
  brand: BrandTruth,
  draft: GeneratedBlogDraft,
  verifiedStats: string[] = [],
): Promise<GeneratedBlogDraft> {
  const blogStr = `TITLE: ${draft.title}\nTLDR: ${draft.tldr}\nFAQ: ${JSON.stringify(draft.faq)}\nBODY:\n${draft.body_md}`
  let check
  try {
    check = await llmCall({
      workspace_id: workspaceId, purpose: 'blog.ground_check', model: 'sonnet',
      system_prompt: buildCheckPrompt(brand, productName, verifiedStats),
      user_message: `BLOG:\n${blogStr}\n\nReturn the JSON verdict.`,
      cache_control: 'none', temperature: 0.1, schema: CHECK_SCHEMA, max_tokens: 1000, timeout_ms: 60_000,
    })
  } catch {
    return draft // fail-open: a broken checker shouldn't block a draft
  }
  const verdict = check.parsed as { grounded: boolean; issues: string[] }
  if (verdict.grounded || verdict.issues.length === 0) return draft

  // One targeted revision, reusing the full GEO system prompt.
  try {
    const res = await llmCall({
      workspace_id: workspaceId, purpose: 'blog.reground', model: 'sonnet',
      system_prompt: buildSystemPrompt(brand, productName),
      user_message: `Here is a draft blog with GROUNDING PROBLEMS a fact-checker found. Fix ONLY these problems and return the full corrected JSON (same schema):

PROBLEMS:
${verdict.issues.map((i) => `- ${i}`).join('\n')}

HOW TO FIX: REMOVE ENTIRELY any statistic or named source flagged above — do not rephrase it, do not swap in a different source, do not keep the number. A blog with fewer stats is far better than one with a single unverifiable citation. Reframe unsourced mechanistic claims as reasoning/experience ("in practice, ..."), not fact. Remove any product claim not in the Brand Truth. Keep everything else — structure, headings, comparison, brand mention, length — intact (rewrite the affected sentences to flow without the removed stat).

CURRENT DRAFT:
${JSON.stringify({ slug: draft.slug, title: draft.title, description: draft.description, tldr: draft.tldr, tags: draft.tags, faq: draft.faq, body_md: draft.body_md })}

Return the corrected JSON object.`,
      cache_control: 'none', temperature: 0.5, schema: SCHEMA, max_tokens: 4500, timeout_ms: 120_000,
    })
    if (!res.parsed) return draft
    const revised = res.parsed as GeneratedBlogDraft
    const cleanBody = humanizeMarkdown(revised.body_md)
    const clean = (s: string) => humanizeText(s).trim()
    return {
      ...revised,
      title: clean(revised.title),
      description: clean(revised.description),
      tldr: clean(revised.tldr),
      faq: revised.faq.map((f) => ({ q: clean(f.q), a: clean(f.a) })),
      body_md: cleanBody,
      word_count: wordCount(cleanBody),
      sources_used: draft.sources_used,
    }
  } catch {
    return draft
  }
}

/**
 * Generate one GEO blog draft from a cluster + Brand Truth. One Sonnet call,
 * then a deterministic humanizer pass on the body. Grounded strictly.
 */
export async function generateBlog(input: BlogGenInput): Promise<GeneratedBlogDraft> {
  // Phase A — web-search research for REAL stats (skippable for offline tests).
  const verifiedStats = input.verified_stats
    ?? (await researchTopicStats(input.cluster.canonical_question, input.brand_truth.what_it_is))

  const result = await llmCall({
    workspace_id: input.workspace_id,
    purpose: 'blog.generate',
    model: 'sonnet',
    system_prompt: buildSystemPrompt(input.brand_truth, input.product_name),
    user_message: buildUserMessage(input.cluster, input.thread_snippets, input.competitors ?? [], verifiedStats),
    cache_control: 'none',
    temperature: 0.7,
    schema: SCHEMA,
    max_tokens: 4500,
    // Long-form generation under a 300s route/cron — give it headroom.
    timeout_ms: 120_000,
  })
  if (!result.parsed) throw new Error('generateBlog: no parsed draft returned')
  const draft = result.parsed as GeneratedBlogDraft

  // Deterministic humanizer safety net on EVERY text field (strips em-dashes,
  // curly quotes, AI vocab, etc.) — not just the body. Sonnet occasionally
  // sneaks em-dashes into the tldr/faq even when told not to.
  const clean = (s: string) => humanizeText(s).trim()
  const cleanBody = humanizeMarkdown(draft.body_md)
  const humanized: GeneratedBlogDraft = {
    ...draft,
    title: clean(draft.title),
    description: clean(draft.description),
    tldr: clean(draft.tldr),
    faq: draft.faq.map((f) => ({ q: clean(f.q), a: clean(f.a) })),
    body_md: cleanBody,
    word_count: wordCount(cleanBody),
    sources_used: verifiedStats,
  }

  // Phase C — grounding gate: verify every cited stat/source traces to the
  // verified list (and no invented brand claims), auto-revise once if not.
  return verifyAndReground(input.workspace_id, input.product_name, input.brand_truth, humanized, verifiedStats)
}
