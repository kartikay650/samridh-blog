// Blog clusters — M2 step 1 of the GEO blog engine.
//
// Groups a workspace's high-value scored threads into TOPIC CLUSTERS, each with
// a canonical buyer-question a blog can answer. This is the input to the blog
// generator: one cluster → one grounded GEO blog.
//
// Why an LLM pass (not lexical / embeddings):
//   - There are no embeddings in the codebase.
//   - `thread_scores.surfaced_via_query` is NOT populated (verified 0/159 on
//     live data), so we can't group by the query that surfaced each thread.
//   - What IS reliable is each thread's title + key_insight + intent
//     classification. One grounded Sonnet call clusters those into clean topics
//     far better than keyword overlap, and names the canonical question in real
//     buyer language — which is exactly what the blog must rank/answer for.
//
// Grounding rule: the model may ONLY cluster the threads it's given, may assign
// each thread to at most one cluster, and must drop threads that don't fit a
// real cluster. No invented topics.
//
// SERVER ONLY.

import { llmCall } from '@/lib/agents/core/llm-call'
import { adminClient } from '@/lib/supabase/admin'

export interface BlogCluster {
  cluster_id: string                 // stable slug key (topic-derived)
  canonical_question: string         // the search-style question a buyer asks (blog title seed)
  topic_label: string                // short human label for the UI
  pain_phrases: string[]             // buyer language from the threads (for grounding + GEO)
  thread_ids: string[]               // provenance — the threads this cluster is built from
  routing: 'open' | 'reddit_dominated'  // M4 hint; refined later
  rationale: string                  // 1 line: why this is worth a blog
}

export interface ClusterOptions {
  /** Min relevance_score for a thread to be a candidate. Default 6. */
  minRelevance?: number
  /** Max candidate threads fed to the clustering call. Default 40. */
  maxCandidates?: number
  /** Min threads a cluster needs to survive. Default 2. */
  minThreadsPerCluster?: number
  /** Max clusters to return. Default 8. */
  maxClusters?: number
}

interface CandidateThread {
  thread_id: string
  title: string
  insight: string
  classification: string
  insight_score: number
  intent_score: number
  comparison: boolean
}

const SCHEMA_FACTORY = (validIds: Set<string>, minThreads: number, maxClusters: number) => ({
  parse(input: unknown): { clusters: BlogCluster[] } {
    if (typeof input !== 'object' || input === null) throw new Error('Expected object')
    const o = input as { clusters?: unknown }
    if (!Array.isArray(o.clusters)) throw new Error('Missing clusters array')
    const str = (v: unknown, max = 300): string => (typeof v === 'string' ? v.trim().slice(0, max) : '')
    const arr = (v: unknown, max = 10): string[] =>
      Array.isArray(v)
        ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((s) => s.trim()).slice(0, max)
        : []
    const slug = (s: string) =>
      s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'topic'

    const out: BlogCluster[] = []
    const usedSlugs = new Set<string>()
    for (const raw of o.clusters) {
      if (typeof raw !== 'object' || raw === null) continue
      const c = raw as Record<string, unknown>
      const question = str(c.canonical_question)
      if (!question) continue
      // Only keep thread_ids the caller actually provided (grounding guard).
      const threadIds = arr(c.thread_ids, 20).filter((id) => validIds.has(id))
      if (threadIds.length < minThreads) continue
      let base = slug(str(c.topic_label) || question)
      let key = base
      let n = 2
      while (usedSlugs.has(key)) key = `${base}-${n++}`
      usedSlugs.add(key)
      const routing = c.routing === 'reddit_dominated' ? 'reddit_dominated' : 'open'
      out.push({
        cluster_id: key,
        canonical_question: question,
        topic_label: str(c.topic_label, 80) || question.slice(0, 80),
        pain_phrases: arr(c.pain_phrases, 8),
        thread_ids: threadIds,
        routing,
        rationale: str(c.rationale, 200),
      })
    }
    // Strongest clusters first (more threads = stronger corroboration signal).
    out.sort((a, b) => b.thread_ids.length - a.thread_ids.length)
    return { clusters: out.slice(0, maxClusters) }
  },
})

function buildSystemPrompt(minThreads: number, maxClusters: number): string {
  return `You are a content strategist for a GEO (Generative Engine Optimization) blog engine. You are given a list of real Reddit threads that a brand's buyers are active in. Your job: group them into TOPIC CLUSTERS, where each cluster is a distinct question or problem that a single blog post could own.

The goal of each cluster is a blog that answers a real buyer question so well that AI engines (ChatGPT, Perplexity, Google AI) cite it. So the canonical_question must be phrased the way a real person would ask an AI — a genuine search query, not a marketing headline.

STRICT RULES:
- Use ONLY the threads provided. Each thread's id may appear in AT MOST ONE cluster.
- A cluster needs at least ${minThreads} genuinely-related threads. If threads don't group, leave them out — do NOT force weak clusters or invent topics.
- Return at most ${maxClusters} clusters, strongest first.
- canonical_question: a real buyer question in plain language (e.g. "how do I get my brand mentioned by ChatGPT?", "what actually works for finding first SaaS customers on Reddit?"). Not a slogan.
- pain_phrases: 3-6 short phrases in the buyers' own words, pulled from the threads.
- routing: "reddit_dominated" if this exact question is one where Reddit threads already dominate the answer (a blog will struggle to outrank them) — vs "open" if it's a question with room for an owned page to rank. Default "open" when unsure.
- rationale: one line on why this topic is worth a blog for this brand.

Return ONLY a JSON object:
{
  "clusters": [
    {
      "canonical_question": "...",
      "topic_label": "short label",
      "pain_phrases": ["...", "..."],
      "thread_ids": ["<id from the list>", "..."],
      "routing": "open" | "reddit_dominated",
      "rationale": "..."
    }
  ]
}
No markdown fences, no commentary.`
}

function buildUserMessage(threads: CandidateThread[]): string {
  const lines = threads.map(
    (t) =>
      `- id:${t.thread_id} | [${t.classification}${t.comparison ? ',comparison' : ''} · intent ${t.intent_score}/insight ${t.insight_score}] ${t.title}${t.insight ? ` — ${t.insight}` : ''}`,
  )
  return `THREADS (cluster these; use the exact ids):

${lines.join('\n')}

Return the JSON object.`
}

/**
 * Cluster a workspace's high-value threads into blog-worthy topics.
 * One grounded Sonnet call. Returns [] if there aren't enough candidates.
 */
export async function buildBlogClusters(
  workspaceId: string,
  opts: ClusterOptions = {},
): Promise<BlogCluster[]> {
  const minRelevance = opts.minRelevance ?? 6
  const maxCandidates = opts.maxCandidates ?? 25
  const minThreads = opts.minThreadsPerCluster ?? 2
  const maxClusters = opts.maxClusters ?? 8

  // Pull scored threads, best first. We cluster on title + key_insight, so we
  // need both tables. Do the join in two steps (scores → threads) to keep the
  // PostgREST query simple and predictable.
  const { data: scores, error } = await adminClient
    .from('thread_scores')
    .select('thread_id, key_insight, summary, intent_classification, insight_score, intent_score, comparison_thread, relevance_score')
    .eq('workspace_id', workspaceId)
    .gte('relevance_score', minRelevance)
    .order('insight_score', { ascending: false, nullsFirst: false })
    .limit(maxCandidates)
  if (error) throw new Error(`buildBlogClusters: scores fetch failed: ${error.message}`)
  if (!scores || scores.length < minThreads) return []

  const threadIds = scores.map((s) => s.thread_id)
  const { data: threads, error: tErr } = await adminClient
    .from('threads')
    .select('id, title')
    .in('id', threadIds)
  if (tErr) throw new Error(`buildBlogClusters: threads fetch failed: ${tErr.message}`)
  const titleById = new Map((threads ?? []).map((t) => [t.id, t.title as string]))

  const candidates: CandidateThread[] = scores
    .map((s) => ({
      thread_id: s.thread_id as string,
      title: titleById.get(s.thread_id) ?? '',
      insight: (s.key_insight as string) || (s.summary as string) || '',
      classification: (s.intent_classification as string) || 'discussion',
      insight_score: (s.insight_score as number) ?? 0,
      intent_score: (s.intent_score as number) ?? 0,
      comparison: !!s.comparison_thread,
    }))
    .filter((c) => c.title)

  if (candidates.length < minThreads) return []

  const validIds = new Set(candidates.map((c) => c.thread_id))
  const result = await llmCall({
    workspace_id: workspaceId,
    purpose: 'blog.cluster_threads',
    model: 'sonnet',
    system_prompt: buildSystemPrompt(minThreads, maxClusters),
    user_message: buildUserMessage(candidates),
    cache_control: 'none',
    schema: SCHEMA_FACTORY(validIds, minThreads, maxClusters),
    max_tokens: 2500,
    // Clustering is a batch step run under a 300s route/cron, not a 60s request.
    // Give it real headroom — a 25-thread grouping call can take 40-70s.
    timeout_ms: 90_000,
  })

  if (!result.parsed) return []
  return (result.parsed as { clusters: BlogCluster[] }).clusters
}
