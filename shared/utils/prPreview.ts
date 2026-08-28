// Pure view-state derivation for the PR-scoped preview control.
//
// The server's `GET /pulls/:number/preview/state` returns
// `{ sessionId, preview }` where `preview` is an `agenthub_preview` snapshot
// event (or null). This maps that (plus a transient client "starting" flag,
// set the instant the user clicks Enable and cleared once a poll returns a
// real snapshot) to the four render states the PR page shows.
//
// Keeping it pure makes the loading/ready/failed logic unit-testable without
// mounting the component or hitting the network.

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

/**
 * @param state The `/preview/state` response, or null before the first fetch.
 * @param opts  `pending: true` — the user just clicked Enable and no snapshot
 *   has come back yet, so render loading even though `preview` is still null.
 */
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
        // Unknown kind — treat as loading rather than claiming success.
        return { status: 'loading', url: null, reason: null, logTail };
    }
  }

  // No snapshot. A freshly-clicked Enable shows loading until the first poll;
  // otherwise there is simply no preview running.
  if (opts.pending) {
    return { status: 'loading', url: null, reason: null, logTail: [] };
  }
  return { status: 'idle', url: null, reason: null, logTail: [] };
}

/**
 * Whether the PR page should surface the preview control for this detail.
 * Native (Agent Hub-hosted) PRs only, only when the project has a dev server
 * configured (`preview_available`), and only while the PR is OPEN. Gating to
 * open PRs is load-bearing: a merged PR's preview is torn down automatically
 * on merge, so re-showing the control (or auto-starting via
 * `preview_default_on`) on a merged/closed PR would fight that teardown. The
 * server enforces the same open-only invariant on the start route.
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
 * Whether a live session worktree actually backs this PR's preview. A PR's
 * preview IS the worktree preview for the session that owns its head branch;
 * once that session is archived/deleted the worktree is reaped and
 * `POST /preview/start` 409s with "No live session worktree is associated with
 * this pull request". The server reports this as `preview_session_available`
 * so the client can show an explanatory note instead of an Enable button that
 * only errors.
 *
 * Defaults to `true` when the field is absent (older servers, or a non-native
 * detail shape) so this never hides a working control — `prPreviewAvailable`
 * remains the primary gate.
 */
export function prPreviewSessionLive(
  detail: { preview_session_available?: boolean } | null | undefined,
): boolean {
  return detail?.preview_session_available !== false;
}
