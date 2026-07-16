/**
 * Format a server-log entry for display in the mobile Server Logs panel.
 *
 * The server emits `LogEntry` objects (`{ ts, level, message }`) both from the
 * REST snapshot (`GET /api/server-logs`) and the live WebSocket broadcast
 * (`{ type: 'server-log', entry }`). This collapses one entry to a single
 * monospace line: `HH:MM:SS LEVEL  message`. Defensive about missing fields and
 * legacy `{ line | text }` shapes so a malformed frame never throws.
 *
 * @param {string | { ts?: string, level?: string, message?: string, line?: string, text?: string } | null | undefined} entry
 * @returns {string}
 */
/**
 * Order server-log lines for display in the mobile Server Logs panel.
 *
 * Lines accumulate chronologically (oldest → newest, newest appended). The
 * panel shows the newest line first, so display order is the reverse of
 * insertion order. Returns a new array; the input is never mutated.
 *
 * @param {ReadonlyArray<T>} lines
 * @returns {T[]}
 */
export function orderServerLogsNewestFirst(lines: any) {
    return Array.isArray(lines) ? lines.slice().reverse() : [];
}
export function formatServerLogLine(entry: any) {
    if (entry == null)
        return '';
    if (typeof entry === 'string')
        return entry;
    const message = typeof entry.message === 'string'
        ? entry.message
        : typeof entry.line === 'string'
            ? entry.line
            : typeof entry.text === 'string'
                ? entry.text
                : '';
    const level = typeof entry.level === 'string' ? entry.level.toUpperCase() : '';
    // `ts` is an ISO 8601 string (e.g. 2026-06-17T20:55:07.123Z); slice the
    // HH:MM:SS clock portion without paying for Date parsing / timezone math.
    const time = typeof entry.ts === 'string' && entry.ts.length >= 19 ? entry.ts.slice(11, 19) : '';
    const prefix = [time, level].filter(Boolean).join(' ');
    return prefix ? `${prefix}  ${message}` : message;
}
