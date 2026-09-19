// PR preview control: map `/preview/state` plus a transient `pending` flag
// (Enable just clicked) to idle/loading/ready/failed.

export type PrPreviewStatus = 'idle' | 'loading' | 'ready' | 'failed';

export interface PrPreviewViewState {
  status: PrPreviewStatus;
  url: string | null;
  reason: string | null;
  logTail: string[];
}

interface PreviewStateResponse {
  sessionId?: string | null;
  preview?: {
    kind?: string;
    fullUrl?: string;
    previewUrl?: string;
    error?: string;
    logTail?: string[];
  } | null;
}

/** `pending: true` means Enable was just clicked and no snapshot has arrived. */
export function prPreviewViewState(
  state: PreviewStateResponse | null | undefined,
  opts: { pending?: boolean } = {},
): PrPreviewViewState {
  const preview = state && state.preview ? state.preview : null;
  const logTail = preview && Array.isArray(preview.logTail) ? preview.logTail : [];

  if (preview) {
    switch (preview.kind) {
      case 'preview':
        return {
          status: 'ready',
          url: preview.fullUrl || preview.previewUrl || null,
          reason: null,
          logTail,
        };
      case 'preview_starting':
        return { status: 'loading', url: null, reason: null, logTail };
      case 'preview_failed':
        return {
          status: 'failed',
          url: null,
          reason: preview.error || 'Preview failed to start.',
          logTail,
        };
      default:
        // Unknown kind: treat as loading, not success.
        return { status: 'loading', url: null, reason: null, logTail };
    }
  }

  // No snapshot. Fresh Enable → loading; otherwise idle.
  if (opts.pending) {
    return { status: 'loading', url: null, reason: null, logTail: [] };
  }
  return { status: 'idle', url: null, reason: null, logTail: [] };
}

/**
 * Native Hub PRs only, with a configured dev server, and only while OPEN.
 * A merged PR's preview is torn down on merge.
 */
export function prPreviewAvailable(
  detail:
    | {
        source?: string;
        preview_available?: boolean;
        pr?: { state?: string; merged_at?: string | null } | null;
      }
    | null
    | undefined,
): boolean {
  if (!detail || detail.source !== 'agenthub' || detail.preview_available !== true) return false;
  const pr = detail.pr;
  const isOpen = String(pr?.state || '').toLowerCase() === 'open';
  return isOpen && !pr?.merged_at;
}

/**
 * True unless the server reports no live session worktree (`preview_session_available`).
 * Defaults true when the field is absent so older servers keep a working control.
 */
export function prPreviewSessionLive(
  detail: { preview_session_available?: boolean } | null | undefined,
): boolean {
  return detail?.preview_session_available !== false;
}
