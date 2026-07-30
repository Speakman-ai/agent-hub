/**
 * Keep a user-started session preview in sync with worktree edits.
 * Preview boot is human-only (toolbar / POST …/preview/start); agents must
 * not emit `<agenthub:preview>`.
 *
 * - `preview_refresh` WS event → client reloads the iframe (Angular HMR often
 *   picks up changes without this; the refresh covers API/proxy staleness).
 * - The dev server watches the worktree directly and picks up edits itself;
 *   we never restart it per turn (that would blip the iframe).
 */
import type { BroadcastFn } from '../types.js';
import type { DevServerRuntimeSync } from './preview-runtime-lookup.js';
import { getSessionPreviewPort } from './session-preview-port.js';

const REFRESH_THROTTLE_MS = 3_000;
const lastRefreshMs = new Map<string, number>();

export type PreviewWorktreeSyncDeps = {
  broadcast: BroadcastFn;
  getDevServerRuntime?: () => DevServerRuntimeSync | null;
};

function activePreviewRow(
  sessionId: string,
  deps: PreviewWorktreeSyncDeps,
): { id: string; status: string } | null {
  const devServer = deps.getDevServerRuntime?.()?.getActiveBySessionId(sessionId);
  return devServer ? { id: devServer.id, status: devServer.status } : null;
}

/** User-started preview is booting or serving (must not be clobbered by agent preview blocks). */
export function sessionHasActiveUserPreview(
  sessionId: string,
  deps: PreviewWorktreeSyncDeps,
): boolean {
  const row = activePreviewRow(sessionId, deps);
  return row?.status === 'ready' || row?.status === 'starting';
}

/** Broadcast `preview_refresh` when a ready preview exists for this session. */
export function broadcastPreviewRefreshIfReady(
  sessionId: string,
  deps: PreviewWorktreeSyncDeps,
  opts?: { force?: boolean; reason?: string },
): void {
  const row = activePreviewRow(sessionId, deps);
  if (!row || row.status !== 'ready') return;
  if (getSessionPreviewPort(sessionId, deps) == null) return;

  const now = Date.now();
  if (!opts?.force) {
    const last = lastRefreshMs.get(sessionId);
    if (last != null && now - last < REFRESH_THROTTLE_MS) return;
  }
  lastRefreshMs.set(sessionId, now);

  try {
    deps.broadcast({
      type: 'agenthub_preview',
      kind: 'preview_refresh',
      sessionId,
      previewId: row.id,
      reason: opts?.reason ?? 'Worktree updated',
      refreshAt: now,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[preview-sync] refresh broadcast failed: ${msg}`);
  }
}

/** After a chat turn: nudge the iframe to reload when preview is ready. */
export function syncPreviewAfterWorktreeTurn(
  sessionId: string,
  deps: PreviewWorktreeSyncDeps,
): void {
  broadcastPreviewRefreshIfReady(sessionId, deps, {
    force: true,
    reason: 'Turn finished — reloading preview',
  });
}
