/**
 * Client-side helpers for the Gmail importance scan, shared by web and mobile.
 * Wire shapes mirror `server/routes/gmail-importance.ts`.
 */

export type GmailImportanceWindowDays = 1 | 7 | 30;
export type GmailImportanceAutoScan = 'off' | 'hourly' | 'every6h' | 'daily';

export interface GmailImportanceSettings {
  enabled: boolean;
  windowDays: GmailImportanceWindowDays;
  autoScan: GmailImportanceAutoScan;
  lastScanAt: string | null;
  lastScanStatus: 'idle' | 'running' | 'ok' | 'error';
  lastScanError: string | null;
  lastScanEngine: string | null;
  lastScanModel: string | null;
  lastScanFailover: string | null;
}

export interface GmailImportantThread {
  threadId: string;
  historyId: string | null;
  important: boolean;
  score: number;
  reason: string | null;
  subject: string | null;
  from: string | null;
  snippet: string | null;
  lastMessageAt: string | null;
  scannedAt: string;
}

export interface GmailImportanceState {
  settings: GmailImportanceSettings;
  running: boolean;
  threads: GmailImportantThread[];
}

export const GMAIL_IMPORTANCE_WINDOW_OPTIONS: ReadonlyArray<{
  value: GmailImportanceWindowDays;
  label: string;
}> = [
  { value: 1, label: '1 day' },
  { value: 7, label: '7 days' },
  { value: 30, label: '30 days' },
];

export const GMAIL_IMPORTANCE_AUTO_SCAN_OPTIONS: ReadonlyArray<{
  value: GmailImportanceAutoScan;
  label: string;
}> = [
  { value: 'off', label: 'Manual only' },
  { value: 'hourly', label: 'Every hour' },
  { value: 'every6h', label: 'Every 6 hours' },
  { value: 'daily', label: 'Daily' },
];

/** How often clients re-fetch state while a scan is running. */
export const GMAIL_IMPORTANCE_POLL_MS = 3000;

/**
 * Put the inbox list in display order: threads already shown in the Important
 * section are removed so a thread never appears twice.
 */
export function withoutImportantThreads<T extends { id: string | null }>(
  threads: readonly T[],
  important: readonly GmailImportantThread[],
): T[] {
  const pinned = new Set(important.map((t) => t.threadId));
  return threads.filter((t) => !t.id || !pinned.has(t.id));
}

/** Display name from an RFC 5322 From header: `"Alice" <a@x.com>` → `Alice`. */
export function senderName(from: string | null | undefined): string {
  const value = (from || '').trim();
  if (!value) return '(unknown sender)';
  const match = value.match(/^"?([^"<]+?)"?\s*<[^>]+>$/);
  if (match) return match[1].trim();
  return value.replace(/^<|>$/g, '');
}

function relative(iso: string, nowMs: number): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return 'unknown time';
  const mins = Math.max(0, Math.round((nowMs - ms) / 60_000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** One-line status under the Important header. */
export function importanceStatusLine(state: GmailImportanceState, nowMs = Date.now()): string {
  const s = state.settings;
  if (state.running) return 'Scanning your inbox…';
  if (s.lastScanStatus === 'error') {
    return `Last scan failed${s.lastScanAt ? ` ${relative(s.lastScanAt, nowMs)}` : ''}: ${
      s.lastScanError || 'unknown error'
    }`;
  }
  if (!s.lastScanAt) return 'Not scanned yet.';
  const via = s.lastScanEngine
    ? ` with ${s.lastScanEngine}${s.lastScanModel ? ` (${s.lastScanModel})` : ''}`
    : '';
  return `Scanned ${relative(s.lastScanAt, nowMs)}${via}.`;
}

/**
 * How often an idle pane re-fetches. Automated scans start on the server with
 * no client request, so an open pane must keep checking to pick them up.
 */
export const GMAIL_IMPORTANCE_IDLE_POLL_MS = 60_000;

export interface GmailImportanceSync {
  /** Load now and keep the pane in sync until `stop`. */
  start(): void;
  stop(): void;
  /** Load now (coalesced with an in-flight load), then reschedule. */
  refresh(): Promise<void>;
  /** Hand over state from a scan/settings response and reschedule. */
  accept(state: GmailImportanceState): void;
}

/**
 * The one place that decides when the Gmail importance pane re-fetches, shared
 * by web and mobile. Every outcome (load success, load failure, a state handed
 * over by a scan or settings call) schedules the next load, so the pane never
 * goes quiet: 3s while a scan runs, 60s while idle. A failed load keeps the
 * last known cadence instead of ending the loop.
 */
export function createGmailImportanceSync(opts: {
  load: () => Promise<GmailImportanceState>;
  onState: (state: GmailImportanceState) => void;
  onError: (message: string) => void;
  pollMs?: number;
  idlePollMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}): GmailImportanceSync {
  const pollMs = opts.pollMs ?? GMAIL_IMPORTANCE_POLL_MS;
  const idlePollMs = opts.idlePollMs ?? GMAIL_IMPORTANCE_IDLE_POLL_MS;
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let active = false;
  let running = false;
  let timer: unknown = null;
  // Bumped whenever a scan/settings response is accepted. A load that started
  // under an older generation carries state from before that mutation, so its
  // result is dropped instead of overwriting the newer state.
  let generation = 0;
  let inFlight: { promise: Promise<void>; generation: number } | null = null;

  const schedule = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
    if (!active) return;
    timer = setTimer(
      () => {
        timer = null;
        void refresh();
      },
      running ? pollMs : idlePollMs,
    );
  };

  const install = (state: GmailImportanceState) => {
    running = state.running;
    opts.onState(state);
    schedule();
  };

  const accept = (state: GmailImportanceState) => {
    if (!active) return;
    generation++;
    install(state);
  };

  const refresh = (): Promise<void> => {
    // Join a load only if nothing newer has been accepted since it started;
    // otherwise its answer is already stale and the caller needs a fresh one.
    if (inFlight && inFlight.generation === generation) return inFlight.promise;
    const startedAt = generation;
    const entry: { promise: Promise<void>; generation: number } = {
      generation: startedAt,
      promise: Promise.resolve(),
    };
    entry.promise = (async () => {
      try {
        const state = await opts.load();
        if (!active) return;
        if (startedAt !== generation) {
          // Superseded by a mutation response; keep its schedule as is.
          return;
        }
        install(state);
      } catch (err) {
        if (!active || startedAt !== generation) return;
        opts.onError((err as Error)?.message || 'Failed to load important mail');
        schedule();
      } finally {
        if (inFlight === entry) inFlight = null;
      }
    })();
    inFlight = entry;
    return entry.promise;
  };

  return {
    start() {
      active = true;
      void refresh();
    },
    stop() {
      active = false;
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
    refresh,
    accept,
  };
}
