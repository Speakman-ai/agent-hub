# Eval loop reference (Phase 3)

Prove a skill changes behavior before trusting it. Each eval runs twice — with
the skill's `SKILL.md` injected (with-skill) and without it (baseline) — and is
graded against optional assertions. Read this when you need the exact format or
the run options; the SKILL.md body has the workflow.

## Where evals live

`<dataDir>/project-skills/<projectId>/<skill-id>/evals/evals.json`. You never touch the file
directly — go through the REST API (the wrappers handle auth and the canonical
serialization).

## evals.json format

This is the shape of the saved file on disk. **In a `PUT` you send only
`evals`** — the `version` field is server-managed: the server writes it (`1`)
into the saved file. You may include `version` in a request (so you can round-
trip the file back verbatim), but it is optional and the server owns its value.
`GET` returns `{ "evals": [...] }`.

```json
{
  "version": 1,
  "evals": [
    {
      "id": "happy-path",
      "prompt": "How do I run only the server tests for the file I just edited?",
      "assertions": [
        { "type": "contains", "value": "npx vitest" },
        { "type": "not_contains", "value": "npm test" }
      ]
    },
    {
      "id": "tone",
      "prompt": "Explain the deploy step to a new engineer."
    }
  ]
}
```

- **`version`** — server-managed, optional on input (written as `1`). Send just
  `evals` unless you are round-tripping the saved file.
- **`id`** — slug (lowercase letters, digits, hyphens), unique within the suite.
  Lets you re-run a single eval with `evalIds`.
- **`prompt`** — the realistic user message fed identically to both variants.
- **`assertions`** — optional. With assertions the eval is **objective**
  (auto-graded pass/fail). Without, it is **subjective** — no verdict, just a
  side-by-side diff for human judgement (use for tone/style skills).
- Limits: at most 10 evals per skill, 10 assertions per eval. Two or three
  prompts is the sweet spot.

### Assertion types

| `type`         | passes when…                                         |
| -------------- | ---------------------------------------------------- |
| `contains`     | output includes `value` (case-sensitive)             |
| `icontains`    | output includes `value` (case-insensitive)           |
| `not_contains` | output does **not** include `value` (case-sensitive) |
| `regex`        | `value` (a JS regex source) matches the output       |

A bad `regex` is rejected at write time (400), so a run never throws mid-grade.
At grade time each `regex` runs in a worker thread that is force-terminated if
it overruns a hard budget, so a catastrophic-backtracking pattern can't hang the
server — it is recorded as a failed, timed-out assertion (the report flags it;
simplify the pattern).

## API

All paths are under the project + skill. Use `ah-api.sh` (auth handled).

### Read the suite

```bash
ah-api.sh GET "/api/projects/$PROJECT_ID/skills/<skill-id>/evals"
```

`{ "evals": [...] }`. An absent file returns `{ "evals": [] }`.

### Write the suite

```bash
ah-api.sh PUT "/api/projects/$PROJECT_ID/skills/<skill-id>/evals" \
  -d '{ "evals": [ { "id": "happy-path", "prompt": "…", "assertions": [ … ] } ] }'
```

Validates and writes `evals.json`. 400 on a malformed suite (bad id, missing
prompt, bad assertion, invalid regex).

### Run the suite

```bash
ah-api.sh POST "/api/projects/$PROJECT_ID/skills/<skill-id>/evals/run" -d '{}'
```

Body options (all optional):

- `evals` — an inline eval suite to run instead of the saved `evals.json`, so
  you can iterate on the prompts/assertions without `PUT`ting them first. Note
  this only skips saving the **eval suite** — the **skill itself must already be
  saved**, because the run always loads the skill's `SKILL.md` from disk. There
  is no "unsaved draft skill" path; `PUT` the skill first (step 4 / step 6).
- `evalIds` — restrict to these ids (single-prompt re-run during iteration).
  Every id must exist in the suite or the request 400s, listing the missing ids
  — a partial miss never silently runs only the resolvable subset.
- `engine` / `model` — override the engine/model. `engine` must be an agent CLI
  (Gemini is excluded — reserved for RAG/embeddings); when set it is the engine
  the run uses, and an unavailable engine 400s rather than falling back to a
  different CLI (which would make results misleading). Default falls back across
  the agent CLIs (claude → cursor → codex).
- `timeoutMs` — per-run timeout; must be an integer in `[1000, 600000]` (out of
  range is a 400).

### Run response

```jsonc
{
  "skillId": "…",
  "total": 2, // evals run
  "graded": 1, // evals with assertions (auto-graded)
  "withSkillPassed": 1, // objective evals passing WITH the skill
  "baselinePassed": 0, // objective evals passing WITHOUT it
  "improvedCount": 1, // baseline-fail → with-skill-pass (the headline signal)
  "results": [
    /* per-eval: withSkill/baseline output + grade, improved bool|null */
  ],
  "markdown": "…", // rendered side-by-side report — surface this to the user
  "engine": "claude-code",
  "model": "…",
}
```

## Reading the result

- **`improvedCount > 0`** is the win: the skill flipped at least one prompt from
  failing to passing. That is direct evidence the skill earns its place.
- **`withSkillPassed === graded`** and `improvedCount === 0` means the skill
  passes but the baseline already did too — the skill may be redundant for these
  prompts. Either the prompts are too easy (write harder ones) or the skill
  isn't adding value.
- A **subjective** eval (`graded: false`, `improved: null`) gives no verdict —
  open the `markdown` diff and judge whether the with-skill output is better.

## Iteration discipline

Failing evals mean the skill text needs work — almost never the eval. Tighten
the body or the description, PUT the updated skill, re-run. Stop when the
objective evals pass with-skill and improve over baseline, or after two rounds
with no progress (report the plateau and show the diff rather than thrashing).
