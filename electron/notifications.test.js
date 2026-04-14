import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dedupKey, pruneRecent, recentNotifications, DEDUP_WINDOW_MS } from './notifications.js';

// We test the pure utility functions here. The Electron Notification class
// is not available outside the Electron main process, so showNotification
// and createNotificationHandlers are integration-tested in the Electron app.

describe('dedupKey', () => {
  it('creates a key from title and body', () => {
    expect(dedupKey('Hello', 'World')).toBe('Hello::World');
  });

  it('handles undefined body', () => {
    expect(dedupKey('Title', undefined)).toBe('Title::');
  });

  it('handles empty body', () => {
    expect(dedupKey('Title', '')).toBe('Title::');
  });

  it('distinguishes different titles', () => {
    expect(dedupKey('A', 'body')).not.toBe(dedupKey('B', 'body'));
  });

  it('distinguishes different bodies', () => {
    expect(dedupKey('title', 'a')).not.toBe(dedupKey('title', 'b'));
  });
});

describe('pruneRecent', () => {
  beforeEach(() => {
    recentNotifications.clear();
  });

  it('removes entries older than the dedup window', () => {
    const oldTs = Date.now() - DEDUP_WINDOW_MS - 100;
    recentNotifications.set('old::entry', oldTs);
    recentNotifications.set('new::entry', Date.now());

    pruneRecent();

    expect(recentNotifications.has('old::entry')).toBe(false);
    expect(recentNotifications.has('new::entry')).toBe(true);
  });

  it('keeps entries within the dedup window', () => {
    recentNotifications.set('recent::entry', Date.now() - 100);

    pruneRecent();

    expect(recentNotifications.has('recent::entry')).toBe(true);
  });

  it('handles empty map', () => {
    expect(() => pruneRecent()).not.toThrow();
    expect(recentNotifications.size).toBe(0);
  });
});
