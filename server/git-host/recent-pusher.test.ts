import '../test/setup.js';
import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordPusher,
  releasePusher,
  takeRecentPusher,
  __clearRecentPushers,
  RECENT_PUSHER_TTL_MS,
} from './recent-pusher.js';

describe('recent-pusher', () => {
  beforeEach(() => __clearRecentPushers());

  it('attributes a single in-flight push to its user', () => {
    recordPusher('proj', 'ryan');
    expect(takeRecentPusher('proj')).toBe('ryan');
  });

  it('returns null when nothing is in flight', () => {
    expect(takeRecentPusher('proj')).toBeNull();
  });

  it('keeps reads stable until the request is released (not consumed on take)', () => {
    const token = recordPusher('proj', 'ryan');
    // A push can fire more than one notify; reads stay consistent.
    expect(takeRecentPusher('proj')).toBe('ryan');
    expect(takeRecentPusher('proj')).toBe('ryan');
    releasePusher('proj', token);
    expect(takeRecentPusher('proj')).toBeNull();
  });

  it('keeps pushers separate per project', () => {
    recordPusher('a', 'ryan');
    recordPusher('b', 'sam');
    expect(takeRecentPusher('b')).toBe('sam');
    expect(takeRecentPusher('a')).toBe('ryan');
  });

  it('declines attribution when two distinct users push the same project concurrently', () => {
    const tA = recordPusher('proj', 'ryan');
    const tB = recordPusher('proj', 'sam');
    // Both overlapping notifies see ambiguity → neither is cross-attributed.
    expect(takeRecentPusher('proj')).toBeNull();
    // Once one request ends, the remaining single push attributes cleanly.
    releasePusher('proj', tA);
    expect(takeRecentPusher('proj')).toBe('sam');
    releasePusher('proj', tB);
    expect(takeRecentPusher('proj')).toBeNull();
  });

  it('declines when an anonymous push overlaps a user push (no user leakage)', () => {
    const tUser = recordPusher('proj', 'ryan');
    const tAnon = recordPusher('proj', null);
    // The anonymous push participates in ambiguity, so ryan is never
    // attributed to the anonymous push's notify (or vice versa).
    expect(takeRecentPusher('proj')).toBeNull();
    releasePusher('proj', tAnon);
    expect(takeRecentPusher('proj')).toBe('ryan');
    releasePusher('proj', tUser);
  });

  it('never attributes an anonymous-only push', () => {
    recordPusher('proj', null);
    expect(takeRecentPusher('proj')).toBeNull();
  });

  it('attributes concurrent pushes from the SAME user (unambiguous identity)', () => {
    recordPusher('proj', 'ryan');
    recordPusher('proj', 'ryan');
    expect(takeRecentPusher('proj')).toBe('ryan');
  });

  it('releasePusher removes only its own entry', () => {
    const tA = recordPusher('proj', 'ryan');
    recordPusher('proj', 'ryan'); // second entry, same user
    releasePusher('proj', tA);
    // One ryan entry remains → still attributes.
    expect(takeRecentPusher('proj')).toBe('ryan');
  });

  it('expires entries older than the TTL backstop', () => {
    const t0 = 1_000_000;
    recordPusher('proj', 'ryan', t0);
    expect(takeRecentPusher('proj', t0 + RECENT_PUSHER_TTL_MS + 1)).toBeNull();
  });

  it('honors a fresh entry within the TTL window', () => {
    const t0 = 1_000_000;
    recordPusher('proj', 'ryan', t0);
    expect(takeRecentPusher('proj', t0 + RECENT_PUSHER_TTL_MS - 1)).toBe('ryan');
  });

  it('an expired overlapping entry no longer forces an ambiguous decline', () => {
    const t0 = 1_000_000;
    recordPusher('proj', 'sam', t0); // stale (e.g. a rejected push that never released)
    recordPusher('proj', 'ryan', t0 + RECENT_PUSHER_TTL_MS); // fresh
    // At a time where only ryan's entry is still live, sam is pruned and
    // ryan attributes cleanly instead of being declined as ambiguous.
    expect(takeRecentPusher('proj', t0 + RECENT_PUSHER_TTL_MS + 1)).toBe('ryan');
  });
});
