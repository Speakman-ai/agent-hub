// PR environment control: map `/preview/state` ({ environment }) plus a
// transient `pending` flag (Start just clicked) to idle/loading/ready/failed.

export type PrPreviewStatus = 'idle' | 'loading' | 'ready' | 'failed';
export type PrEnvironmentPhase = 'queued' | 'building' | 'ready' | 'failed' | 'stopped';

export interface PrPreviewViewState {
  status: PrPreviewStatus;
  /** The server-side lifecycle status, or null when there is no environment. */
  phase: PrEnvironmentPhase | null;
  url: string | null;
  /** Failure reason (failed) or why it stopped (idle after a stop). */
  reason: string | null;
  /** Human-readable status line for the panel. */
  label: string;
  /** A teardown failed and has not been retried successfully (Stop retries). */
  cleanupPending: boolean;
  logTail: string[];
}

interface PrEnvironmentLike {
  status?: string;
  url?: string | null;
  error?: string | null;
  stopReason?: string | null;
  cleanupPending?: boolean;
  logTail?: string[];
}

interface PreviewStateResponse {
  environment?: PrEnvironmentLike | null;
}

const STOP_REASONS: Record<string, string> = {
  merged: 'Stopped: the pull request was merged.',
  closed: 'Stopped: the pull request was closed.',
  manual: 'Stopped.',
  no_preview_config: 'Stopped: the head commit has no `preview:` block in deploy.yaml.',
};

/** `pending: true` means Start was just clicked and no state has arrived. */
export function prPreviewViewState(
  state: PreviewStateResponse | null | undefined,
  opts: { pending?: boolean } = {},
): PrPreviewViewState {
  const env = state?.environment ?? null;
  const logTail = env && Array.isArray(env.logTail) ? env.logTail : [];
  const cleanupPending = env?.cleanupPending === true;

  switch (env?.status) {
    case 'queued':
      return {
        status: 'loading',
        phase: 'queued',
        url: null,
        reason: null,
        label: 'Queued, waiting for a runner…',
        cleanupPending,
        logTail,
      };
    case 'building':
      return {
        status: 'loading',
        phase: 'building',
        url: null,
        reason: null,
        label: 'Building environment…',
        cleanupPending,
        logTail,
      };
    case 'ready':
      return {
        status: 'ready',
        phase: 'ready',
        url: env.url || null,
        reason: null,
        label: 'Environment ready',
        cleanupPending,
        logTail,
      };
    case 'failed':
      return {
        status: 'failed',
        phase: 'failed',
        url: null,
        reason: env.error || 'The PR environment failed to start.',
        label: 'Environment failed',
        cleanupPending,
        logTail,
      };
    case 'stopped':
      if (opts.pending) break;
      return {
        status: 'idle',
        phase: 'stopped',
        url: null,
        reason: cleanupPending
          ? `Teardown did not finish${env.error ? ` (${env.error})` : ''}. Stop again to retry.`
          : (STOP_REASONS[env.stopReason ?? ''] ?? 'Stopped.'),
        label: 'Stopped',
        cleanupPending,
        logTail,
      };
    default:
      break;
  }

  if (opts.pending) {
    return {
      status: 'loading',
      phase: null,
      url: null,
      reason: null,
      label: 'Starting…',
      cleanupPending,
      logTail: [],
    };
  }
  return {
    status: 'idle',
    phase: null,
    url: null,
    reason: null,
    label: 'Not running',
    cleanupPending,
    logTail: [],
  };
}

type PrPreviewDetail =
  | {
      preview_available?: boolean;
      pr?: { state?: string; merged_at?: string | null } | null;
    }
  | null
  | undefined;

/**
 * Show the PR environment panel. The server decides (`preview_available`):
 * on an open PR when the head declares `preview:` or an environment needs
 * attention; on a closed/merged PR only while something is still running or
 * its teardown is unconfirmed, so the error, logs, and Retry teardown stay
 * reachable. Works for Hub-hosted and GitHub PRs.
 */
export function prPreviewAvailable(detail: PrPreviewDetail): boolean {
  return detail?.preview_available === true;
}

/** Start/Retry is only offered on an open, unmerged PR whose panel is shown. */
export function prPreviewCanStart(detail: PrPreviewDetail): boolean {
  if (!prPreviewAvailable(detail)) return false;
  const pr = detail?.pr;
  return String(pr?.state || '').toLowerCase() === 'open' && !pr?.merged_at;
}

/**
 * How long to wait before re-reading `/preview/state`. Fast while a build is
 * in flight; slower otherwise, because the server can rebuild (a push to the
 * PR) or tear down (merge, close) a ready/failed/stopped environment at any
 * time without the client asking.
 */
export const PR_ENV_POLL_ACTIVE_MS = 2500;
export const PR_ENV_POLL_IDLE_MS = 15000;

export function prEnvironmentPollMs(status: PrPreviewStatus): number {
  return status === 'loading' ? PR_ENV_POLL_ACTIVE_MS : PR_ENV_POLL_IDLE_MS;
}

export interface PrEnvironmentPollerOptions<T> {
  /** One `/preview/state` read. May reject; the loop keeps going. */
  fetchState: () => Promise<T>;
  /** Called with each successful result while the poller is running. */
  onState: (state: T) => void;
  /** Delay before the next read, evaluated after each read settles. */
  nextDelayMs: () => number;
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
}

/**
 * Poll the PR environment until stopped. Reads immediately, then schedules
 * the next read after every read settles, whether it succeeded, failed, or
 * returned the same state. The loop does not depend on UI state changing, so
 * a transient network error or an unchanged response cannot end it. Returns a
 * stop function; results that land after stop are dropped.
 */
export function startPrEnvironmentPoller<T>(opts: PrEnvironmentPollerOptions<T>): () => void {
  const schedule = opts.schedule ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const cancel =
    opts.cancel ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let stopped = false;
  let handle: unknown = null;

  const tick = async (): Promise<void> => {
    handle = null;
    try {
      const state = await opts.fetchState();
      if (!stopped) opts.onState(state);
    } catch {
      // Transient failure: keep the last shown state and try again.
    } finally {
      if (!stopped) handle = schedule(() => void tick(), opts.nextDelayMs());
    }
  };

  void tick();
  return () => {
    stopped = true;
    if (handle != null) cancel(handle);
    handle = null;
  };
}
