---
name: design-rationale
description: >-
  Recover WHY code is shaped the way it is — the intent, constraints, and
  history behind a design, not its mechanics. Works like a detective: gather
  evidence from git history, PRs, and code comments first, then issue trackers,
  design docs, chat, and observability where available, and assemble a
  confidence-weighted, cited narrative that names its own gaps. TRIGGER on "why
  was this built this way", "why this approach over X", "what constraint forced
  this", edge-case/guard archaeology, or regression and postmortem
  investigation. DO NOT TRIGGER on "how does it work" mechanics (use
  code-walkthrough) or on greenfield design where there is no history to
  recover.
category: workflow
version: 1.0.0
keep-coding-instructions: true
---

# Design Rationale — Recover the "Why"

Code rarely reveals its own intent. The reason a thing exists lives in the
record around it, not in its shape. Your job is to assemble that record
honestly.

## Epistemics (the discipline)

- **Evidence before narrative.** Collect fragments first; then see what story
  they actually support. Do not start with a theory and hunt for proof.
- **Cite everything.** Every claim about intent links to a commit hash, PR,
  ticket, doc URL, chat permalink, or code comment.
- **Hedge to match confidence.** Direct evidence → state it. Inference →
  "appears to", "likely", "suggests".
- **Surface contradictions.** When evidence fits more than one story, show
  both.
- **Name the gaps.** "We could not find why" beats confident speculation.
- **Do not infer intent from code shape.** The mechanics are not the motive.

## Method

1. **Locate the target.** File paths, line ranges, symbols in question.
2. **Anchor in history.** Start with what you always have: `git log`, `git
   blame`, the introducing commit and PR, linked ticket numbers, and inline
   comments around the code.
3. **Widen to available sources.** Query the ones this environment actually
   exposes (often via MCP or provided credentials), skipping any that are
   genuinely unavailable rather than guessing they are empty:
   issue tracker (Linear/Jira), long-form docs (Notion/Confluence, RFCs,
   postmortems), chat (Slack/Discord), observability and error tracking
   (Datadog/Sentry), product analytics.
4. **Synthesize.** Combine into a confidence-weighted account, separating
   direct evidence from inference.
5. **Present** with explicit citations, hedged language, and a "Sources
   consulted" map showing which categories returned something and which
   returned nothing.

## Engine note

If your CLI engine supports parallel subagents, one investigator per source
speeds this up; Agent Hub itself does not dispatch subagents, so on engines
without that capability, investigate sequentially. The output — a patchwork of
cited evidence with honest confidence boundaries — is the same either way.

---

_Provenance: adapted from concepts in Cursor's MIT-licensed `pstack` plugin
(`why`), trimmed to drop hard MCP dependencies and subagent orchestration.
Original expression; ideas credited._
