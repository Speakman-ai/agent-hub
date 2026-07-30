# Outer Orchestration Plan Act Verify

This document defines **outer orchestration** for Agent Hub: a **durable, persisted control loop** (Plan → Act → Verify) that is intentionally **separate from** the existing **inner ReAct** loop (`<agenthub:react>` + auto-continuation budgets in `server/chat.ts`).

**Status:** roadmap — **P1 partially shipped:** `sessions.orchestration_phase`, `sessions.orchestration_meta`; `GET /api/sessions/:id` exposes `orchestrationMeta` (parsed); `PUT /api/sessions/:id/orchestration` updates phase/meta; `buildEnrichedPrompt` appends a soft **Outer orchestration** section when set. Automatic host-driven transitions remain future work (P3+).

## Problem statement

Today the host already composes several “loops,” but they solve different problems and do not share a single persisted phase model:

| Mechanism | Scope | Persisted? | Typical stop condition |
|-----------|--------|------------|-------------------------|
| Inner ReAct (`<agenthub:react>`) | One assistant turn → host tool actions → optional auto-continue | Observations merged into `pending_skill_context`; continuation depth capped (`MAX_AUTO_CONTINUATION_DEPTH`) | No `<agenthub:close-card>`; budgets not exhausted |
| Auto-continuation retry | Scheduling when continuation is blocked (busy session) | Retry counter in memory for the scheduling path | `AUTO_CONTINUATION_MAX_RETRIES` |
| Autonomous epic dispatch | Kanban-driven “next card” work | Card `session_id`, iteration counters, epic flags | Max iterations, empty queue, human gate (Review) |

**Gap:** there is no **first-class outer phase** (e.g. “we are verifying PR #601, not planning”) that survives process restarts, shows up in the UI, and drives **explicit stop / escalate** policy independent of “did the model emit another ReAct block.”

## Definitions

- **Inner loop (ReAct):** Model-authored `<agenthub:react>` (and legacy wiki/skill blocks) parsed after the CLI exits; host runs wiki/skill/web; may auto-continue the **same session** within depth + retry budgets. See `react_loop_enabled`, `MAX_AUTO_CONTINUATION_DEPTH`, `planAutoContinuationRetry`, `AUTO_CONTINUATION_PROMPT` in `server/chat.ts`.

- **Outer loop (PAV — Plan, Act, Verify):** Host- or policy-owned **macro phases** spanning one or more model turns (and optionally multiple sessions). Each phase has **entry criteria**, **allowed tools/side-effects**, **exit criteria**, and **escalation** paths.

- **Orchestration unit:** The smallest tracked entity for outer state — default proposal: the **chat session** row (`sessions`) gains `orchestration_phase` + `orchestration_meta` (JSON). Alternative: a dedicated `session_orchestration` table keyed by `session_id` with versioned rows for audit.

## Phase model (canonical)

States are **ordered** for a typical ticket, but **transitions are not strictly linear** (escalation can jump backward or to a terminal state).

```text
        ┌──────────┐
        │ PLANNING │  Clarify goal, slice work, choose strategy
        └────┬─────┘
             │ plan approved / user message locks scope
             ▼
        ┌──────────┐
        │  ACTING  │  Edits, commits, runs CI locally
        └────┬─────┘
             │ artifact ready (PR, patch, or explicit non-code outcome)
             ▼
        ┌──────────┐
        │VERIFYING │  Tests, PR checks, review checklist, diff re-read
        └────┬─────┘
             │
    ┌────────┴────────┐
    ▼                 ▼
 DONE            ESCALATED
(terminal)       (human / lead / different agent)
```

### Phase semantics

| Phase | Primary actor | Allowed / expected side-effects | Exit when |
|-------|----------------|-----------------------------------|-----------|
| PLANNING | Lead (usually) | Read-only by default in ask mode; otherwise repo reads + design notes | Written plan + acceptance criteria agreed, or user overrides with “implement now” |
| ACTING | Lead or peer | File mutations, `git`, local test runs | Code + tests + commit (or intentional docs-only change) meet plan |
| VERIFYING | Lead or reviewer agent | CI interpretation, PR comment triage, targeted fixes | Green checks + review policy satisfied, or explicit waiver in meta |
| DONE | — | Auto-close card (`<agenthub:close-card>`), merge handoff receipt | Terminal |
| ESCALATED | Human / other agent | User reassignment or kanban move to Blocked | Terminal for this session’s ownership |

## Stop rules (outer)

**Hard stops** (outer loop must not auto-advance without new user input or policy):

1. **Control blocks present** — `<agenthub:close-card>` terminates the *current* inner continuation chain; outer phase should **not** assume the next turn belongs to the same macro-step without explicit policy.
2. **Ask mode** — `ask_mode=1`: outer loop should stay in PLANNING or VERIFYING (read-only analysis) unless user flips mode.
3. **Budget exhaustion** — web/wiki RAG budgets, `MAX_AUTO_CONTINUATION_DEPTH`, `AUTO_CONTINUATION_MAX_RETRIES`: stop **inner** auto-continue; outer loop may transition to ESCALATED or wait for user.
4. **Verify failure** — failing checks with no auto-fix path: transition ACTING → VERIFYING stays, or VERIFYING → ESCALATED with structured reason in `orchestration_meta`.
5. **Human merge gate** — repository policy already treats merge as human; outer loop **DONE** should mean “ready for human merge,” not “merged.”

**Soft stops** (prompt injection to the model, no schema change):

- Nudge text appended to system or `pending_skill_context`: “You are in VERIFYING: do not expand scope.”

## Escalation rules

| Signal | Example | Proposed outer transition |
|--------|---------|----------------------------|
| Specialist ownership needed | Security / native / infra | PLANNING or ACTING → user reassignment or **new session** starts in ACTING with inherited note |
| Parallel evidence gathering | Audit three modules | ACTING → explicit multi-agent session coordination → remain ACTING until synthesis |
| Wrong agent / overloaded | Lead cannot verify | VERIFYING → ESCALATED + user reassignment to reviewer |
| Duplicate work | Card already done | Any → `<agenthub:close-card>` → DONE |

## Interaction with the flat agent model

Agent Hub keeps agents as peers. Outer phases can span multiple sessions when
the operator explicitly reassigns work, but the host does not fan out or
transfer work through assistant-emitted coordination tags.

- **Inner ReAct** can run **inside any phase**; the outer phase tells the host **which automatic transitions are legal** after the inner loop drains (e.g. do not auto-continue from VERIFYING into “more feature work” without user ack).

## UI / client notes (hub-frontend)

Until the server exposes `orchestration_phase`:

- Optional: show a **session chip** driven by `GET /api/sessions/:id` when fields exist.
- Until then, **no client change required**; agents can still tag plans in prose. First implementation should be **API + chat.ts transition hooks** before polish.

## Implementation phasing

| Phase | Deliverable | Risk |
|-------|-------------|------|
| **P0 — Spec only** | This document + wiki mirror | None |
| **P1 — Read-only surface** | `sessions.orchestration_phase` + `orchestration_meta` columns; default `NULL` → treat as legacy “freeform”; API exposes fields on session GET; no automatic transitions | Low |
| **P2 — Manual transitions** | `PUT /api/sessions/:id/orchestration` with role guard; UI dropdown for lead; audit log row | Medium |
| **P3 — Host-driven transitions** | `chat.ts` sets phase on events (e.g. PR opened → VERIFYING; CI green + review ok → DONE candidate); integrates with autonomous dispatch so epic runs advance phase on card boundaries | Medium–high |
| **P4 — Policy engine** | Org-level YAML / JSON: per-project stop/escalate matrix; reviewer routing | High |

## Related code (reference anchors)

- Inner ReAct + auto-continue guard vs control flow: `server/chat.ts` (`controlFlowPresent`, `shouldAutoContinue`).
- Agent lifecycle: `server/project-model.ts` and the session ownership helpers.
- Autonomous kanban: epic + dispatcher (see types on `KanbanEpicRow`, `tryAutonomousDispatch` wiring in `server/chat.ts` tail).

## Open questions

1. Should **VERIFYING** be a **separate session template** (reviewer agent) vs a phase flag on the implementer session?
2. How should outer state interact with **threads** (heartbeats / crons) — ignore, or allow “VERIFYING” on a thread run?
3. Do we need a **user-visible timeline** of phase transitions for compliance audits?

---

*Authored for Agent Hub autonomous dispatch — outer orchestration design (Plan → Act → Verify).*
