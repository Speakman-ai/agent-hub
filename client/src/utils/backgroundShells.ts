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

/** Interactive PTY tab id in SessionTerminalPane. */
export const PTY_TAB_ID = 'pty';

/** Cap finished job tabs so a long session does not accumulate dozens. */
export const MAX_FINISHED_TERMINAL_JOBS = 8;

const MAX_JOB_LOG_CHARS = 512 * 1024;

export type BackgroundShellLogsBySession = Record<string, Record<string, string>>;

export interface TerminalTab {
  id: string;
  kind: 'pty' | 'job';
  label: string;
  status?: BackgroundShellStatus;
}

function setSessionShells(
  prev: BackgroundShellsBySession,
  sessionId: string,
  shells: BackgroundShellView[],
): BackgroundShellsBySession {
  if (shells.length === 0) {
    if (!(sessionId in prev)) return prev;
    const next = { ...prev };
    delete next[sessionId];
    return next;
  }
  return { ...prev, [sessionId]: shells };
}

function trimFinishedJobs(shells: BackgroundShellView[]): BackgroundShellView[] {
  const running = shells.filter((shell) => shell.status === 'running');
  const finished = shells.filter((shell) => shell.status !== 'running');
  return sortShells([...running, ...finished.slice(-MAX_FINISHED_TERMINAL_JOBS)]);
}

function capLog(text: string): string {
  if (text.length <= MAX_JOB_LOG_CHARS) return text;
  return text.slice(text.length - MAX_JOB_LOG_CHARS);
}

/**
 * Keep running *and* recently finished shells for Terminal job tabs.
 * Chat's compact panel still uses `applyBackgroundShellUpdate`, which drops
 * terminal statuses so the pill only reflects work in flight.
 */
export function applyTerminalJobUpdate(
  prev: BackgroundShellsBySession,
  shell: unknown,
): BackgroundShellsBySession {
  if (!isShell(shell)) return prev;
  const sessionId = shell.session_id;
  const existing = prev[sessionId] ?? [];
  const without = existing.filter((candidate) => candidate.id !== shell.id);
  return setSessionShells(prev, sessionId, trimFinishedJobs([...without, shell]));
}

/**
 * Connect snapshot is running-only. Preserve finished job tabs the client
 * already had so a reconnect does not yank output the human was looking at.
 */
export function applyTerminalJobSnapshot(
  prev: BackgroundShellsBySession,
  sessions: unknown,
): BackgroundShellsBySession {
  const running = applyBackgroundShellSnapshot(sessions);
  const next: BackgroundShellsBySession = { ...running };
  for (const [sessionId, shells] of Object.entries(prev)) {
    const runningIds = new Set((next[sessionId] ?? []).map((row) => row.id));
    const finished = shells.filter((row) => row.status !== 'running' && !runningIds.has(row.id));
    if (finished.length === 0) continue;
    next[sessionId] = trimFinishedJobs([...(next[sessionId] ?? []), ...finished]);
  }
  return next;
}

export function dismissTerminalJob(
  prev: BackgroundShellsBySession,
  sessionId: string,
  shellId: string,
): BackgroundShellsBySession {
  const existing = prev[sessionId];
  if (!existing) return prev;
  const next = existing.filter((shell) => shell.id !== shellId);
  if (next.length === existing.length) return prev;
  return setSessionShells(prev, sessionId, next);
}

export function applyBackgroundShellLog(
  prev: BackgroundShellLogsBySession,
  event: { sessionId?: unknown; shellId?: unknown; chunk?: unknown },
): BackgroundShellLogsBySession {
  if (
    typeof event.sessionId !== 'string' ||
    typeof event.shellId !== 'string' ||
    typeof event.chunk !== 'string' ||
    event.chunk.length === 0
  ) {
    return prev;
  }
  const sessionLogs = prev[event.sessionId] ?? {};
  return {
    ...prev,
    [event.sessionId]: {
      ...sessionLogs,
      [event.shellId]: capLog((sessionLogs[event.shellId] ?? '') + event.chunk),
    },
  };
}

/**
 * Fold a REST log-tail snapshot into live chunks. Prefer the longer coherent
 * view: keep live data when it already extends the snapshot, otherwise take
 * the snapshot when it is a prefix/superset of what we have.
 */
export function mergeLogSnapshot(existing: string, snapshot: string): string {
  if (!snapshot) return existing;
  if (!existing) return capLog(snapshot);
  if (existing.startsWith(snapshot)) return existing;
  if (snapshot.startsWith(existing) || snapshot.endsWith(existing)) return capLog(snapshot);
  return existing;
}

export function applyBackgroundShellLogSnapshot(
  prev: BackgroundShellLogsBySession,
  sessionId: string,
  shellId: string,
  snapshot: string,
): BackgroundShellLogsBySession {
  const sessionLogs = prev[sessionId] ?? {};
  const merged = mergeLogSnapshot(sessionLogs[shellId] ?? '', snapshot);
  if (merged === (sessionLogs[shellId] ?? '')) return prev;
  return {
    ...prev,
    [sessionId]: { ...sessionLogs, [shellId]: merged },
  };
}

export function terminalJobLabel(shell: BackgroundShellView): string {
  const label = shell.label?.trim();
  if (label) return label;
  const cmd = shell.command.replace(/\s+/g, ' ').trim();
  if (cmd.length <= 24) return cmd || 'job';
  return `${cmd.slice(0, 23)}…`;
}

/** Shell PTY first, then one tab per Hub background shell. */
export function terminalTabsFromJobs(jobs: BackgroundShellView[] | undefined): TerminalTab[] {
  const tabs: TerminalTab[] = [{ id: PTY_TAB_ID, kind: 'pty', label: 'Shell' }];
  if (!jobs) return tabs;
  for (const job of jobs) {
    tabs.push({
      id: job.id,
      kind: 'job',
      label: terminalJobLabel(job),
      status: job.status,
    });
  }
  return tabs;
}

/**
 * Watched shells that just started: open/focus Terminal so turn-end is not
 * a silent chat with output buried behind an expand.
 */
export function shouldFocusTerminalJob(shell: unknown): shell is BackgroundShellView {
  return isShell(shell) && shell.status === 'running' && shell.watch === 1;
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
