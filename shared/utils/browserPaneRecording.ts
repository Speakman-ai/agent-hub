/**
 * Demo recording state for the Agent browser pane (web + mobile). The server
 * records the human's actions while active and saves them as a session
 * artifact on Stop or at the time cap.
 */

export interface BrowserPaneRecording {
  active: boolean;
  startedAt: number | null;
  endsAt: number | null;
  steps: number;
}

export const BROWSER_PANE_RECORDING_IDLE: BrowserPaneRecording = {
  active: false,
  startedAt: null,
  endsAt: null,
  steps: 0,
};

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Parse a server `{type:'recording', state}` payload; malformed means idle. */
export function parseBrowserPaneRecording(raw: unknown): BrowserPaneRecording {
  if (!raw || typeof raw !== 'object') return BROWSER_PANE_RECORDING_IDLE;
  const r = raw as Record<string, unknown>;
  if (r.active !== true) return BROWSER_PANE_RECORDING_IDLE;
  return {
    active: true,
    startedAt: num(r.startedAt),
    endsAt: num(r.endsAt),
    steps: Math.max(0, Math.floor(num(r.steps) ?? 0)),
  };
}

/** `m:ss` left before the cap stops the recording. */
export function formatRecordingRemaining(rec: BrowserPaneRecording, now: number): string {
  if (!rec.active || rec.endsAt == null) return '0:00';
  const secs = Math.max(0, Math.ceil((rec.endsAt - now) / 1000));
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
}

/** Notice shown when the server saved a recording. */
export function browserPaneRecordingSavedNotice(raw: unknown): string {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const steps = num(r.steps) ?? 0;
  const capped = r.stopReason === 'time_limit';
  const what = `${steps} step${steps === 1 ? '' : 's'}`;
  return capped
    ? `Recording hit the 10 minute limit. Saved ${what} to Artifacts.`
    : `Recording saved to Artifacts (${what}).`;
}
