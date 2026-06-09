/**
 * get-session-preview-state — resolve the current preview snapshot event
 * for a single session, for the `GET /api/sessions/:id/preview/state`
 * hydration endpoint.
 *
 * Why this exists: `SessionPreviewPane` derives its status purely from
 * live `agenthub_preview` WS events. The WS connect-snapshot
 * (`preview-snapshot.ts`) rehydrates a client that (re)connects, but a
 * `ready` frame lost while the socket stays OPEN — a transient drop that
 * never triggers an `onclose` → reconnect, so the connect-snapshot never
 * replays — strands the pane on `preview_starting` forever even though
 * the backend group is `ready` and the proxy serves 200.
 *
 * This resolver lets the client re-request the current truth on demand
 * (e.g. when it notices a pane stuck in `starting`) and reconcile
 * without forcing a full WS reconnect. It returns the SAME wire shape
 * the connect-snapshot emits, by reusing {@link previewSnapshotEventFromRow}
 * — so the client applies it through the exact same reducer path as a
 * live event, with no new event kind to handle.
 *
 * Pure: takes the narrowed runtime surface so tests pass a stub with no
 * real runtime / docker daemon.
 */
import { previewSnapshotEventFromRow, type PreviewSnapshotEvent } from './preview-snapshot.js';
import type { ComposePreviewRow } from './preview-compose-runtime.js';

/**
 * The compose-runtime surface this resolver needs. Narrowed from
 * `PreviewComposeRuntime` so tests can pass a stub.
 */
export interface SessionPreviewStateRuntime {
  getActiveBySessionId(sessionId: string): ComposePreviewRow | null;
  getLogTail(groupId: string): string[];
}

/**
 * Resolve the current `agenthub_preview` snapshot event for `sessionId`,
 * or `null` when no compose preview group is active for it.
 *
 * `getLogTail` is best-effort — on the production runtime it hits the
 * docker daemon for a fresh `docker compose logs --tail`; if that throws
 * we still return the event with an empty tail rather than failing the
 * whole hydration request.
 */
export function getSessionPreviewStateEvent(
  runtime: SessionPreviewStateRuntime | null | undefined,
  sessionId: string,
): PreviewSnapshotEvent | null {
  if (!runtime) return null;
  const row = runtime.getActiveBySessionId(sessionId);
  if (!row) return null;
  let logTail: string[] = [];
  try {
    logTail = runtime.getLogTail(row.id);
  } catch {
    logTail = [];
  }
  return previewSnapshotEventFromRow(row, logTail);
}
