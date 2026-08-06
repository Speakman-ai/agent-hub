/**
 * Client-side state for Hub-owned background shells and the watch-loop
 * indicator.
 *
 * The server owns these processes so they survive the chat turn that started
 * them (see `server/background-shells/`). Two WebSocket messages keep the
 * client in step: a `background-shells-snapshot` on connect that replaces the
 * whole map, and `background_shell_update` for each live transition. The
 * snapshot matters more than it looks — a shell can run for hours, so a tab
 * sleep or Wi-Fi switch will drop every update in between, and without a
 * replace-the-world message the indicator would be stuck on stale state.
 *
 * Kept as pure functions so the reducer logic is unit-testable without
 * mounting the app.
 */

export type BackgroundShellStatus = 'running' | 'exited' | 'failed' | 'stopped';

export interface BackgroundShellView {
  id: string;
  session_id: string;
  command: string;
  label: string | null;
  status: BackgroundShellStatus;
  exit_code: number | null;
  /** 1 while the watch loop will wake this session when the shell finishes. */
  watch: number;
  created_at: string;
  updated_at: string;
}

export type BackgroundShellsBySession = Record<string, BackgroundShellView[]>;

export interface BackgroundShellSnapshotEntry {
  sessionId: string;
  shells: BackgroundShellView[];
}

function isShell(value: unknown): value is BackgroundShellView {
  if (!value || typeof value !== 'object') return false;
  const shell = value as Partial<BackgroundShellView>;
  return typeof shell.id === 'string' && typeof shell.session_id === 'string';
}

/** Newest last, so a panel reads top-to-bottom in launch order. */
function sortShells(shells: BackgroundShellView[]): BackgroundShellView[] {
  return [...shells].sort((a, b) => a.created_at.localeCompare(b.created_at));
}

/**
 * Replace the entire map from a connect snapshot. Sessions absent from the
 * snapshot are dropped — that is the point: their shells finished while this
 * client was disconnected.
 */
export function applyBackgroundShellSnapshot(sessions: unknown): BackgroundShellsBySession {
  if (!Array.isArray(sessions)) return {};
  const next: BackgroundShellsBySession = {};
  for (const entry of sessions) {
    if (!entry || typeof entry !== 'object') continue;
    const { sessionId, shells } = entry as Partial<BackgroundShellSnapshotEntry>;
    if (typeof sessionId !== 'string' || !Array.isArray(shells)) continue;
    const valid = shells.filter(isShell);
    if (valid.length > 0) next[sessionId] = sortShells(valid);
  }
  return next;
}

/**
 * Fold one live update in. A shell that reached a terminal status is removed
 * rather than kept as a tombstone: the panel and the indicator are both about
 * work in flight, and the transcript already records completions.
 */
export function applyBackgroundShellUpdate(
  prev: BackgroundShellsBySession,
  shell: unknown,
): BackgroundShellsBySession {
  if (!isShell(shell)) return prev;
  const sessionId = shell.session_id;
  const existing = prev[sessionId] ?? [];
  const without = existing.filter((candidate) => candidate.id !== shell.id);

  if (shell.status !== 'running') {
    if (without.length === existing.length) return prev;
    if (without.length === 0) {
      const next = { ...prev };
      delete next[sessionId];
      return next;
    }
    return { ...prev, [sessionId]: without };
  }

  return { ...prev, [sessionId]: sortShells([...without, shell]) };
}

export interface WatchIndicator {
  /** Running shells for the session, watched or not. */
  running: number;
  /** Running shells that will wake the session when they finish. */
  watching: number;
}

/**
 * Indicator state for one session, or null when there is nothing to show.
 *
 * Returning null rather than a zeroed object keeps the call sites honest —
 * a pill should not render at all when no shell is running.
 */
export function deriveWatchIndicator(
  shells: BackgroundShellView[] | undefined,
): WatchIndicator | null {
  if (!shells || shells.length === 0) return null;
  const running = shells.filter((shell) => shell.status === 'running');
  if (running.length === 0) return null;
  return {
    running: running.length,
    watching: running.filter((shell) => shell.watch === 1).length,
  };
}

/** Short pill copy, e.g. "2 watching" / "1 running". */
export function watchIndicatorLabel(indicator: WatchIndicator): string {
  if (indicator.watching > 0) return `${indicator.watching} watching`;
  return `${indicator.running} running`;
}

/** Tooltip copy explaining what the pill means for this session. */
export function watchIndicatorTitle(indicator: WatchIndicator): string {
  if (indicator.watching > 0) {
    const noun = indicator.watching === 1 ? 'shell' : 'shells';
    const verb = indicator.watching === 1 ? 'it finishes' : 'they finish';
    return `Watching ${indicator.watching} background ${noun} — this session resumes automatically when ${verb}.`;
  }
  const noun = indicator.running === 1 ? 'shell' : 'shells';
  return `${indicator.running} background ${noun} running (not watched — this session will not resume on its own).`;
}
