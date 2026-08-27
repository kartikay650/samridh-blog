// Shared post-processing for any AI-generated text destined for Reddit.
// Acts as a safety net AFTER the skill file instructions.
// Two jobs: (1) strip AI patterns, (2) inject human voice characteristics.
// Used by reply generator and post generator.

export function humanizeText(input: string): string {
  let text = input

  // -------------------------------------------------------------------------
  // PASS 1 — CURLY QUOTES AND UNICODE PUNCTUATION
  // Do this first so later regex patterns work on clean ASCII
  // -------------------------------------------------------------------------

  // Curly double quotes → straight quotes
  text = text.replace(/[\u201C\u201D]/g, '"')
  // Curly single quotes / apostrophes → straight
  text = text.replace(/[\u2018\u2019]/g, "'")
  // Ellipsis character → three dots
  text = text.replace(/\u2026/g, '...')

  // -------------------------------------------------------------------------
  // PASS 2 — DASHES
  // Em and en dashes are the single biggest AI tell
  // -------------------------------------------------------------------------

  text = text.replace(/\s*—\s*/g, ', ')
  text = text.replace(/\s*–\s*/g, ', ')
  text = text.replace(/--/g, ', ')

  // -------------------------------------------------------------------------
  // PASS 3 — BANNED OPENING PHRASES
  // Strip from start of text. These are instant AI detection.
  // -------------------------------------------------------------------------

  const bannedOpenings = [
    /^[Gg]reat question[!.]?\s*/,
    /^[Tt]hat['']s a really good point[!.]?\s*/,
    /^[Ii] totally understand where you['']re coming from[!.]?\s*/,
    /^[Ii] hear you[!.]?\s*/,
    /^[Aa]bsolutely[!.]?\s*/,
    /^[Cc]ertainly[!.]?\s*/,
    /^[Oo]f course[!.]?\s*/,
    /^[Tt]his resonates with me[!.]?\s*/,
    /^[Tt]hanks for sharing this[!.]?\s*/,
    /^[Ll]ove this post[!.]?\s*/,
    /^[Aa]s someone who\s*/,
    /^[Ii]['']ve been in your shoes[!.]?\s*/,
    /^[Ss]o here['']s the thing[!,.]?\s*/,
    /^[Ll]et me share my perspective[!.]?\s*/,
    /^[Ii] think you['']re onto something[!.]?\s*/,
    /^[Tt]his is such an important topic[!.]?\s*/,
    /^[Ii] couldn['']t agree more[!.]?\s*/,
    /^[Hh]ere['']s my take[!:.]?\s*/,
    /^[Ww]hat a great discussion[!.]?\s*/,
    /^[Ll]et me share my thoughts[!.]?\s*/,
    /^[Ii] think the key insight is[!:.]?\s*/,
    /^[Yy]ou['']re absolutely right[!.]?\s*/,
    /^[Tt]hat['']s an excellent point[!.]?\s*/,
  ]
  for (const pattern of bannedOpenings) {
    text = text.replace(pattern, '')
  }

  // -------------------------------------------------------------------------
  // PASS 4 — BANNED CLOSING PHRASES
  // Strip from end of text. Nobody on Reddit says these.
  // -------------------------------------------------------------------------

  const bannedClosings = [
    /[Hh]ope this helps[!.]?\s*$/,
    /[Ff]eel free to reach out[!.]?\s*$/,
    /[Ll]et me know if you have any questions[!.]?\s*$/,
    /[Hh]appy to chat more about this[!.]?\s*$/,
    /[Hh]appy to help[!.]?\s*$/,
    /[Dd][Mm] me if you want to know more[!.]?\s*$/,
    /[Bb]est of luck[!.]?\s*$/,
    /[Ww]ishing you all the best[!.]?\s*$/,
    /[Ii]['']d love to hear how it goes[!.]?\s*$/,
    /[Kk]eep us posted[!.]?\s*$/,
    /[Gg]ood luck with everything[!.]?\s*$/,
    /[Ee]xciting times ahead[!.]?\s*$/,
    /[Tt]he future looks bright[!.]?\s*$/,
    /[Ll]et me know your thoughts[!.]?\s*$/,
    /[Dd]on['']t hesitate to reach out[!.]?\s*$/,
    /[Ll]et me know if you['']d like me to expand[^.]*[!.]?\s*$/,
    /[Ww]ould you like me to[^.]*[?]?\s*$/,
    /[Hh]appy to answer any[^.]*[!.]?\s*$/,
  ]
  for (const pattern of bannedClosings) {
    text = text.replace(pattern, '')
  }

  // -------------------------------------------------------------------------
  // PASS 4.3 — STARTUP / AI CLICHÉS (deterministic, guaranteed removal)
  // The LLM humanizer misses these inconsistently and production runs no judge,
  // so replace them with plain equivalents here. Ordered longest-first.
  // -------------------------------------------------------------------------

  const cliches: [RegExp, string][] = [
    [/\bmoved the needle\b/gi, 'made a difference'],
    [/\bmove the needle\b/gi, 'make a difference'],
    [/\bmoving the needle\b/gi, 'making a difference'],
    [/\bclos(e|ed|ing) (that|the) gap\b/gi, 'get past that'],
    [/\bhit(ting)? a wall\b/gi, 'got stuck'],
    [/\bleaving (money|something|cash) on the table\b/gi, 'missing something'],
    [/\bat the end of the day,?\s*/gi, ''],
    [/\bthe real question is,?\s*/gi, ''],
    [/\bhere'?s the thing,?\s*/gi, ''],
    [/\bgame[-\s]?changer\b/gi, 'big deal'],
    [/\bdouble down\b/gi, 'focus harder'],
    [/\blow[-\s]hanging fruit\b/gi, 'easy wins'],
    [/\btable stakes\b/gi, 'the basics'],
    [/\bget past the first wall\b/gi, 'get the first few'],
  ]
  for (const [re, repl] of cliches) {
    text = text.replace(re, repl)
  }
  // Tidy double spaces left by removals (keep lowercase — it's intentional).
  text = text.replace(/ {2,}/g, ' ').replace(/\s+([.,!?])/g, '$1')

  // -------------------------------------------------------------------------
  // PASS 4.4 — LABEL HEADERS + META-COMMENTARY
  // Real Reddit comments don't start sentences with archetype labels and
  // don't narrate the act of reading the thread. Both are AI tells.
  // -------------------------------------------------------------------------

  // Strip archetype labels at start of line/sentence:
  //   "Caveat: ..."   "Hot take: ..."   "Quick thought: ..."   "Background: ..."
  //   "TL;DR: ..."    "TLDR: ..."       "Note: ..."           "Edit: ..."
  //   "The thing is, ..."
  // (Edit: is sometimes legit when a user actually edits — but at start of a fresh draft it's an AI tell)
  text = text.replace(/(^|\n|\.\s+|\?\s+|!\s+)(Caveat|Hot take|Quick thought|Background|TL;DR|TLDR|Edit|Note|The thing is|Important note|Key point|Main point|Summary|My take|Hot tip|Pro tip):\s+/gi, '$1')

  // Strip meta-commentary about reading the thread.
  // "Most people in this thread are saying X" / "Most of the people in this thread..." / "Reading through the replies"
  // / "I noticed the top comment" / "Looking at the other replies"
  text = text.replace(/\b(Most|Many|Lots) (?:of (?:the )?(?:people|users|comments|you|us)|people|comments|users) (?:here|in|on) (?:in )?this thread[^.!?]*?(?:saying|claiming|suggesting|recommending|arguing|pointing out|noting)[^.!?]*[.!?]\s*/gi, '')
  text = text.replace(/\b(?:Most|Many) (?:people|users|of you|comments) (?:here|in this thread)[^.!?]*[.!?]\s*/gi, '')
  text = text.replace(/\b(?:Reading|Scrolling|Looking) (?:through|at|over) (?:the|these|all the|other) (?:replies|comments|responses)[^.!?]*[.!?]\s*/gi, '')
  text = text.replace(/\bI noticed (?:the|that the) (?:top|first|previous|earlier) comment[^.!?]*[.!?]\s*/gi, '')
  text = text.replace(/\bI see (?:a lot of|many|several|some) (?:replies|comments|people) (?:here )?(?:saying|suggesting|recommending)[^.!?]*[.!?]\s*/gi, '')
  text = text.replace(/\b(?:What|Something) I (?:notice|see) (?:in this thread|here) is[^.!?]*[.!?]\s*/gi, '')

  // -------------------------------------------------------------------------
  // PASS 4.5 — ACADEMIC / CLINICAL VOCABULARY
  // Words a tired person on Reddit never types. Strip or downgrade them.
  // Added because the V2 reply drafter was producing "phospholipid cofactors"
  // and "intracellular transport" — sounds like a science paper, not Reddit.
  // -------------------------------------------------------------------------

  // bioavailability → absorption
  text = text.replace(/\bbioavailab(?:le|ility)\b/gi, (m) => /lity$/i.test(m) ? 'absorption' : 'absorbable')

  // intracellular / extracellular / cellular → drop the prefix, just "cells"
  text = text.replace(/\bintracellular\s+/gi, '')
  text = text.replace(/\bextracellular\s+/gi, '')
  text = text.replace(/\bcellular\s+(uptake|absorption|transport|hydration|level)/gi, '$1')

  // mechanism / mechanistic / physiological → drop or "reason"
  text = text.replace(/\bthe (?:underlying )?mechanism (?:is|here is)\b/gi, 'the reason is')
  text = text.replace(/\bphysiologically?\b/gi, '')
  text = text.replace(/\bphysiological\s+/gi, '')
  text = text.replace(/\bmechanistic(?:ally)?\b/gi, '')

  // cofactor / cofactors → drop entirely
  text = text.replace(/\bco-?factors?\b/gi, '')

  // optimally / fundamentally / essentially / meaningfully → drop
  text = text.replace(/\boptimally\b/gi, '')
  text = text.replace(/\bfundamentally\b/gi, '')
  text = text.replace(/\bessentially\b/gi, '')
  text = text.replace(/\bmeaningfully\b/gi, '')
  text = text.replace(/\bsystematically\b/gi, '')
  text = text.replace(/\bsignificantly\b/gi, 'a lot')

  // "Tested rigorously" / "evidence suggests" / "the data shows" → drop
  text = text.replace(/\b(?:tested|examined) rigorously\b/gi, 'tested')
  text = text.replace(/\bevidence (?:strongly )?suggests\s+/gi, '')
  text = text.replace(/\bthe data shows\s+/gi, '')
  text = text.replace(/\bresearch (?:has )?(?:shown|demonstrated) that\s+/gi, '')

  // STUDY CITATIONS — strip "A 2020 review in Nutrients found..." style
  // (real Redditors say "saw a study somewhere", they don't cite year+journal)
  text = text.replace(/\bA \d{4} (?:review|study|paper|meta-analysis) (?:in|published in) [A-Z][a-zA-Z ]+? (?:found|showed|demonstrated|reported)\s+/g, '')
  text = text.replace(/\bAccording to a \d{4} (?:study|review|paper)[^.]*\.\s*/g, '')

  // "OP correctly identifies / catches / nails" — formal observer voice
  text = text.replace(/\bOP (?:correctly )?(?:identifies|catches|notes|recognizes|points out)\b/gi, 'OP nails')
  text = text.replace(/\bwhich is the right call\b/gi, '')
  text = text.replace(/\bthe right call\b/gi, 'smart')

  // "regardless of what you use" — formal hedge
  text = text.replace(/,?\s*regardless of what you use\b/gi, '')
  text = text.replace(/\bregardless of\s+/gi, 'no matter ')

  // "the mechanism is real" / "the difference is real" — AI tells
  text = text.replace(/\bthe (?:mechanism|effect|difference) is real\s*\.?/gi, '')

  // -------------------------------------------------------------------------
  // PASS 4.6 — FORMAL DISCLOSURE PATTERNS
  // Replace press-release disclosure with casual parenthetical.
  // "Disclosure: I founded XYZ Wellness - Daily Cellular Hydration Mix"
  //   → "(fwiw I run a brand in this space)"
  // -------------------------------------------------------------------------

  // Demote formal "Disclosure:" prefix to casual "fwiw" — drafter prompt
  // already heavily favors casual phrasing, so this is a light safety net.
  // Use a lowercase replacement; we'll let it stay mid-sentence as "fwiw".
  text = text.replace(/(^|\.\s+|\?\s+|!\s+)Disclosure:\s*I\s+/g, '$1fwiw i ')
  text = text.replace(/(^|\.\s+|\?\s+|!\s+)Full disclosure:\s*I\s+/g, '$1fwiw i ')
  text = text.replace(/\bDisclosure:\s*I\s+/g, 'fwiw i ')
  text = text.replace(/\bFull disclosure:\s*I\s+/g, 'fwiw i ')

  // Strip the trailing formal product label pattern that looks like a press
  // release: "ProductName - Long Tagline With Capitalized Words". When seen
  // right after "I founded/built/run X", trim the dash-tagline portion.
  text = text.replace(/\b(I (?:founded|built|run|created|made)\s+[A-Z]\w+)\s+[-–—]\s+[A-Z][^.,]+/g, '$1')

  // -------------------------------------------------------------------------
  // PASS 5 — FILLER LEAD-INS
  // Remove entire phrases that add nothing
  // -------------------------------------------------------------------------

  text = text.replace(/[Ii]n today's [a-z]+ landscape,?\s*/g, '')
  text = text.replace(/[Ii]n today's world,?\s*/g, '')
  text = text.replace(/[Ii]t['']s important to note that\s*/g, '')
  text = text.replace(/[Ii]t['']s worth noting that\s*/g, '')
  text = text.replace(/[Ii]t['']s worth mentioning that\s*/g, '')
  text = text.replace(/[Nn]eedless to say,?\s*/g, '')
  text = text.replace(/[Ii]t goes without saying(?: that)?,?\s*/g, '')
  text = text.replace(/[Aa]t the end of the day,?\s*/g, '')
  text = text.replace(/[Aa]t its core,?\s*/g, '')
  text = text.replace(/[Ii]n order to\b/gi, 'to')
  text = text.replace(/\bwhen it comes to\b/gi, 'with')
  text = text.replace(/\bin terms of\b/gi, 'for')
  text = text.replace(/\bdue to the fact that\b/gi, 'because')
  text = text.replace(/\bat this point in time\b/gi, 'now')
  text = text.replace(/\bhas the ability to\b/gi, 'can')
  text = text.replace(/\bin the event that\b/gi, 'if')
  text = text.replace(/\bprior to\b/gi, 'before')
  text = text.replace(/\bsubsequent to\b/gi, 'after')

  // -------------------------------------------------------------------------
  // PASS 6 — COPULA AVOIDANCE
  // AI substitutes elaborate constructions for simple "is/are/has"
  // "serves as" → "is", "boasts" → "has", etc.
  // -------------------------------------------------------------------------

  text = text.replace(/\bserves as\b/gi, 'is')
  text = text.replace(/\bfunctions as\b/gi, 'is')
  text = text.replace(/\bstands as\b/gi, 'is')
  text = text.replace(/\bacts as\b/gi, 'is')
  text = text.replace(/\bmarks a\b/gi, 'is a')
  text = text.replace(/\brepresents a\b/gi, 'is a')
  text = text.replace(/\bboasts\b/gi, 'has')
  text = text.replace(/\bfeatures\b/gi, 'has')

  // -------------------------------------------------------------------------
  // PASS 7 — AI VOCABULARY SWAPS
  // Direct word replacements that preserve meaning
  // -------------------------------------------------------------------------

  // utilize → use
  text = text.replace(/\butilize[sd]?\b/gi, (m) => {
    const l = m.toLowerCase()
    if (l === 'utilized') return 'used'
    if (l === 'utilizes') return 'uses'
    return 'use'
  })

  // leverage → use (verb form only — noun "leverage" stays)
  text = text.replace(/\bleveraged\b/gi, 'used')
  text = text.replace(/\bleverages\b/gi, 'uses')

  // streamline → simplify
  text = text.replace(/\bstreamlines?\b/gi, (m) => m.toLowerCase().endsWith('s') ? 'simplifies' : 'simplify')
  text = text.replace(/\bstreamlined\b/gi, 'simplified')
  text = text.replace(/\bstreamlining\b/gi, 'simplifying')

  // robust → solid
  text = text.replace(/\brobust\b/gi, 'solid')

  // seamless / seamlessly → smooth / smoothly
  text = text.replace(/\bseamlessly\b/gi, 'smoothly')
  text = text.replace(/\bseamless\b/gi, 'smooth')

  // comprehensive → complete
  text = text.replace(/\bcomprehensive\b/gi, 'complete')

  // innovative → new
  text = text.replace(/\binnovative\b/gi, 'new')

  // empower → help
  text = text.replace(/\bempowered\b/gi, 'helped')
  text = text.replace(/\bempowers\b/gi, 'helps')
  text = text.replace(/\bempower\b/gi, 'help')

  // delve → dig
  text = text.replace(/\bdelve[sd]?\s*(?:into|in)?\b/gi, 'dig into')

  // foster → build
  text = text.replace(/\bfoster[sed]*\b/gi, 'build')

  // elevate → improve
  text = text.replace(/\belevated?\b/gi, 'improved')
  text = text.replace(/\belevates\b/gi, 'improves')
  text = text.replace(/\belevating\b/gi, 'improving')

  // game-changer / game changer → drop word entirely
  text = text.replace(/\bgame[- ]?changer\b/gi, '')

  // groundbreaking → drop
  text = text.replace(/\bgroundbreaking\b/gi, '')

  // cutting-edge / cutting edge → modern
  text = text.replace(/\bcutting[- ]?edge\b/gi, 'modern')

  // revolutionary → drop
  text = text.replace(/\brevolutionary\b/gi, '')

  // transformative → impactful
  text = text.replace(/\btransformative\b/gi, 'impactful')

  // pivotal → key
  text = text.replace(/\bpivotal\b/gi, 'key')

  // holistic → complete
  text = text.replace(/\bholistic\b/gi, 'complete')

  // synergy / synergies → drop
  text = text.replace(/\bsynerg(?:y|ies)\b/gi, '')

  // paradigm → model
  text = text.replace(/\bparadigm\b/gi, 'model')

  // harness → use
  text = text.replace(/\bharnessed?\b/gi, 'used')
  text = text.replace(/\bharnesses\b/gi, 'uses')
  text = text.replace(/\bharnessing\b/gi, 'using')

  // supercharge → boost
  text = text.replace(/\bsupercharged?\b/gi, 'boost')

  // unlock → open up
  text = text.replace(/\bunlock(?:ed|s|ing)?\b/gi, 'open up')

  // reimagine → rethink
  text = text.replace(/\breimagined?\b/gi, 'rethink')

  // nuanced → subtle
  text = text.replace(/\bnuanced\b/gi, 'subtle')

  // multifaceted → complex
  text = text.replace(/\bmultifaceted\b/gi, 'complex')

  // landscape (abstract) → space / area
  text = text.replace(/\blandscape\b/gi, 'space')

  // ecosystem (abstract) → space
  text = text.replace(/\becosystem\b/gi, 'space')

  // vibrant → active
  text = text.replace(/\bvibrant\b/gi, 'active')

  // crucial → important (then let writers decide if even that's needed)
  text = text.replace(/\bcrucial\b/gi, 'important')

  // key (as adjective meaning crucial) — too hard to automate safely, leave

  // testament → proof
  text = text.replace(/\btestament\b/gi, 'proof')

  // underscore (verb) → show
  text = text.replace(/\bunderscores?\b/gi, 'shows')
  text = text.replace(/\bunderscored\b/gi, 'showed')

  // highlight (verb) → show
  text = text.replace(/\bhighlights?\b/gi, 'shows')
  text = text.replace(/\bhighlighted\b/gi, 'showed')

  // showcase → show
  text = text.replace(/\bshowcases?\b/gi, 'shows')
  text = text.replace(/\bshowcased\b/gi, 'showed')

  // additionally → also
  text = text.replace(/\bAdditionally,?\s*/g, 'Also, ')
  text = text.replace(/\badditionally,?\s*/g, 'also ')

  // Furthermore → Also
  text = text.replace(/\bFurthermore,?\s*/g, 'Also, ')
  text = text.replace(/\bfurthermore,?\s*/g, 'also ')

  // Moreover → Also
  text = text.replace(/\bMoreover,?\s*/g, 'Also, ')
  text = text.replace(/\bmoreover,?\s*/g, 'also ')

  // I'm excited / thrilled / proud to → strip
  text = text.replace(/[Ii]['']m (?:excited|thrilled|proud) to\s*/g, '')
  text = text.replace(/[Ii]['']m passionate about\s*/g, '')

  // -------------------------------------------------------------------------
  // PASS 8 — SUPERFICIAL -ING ENDINGS
  // Tacked-on participle phrases that add fake depth
  // Strip the entire participial phrase when it starts a new clause
  // -------------------------------------------------------------------------

  text = text.replace(/,\s*(?:thereby\s+)?highlighting\s+[^.!?]*/gi, '')
  text = text.replace(/,\s*(?:thereby\s+)?underscoring\s+[^.!?]*/gi, '')
  text = text.replace(/,\s*(?:thereby\s+)?emphasizing\s+[^.!?]*/gi, '')
  text = text.replace(/,\s*(?:thereby\s+)?showcasing\s+[^.!?]*/gi, '')
  text = text.replace(/,\s*(?:thereby\s+)?reflecting\s+[^.!?]*/gi, '')
  text = text.replace(/,\s*(?:thereby\s+)?symbolizing\s+[^.!?]*/gi, '')
  text = text.replace(/,\s*(?:thereby\s+)?contributing to\s+[^.!?]*/gi, '')
  text = text.replace(/,\s*(?:thereby\s+)?cultivating\s+[^.!?]*/gi, '')
  text = text.replace(/,\s*(?:thereby\s+)?fostering\s+[^.!?]*/gi, '')
  text = text.replace(/,\s*(?:thereby\s+)?ensuring\s+[^.!?]*/gi, '')
  text = text.replace(/,\s*(?:thereby\s+)?encompassing\s+[^.!?]*/gi, '')

  // -------------------------------------------------------------------------
  // PASS 9 — NEGATIVE PARALLELISMS
  // "It's not just X, it's Y" — dead AI giveaway
  // -------------------------------------------------------------------------

  text = text.replace(/[Ii]t['']s not just (?:about )?([^,;.]+),\s*it['']s ([^.!?]+)/g, '$2')
  text = text.replace(/[Ii]t['']s not merely ([^,;.]+),\s*it['']s ([^.!?]+)/g, '$2')
  text = text.replace(/[Nn]ot only ([^,;.]+),\s*but (?:also )?([^.!?]+)/g, '$1 and $2')

  // -------------------------------------------------------------------------
  // PASS 10 — VAGUE ATTRIBUTIONS
  // Replace with nothing — better to have no attribution than a fake one
  // -------------------------------------------------------------------------

  text = text.replace(/[Ee]xperts (?:argue|say|suggest|believe|note) that\s*/g, '')
  text = text.replace(/[Ii]ndustry (?:observers|analysts|experts) (?:note|say|have noted) that\s*/g, '')
  text = text.replace(/[Ss]ome (?:critics|observers|experts) argue that\s*/g, '')
  text = text.replace(/[Aa]ccording to (?:industry reports|various sources|some sources),?\s*/g, '')
  text = text.replace(/[Rr]esearch (?:shows|suggests|indicates) that\s*/g, '')
  text = text.replace(/[Ss]tudies (?:show|suggest|indicate) that\s*/g, '')

  // -------------------------------------------------------------------------
  // PASS 11 — HYPHENATED COMPOUND WORDS
  // AI hyphenates these with perfect consistency — humans don't
  // -------------------------------------------------------------------------

  const hyphenatedCompounds: [RegExp, string][] = [
    [/\bdata-driven\b/gi, 'data driven'],
    [/\bcross-functional\b/gi, 'cross functional'],
    [/\bclient-facing\b/gi, 'client facing'],
    [/\bdecision-making\b/gi, 'decision making'],
    [/\bwell-known\b/gi, 'well known'],
    [/\bhigh-quality\b/gi, 'high quality'],
    [/\breal-time\b/gi, 'real time'],
    [/\blong-term\b/gi, 'long term'],
    [/\bend-to-end\b/gi, 'end to end'],
    [/\bgoal-oriented\b/gi, 'goal oriented'],
    [/\bresult-driven\b/gi, 'result driven'],
    [/\bvalue-driven\b/gi, 'value driven'],
    [/\bforward-thinking\b/gi, 'forward thinking'],
    [/\bbest-in-class\b/gi, 'best in class'],
    [/\bstate-of-the-art\b/gi, 'state of the art'],
    [/\bworld-class\b/gi, 'world class'],
    [/\bright-fit\b/gi, 'right fit'],
  ]
  for (const [pattern, replacement] of hyphenatedCompounds) {
    text = text.replace(pattern, replacement)
  }

  // -------------------------------------------------------------------------
  // PASS 12 — BOLDFACE AND FORMATTING
  // Strip markdown bold/italic that slips through
  // -------------------------------------------------------------------------

  // Remove bold: **text** → text
  text = text.replace(/\*\*([^*]+)\*\*/g, '$1')
  // Remove italic: *text* → text
  text = text.replace(/\*([^*]+)\*/g, '$1')
  // Remove inline code in reply context: `text` → text
  text = text.replace(/`([^`]+)`/g, '$1')

  // -------------------------------------------------------------------------
  // PASS 13 — SEMICOLONS
  // Banned in casual Reddit writing — replace with period or comma
  // -------------------------------------------------------------------------

  // Semicolons between two independent clauses → period + capitalize
  text = text.replace(/;\s*([a-z])/g, (_, letter) => '. ' + letter.toUpperCase())
  // Semicolons before conjunctions
  text = text.replace(/;\s*(however|therefore|moreover|furthermore|additionally)/gi,
    (_, conj) => '. ' + conj.charAt(0).toUpperCase() + conj.slice(1))

  // -------------------------------------------------------------------------
  // PASS 14 — GENERIC POSITIVE CONCLUSIONS
  // Vague upbeat endings that mean nothing
  // -------------------------------------------------------------------------

  text = text.replace(/[Tt]he future looks bright[^.]*\./g, '')
  text = text.replace(/[Ee]xciting times (?:lie |are )ahead[^.]*\./g, '')
  text = text.replace(/[Tt]his represents a (?:major )?step in the right direction[^.]*\./g, '')
  text = text.replace(/[Ww]e['']re just getting started[^.]*\./g, '')
  text = text.replace(/[Tt]he best is yet to come[^.]*\./g, '')
  text = text.replace(/[Oo]nly time will tell[^.]*\./g, '')

  // -------------------------------------------------------------------------
  // PASS 15 — EXCESSIVE HEDGING
  // Hedge stacking makes everything sound uncertain and corporate
  // -------------------------------------------------------------------------

  text = text.replace(/\bcould potentially possibly\b/gi, 'might')
  text = text.replace(/\bit could be argued that\b/gi, '')
  text = text.replace(/\bsome might say that\b/gi, '')
  text = text.replace(/\bit might potentially\b/gi, 'it might')
  text = text.replace(/\bmight potentially\b/gi, 'might')
  text = text.replace(/\bcould potentially\b/gi, 'could')

  // -------------------------------------------------------------------------
  // PASS 16 — KNOWLEDGE CUTOFF DISCLAIMERS
  // AI tells that leak into generated content
  // -------------------------------------------------------------------------

  text = text.replace(/[Aa]s of my (?:last )?(?:training|knowledge)[^,.]*, /g, '')
  text = text.replace(/[Ww]hile specific details (?:are|may be) (?:limited|scarce)[^,.]*, /g, '')
  text = text.replace(/[Bb]ased on available information,?\s*/g, '')
  text = text.replace(/[Uu]p to my (?:last )?(?:training|knowledge) update,?\s*/g, '')

  // -------------------------------------------------------------------------
  // PASS 17 — CLEANUP
  // Fix artifacts left by previous passes
  // -------------------------------------------------------------------------

  // Collapse multiple spaces
  text = text.replace(/\s{2,}/g, ' ')
  // Fix orphaned punctuation from removals
  text = text.replace(/,\s*,/g, ',')
  text = text.replace(/\.\s*,/g, '.')
  text = text.replace(/,\s*\./g, '.')
  text = text.replace(/\s+([.,!?])/g, '$1')
  // Fix double periods
  text = text.replace(/\.{2,}/g, '.')
  // Fix sentences that now start with lowercase after removal
  text = text.replace(/\.\s+([a-z])/g, (_, letter) => '. ' + letter.toUpperCase())
  // Remove leading comma or period if opening phrase was stripped
  text = text.replace(/^[,.\s]+/, '')
  // Fix "Also, also" duplicates from our replacements
  text = text.replace(/\b[Aa]lso,?\s+also\b/gi, 'also')

  return text.trim()
}
