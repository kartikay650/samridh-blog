# samridh-blog

A GEO-optimized blog-generation engine. Feed it your company's **brand-truth** + a **topic**, and it produces a publish-ready, AI-citable markdown post (grounded stats with sources, answer-first structure, FAQ/Article JSON-LD schema, and a humanizer pass so it doesn't read as AI).

## Start here
👉 **Open `CLAUDE.md`** and point Claude Code at it. It's the full setup guide:
1. **Fill in your brand data** — copy `brand-truth.example.json` → `brand-truth.json` and complete it (this is the most important input; everything is grounded in it).
2. **Detach from the origin project's database** — a short, file-by-file checklist (swap the Supabase brand-truth loader for the JSON file; stub the cost-logging hooks).
3. **Run it** — `ANTHROPIC_API_KEY`, then generate posts from a topic.

## Quick start
```bash
npm install
cp .env.example .env        # add ANTHROPIC_API_KEY
cp brand-truth.example.json brand-truth.json   # fill with your company's facts
# then follow CLAUDE.md STEP 2 to wire it up, and:
npm run generate -- "your topic here"
```

Don't rewrite the logic — adapt the edges. See `CLAUDE.md`.
