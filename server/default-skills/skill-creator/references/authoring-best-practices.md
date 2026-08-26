# Skill Authoring — Best Practices & Reference

Depth material for the `skill-creator` coach. Read this when you need the exact
frontmatter contract, the rationale behind a rule, or a skeleton to start from.

## Why these rules exist

A skill is not documentation a human reads top to bottom. It is **context
injected into a model**, gated by progressive disclosure:

| Level    | What loads                           | When                      |
| -------- | ------------------------------------ | ------------------------- |
| Metadata | `name` + `description` (~60 tokens)  | always in context         |
| Body     | the full `SKILL.md` instructions     | when the skill triggers   |
| Depth    | `references/`, `scripts/`, `assets/` | only when explicitly read |

Two consequences drive everything:

1. **The `description` is the trigger.** If it does not match the user's intent,
   the body never loads, so a perfect body behind a weak description is dead
   weight. Models _under_-trigger by default, so descriptions must be "pushy".
2. **Body length is a tax.** Every line of the body competes for attention once
   loaded. Lean bodies keep the model focused; depth belongs in `references/`
   that load on demand.

## Frontmatter contract

```yaml
---
name: my-skill # required. lowercase, hyphenated slug. matches the folder id.
description: >- # required. THE trigger. what + when, pushy, with phrases.
  One-to-three sentences: what the skill does AND when to use it. Include
  concrete trigger phrases and an explicit "DO NOT TRIGGER on…" clause.
category: general # optional. general | integration | platform | conventions | troubleshooting | …
version: 1.0.0 # optional. semver string.
keep-coding-instructions: true # optional. keep host coding instructions in-prompt when loaded.
credentials: # optional. reusable per-user values injected at spawn.
  - name: SERVICE_API_KEY # POSIX env-var name; never put the real value here.
    label: API key
    type: secret # string | secret | file | json
    required: true
---
```

- `name` must be a slug and, for project skills, must not collide with a bundled
  default — the write API returns 409 on a shadowing name.
- `description` carries **all** the "when to use" signal. Do not bury triggering
  conditions in the body; the body is not in context at trigger time.
- External-service skills should declare every reusable API key, token,
  username, or password in `credentials:`. This declaration makes the secure
  per-user authentication form appear on web and mobile; values remain encrypted
  outside the skill and are injected as the declared env vars on spawn.

## Writing a "pushy" description

A weak description states only _what_:

> Extracts text from PDF files.

A strong one states _what_ + _when_ + concrete phrases + a negative guard:

> Extracts text and tables from PDF files into structured Markdown. TRIGGER when
> the user uploads or references a `.pdf`, asks to "pull text/tables out of this
> PDF", "summarize this PDF", or "convert this PDF to markdown". DO NOT TRIGGER
> on image files, plain-text docs, or general questions about PDFs.

The negative guard matters as much as the positive triggers: it stops the skill
from firing on near-misses and training the user to distrust it.

## The all-caps smell

Treat `MUST` / `ALWAYS` / `NEVER` as a flag to reframe, not a strength. A bare
imperative only covers the case you spelled out. Pair the rule with its reason
so the model generalizes:

- Weak: `NEVER commit secrets.`
- Strong: `Do not write secrets into the skill body — skills are shared context
and may be read by other agents, so anything here leaks. Declare secrets in
the credentials frontmatter instead, which the host injects at spawn.`

## Body skeleton

```markdown
# <Skill Name>

<One paragraph: what this skill makes the agent good at, and the mental model.>

## When this applies

<Restate the trigger in the body too, briefly — useful once loaded.>

## Steps

1. <imperative step, with the why where it is non-obvious>
2. <…>

## Example

<One concrete worked input → output. Examples outperform prose.>

## Edge cases / limits

<What it does not handle; when to fall back or ask the user.>
```

## Keep it lean

- Target well under 200 lines for a focused skill; hard ceiling 500.
- If you are pasting a long API table, schema, or catalog into the body, move it
  to `references/<topic>.md` and link it. The coach flow currently writes
  `SKILL.md` only, so when depth is needed, note the follow-up rather than
  inlining everything.
- Remove instructions that do not change behavior. Lean prompts grade better.

## Extract, don't invent

The best skills come from real work. If the user just performed the procedure by
hand (in this session or a prior one), turn that concrete transcript into the
skill — the steps, the gotchas they hit, the commands they actually ran.
Invented procedures tend to miss the edge cases that real runs surface.
