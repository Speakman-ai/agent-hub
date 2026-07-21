import './test/setup.js';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  __resetReactChainCancelForTests,
  clearReactChainCancel,
  ENTRY_TTL_MS,
  isReactChainCancelRequested,
  MAX_TRACKED,
  reactChainCancelTrackedCount,
  requestReactChainCancel,
} from './react-chain-cancel.js';

// Module singleton — reset before every test so counts are deterministic.
beforeEach(() => {
  __resetReactChainCancelForTests();
});

describe('react-chain-cancel', () => {
  it('is not cancelled by default', () => {
    expect(isReactChainCancelRequested('sess-default')).toBe(false);
  });

  it('marks and reports a requested cancel', () => {
    const sessionId = 'sess-request';
    requestReactChainCancel(sessionId);
    expect(isReactChainCancelRequested(sessionId)).toBe(true);
  });

  it('clears a requested cancel', () => {
    const sessionId = 'sess-clear';
    requestReactChainCancel(sessionId);
    clearReactChainCancel(sessionId);
    expect(isReactChainCancelRequested(sessionId)).toBe(false);
  });

  it('scopes the flag per session', () => {
    requestReactChainCancel('sess-a');
    expect(isReactChainCancelRequested('sess-a')).toBe(true);
    expect(isReactChainCancelRequested('sess-b')).toBe(false);
  });

  it('request is idempotent and a single clear resets it', () => {
    const sessionId = 'sess-idempotent';
    requestReactChainCancel(sessionId);
    requestReactChainCancel(sessionId);
    expect(isReactChainCancelRequested(sessionId)).toBe(true);
    clearReactChainCancel(sessionId);
    expect(isReactChainCancelRequested(sessionId)).toBe(false);
  });
});

describe('react-chain-cancel — memory bound', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reaps an abandoned flag once it exceeds the TTL (lazy, on read)', () => {
    vi.useFakeTimers();
    const sessionId = 'sess-ttl';
    requestReactChainCancel(sessionId);
    expect(reactChainCancelTrackedCount()).toBe(1);

    // Exactly at the TTL boundary: still live.
    vi.advanceTimersByTime(ENTRY_TTL_MS);
    expect(isReactChainCancelRequested(sessionId)).toBe(true);

    // Past the TTL: treated as absent and physically deleted on read.
    vi.advanceTimersByTime(1);
    expect(isReactChainCancelRequested(sessionId)).toBe(false);
    expect(reactChainCancelTrackedCount()).toBe(0);
  });

  it('a fresh request refreshes the TTL window', () => {
    vi.useFakeTimers();
    const sessionId = 'sess-ttl-refresh';
    requestReactChainCancel(sessionId);

    // Advance nearly a full TTL, then re-request → window restarts from now.
    vi.advanceTimersByTime(ENTRY_TTL_MS - 1);
    requestReactChainCancel(sessionId);

    // Past the ORIGINAL expiry but within the refreshed window: still live.
    vi.advanceTimersByTime(ENTRY_TTL_MS - 1);
    expect(isReactChainCancelRequested(sessionId)).toBe(true);
  });

  it('writes opportunistically sweep expired entries', () => {
    vi.useFakeTimers();
    requestReactChainCancel('sweep-old');
    expect(reactChainCancelTrackedCount()).toBe(1);

    // Expire it, then a request for a different session sweeps the stale one
    // WITHOUT anyone reading it (proves the write-time sweep, not lazy read).
    vi.advanceTimersByTime(ENTRY_TTL_MS + 1);
    requestReactChainCancel('sweep-new');
    expect(reactChainCancelTrackedCount()).toBe(1);
    expect(isReactChainCancelRequested('sweep-new')).toBe(true);
  });

  it('never retains more than MAX_TRACKED sessions, evicting the oldest first', () => {
    const overflow = 10;
    for (let i = 0; i < MAX_TRACKED + overflow; i++) {
      requestReactChainCancel(`cap-${i}`);
    }
    expect(reactChainCancelTrackedCount()).toBe(MAX_TRACKED);
    // Oldest inserts were evicted; the newest are retained.
    expect(isReactChainCancelRequested('cap-0')).toBe(false);
    expect(isReactChainCancelRequested(`cap-${MAX_TRACKED + overflow - 1}`)).toBe(true);
  });
});
