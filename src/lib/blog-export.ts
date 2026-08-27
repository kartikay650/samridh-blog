// Blog export — client-safe pure functions. Turns a generated draft into
// artifacts the founder pastes into their own site (Shopify / WordPress / etc.):
//   - markdown with frontmatter (mirrors trybeetle.com's content/blog schema)
//   - standalone HTML with Article + FAQPage JSON-LD (the GEO-critical schema)
//
// No deps: a minimal, safe markdown→HTML converter (headings, lists, bold,
// links, inline code, paragraphs) — enough for a review draft, not a full engine.

export interface ExportableDraft {
  slug: string
  title: string
  description: string
  tldr: string
  body_md: string
  faq: Array<{ q: string; a: string }>
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function inlineMd(s: string): string {
  // escape first, then apply inline markdown to the escaped text
  let out = esc(s)
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>')
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>')
  return out
}

/** Minimal markdown → HTML. Handles h2/h3, ul/ol, blockquote, paragraphs, inline. */
export function markdownToHtml(md: string): string {
  const lines = md.split('\n')
  const html: string[] = []
  let listType: 'ul' | 'ol' | null = null
  let para: string[] = []

  const flushPara = () => {
    if (para.length) { html.push(`<p>${inlineMd(para.join(' '))}</p>`); para = [] }
  }
  const closeList = () => { if (listType) { html.push(`</${listType}>`); listType = null } }

  for (const raw of lines) {
    const line = raw.trimEnd()
    if (!line.trim()) { flushPara(); closeList(); continue }

    const h = line.match(/^(#{2,3})\s+(.*)$/)
    if (h) { flushPara(); closeList(); const tag = h[1].length === 2 ? 'h2' : 'h3'; html.push(`<${tag}>${inlineMd(h[2])}</${tag}>`); continue }

    const ul = line.match(/^[-*]\s+(.*)$/)
    const ol = line.match(/^\d+\.\s+(.*)$/)
    if (ul || ol) {
      flushPara()
      const want = ul ? 'ul' : 'ol'
      if (listType !== want) { closeList(); html.push(`<${want}>`); listType = want }
      html.push(`<li>${inlineMd((ul ? ul[1] : ol![1]))}</li>`)
      continue
    }

    const bq = line.match(/^>\s?(.*)$/)
    if (bq) { flushPara(); closeList(); html.push(`<blockquote>${inlineMd(bq[1])}</blockquote>`); continue }

    para.push(line)
  }
  flushPara(); closeList()
  return html.join('\n')
}

export function toMarkdown(draft: ExportableDraft, author: string, dateISO: string): string {
  const date = dateISO.slice(0, 10)
  const yamlStr = (s: string) => `"${s.replace(/"/g, '\\"')}"`
  const faqYaml = draft.faq.map((f) => `  - q: ${yamlStr(f.q)}\n    a: ${yamlStr(f.a)}`).join('\n')
  return `---
title: ${yamlStr(draft.title)}
description: ${yamlStr(draft.description)}
date: "${date}"
updated: "${date}"
author: ${yamlStr(author)}
slug: "${draft.slug}"
tldr: ${yamlStr(draft.tldr)}
faq:
${faqYaml}
---

${draft.body_md}
`
}

export function toJsonLd(draft: ExportableDraft, author: string, dateISO: string): object {
  const date = dateISO.slice(0, 10)
  const article = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: draft.title,
    description: draft.description,
    author: { '@type': 'Organization', name: author },
    datePublished: date,
    dateModified: date,
  }
  const faqPage = draft.faq.length
    ? {
        '@context': 'https://schema.org',
        '@type': 'FAQPage',
        mainEntity: draft.faq.map((f) => ({
          '@type': 'Question',
          name: f.q,
          acceptedAnswer: { '@type': 'Answer', text: f.a },
        })),
      }
    : null
  return faqPage ? { article, faqPage } : { article }
}

export function toHtml(draft: ExportableDraft, author: string, dateISO: string): string {
  const bodyHtml = markdownToHtml(draft.body_md)
  const jsonld = toJsonLd(draft, author, dateISO) as { article: object; faqPage?: object }
  const faqHtml = draft.faq.length
    ? `\n<section>\n<h2>Frequently asked questions</h2>\n${draft.faq
        .map((f) => `<h3>${esc(f.q)}</h3>\n<p>${esc(f.a)}</p>`)
        .join('\n')}\n</section>`
    : ''
  const scripts = [jsonld.article, jsonld.faqPage]
    .filter(Boolean)
    .map((obj) => `<script type="application/ld+json">\n${JSON.stringify(obj, null, 2)}\n</script>`)
    .join('\n')

  return `<!-- Paste into your site's HTML editor. JSON-LD included for AI/SEO citation. -->
<article>
<h1>${esc(draft.title)}</h1>
<p><em>${esc(draft.tldr)}</em></p>
${bodyHtml}${faqHtml}
</article>
${scripts}
`
}

/**
 * Body HTML for a Shopify article: markdown body + FAQ section + Article/FAQPage
 * JSON-LD. No <h1> (Shopify renders the title separately) and no tldr block (the
 * body already opens answer-first). Published via the API, which preserves the
 * <script> JSON-LD that the Shopify admin editor would strip.
 */
export function toShopifyBody(draft: ExportableDraft, author: string, dateISO: string): string {
  const bodyHtml = markdownToHtml(draft.body_md)
  const jsonld = toJsonLd(draft, author, dateISO) as { article: object; faqPage?: object }
  const faqHtml = draft.faq.length
    ? `\n<section>\n<h2>Frequently asked questions</h2>\n${draft.faq
        .map((f) => `<h3>${esc(f.q)}</h3>\n<p>${esc(f.a)}</p>`)
        .join('\n')}\n</section>`
    : ''
  const scripts = [jsonld.article, jsonld.faqPage]
    .filter(Boolean)
    .map((obj) => `<script type="application/ld+json">\n${JSON.stringify(obj)}\n</script>`)
    .join('\n')
  return `${bodyHtml}${faqHtml}\n${scripts}`
}

export function download(filename: string, content: string, mime = 'text/plain') {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
