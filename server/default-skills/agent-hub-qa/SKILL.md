---
name: agent-hub-qa
description: >-
  Agent Hub QA validation: author QA plans (ordered test cases) with the
  user, execute approved plans against a target URL with the browser or
  preview tools, post a verdict and screenshot per case, and file finding
  cards for failures. Ships the qa.sh wrapper over
  /api/projects/<slug>/qa/plans. Force-loaded in QA sessions (session mode
  `qa`). TRIGGER on Agent Hub QA signals: "QA plan", "test case", "QA run",
  "verdict", "sign off", "qa.sh", or URLs under /api/projects/<slug>/qa/.
  DO NOT TRIGGER on writing unit/E2E tests in a codebase (Vitest,
  Playwright specs) or on third-party test managers (TestRail, Zephyr,
  Xray).
category: platform
version: 1.0.0
keep-coding-instructions: true
---

# Agent Hub QA

You are working a **QA plan**: an ordered list of test cases run against a
target URL. Plans, cases, runs, and results live in the Hub QA API. Use
`qa.sh` (on `PATH`, prints the API's JSON) for all of it. Never hand-roll curl.

QA sessions are **read-only on code**: no file edits, commits, pushes, PRs,
or Finalize. Bugs become finding cards that dev agents fix.

## Lifecycle

| Plan status   | Meaning                                       |
| ------------- | --------------------------------------------- |
| `new`         | Draft or approved, never run.                 |
| `in_progress` | At least one run started.                     |
| `done`        | Latest run all `pass` and a human signed off. |

Status is derived by the server. You never set it. **Only a human** approves
a plan and signs it off. Runs are refused (`409`, code `not_approved`) on an
unapproved plan, and editing a case or the target URL on an approved plan
revokes approval.

## qa.sh reference

```bash
qa.sh plan list [--status new|in_progress|done]
qa.sh plan get <planId>                    # plan + cases (with latestVerdict) + runs
qa.sh plan update <planId> [--title T] [--goal G] [--target-url U]
                  [--epic-id ID|--no-epic] [--card-id ID|--no-card]
                  [--auto-rerun on|off] [--max-iterations N]

qa.sh case add <planId> --title T [--steps S] [--expected E]
qa.sh case update <planId> <caseId> [--title T] [--steps S] [--expected E]
qa.sh case delete <planId> <caseId>
qa.sh case reorder <planId> <caseId> <caseId> ...   # every case id, new order

qa.sh run get <planId> <runId>             # run + results so far
qa.sh run begin <planId> <runId>           # queued -> running (no-op if already running)
qa.sh run finish <planId> <runId>          # finish early; missing cases make it failed

qa.sh result post <planId> <runId> --case <caseId> \
  --verdict pass|fail|needs_change|blocked \
  [--actual A] [--notes N] [--screenshot <artifactId>]... [--finding-card <cardId>]
```

Long text flags (`--steps`, `--expected`, `--actual`, `--notes`, `--goal`)
take a literal, `@path` to read a file, or `-` to read stdin. `--screenshot`
repeats and also accepts a comma-separated list.

## 1. Authoring a plan

The session opens with the plan id, target URL, goal, and the linked
epic/card descriptions.

1. `qa.sh plan get <planId>` to see what exists.
2. Propose cases grounded in the acceptance criteria. One behavior per case.
   - **Title**: what is being checked ("Signed-in user can rename a project").
   - **Steps**: numbered, concrete, reproducible by someone who never saw this chat.
   - **Expected**: something observable on screen, not "works correctly".
3. Add them with `qa.sh case add`, in run order (or `case reorder` after).
4. Refine with the user. Apply their edits with `case update` / `case delete`.
5. Stop at "ready for approval" and ask the human to press **Approve** on the
   plan. Do not approve it yourself.

```bash
qa.sh case add "$PLAN" --title "Login with valid credentials" \
  --steps $'1. Open /login\n2. Enter the test user\n3. Press Sign in' \
  --expected "Dashboard loads with the user's name in the header"
```

## 2. Executing a run

Starting a run opens a fresh QA session whose first message carries the plan
id, run id, scope (`full` or `failed_only`), the in-scope cases, and which
tool to drive the target with. The server has already marked the run
`running`.

1. Work only the cases listed in the seed. Posting a result for any other
   case is refused (`409`, code `out_of_scope`).
2. Pick the tool by target (the seed names it):
   - Public URL: the `browser` ReAct tool (`navigate`, `click`, `type`,
     `screenshot`, `read_page`).
   - This project's session preview, `localhost`, or a private host: the
     `preview` tool. The `browser` tool's egress policy refuses those targets.
     In a run session the preview tool drives the preview of the session that
     hosts the target (named in the seed). Navigate by route, and do not try
     to start it: if it is down, the cases are `blocked`.
3. Logins: use skill credentials from the environment, or an
   `agenthub:credential-request` card. Never put a secret in chat.
4. Before any destructive action on the target (deleting data, sending a
   message, a purchase), request the `approval` tool and wait for the answer.
5. For each case in scope, in order: follow the steps, take **at least one**
   screenshot, upload it, and post the result (below) before moving on.
6. The server finishes the run, derives `passed` / `failed`, and posts a
   verdict summary (counts, finding card links, screenshot names) into this
   session as soon as every in-scope case has a result. Call
   `qa.sh run finish` only to stop early; any case still missing makes the
   run `failed`. Do not repeat the summary yourself.

A `failed_only` run covers every case whose latest verdict is missing, not
`pass`, or was recorded against an older version of the case. If a human
cancels the run, your turn is stopped and later results are refused.

## 3. Screenshots

`screenshot` (browser or preview) returns a saved image path. Upload it as a
session artifact **from this run session** and keep the id. The results API
refuses (`400`, code `artifact_not_owned`) any id this session did not upload:

```bash
ART=$(artifacts.sh put ./shot.png "case 3: dashboard after login" | jq -r .id)
```

## 4. Reporting a result

```bash
qa.sh result post "$PLAN" "$RUN" --case "$CASE" --verdict fail \
  --actual "Sign in spinner never stops; console shows 500 from /api/session" \
  --screenshot "$ART"
```

| Verdict        | Use when                                                          |
| -------------- | ----------------------------------------------------------------- |
| `pass`         | Expected result observed.                                         |
| `fail`         | Behavior is broken or contradicts the expected result.            |
| `needs_change` | It works, but the expected result or UX is wrong / incomplete.    |
| `blocked`      | You could not reach or execute the case (login, outage, tooling). |

`--actual` is what you saw, not what you expected. A case you could not
reach is `blocked`, never `pass`. Posting again for the same case in the same
run replaces the earlier result.

## 5. Filing finding cards

Every `fail` or `needs_change` result gets one finding card per case per
iteration. If the posted result already carries a `findingCardId`, the server
filed it: do nothing more.

Otherwise:

1. Check the plan's earlier runs (`qa.sh run get`) for an open finding card on
   the same case. If one exists, comment on it with this iteration's actual
   result and screenshot instead of filing a duplicate
   (`board.sh comment <cardId> '{"author":"QA","content":"…"}'`).
2. Else create the card, linked to the plan's epic (if any):

   ```bash
   DESC=$'**Steps**\n1. …\n\n**Expected** …\n\n**Actual** …\n\n**Screenshots** artifact <id>\n\n**QA plan** <planId>, iteration <n>'
   CARD=$(kanban-create-card.sh --title "QA: <case title>" --labels qa-finding \
     --priority high --epic-id "$EPIC" --description "$DESC" | jq -r .id)
   ```

3. Record the link: post the result again with `--finding-card <cardId>`.

Do not assign the card or start a dev session yourself. Do not fix the bug.

## See also

- `agent-hub` core skill: `artifacts.sh`, `ah-api.sh`, auth, error reporting.
- `agent-hub-kanban`: card comments, epics, labels.
- Endpoint shapes: the `QA` tag in the published OpenAPI spec.
