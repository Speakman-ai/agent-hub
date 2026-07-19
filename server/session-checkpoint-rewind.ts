import type { Project, SessionRow, Stmts } from './types.js';
import { computeSessionState, DEFAULT_SESSION_STATE, type SessionState } from './session-state.js';
import { sessionCanUseDesignMode } from './project-mode-guards.js';

/**
 * File-level checkpoint rewind is implemented by spawning the Claude Code CLI
 * with `--rewind-files`. Other engines do not expose an equivalent hook today.
 */
export function engineSupportsCheckpointRewind(engine: string | null | undefined): boolean {
  return engine === 'claude-code';
}

export type SessionWireRow = SessionRow & {
  checkpoint_rewind_supported: boolean;
  /**
   * The kanban card id that owns this session, if any. Surfaced so client
   * surfaces like `<FinalizeButton>` — which targets a specific card —
   * can render conditionally on card-linkage without a second round trip.
   *
   * Populated only when the caller threads `stmts` into
   * `enrichSessionForClient`. Callers that omit `stmts` (e.g. WebSocket
   * broadcast emitters that don't have the deps bag handy) get `null` —
   * the field is still present so the type stays uniform across surfaces.
   */
  card_id: string | null;
  /**
   * Status of the most-recent Finalize Code Changes run for this session,
   * or `null` if the session has never been finalized. Surfaced so the
   * sidebar can render a "ready to push" indicator next to the session
   * name without a per-session round trip. Populated only when `stmts` is
   * threaded into `enrichSessionForClient`; otherwise `null`.
   */
  finalize_status: string | null;
  /**
   * Always-on lifecycle state — exactly one of `SESSION_STATES`. When `stmts`
   * is threaded this is the freshly-resolved live value (authoritative even if
   * the persisted `sessions.state` cache is stale); without `stmts` it falls
   * back to the persisted column, then to the default. Clients render one icon
   * per state, so this field is never null on the wire.
   */
  state: SessionState;
  /**
   * Whether this session can enter Design mode (`PUT /api/sessions/:id/mode`
   * with `design`). Computed from the SAME `sessionCanUseDesignMode` helper the
   * mode routes and chat spawn path gate on, so the client's mode picker offers
   * Design exactly when the server would accept it — never reimplementing the
   * check (which would drift). True when the session has an isolated worktree
   * (dev projects) OR belongs to a workflow (no-code) project (data-dir store).
   * The workflow arm needs the `project` argument; without it this falls back to
   * the worktree-only signal (a workflow session then reports `false` on the wire
   * until a project-aware refetch — matching how `card_id` / `finalize_status`
   * degrade on stmts-less broadcast paths).
   */
  can_design_mode: boolean;
};

/**
 * Best-effort card-id lookup. Wrapped in try/catch so a unit-test DB that
 * lacks the `kanban_cards` table never crashes a session response — the
 * field falls back to `null` rather than throwing.
 */
function lookupCardIdForSession(stmts: Stmts, sessionId: string): string | null {
  try {
    const row = stmts.getKanbanCardBySession.get(sessionId) as { id?: string } | undefined;
    return row?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Best-effort latest-finalize-run status lookup. Wrapped in try/catch so a
 * unit-test DB lacking the `finalize_runs` table falls back to `null`
 * rather than throwing.
 */
export function lookupFinalizeStatusForSession(stmts: Stmts, sessionId: string): string | null {
  try {
    const row = stmts.getLatestFinalizeRunForSession.get(sessionId) as
      | { status?: string; mode?: string }
      | undefined;
    if (!row?.status) return null;
    // A single-phase run ("Run Tests" / "Reviewer") parks at `ready_to_push`
    // internally, but the branch is only truly ready to push once BOTH phases
    // passed the same commit. Don't seed the sidebar's "ready to push"
    // indicator from a partial park — report the phase that passed instead
    // (a client-inert string the indicator ignores).
    if (row.status === 'ready_to_push' && row.mode && row.mode !== 'full') {
      return isSessionFinalizeFullyValidated(stmts, sessionId)
        ? 'ready_to_push'
        : `${row.mode}_passed`;
    }
    return row.status;
  } catch {
    return null;
  }
}

/**
 * Whether the session's latest finalize phases together amount to a full
 * validation: both the checks-bearing and review-bearing runs passed
 * (`ready_to_push` / `pushed`) against the SAME `validated_head_sha`. Mirrors
 * the orchestrator's `isBranchFullyValidated` and the client's `bothValidated`
 * so the three surfaces agree on when "ready to push" is legitimate.
 */
function isSessionFinalizeFullyValidated(stmts: Stmts, sessionId: string): boolean {
  const checks = stmts.getLatestChecksRunForSession.get(sessionId) as
    | { status?: string; validated_head_sha?: string | null }
    | undefined;
  const review = stmts.getLatestReviewRunForSession.get(sessionId) as
    | { status?: string; validated_head_sha?: string | null }
    | undefined;
  const passed = (r?: { status?: string }) =>
    r?.status === 'ready_to_push' || r?.status === 'pushed';
  return (
    passed(checks) &&
    passed(review) &&
    !!checks?.validated_head_sha &&
    checks.validated_head_sha === review?.validated_head_sha
  );
}

/**
 * Enrich a `SessionRow` for the client wire format. Pass `stmts` to also
 * resolve the owning kanban `card_id` — surfaces that gate UI on
 * card-linkage (e.g. `<FinalizeButton>`) need this populated. Callers
 * without convenient access to `stmts` may omit it; the field renders as
 * `null` and downstream UI gracefully hides card-only controls.
 *
 * The signature is intentionally `stmts?` so existing WebSocket broadcast
 * emitters that pass only the row don't need to refactor in lockstep — the
 * routes that drive the *primary* session payloads (list, detail, restore,
 * forwarded session, finalize trigger) thread `stmts` and get the full
 * wire shape; transient broadcasts that don't have it stay null.
 *
 * ─── Contract for new callers ──────────────────────────────────────────
 *
 * If you are wiring a NEW emitter that broadcasts a session payload to
 * the client (a `session_created` / `session-updated` / similar event),
 * you MUST pass `stmts` — otherwise the wire row arrives with
 * `card_id: null` and any client-side surface gated on card-linkage
 * (FinalizeButton, kanban links, card-anchored badges) will silently
 * disappear for sessions that DO have a linked card. That looks like a
 * UI bug, not an omission, and is hard to spot in code review.
 *
 * The current call sites that pass `stmts`:
 *   - `routes/sessions.ts` (list, detail, restore, forward, etc.)
 *   - `routes/board.ts` (card → session spawn broadcast)
 *   - `routes/webhooks.ts` (review/reviewer spawn broadcasts)
 *   - `autonomous.ts` (autonomous dispatch session_created)
 *   - `chat.ts` (session-updated after first message + title upgrade)
 *   - `handoff.ts` (handoff session_created)
 *   - `kanban-caller-session.ts` (card-link title rename broadcast)
 *   - `session-agents.ts` (`enrichSessionWithAgents` reuses it)
 *
 * The two-arg shape is enforced by ESLint via grep-friendly call sites,
 * not by the type system (the optional is a back-compat affordance, not
 * a "use it or not" hint). When in doubt: pass `stmts`.
 */
export function enrichSessionForClient(
  row: SessionRow,
  stmts?: Stmts,
  project?: Project | null,
): SessionWireRow {
  return {
    ...row,
    checkpoint_rewind_supported: engineSupportsCheckpointRewind(row.engine),
    card_id: stmts ? lookupCardIdForSession(stmts, row.id) : null,
    finalize_status: stmts ? lookupFinalizeStatusForSession(stmts, row.id) : null,
    state: stmts
      ? computeSessionState(stmts, row.id)
      : ((row.state as SessionState | null | undefined) ?? DEFAULT_SESSION_STATE),
    can_design_mode: sessionCanUseDesignMode(row, project ?? null),
  };
}
