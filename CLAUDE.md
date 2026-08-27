# CLAUDE.md — GEO Blog Generator (read this first)

You (Claude) are being handed a blog-generation engine to wire up for **this company** and get producing publish-ready, AI-citable blog posts. Follow the steps in order. The engine works; what it needs from you is (1) the company's brand data and (2) a small pass to detach it from the origin project's database. Don't rewrite the logic — adapt the edges.

---

## What this engine does

Given a **brand-truth** object + a **topic**, it produces a publish-ready markdown blog post optimized for **GEO** (Generative Engine Optimization — getting cited by ChatGPT, Perplexity, Google AI Overviews) *and* traditional SEO. The pipeline:

```
brand-truth (your company's facts)
   → research real, cited stats (web search, grounded)
   → draft the post (answer-first, GEO tactics, brand voice)
   → grounding / quality gate (no fabricated stats; verify claims)
   → humanizer pass (strip AI tells so it reads human)
   → export as clean markdown (+ FAQ/Article JSON-LD schema)
```

**GEO principles baked in** (preserve these — they're the whole point):
- Real statistics with **cited sources** (fabricated stats are rejected by the grounding gate).
- **Answer-first** structure + an FAQ section → feeds FAQPage/Article JSON-LD schema AI engines cite.
- Grounded strictly in brand-truth — never invents product facts.
- Mandatory **humanizer** pass so drafts never read as AI-generated.
- **No keyword stuffing** (it measurably hurts AI citation).

---

## STEP 1 — Feed in the brand data + DNA (do this FIRST, before any code)

**This is the most important input.** The entire engine grounds every sentence in one object: `brand-truth.json`. Thin or wrong brand data = generic, hallucinated blogs. Rich, truthful data = sharp, on-brand, citable posts.

1. Copy `brand-truth.example.json` → `brand-truth.json`.
2. Fill **every field** with the company's real, verifiable facts — product one-liner, what it is, ICP, key facts (real features/stats/integrations/certs), differentiators, positioning, real buyer FAQs, and off-limits claims. The example file explains each field.
3. Be specific and truthful. Leave a field empty rather than inventing. A hallucination here poisons every post.

Ask the company owner for: what the product is, who buys it, the real differentiators, any real numbers/certs they can stand behind, the questions buyers actually ask, and anything they legally must NOT claim.

---

## STEP 2 — Detach from the origin project's database (your coding task)

The engine came from a project that stored brand-truth + logged costs in **Supabase**. Those hooks are the only thing between "copied files" and "runs clean." Replace them — the logic stays untouched.

**File-by-file checklist:**

1. **`src/lib/agents/core/llm-call.ts`** — the Anthropic wrapper. Imports `@/lib/supabase/admin` and calls `assertBudget`, `chargeWorkspace`, `logCall`.
   - Remove the `adminClient` import.
   - Stub `assertBudget`, `chargeWorkspace`, and the DB `logCall` to no-ops (or `console.log` for local cost visibility). Keep everything else — the Anthropic call, prompt caching, schema validation, retries.
   - Confirm `ANTHROPIC_API_KEY` is read from env.

2. **`src/lib/brand-truth.ts`** — defines the `BrandTruth` type + `getBrandTruth`/`buildBrandTruth` (which read Supabase).
   - Keep the `BrandTruth` **type/interface** as-is.
   - Replace `getBrandTruth()` with a function that reads and parses **`brand-truth.json`** from disk. Delete or stub `buildBrandTruth` (the human fills the JSON in Step 1).

3. **`src/lib/blog-pipeline.ts`** — the orchestrator. Reads brand-truth and writes results to Supabase; the origin project also seeded topics from Reddit threads.
   - Point brand-truth loading at your new JSON loader.
   - Replace the DB writes with **writing the markdown to disk** (e.g. `./output/<slug>.md`) or returning it.
   - Remove the Reddit-thread topic-seeding path; take a plain **topic string** (or a `topics.txt` list) as input instead.

4. **Anything else importing `@/lib/supabase/...`** — grep and stub/replace. There should be nothing beyond the three files above.

5. **Path alias:** `tsconfig.json` maps `@/*` → `src/*`, so internal `@/lib/...` imports resolve. Keep that.

**Definition of done:** `tsc` is clean, and one entry point works: `generateBlog(brandTruth, topic)` → returns/writes a markdown post.

---

## STEP 3 — Run it

1. `npm install`
2. Set `ANTHROPIC_API_KEY` (copy `.env.example` → `.env`).
3. Fill `brand-truth.json` (Step 1).
4. Wire a tiny CLI (`run.ts`) that loads `brand-truth.json`, takes a topic arg, calls the pipeline, and writes the markdown to `./output/`.
5. Read the output. Iterate on brand-truth if anything's off — blog quality is a direct function of brand-truth quality.

---

## Guardrails (do not remove)
- **Never fabricate stats or product facts.** The grounding gate exists for this — keep it.
- **Always run the humanizer** as the final pass.
- **Ground everything in brand-truth.** If brand-truth doesn't support a claim, the post doesn't make it.
- Keep it truthful and non-manipulative — the GEO thesis depends on genuinely useful, accurate content.

---

## File map
- `src/lib/blog-pipeline.ts` — orchestrates the full run (start here).
- `src/lib/blog-generator.ts` — research stats, draft, reground, humanize-markdown.
- `src/lib/blog-quality-gate.ts` — grounding + quality checks.
- `src/lib/blog-export.ts` — markdown + JSON-LD schema export.
- `src/lib/blog-clusters.ts` — topic clustering / internal-linking helpers.
- `src/lib/brand-truth.ts` — `BrandTruth` type + loader (rewire the loader in Step 2).
- `src/lib/humanizer.ts` — deterministic AI-tell removal (self-contained; no changes needed).
- `src/lib/agents/core/llm-call.ts` — Anthropic wrapper (stub the DB hooks in Step 2).
- `src/lib/agents/core/types.ts` — shared LLM types.

Start with Step 1, then Step 2's checklist, then Step 3. Ask the owner for brand data before writing code.
