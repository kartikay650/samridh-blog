// Blog quality gate — M2 step 3.
//
// Deterministic, no-LLM check before a generated draft is stored/shown. Guards
// against thin or near-duplicate content (Google's 2026 core updates punish
// both). Uniqueness is a word-trigram (3-gram shingle) Jaccard similarity vs the
// workspace's other generated blogs — no embeddings needed, and near-duplicate
// prose is exactly what shingling catches.
//
// SERVER-safe pure functions (importable anywhere).

import type { GeneratedBlogDraft } from '@/lib/blog-generator'

const MIN_UNIQUE_SCORE = 60   // 0-100; reject below this vs the closest existing post
const MIN_WORDS = 700
const MIN_FAQ = 3

export interface GateResult {
  pass: boolean
  unique_score: number        // 0-100, 100 = nothing similar exists
  word_count: number
  faq_count: number
  reasons: string[]           // why it failed (empty if pass)
}

function normalize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
}

export function trigramSet(text: string): Set<string> {
  const words = normalize(text)
  const grams = new Set<string>()
  for (let i = 0; i + 2 < words.length; i++) {
    grams.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`)
  }
  return grams
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  const [small, large] = a.size < b.size ? [a, b] : [b, a]
  small.forEach((g) => { if (large.has(g)) inter++ })
  return inter / (a.size + b.size - inter)
}

/**
 * Uniqueness 0-100 vs the most similar existing document. 100 = no overlap.
 * Compares against each existing body and takes the WORST (max similarity).
 */
export function uniqueScore(candidateBody: string, existingBodies: string[]): number {
  if (existingBodies.length === 0) return 100
  const cand = trigramSet(candidateBody)
  let maxSim = 0
  for (const body of existingBodies) {
    const sim = jaccard(cand, trigramSet(body))
    if (sim > maxSim) maxSim = sim
  }
  return Math.round((1 - maxSim) * 100)
}

/**
 * Run the gate on a draft. `existingBodies` = the workspace's other generated
 * blog bodies (+ optionally the customer's existing site pages).
 */
export function qualityGate(draft: GeneratedBlogDraft, existingBodies: string[] = []): GateResult {
  const reasons: string[] = []
  const score = uniqueScore(draft.body_md, existingBodies)
  const faqCount = draft.faq.length

  if (draft.word_count < MIN_WORDS) reasons.push(`thin: ${draft.word_count} words (min ${MIN_WORDS})`)
  if (score < MIN_UNIQUE_SCORE) reasons.push(`duplicative: ${score}% unique (min ${MIN_UNIQUE_SCORE}%)`)
  if (faqCount < MIN_FAQ) reasons.push(`too few FAQ pairs: ${faqCount} (min ${MIN_FAQ})`)
  if (!draft.tldr) reasons.push('missing tldr (answer-first block)')

  return { pass: reasons.length === 0, unique_score: score, word_count: draft.word_count, faq_count: faqCount, reasons }
}
