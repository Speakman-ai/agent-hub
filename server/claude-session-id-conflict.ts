/**
 * Helpers for the Claude Code "Session ID … is already in use" error path.
 *
 * ─── Background ────────────────────────────────────────────────────────────
 * When chat.ts spawns Claude Code for a brand-new Agent Hub session, it
 * passes `--session-id <agentHubSessionId>` so Claude's on-disk JSONL
 * (`~/.claude/projects/<encoded-cwd>/<id>.jsonl`) gets named with our id.
 *
 * `engine_session_id` is persisted to our DB only after the assistant
 * message is saved (i.e. AFTER the first `assistant_text` event). If the
 * spawn dies before any assistant text arrives — user cancel, network blip,
 * upstream API error, runner crash — Claude has already created the JSONL
 * but our DB still has `engine_session_id = NULL`. The next turn enters
 * with `isNewEngineSession === true` and re-spawns with the same
 * `--session-id`, which Claude rejects:
 *
 *     Error: Session ID d1de0ab1-dda9-4165-9b0d-26b657d8e2b7 is already in use.
 *
 * The fix has two layers:
 *
 *   1) PREVENT — when Claude emits its `system` init event (which means
 *      it has booted and the JSONL exists), persist `engine_session_id`
 *      immediately. Subsequent turns will use `--resume`.
 *
 *   2) RECOVER — if we still see "Session ID … is already in use" in the
 *      child stderr (e.g. for sessions that were already wedged before
 *      this fix shipped, or for any future code path that bypasses the
 *      system-event hook), parse the offending id, persist it as the
 *      `engine_session_id`, and rewrite the user-facing error to point
 *      at retrying with `--resume` instead of leaking the raw CLI error.
 * ──────────────────────────────────────────────────────────────────────────
 */

/**
 * Match the exact wording Claude Code uses when `--session-id <X>` collides
 * with an existing on-disk JSONL. We accept either an `Error:` prefix or a
 * bare line so we're resilient to small formatting changes upstream.
 */
const SESSION_ID_IN_USE_RE =
  /Session ID\s+([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\s+is already in use\.?/;

/**
 * If `text` (typically a stderr buffer from a Claude Code child) contains
 * the "Session ID … is already in use" error, return the offending id.
 * Returns `null` otherwise. Pure — no I/O.
 */
export function detectSessionIdInUseError(text: string): { sessionId: string } | null {
  if (!text) return null;
  const m = SESSION_ID_IN_USE_RE.exec(text);
  if (!m) return null;
  return { sessionId: m[1] };
}

/**
 * Friendly message to surface to the user when we recover from a stuck
 * session. The next turn will go through the `--resume` path — telling the
 * user to "send your message again" is accurate.
 */
export function buildSessionIdInUseRecoveryMessage(sessionId: string): string {
  return (
    `Claude reported that session ${sessionId} was already initialised on disk, ` +
    `but Agent Hub had not recorded it yet. The session has been re-linked — ` +
    `please send your message again to continue.`
  );
}
