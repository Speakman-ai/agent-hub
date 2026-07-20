/**
 * Server Log Capture — intercepts console.log/warn/error, stores in a ring buffer,
 * and broadcasts new lines via WebSocket.
 */

import type { BroadcastFn } from './types.js';

export interface LogEntry {
  ts: string;
  level: 'log' | 'warn' | 'error';
  message: string;
}

const MAX_BUFFER = 2000;
const buffer: LogEntry[] = [];

let broadcast: BroadcastFn | null = null;
let forwarder: ((entry: LogEntry) => void) | null = null;
let installed = false;

const origLog = console.log.bind(console);
const origWarn = console.warn.bind(console);
const origError = console.error.bind(console);

function formatArgs(args: unknown[]): string {
  return args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
}

function pushEntry(level: LogEntry['level'], args: unknown[]): void {
  const entry: LogEntry = {
    ts: new Date().toISOString(),
    level,
    message: formatArgs(args),
  };
  buffer.push(entry);
  if (buffer.length > MAX_BUFFER) {
    buffer.splice(0, buffer.length - MAX_BUFFER);
  }
  if (broadcast) {
    broadcast({ type: 'server-log', entry });
  }
  if (forwarder) {
    // The forwarder must be non-throwing; guard anyway so a shipper bug can
    // never break console output or re-enter this path.
    try {
      forwarder(entry);
    } catch {
      /* swallow — never let log-shipping crash the logger */
    }
  }
}

/** Install console intercepts. Call once at startup, before any logging. */
export function installLogCapture(): void {
  if (installed) return;
  installed = true;
  console.log = (...args: unknown[]) => {
    origLog(...args);
    pushEntry('log', args);
  };
  console.warn = (...args: unknown[]) => {
    origWarn(...args);
    pushEntry('warn', args);
  };
  console.error = (...args: unknown[]) => {
    origError(...args);
    pushEntry('error', args);
  };
}

/** Wire up the WebSocket broadcast so new entries are pushed to clients. */
export function setLogBroadcast(fn: BroadcastFn): void {
  broadcast = fn;
}

/**
 * Register a forwarder invoked for every captured log entry (e.g. to ship the
 * Hub's own logs to Agent Hub's log-ingest endpoint). Pass `null` to detach.
 * The forwarder MUST NOT throw and MUST NOT emit via `console.*` (that would
 * re-enter this capture path); `pushEntry` guards against throws regardless.
 */
export function setLogForwarder(fn: ((entry: LogEntry) => void) | null): void {
  forwarder = fn;
}

/** Return a snapshot of the current buffer (for REST endpoint). */
export function getLogBuffer(): LogEntry[] {
  return [...buffer];
}

/** Clear all entries from the log buffer. */
export function clearLogBuffer(): void {
  buffer.length = 0;
}
