# agent-hub Skill Evals — Results Log

Tracks measured pass/fail for each `expected_behavior` assertion across the
model matrix. Append a new section every time the harness is re-run against
the live Anthropic Messages API; do not overwrite prior rows — the
longitudinal record is the point.

## How to run

```bash
# With-skill (default):
ANTHROPIC_API_KEY=sk-... node server/default-skills/agent-hub/evals/run.mjs \
  --out with-skill-$(date +%Y%m%d).json

# Baseline (no skill in system prompt — same query, raw model):
ANTHROPIC_API_KEY=sk-... node server/default-skills/agent-hub/evals/run.mjs \
  --baseline --out baseline-$(date +%Y%m%d).json
```

Paste the summary matrix from stdout under the headings below, and drop the
JSON report into `evals/archive/` (gitignored) for deeper inspection.

## Acceptance bar (from the ticket)

- `create-ticket`, `move-card`, `search-wiki` must all **pass on Sonnet**.
- Haiku + Opus results are **recorded** regardless. A Haiku miss on a
  subtle instruction-following detail (e.g. remembering to pass
  `$AGENT_HUB_SESSION_ID`) is allowed but tracked.
- `delegate-task` is bonus coverage — tracked, not blocking.

## Measured results

### Run 1 — TBD (pending first live execution)

Should-fire matrix (happy path — skill is expected to surface its scripts):

| eval           | haiku   | sonnet  | opus    | baseline-sonnet |
| -------------- | ------- | ------- | ------- | --------------- |
| create-ticket  | pending | pending | pending | pending         |
| move-card      | pending | pending | pending | pending         |
| search-wiki    | pending | pending | pending | pending         |
| delegate-task  | pending | pending | pending | pending         |

Should-not-fire matrix (anti-trigger — skill must stay out of the way):

| eval                  | haiku   | sonnet  | opus    | baseline-sonnet |
| --------------------- | ------- | ------- | ------- | --------------- |
| no-fire-linear-kanban | pending | pending | pending | pending         |
| no-fire-notion-wiki   | pending | pending | pending | pending         |
| no-fire-github-api    | pending | pending | pending | pending         |

**Notes** — fill in after first run:

- Which assertions failed most often? (look for `pass: false` entries in the
  JSON report).
- How large is the baseline gap? (expected: baseline Sonnet should fail
  every `mentions_script` assertion, since the raw model has no reason to
  know `scripts/kanban-create-card.sh` exists).
- For the `no-fire-*` row: ideally baseline and with-skill both pass
  (the raw model has no reason to invent Agent Hub scripts either). A
  regression where with-skill *fails* and baseline *passes* is the
  exact false-positive scenario the P2 #6 anti-trigger clause is meant
  to prevent — that pattern should open a follow-up card, not be
  silenced.

## Shape validation

The structural side of the harness — eval JSON shape, runner executability,
plugin/default-skills parity — is validated in CI by
`server/test/agent-hub-skill-evals.test.ts`. Green CI means the evals are
ready to run; it does **not** mean the model responses pass.

## Why a separate log file

The JSON reports are machine-readable but verbose. This file is the
human-readable index future reviewers will grep for "has Sonnet ever
regressed on move-card?" without spelunking through archived JSON.
