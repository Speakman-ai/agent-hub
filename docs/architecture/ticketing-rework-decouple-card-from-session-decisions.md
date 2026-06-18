# Ticketing Rework — Decouple Card from Session (decisions)

**Status:** decisions locked (spike output) · **Type:** spike → epic
**Author:** agent-hub-dev · **Date:** 2026-06-18
**Scoping doc:** wiki `ticketing-rework-decouple-card-from-session-scoping`

This is the decision record for the "do we need a kanban card per session?"
spike. The audit (see the scoping wiki page) established that the architecture
already tolerates cardless sessions: chat / heartbeat / cron sessions never
touch a card, and an ad-hoc session that ships code gets a card lazily
materialized at Finalize time by `server/finalize/ensure-kanban-card.ts`. The
only hard coupling is `finalize_runs.card_id NOT NULL`.

The through-line of these decisions: **do not hard-decouple the card now.**
The eager lazy card is a *simplifying invariant* — every shipped change has
exactly one card, and four downstream surfaces (post-push detach, the
Done-state contract, dashboard merged-detection, the board UI) all lean on it.
Full decoupling (nullable `card_id`) buys only board-noise reduction while
forcing null-handling into all four surfaces. Better to attack the noise
directly (deterministic linking + better auto-titles) and defer the migration
behind a measured need.

## Decision 1 — Card→PR discovery becomes branch-deterministic; title-match demoted

**Decision: keep the deterministic paths primary, demote the title-match
fallback — do not remove it.**

`server/kanban-pr-link.ts` resolves an incoming PR to a card via, in order:

1. `pr_url` already linked (`already_linked`),
2. branch carries `session-<id8>` (`branch_session_id`) or matches
   `sessions.worktree_branch` (`branch_worktree`),
3. exact case-insensitive card **title** match (`title`).

Path 3 is the flaky one: cardless ships auto-title cards "Session work", so many
cards collide on the same title and the match becomes ambiguous/wrong.

Locked changes (follow-up card):

- Branch-based resolution (`branch_session_id`, then `branch_worktree`) is the
  authoritative deterministic path. `session-<id8>` is embedded in every session
  worktree branch (`server/worktree.ts`), so it is always available for
  Hub-originated PRs.
- The `title` path stays as a **last resort for external PRs only** (human /
  dependabot branches with no session ref), and must:
  - **exclude auto-generated / default titles** ("Session work", and the
    session-name fallback) from candidacy, so cardless collisions can never
    resolve by title;
  - emit a structured warning log when it fires, so heuristic links are
    auditable.
- Not in scope but noted: the table has `pr_url` but no `pr_number`. A future
  card may add `pr_number` for exact webhook matching; not required to make
  linking deterministic.

## Decision 2 — Auto-created card policy stays eager-at-ship; titles improve

**Decision: keep one card per shipping session, created lazily at Finalize
time (current behavior). Reject the roll-up "ad-hoc work" card. Improve the
title instead of the "Session work" fallback.**

- **Roll-up rejected.** A single shared "ad-hoc work" card breaks the
  1:1 card↔session↔PR invariant the pipeline relies on. `post-push-detach.ts`
  moves *the* card to Done and comments the PR handoff on it; a shared card
  cannot track N independent PRs or land in Done per-ship.
- **Eager-at-ship kept** as the default. It is the cheap mechanism that already
  makes cardless sessions work; it keeps every downstream surface card-shaped.
- **Title fix (follow-up card).** `ensureKanbanCardForSession` currently falls
  back to "Session work" when the session is unnamed. Derive a meaningful title
  from (in order) the session name, the PR title, the branch, or the first
  commit subject. This both reduces board-scan noise and removes the
  title-collision risk that Decision 1 guards against — the two reinforce each
  other.

## Decision 3 — Keep `finalize_runs.card_id` NOT NULL (do not migrate now)

**Decision: leave `card_id` NOT NULL. Defer the nullable migration behind a
measured board-noise need.**

Making it nullable is the only change that would *truly* decouple card from
session, but it forces null-handling into:

- `post-push-detach.ts` — skip the card move + comment, record the handoff on
  the finalize run / session timeline instead;
- the Done-state contract — N/A with no card;
- the board UI — cardless finalize runs would not appear on the board;
- dashboard merged-detection (Decision 4) — `merged` currently *only* resolves
  via a linked Done card.

That is a lot of surface area for the marginal benefit of fewer auto-cards. The
NOT NULL + lazy-ensure pairing is a clean invariant; Decision 2 already removes
the noise complaint (better titles, and the operator can archive). Create a
**deferred** follow-up card to revisit only if ad-hoc card volume is measured to
be a real problem.

## Decision 4 — Cardless terminal detection: no change now; spec the fix behind Decision 3

**Decision: no change required while Decision 3 holds. Specify (don't build)
the cardless terminal signal so it ships together with any future nullable
`card_id`.**

Mechanics confirmed in code:

- The dashboard "Active Sessions Queue" (`server/routes/dashboard.ts`) keeps
  every session whose resolved state is **not** `merged`.
- `merged` (`shared/utils/sessionState.js` → `resolveSessionState`,
  `server/session-state.ts` → `lookupMergedForSession`) resolves **only** when
  the linked kanban card sits in a Done column.
- A session that ships *also* independently resolves to `pushed` from its
  `finalize_runs` row — that signal needs no card. `pushed` is pre-merge and
  legitimately still in-flight, so the queue is right to keep it visible.

Because Decision 3 keeps `card_id` NOT NULL and `cardDoneOnPush` defaults true,
every shipped session gets a card that lands in Done on push → `merged`
resolves → it leaves the queue. So the "cardless session never reaches merged"
gap **does not bite** under the locked decisions.

The gap *would* reappear the moment `card_id` goes nullable (Decision 3's
deferred card). The fix to ship alongside that migration: extend
`lookupMergedForSession` to also treat a session as terminal when its
`finalize_runs` row reached a merged/closed terminal (PR-merge webhook stamping
a durable signal), independent of any card. This follow-up is therefore
**blocked by** the Decision 3 card.

## Follow-up cards

| # | Title | Decision | Notes |
| - | ----- | -------- | ----- |
| 1 | Harden Card→PR linking: branch-deterministic primary, demote title-match | 1 | `kanban-pr-link.ts` + tests; exclude auto-titles from title path; structured log |
| 2 | Improve auto-created card titles (drop "Session work" fallback) | 2 | `ensure-kanban-card.ts` + tests; derive from session/PR/branch/first-commit |
| 3 | [Deferred] Revisit `finalize_runs.card_id` NOT NULL | 3 | Only if ad-hoc card noise is measured; low priority |
| 4 | [Deferred] Cardless terminal-state detection for dashboard queue | 4 | Blocked by #3; add finalize/PR-merge merged signal to `lookupMergedForSession` |
