// Blog pipeline orchestrator — ties M0 + M2 together and persists to M1 tables.
//
//   ensure Brand Truth → cluster high-value threads → generate a GEO blog per
//   OPEN cluster → quality-gate → persist draft + provenance.
//
// Idempotent by slug: a cluster whose slug already has a draft is skipped (so
// re-running doesn't duplicate). Pass force to regenerate.
//
// SERVER ONLY.

import { adminClient } from '@/lib/supabase/admin'
import { getBrandTruth, buildBrandTruth } from '@/lib/brand-truth'
import { buildBlogClusters, type BlogCluster } from '@/lib/blog-clusters'
import { generateBlog } from '@/lib/blog-generator'
import { qualityGate } from '@/lib/blog-quality-gate'

export interface PipelineOptions {
  /** Max blogs to generate this run. Default 3. */
  maxBlogs?: number
  /** Include reddit_dominated clusters too (default false — blog OPEN queries only). */
  includeDominated?: boolean
  /** Regenerate even if a draft with the cluster's slug already exists. Default false. */
  force?: boolean
}

export interface PipelineResult {
  brand_truth_ready: boolean
  clusters_found: number
  generated: number
  gated_out: number
  skipped_existing: number
  blogs: Array<{ id: string; slug: string; title: string; unique_score: number; routing: string; threads: number; status: string }>
  gate_failures: Array<{ slug: string; reasons: string[] }>
}

export async function runBlogPipeline(workspaceId: string, opts: PipelineOptions = {}): Promise<PipelineResult> {
  const maxBlogs = opts.maxBlogs ?? 3
  const includeDominated = opts.includeDominated ?? false

  const result: PipelineResult = {
    brand_truth_ready: false,
    clusters_found: 0,
    generated: 0,
    gated_out: 0,
    skipped_existing: 0,
    blogs: [],
    gate_failures: [],
  }

  // ── M0: Brand Truth (build once if missing) ──
  let brandTruth = await getBrandTruth(workspaceId)
  if (!brandTruth) brandTruth = await buildBrandTruth(workspaceId)
  result.brand_truth_ready = !!brandTruth
  if (!brandTruth) return result

  const { data: ws } = await adminClient.from('workspaces').select('product_name, competitors').eq('id', workspaceId).maybeSingle()
  const productName = ws?.product_name ?? 'the brand'
  const competitors = (ws?.competitors as string[] | null) ?? []

  // ── M2.1: cluster ──
  const clusters = await buildBlogClusters(workspaceId)
  result.clusters_found = clusters.length
  const candidates = clusters.filter((c) => includeDominated || c.routing === 'open')

  // Existing drafts: slugs (for idempotency) + bodies (for the uniqueness gate).
  const { data: existing } = await adminClient
    .from('generated_blogs')
    .select('slug, body_md')
    .eq('workspace_id', workspaceId)
  const existingSlugs = new Set((existing ?? []).map((r) => r.slug as string))
  const existingBodies = (existing ?? []).map((r) => r.body_md as string)

  for (const cluster of candidates) {
    if (result.generated >= maxBlogs) break
    if (!opts.force && existingSlugs.has(cluster.cluster_id)) {
      result.skipped_existing++
      continue
    }

    const snippets = await loadThreadSnippets(cluster.thread_ids)
    let draft
    try {
      draft = await generateBlog({
        workspace_id: workspaceId,
        product_name: productName,
        cluster,
        brand_truth: brandTruth,
        thread_snippets: snippets,
        competitors,
      })
      // Note: generateBlog now runs web-search research + the grounding gate
      // (verify every cited stat traces to the verified list) internally.
    } catch (err) {
      result.gate_failures.push({ slug: cluster.cluster_id, reasons: [`generation_failed: ${err instanceof Error ? err.message : String(err)}`] })
      continue
    }

    const gate = qualityGate(draft, existingBodies)
    if (!gate.pass) {
      result.gated_out++
      result.gate_failures.push({ slug: draft.slug, reasons: gate.reasons })
      continue
    }

    const persisted = await persistDraft(workspaceId, cluster, draft, gate.unique_score)
    if (persisted) {
      result.generated++
      existingBodies.push(draft.body_md)   // dedupe subsequent drafts in the same run
      existingSlugs.add(persisted.slug)
      result.blogs.push({
        id: persisted.id,
        slug: persisted.slug,
        title: draft.title,
        unique_score: gate.unique_score,
        routing: cluster.routing,
        threads: cluster.thread_ids.length,
        status: 'draft',
      })
    }
  }

  return result
}

async function loadThreadSnippets(threadIds: string[]): Promise<string[]> {
  if (threadIds.length === 0) return []
  const [{ data: scores }, { data: threads }] = await Promise.all([
    adminClient.from('thread_scores').select('thread_id, key_insight, summary').in('thread_id', threadIds),
    adminClient.from('threads').select('id, title').in('id', threadIds),
  ])
  const insightById = new Map((scores ?? []).map((s) => [s.thread_id, (s.key_insight as string) || (s.summary as string) || '']))
  return (threads ?? []).map((t) => `${t.title}${insightById.get(t.id) ? ` — ${insightById.get(t.id)}` : ''}`)
}

async function persistDraft(
  workspaceId: string,
  cluster: BlogCluster,
  draft: Awaited<ReturnType<typeof generateBlog>>,
  uniqueScore: number,
): Promise<{ id: string; slug: string } | null> {
  // Use the cluster's stable slug as the row slug (idempotency key with the
  // unique (workspace_id, slug) index), falling back to the draft slug.
  const slug = cluster.cluster_id || draft.slug
  const { data: row, error } = await adminClient
    .from('generated_blogs')
    .insert({
      workspace_id: workspaceId,
      slug,
      title: draft.title,
      description: draft.description,
      body_md: draft.body_md,
      tldr: draft.tldr,
      faq: draft.faq,
      target_query: cluster.canonical_question,
      pain_phrases: cluster.pain_phrases,
      source_cluster_id: cluster.cluster_id,
      routing: cluster.routing,
      unique_score: uniqueScore,
      word_count: draft.word_count,
      sources_used: draft.sources_used ?? [],
      status: 'draft',
    })
    .select('id, slug')
    .single()

  if (error || !row) {
    console.error('[blog-pipeline] persist failed:', error?.message)
    return null
  }

  // Provenance: one blog_thread_matches row per source thread.
  const matchRows = cluster.thread_ids.map((tid) => ({ blog_id: row.id, thread_id: tid, relation: 'source' }))
  if (matchRows.length) {
    const { error: mErr } = await adminClient.from('blog_thread_matches').insert(matchRows)
    if (mErr) console.error('[blog-pipeline] provenance insert failed:', mErr.message)
  }

  return { id: row.id as string, slug: row.slug as string }
}
