---
name: unslop
description: >-
  Cut AI "tells" from prose so writing reads like a person wrote it. Removes
  puffery, filler, hedging, forced "not just X but Y" constructions, rule-of-
  three triads, sycophancy, decorative punctuation (em/en dashes, curly quotes,
  excess bold), and generic conclusions, then re-injects a clear point of view.
  TRIGGER when asked to edit, tighten, de-AI, humanize, or "make this sound less
  like ChatGPT"; when polishing docs, READMEs, changelogs, PR descriptions,
  commit messages, release notes, or user-facing copy; or when the user says the
  text "sounds like AI" / "sounds generic". DO NOT TRIGGER on code refactors,
  translation, summarization for machine consumption, or when the user
  explicitly wants a formal or templated tone.
category: communication
version: 1.0.0
keep-coding-instructions: true
---

# Unslop — De-slop Writing

Edit text so it reads like a person with an opinion wrote it, not a model
averaging the internet. Preserve the meaning; change the voice.

## Process

1. **Spot the tells.** Scan for the patterns below.
2. **Rewrite in place.** Keep the author's meaning and register; swap the
   artificial phrasing for plain speech.
3. **Add a point of view.** React to the facts instead of neutrally listing
   pros and cons. Vary sentence length. Let structure be a little imperfect.
4. **Audit.** Re-read once more only for remaining tells. Stop when it sounds
   like a person, not when it sounds "polished".

## Tells to cut

**Puffery and promo.** "pivotal", "stands as a testament to", "plays a vital
role", "rich tapestry", "in the ever-evolving landscape", "unlock", "elevate",
"seamless", "robust". Cut the adjective or name the concrete thing.

**Forced structure.** "not just X, but Y". Rule-of-three triads where two items
would do. "It's not about X, it's about Y". Parallel-clause padding. Say the one
thing you mean.

**Filler and hedging.** "It's important to note that", "It's worth mentioning",
"When it comes to", "In today's fast-paced world", "At the end of the day",
"That being said". Delete; start at the noun or verb that carries the point.

**Sycophancy.** "Great question!", "You're absolutely right", "Excellent
point". Drop the flattery and answer.

**Vague attribution.** "studies show", "experts agree", "it is widely believed".
Cite the specific source or drop the claim.

**Weak verbs.** "serves as", "functions as", "acts as", "is designed to" for a
plain "is" or a strong verb. "utilize" → "use". Verb + adverb ("quickly
improved") → one strong verb ("sped up").

**Passive voice** where an actor exists. "mistakes were made" → name who.

**Generic conclusions.** "In conclusion", "Overall", "In summary" followed by a
restatement. End on the last real point.

**Decorative punctuation.** Em/en dashes used as all-purpose connectors, colons
in titles ("X: A Deep Dive"), curly quotes, excess **bold**, Title Case
Headings, decorative emoji. Prefer a period, a comma, or a new sentence.

## Plain-speech defaults

- Concrete mechanism over abstract feeling.
- Shorter sentences. One idea each.
- Active voice, named actors.
- Strong verbs over adverbs; plain words over thesaurus reaches.
- Specific over generic ("dropped 40ms off the p95" over "improved
  performance").

---

_Provenance: adapted from concepts in Cursor's MIT-licensed `pstack` plugin
(`unslop`). Original expression; ideas credited._
