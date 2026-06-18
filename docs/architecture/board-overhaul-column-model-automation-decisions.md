# Board Overhaul — Column Model & Automation Semantics (Spike Decisions)

> Spike card `e224267a` · Epic: Board Overhaul (`951c89d1`) · Sibling spike:
> Ticketing Rework — Decouple Card from Session (`68694dd7`).
> **No production code in this spike** — output is the decisions below plus
> four follow-up implementation cards.

## Through-line

Adopt Linear's model: automation semantics belong to a column **category**, not
to the column's display **name**. Today every automation reads a string
(`name.toLowerCase().includes('done')`, `name === 'in progress'`, dispatcher
name match), so renaming a column silently breaks merged-detection,
`card-on-merge`, and autonomous dispatch. A category enum makes renames safe and
makes "only In Progress + Done carry automation meaning" literally true in the
data model. Everything else flows from that.

Grounding (Linear docs, verified June 2026): a status belongs to exactly one of
five categories — `backlog | unstarted | started | completed | canceled` — and
the **category**, not the status name, is what tools key off. An "active" status
is one in the unstarted/started categories.

## Current state (what the code does today)

- **Default seed:** `[To Do, In Progress, Review, Done]` (Backlog dropped in the
  May 2026 migration). The agent-hub project's own board runs the leaner
  `[To Do, In Progress, Done]`.
- **Detection is all by name string:**
  - `isColumnDone(name)` = `name.toLowerCase().includes('done')`
    (`server/kanban-blockers.ts`).
  - `pickDoneColumn` = exact `done` → contains `done` → rightmost by position
    (`server/card-auto-close.ts`).
  - In-Progress detection in the assign route = `name.toLowerCase() === 'in progress'`
    (`server/routes/board.ts`).
  - Autonomous dispatch eligibility considers only `To Do` cards
    (`getEligibleAutonomousCards`, `server/db.ts`).
- **Assignment is the only session cause:** `POST /board/cards/:id/assign` moves
  the card to In Progress, links `session_id`, and spawns the session via
  `handleChat`. Manual column moves (`PATCH /board/cards/:id`) have **no** session
  side-effects. The only column→action causation is the opt-in
  `trigger_column_id` workflow trigger (PR #635).
- **Terminal state:** `cardDoneOnPush` (default **true**) moves the card to Done
  at push time; `handleCardOnMerge` moves it to Done at merge time (native
  `pull_requests` path; GitHub-webhook path mirrors it). `resolveSessionState`
  reports `merged` whenever the linked card is in a done-named column.
- **Counts & pagination already shipped:** `GET /board` returns a per-column
  `counts` map; per-column keyset pagination + `position` ordering exist.

## Decisions

### D1 — Column set: richer set, semantics on a `category`, not the name

Add `kanban_columns.category` enum: `backlog | todo | in_progress | review |
done | canceled`. The default seed names are unchanged; the migration backfills
`category` from the current name heuristics (idempotent, per-board transaction,
mirroring the Backlog-drop migration), and all automation reads route through
category **with name-match fallback** for un-migrated/legacy rows.

The three categories the system actually reads (the automation anchors):

- `todo` (Linear *unstarted*) — autonomous-dispatch-eligible.
- `in_progress` (Linear *started*) — a working session is/should be active.
- `done` (Linear *completed*) — terminal == merged.

`backlog`, `review`, and `canceled` are organizational + hideable; no automation.

> Refinement of the user's lean ("In Progress + Done are the anchors"): `todo`
> is also an anchor because the dispatcher keys off it. There are three
> system-read categories, not two.

→ Card **`95bc9e95`** (foundational; blocks D2/D3/D4).

### D2 — Cause vs effect: assignment is the only cause; manual drags are effect-only

In Progress is an **effect** of working, not a **cause** of it.

- Drag **into** `in_progress` does **not** spawn a session (a spawned session
  costs money + a worktree; auto-spawn-on-drag is too sharp an edge).
- Drag **out of** `in_progress` does **not** stop/detach the running session (the
  session owns its own lifecycle; detaching strands commits where Finalize can't
  see them).
- The card→session binding is established once, at assign time, and is thereafter
  a one-way reference. Column position afterward is descriptive.
- **Escape hatch preserved:** users who want drag-to-column causation use the
  existing per-column `trigger_column_id` workflow trigger (opt-in, audit-tagged
  `source:'kanban_column'`).

This largely codifies current behavior; the work is regression tests + the
documented contract.

→ Card **`976933a0`**.

### D3 — Done == merged, written only by merge

`done` means merged, and **only** merged.

- **Merge is the sole terminal writer.** Both git hosts converge on
  `handleCardOnMerge` (native `pull_requests` path; GitHub-webhook path mirrors
  it). Card discovery stays branch-deterministic per ticketing-spike Decision 1
  (`522f39d4`); title-match is the demoted last resort.
- **Push no longer moves the card to Done.** With a review-category column
  present, push lands the card in `review` (pushed, awaiting merge). Reframe the
  flag: `cardDoneOnPush` (push→Done) → `cardReviewOnPush` (push→Review), default
  on when a review column exists; boards without one leave the card in
  `in_progress`. Keep `cardDoneOnPush` as a legacy opt-in.
- **Result:** `resolveSessionState` distinguishes `pushed` (finalize settled,
  unmerged) from `merged` (card in done) honestly, and the dashboard
  active-sessions queue keeps pushed-unmerged sessions visible — fixing the
  current premature drop-off.
- Detection prefers `category === 'done'`, falls back to name heuristics for
  un-migrated boards.

This is the **carded** half of ticketing-spike Decision 4; the **cardless**
terminal-detection half stays deferred in `7d7fb19e`.

→ Card **`e2918f56`** (blocked by D1).

### D4 — Hidden/secondary columns + per-column counts/sort

- **Per-column counts:** already shipped (`GET /board` `counts` map). No work.
- **Per-column keyset pagination + `position` ordering:** already shipped
  (`db0c0415` / `24c8885c` / `ef1197fb`). No work.
- **Per-column sort *modes* (manual vs auto by priority/date):** out of scope;
  position ordering is enough. Defer unless requested.
- **Hidden/secondary columns:** in the model, ship later. Add
  `kanban_columns.hidden BOOLEAN` + a web/mobile hide toggle; allow
  organizational `backlog`/`canceled` columns. Default seed stays lean (no
  Canceled seeded by default — per the Backlog-drop lesson). **Blocked by D1:**
  the Backlog-drop migration is the cautionary tale — a soft-hide that leaves DB
  rows visible to the dispatcher/API is a trap. Hiding is only safe once
  automation keys off category, so a hidden `backlog`/`canceled` column is
  automatically inert.

→ Card **`81f8f45f`** (blocked by D1).

## Follow-up cards

| Card | Decision | Blocked by | Priority |
| --- | --- | --- | --- |
| `95bc9e95` | D1 — column category model | — | high |
| `976933a0` | D2 — cause-vs-effect contract | — | medium |
| `e2918f56` | D3 — push→Review, merge→Done | `95bc9e95` | high |
| `81f8f45f` | D4 — hidden/secondary columns | `95bc9e95` | low |

All four are under the Board Overhaul epic (`951c89d1`).

## User-visible behavior change

**No** — spike only (this decision record + wiki page + four follow-up cards).
All user-visible work is carried by the follow-up cards.
