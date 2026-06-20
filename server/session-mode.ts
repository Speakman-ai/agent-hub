/**
 * Session mode — the user-selectable "what is this session for" dimension that
 * sits alongside `ask_mode` and `finalize_automation`.
 *
 * Background: Agent Hub's chat-mode controls historically meant two things:
 *   - `ask_mode` (read-only / plan) vs. normal build, and
 *   - the Finalize automation level (manual / review / push / merge).
 *
 * This module introduces a first-class **session mode** so "Design" can fold
 * into the same picker as the other modes instead of living in the standalone
 * Design Studio subsystem (separate `designs` table + `design:<id>` pseudo
 * sessions). A session in `design` mode runs in its own worktree, loads the
 * `design` skill, and produces the same HTML/CSS/JS artifacts the standalone
 * studio did — only now the artifacts live in the session worktree, so flipping
 * back to `chat` mode hands them to the build flow for free (same checkout).
 *
 * Scope of THIS module: the canonical value list, validation/normalization, and
 * a derived "is design behavior active" predicate. Spawn wiring (skill + system
 * prompt), the canvas pane, mobile/Electron parity, and the Design Studio
 * migration are tracked as separate follow-up cards — see the architecture spec
 * `design-mode-fold-into-session-mode-picker`.
 *
 * Storage: `sessions.session_mode TEXT NOT NULL DEFAULT 'chat'`. Pure
 * functions only here so they unit-test without a DB.
 */

/** Canonical, ordered list of session modes. Order is display order. */
export const SESSION_MODES = ['chat', 'design'] as const;

export type SessionMode = (typeof SESSION_MODES)[number];

/** Mode assumed for legacy rows, missing values, and anything unrecognized. */
export const DEFAULT_SESSION_MODE: SessionMode = 'chat';

/** Narrowing type guard: true iff `value` is exactly one of SESSION_MODES. */
export function isSessionMode(value: unknown): value is SessionMode {
  return typeof value === 'string' && (SESSION_MODES as readonly string[]).includes(value);
}

/**
 * Coerce arbitrary input to a valid SessionMode. NULL / undefined / unknown
 * strings collapse to DEFAULT_SESSION_MODE so callers never have to special-case
 * legacy rows (the column was added with a DEFAULT 'chat', but row objects read
 * before the migration ran — or from other code paths — may carry null/absent).
 */
export function normalizeSessionMode(value: unknown): SessionMode {
  return isSessionMode(value) ? value : DEFAULT_SESSION_MODE;
}

/**
 * Whether design-mode behavior (design skill load, artifact canvas) should be
 * active for a session row. Accepts the raw row shape so callers can pass a
 * `SessionRow` directly without threading the column out.
 */
export function isDesignModeActive(
  session: { session_mode?: string | null } | null | undefined,
): boolean {
  return normalizeSessionMode(session?.session_mode) === 'design';
}

/**
 * Whether a session has an isolated worktree usable for design mode — the single
 * source of truth shared by the mode route (which refuses to persist `design`
 * for a worktree-less session) and the chat spawn path (which disables design
 * behavior in the same case). Design mode writes artifacts under `design/` in
 * the session worktree and must NEVER fall back to the shared project checkout,
 * so "usable worktree" means a non-empty `worktree_path`. Keeping both callers
 * on this predicate prevents the accept-side and run-side checks from drifting.
 */
export function sessionHasUsableWorktree(
  session: { worktree_path?: string | null } | null | undefined,
): boolean {
  return !!(session?.worktree_path ?? '').trim();
}
