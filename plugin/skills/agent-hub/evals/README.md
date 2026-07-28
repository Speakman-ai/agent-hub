# agent-hub — Skill Evals

Regression suite for the `agent-hub` skill. Each JSON file describes one
scenario; the runner dispatches each scenario to Haiku, Sonnet, and Opus and
grades the response with deterministic text matchers.

## Eval schema

```jsonc
{
  "id": "create-ticket",
  "description": "Human-readable summary of the scenario.",
  "skills": ["agent-hub", "kanban"],         // skills expected to be active
  "query": "Natural-language user message.",
  "files": [                                  // optional — defaults to SKILL.md
    "server/default-skills/agent-hub/SKILL.md",
    "server/default-skills/agent-hub/references/kanban.md"
  ],
  "expected_behavior": [
    { "type": "mentions_script", "value": "scripts/kanban-create-card.sh",
      "rationale": "why this assertion exists" }
  ]
}
```

### Behavior matcher types

| type                   | value shape      | passes when…                              |
| ---------------------- | ---------------- | ----------------------------------------- |
| `contains`             | string           | response contains the substring           |
| `not_contains`         | string           | response does **not** contain it          |
| `contains_any`         | string[]         | any one substring is present              |
| `not_contains_any`     | string[]         | none of the substrings are present        |
| `regex`                | regex string     | `new RegExp(value).test(response)`        |
| `mentions_script`      | `scripts/X.sh`   | response mentions the script path         |
| `mentions_any_script`  | string[]         | any of the listed script paths appear     |
| `references_file`      | path             | response mentions the file path           |

Each assertion carries an optional `rationale` — this is what shows up in the
grading output when an assertion fails, so write it like a PR comment.

## Running

Dry-run (shape-validate evals, no API calls — suitable for CI):

```bash
node server/default-skills/agent-hub/evals/run.mjs --dry-run
```

Full run (requires `ANTHROPIC_API_KEY` in env):

```bash
ANTHROPIC_API_KEY=sk-... node server/default-skills/agent-hub/evals/run.mjs \
  --out evals-report.json
```

Filter to one eval / one model:

```bash
node server/default-skills/agent-hub/evals/run.mjs --eval create-ticket --model sonnet
```

Baseline comparison (no skill context in system prompt) — use this to quantify
the skill's value-add vs. raw model behaviour:

```bash
node .../run.mjs --baseline --out baseline-report.json
node .../run.mjs           --out with-skill-report.json
diff <(jq -S .results baseline-report.json) <(jq -S .results with-skill-report.json)
```

## Acceptance criteria (ticket)

- All three **required** evals (`create-ticket`, `move-card`, `search-wiki`)
  must pass on Sonnet.
- Haiku and Opus results are recorded regardless; a Haiku miss on a
  subtlety (e.g. remembering `$AGENT_HUB_SESSION_ID`) is expected and does
  not block the release.

## Should-fire vs. should-not-fire

Evals fall into two classes, distinguished by the optional top-level
`mode` field:

- **should-fire** (default, no `mode` set): happy-path scenarios where
  the skill is expected to guide the model toward a specific Agent-Hub
  script or pattern. Graded primarily by `mentions_script` and positive
  `contains` assertions.
- **should-fire-not / should-not-fire** (`"mode": "should-not-fire"`):
  scenarios where the query only *looks* like it's about Agent Hub —
  e.g. "kanban in Linear", "wiki in Notion", "GitHub REST API". The
  SKILL.md frontmatter's `DO NOT TRIGGER` clause exists specifically to
  suppress these. Graded primarily by `not_contains_any` assertions
  against Agent Hub's scripts and localhost endpoints, plus a positive
  `contains_any` asserting the agent points the user at the correct
  *third-party* tool.

The runner does not treat the two modes differently — it just runs the
assertions. The `mode` field is a tag for humans reading reports.

When the false-positive rate measured on `no-fire-*` cases trends up,
revisit the `DO NOT TRIGGER` clause in SKILL.md rather than silencing
the eval.

## What not to put here

- LLM-as-judge grading. The whole point of the deterministic matchers is
  auditability — if a scenario needs semantic grading, file a follow-up,
  don't smuggle it in via a regex that pretends to be deterministic.
- Scenarios that hit the live Agent Hub API. The runner only calls the
  Anthropic Messages API. Integration tests against the local server live
  in `server/test/`.
