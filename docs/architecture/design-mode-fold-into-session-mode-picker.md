# Design Mode — Fold Design Studio into the session mode picker

> Status: spec locked (2026-06-20) · Type: spike → decomposition · Author: agent-hub-dev
> Tracking card: `73d3095c` (1016) · Wiki mirror: `design-mode-fold-into-session-mode-picker`

## Problem

Design Studio is a parallel subsystem that lives outside the main chat flow:

- Its own DB tables (`designs`, `design_projects`, `design_messages`) and a
  singleton agent id `__design_studio__`.
- Pseudo-sessions: the spawn sets `AGENT_HUB_SESSION_ID=design:<designId>`; there
  is no real `sessions` row.
- A dedicated WebSocket path (`design_chat` / `design_cancel` →
  `handleDesignChat`) instead of the normal chat turn loop.
- A separate spawn path (`server/design-chat.ts`, `design-multi-engine.ts`) that
  rebuilds engine selection, system-prompt assembly, and streaming.
- Artifacts under `<dataDir>/designs/<designId>/`, served at
  `/design-files/:designId/*`, rendered in a dedicated `DesignView` canvas.
- Its own web routes (`DesignsList`, `DesignView`), mobile screens
  (`DesignsListScreen`, `DesignViewScreen`), and Electron PDF export.

The user vision: stop treating "design" as a separate product. Make **Design** a
mode of a normal chat session, alongside the existing Ask / build / finalize
controls. A user designs in Design mode, then flips to Build mode and the design
artifacts carry over as context because **it's the same session worktree**.

## Reality check on "the Ask/Build/Deploy picker"

There is no literal three-way Ask/Build/Deploy control. Today the chat-mode
surface is two orthogonal things:

1. `sessions.ask_mode` (0/1) — read-only / plan vs. normal build.
2. `sessions.finalize_automation` (`manual|review|push|merge`) — what happens at
   end-of-turn. Surfaced together in `FinalizeAutomationSelect` (web) /
   `FinalizeBar` (mobile) as: Ask, Build, Build+Review, Build+Push, Auto Merge.

"Deploy" is a separate epic (`deploy.yaml`), not a chat mode. So "fold Design into
the picker" means: introduce a **new, first-class session-mode dimension**
(`session_mode`) and add `Design` to that picker — it is not a value crammed into
`ask_mode` or `finalize_automation`.

## Decision

Add `sessions.session_mode TEXT NOT NULL DEFAULT 'chat'` with values
`chat | design`. A `design` session is a **normal session** (real row, real
worktree, normal chat turn loop, normal Finalize) that additionally:

- Loads the `design` skill into the spawn.
- Uses a design-oriented system-prompt preamble (port `buildDesignSystemPrompt`
  to operate on the session worktree instead of the design artifact dir).
- Writes HTML/CSS/JS into a known subdir of the worktree (`design/`) so it is
  both renderable and naturally present when the user flips to `chat`/Build.
- Renders a live canvas pane in the session view, served from the worktree.

Crucially, criterion "switching Design → Build carries artifacts over" is **free**
under this model: the files are already in the session worktree, so flipping
`session_mode` back to `chat` needs no copy/forward step. This is the main reason
to fold into a session rather than keep the separate `designs` store.

### Why not keep the `designs` table and just link it harder?

The existing `forward design` flow already copies a design into a new session.
Keeping both systems means maintaining two spawn paths, two artifact stores, and a
copy step forever. Folding collapses to one session lifecycle, one spawn path, one
worktree, one Finalize. The `designs` tables become migration-only.

## Architecture

### Data model (shipped — foundation slice)

- `sessions.session_mode` column (migration in `server/db.ts`).
- `server/session-mode.ts`: `SESSION_MODES`, `SessionMode`,
  `DEFAULT_SESSION_MODE`, `isSessionMode`, `normalizeSessionMode`,
  `isDesignModeActive(row)`. Pure, unit-tested.
- `PUT /api/sessions/:sessionId/mode` `{ mode }` → persists, broadcasts
  `session-updated`, returns the enriched row. OpenAPI-registered.
- `session_mode` flows to clients automatically via `enrichSessionForClient`
  (it spreads `...row`) and is documented on the `Session` component.

This slice is intentionally inert at the product level: no picker option and no
spawn behavior yet, so selecting it would be a dead control. Those land in the
follow-up cards below, each behind the same flag, so the picker only appears once
it does something.

### Spawn wiring (follow-up)

In the chat spawn path (`server/chat.ts`), when `isDesignModeActive(session)`:

- Append the `design` skill to the resolved skill set for the turn.
- Prepend the design system-prompt preamble (refactor of
  `buildDesignSystemPrompt` to take a worktree + linked-project context instead
  of a design row).
- Keep the normal turn loop, streaming, persistence, and Finalize. No
  `design_chat` WS branch.

The design skill (`server/default-skills/design`) is currently gated to
`__design_studio__` / `designs/<uuid>/` cwd. Repoint that gate to also enable on
`session_mode === 'design'` (skill-router). The read-only `designs` skill and any
`DesignSync` tool get repointed to read the in-session artifact dir.

### Canvas (follow-up)

Add a worktree-artifact mount analogous to `/design-files/:id/*`, e.g.
`/session-files/:sessionId/design/*` with the same path-traversal guard and
org/ownership check. Reuse `SessionDesignPane` / `DesignCanvas` to render it,
shown when `session_mode === 'design'`. Mobile has no iframe — it shows the chat
+ a "files produced" list / open-in-web affordance (parity with today's mobile
Design screens, which are also chat-only).

### Migration (follow-up)

Existing `designs` rows: provide an importer that, per design, creates a session
in `design` mode for the owning org's design agent (or a chosen agent), copies the
artifact dir into the session worktree `design/`, and replays
`design_messages` as session messages. Keep `designs` read-only (and the
standalone route redirecting) for one release before dropping. No destructive
delete until parity is confirmed in production.

### Removal (follow-up, gated on parity)

Once design-mode reaches parity, redirect `/designs` and `/design/:id` to the
session flow, remove `DesignsList`/`DesignView` (web), the mobile Design screens,
and the `design_chat` WS path. The `designs` tables and `/design-files` mount stay
until the migration window closes.

## Decomposition (child cards)

1. Spawn wiring: design skill + system prompt on `session_mode === 'design'`
   (server). Blocks 2–5.
2. Web: `Design` option in the mode picker + canvas pane in the session view.
3. Mobile: `Design` option + chat-only design parity.
4. Electron: Design-mode parity (PDF export reuse) + verify no standalone-only
   coupling.
5. Migration: importer for existing `designs` → design-mode sessions; redirect
   standalone routes.
6. Skill repointing: `design` / `designs` / `DesignSync` target the in-session
   artifact dir; drop the `__design_studio__`-only gate.
7. Removal (gated on 2–6 + production parity sign-off): delete standalone module,
   `design_chat` path; retire `designs` tables after the migration window.

## Acceptance criteria mapping

| Card AC | Covered by |
| --- | --- |
| Design in the picker (web/mobile/electron) | cards 2, 3, 4 |
| Design mode produces same artifacts | card 1 (+ skill, card 6) |
| Design → Build hands artifacts over | free under this model (same worktree); validated by cards 1–2 |
| Standalone module removed/redirected | cards 5, 7 |
| Migration path defined | card 5 (defined here; implemented there) |
| Skills repointed | card 6 |

## Status of this card

Foundation (data model + REST + helper + tests + OpenAPI) shipped. Remaining work
is tracked by the child cards above. This card is retitled `[Spec]`. No
end-user-visible behavior change yet — the API gains `session_mode` and `PUT
/mode`, but no UI/spawn consumes it until card 1+2 land.
