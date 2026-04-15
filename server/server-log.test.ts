import { describe, it, expect, beforeEach } from 'vitest';
import { clearLogBuffer, getLogBuffer, installLogCapture, setLogBroadcast } from './server-log.js';
import type { LogEntry } from './server-log.js';

describe('server-log', () => {
  // installLogCapture is already called in index.ts, but we call it here
  // to ensure the intercepts are installed for isolated test runs.
  beforeEach(() => {
    clearLogBuffer();
  });

  it('captures console.log entries in the buffer', () => {
    installLogCapture();
    console.log('test message');
    const buf = getLogBuffer();
    const last = buf[buf.length - 1];
    expect(last).toBeDefined();
    expect(last.level).toBe('log');
    expect(last.message).toBe('test message');
    expect(last.ts).toBeTruthy();
  });

  it('captures console.warn and console.error', () => {
    installLogCapture();
    console.warn('warning msg');
    console.error('error msg');
    const buf = getLogBuffer();
    const warns = buf.filter((e: LogEntry) => e.level === 'warn' && e.message === 'warning msg');
    const errors = buf.filter((e: LogEntry) => e.level === 'error' && e.message === 'error msg');
    expect(warns.length).toBeGreaterThanOrEqual(1);
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });

  it('broadcasts new entries via setLogBroadcast', () => {
    installLogCapture();
    const received: Record<string, unknown>[] = [];
    setLogBroadcast((data) => received.push(data));

    console.log('broadcast test');

    expect(received.length).toBeGreaterThanOrEqual(1);
    const entry = received.find((r) => (r.entry as LogEntry)?.message === 'broadcast test');
    expect(entry).toBeDefined();
    expect(entry!.type).toBe('server-log');

    // Clean up
    setLogBroadcast(() => {});
  });

  it('returns buffer via getLogBuffer for REST endpoint', () => {
    installLogCapture();
    console.log('rest test');
    const buf = getLogBuffer();
    expect(Array.isArray(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(0);
  });
});
