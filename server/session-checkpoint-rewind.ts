import type { SessionRow, Stmts } from './types.js';

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
export function enrichSessionForClient(row: SessionRow, stmts?: Stmts): SessionWireRow {
  return {
    ...row,
    checkpoint_rewind_supported: engineSupportsCheckpointRewind(row.engine),
    card_id: stmts ? lookupCardIdForSession(stmts, row.id) : null,
  };
}
