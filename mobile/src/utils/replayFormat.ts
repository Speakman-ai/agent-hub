// replayFormat.ts — pure presentation helpers for the mobile Replays dashboard.
// 1:1 port of client/src/utils/replayFormat.ts so the web and mobile tables
// render identical labels. Kept framework-free for trivial unit testing.

/** Format an rrweb capture span (ms) as a compact `Xm Ys` / `Ys` / `0s` label
 *  (Datadog "Time Spent" column). Negative / non-finite → `0s`. */
export function formatReplayDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return '0s';
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

/** Human-readable byte size (compressed blob size column). */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value >= 100 || unit === 0 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unit]}`;
}

/** Strip a URL down to `host + path` for a dense table cell; returns the raw
 *  string when it isn't a parseable absolute URL, and '—' for empty. */
export function formatPageUrl(url: string | null | undefined): string {
  if (!url || typeof url !== 'string' || url.trim() === '') return '—';
  try {
    const u = new URL(url);
    const path = u.pathname === '/' ? '' : u.pathname;
    return `${u.host}${path}`;
  } catch {
    return url;
  }
}

/** Absolute wall-clock label for a numeric epoch-ms session start. `—` when
 *  missing/invalid. Mirrors RumSessionsExplorer's `absMs`. */
export function formatSessionStart(ms: number | null | undefined): string {
  if (ms == null) return '—';
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

/** Absolute label for a capture-grain `created_at` timestamp string. Mirrors
 *  ReplayCaptureTable's `absDate`. A bare SQLite datetime (`YYYY-MM-DD HH:MM:SS`)
 *  is normalized to ISO-8601 UTC (`T` separator + `Z`) before parsing —
 *  space-separated datetimes parse in V8/Node but are NOT guaranteed under
 *  Hermes, so we never hand `new Date` a non-ISO string. */
export function formatCaptureDate(ts: string | null | undefined): string {
  if (!ts) return '';
  const iso = ts.includes('T') ? ts : `${ts.replace(' ', 'T')}Z`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(ts);
  return d.toLocaleString();
}
