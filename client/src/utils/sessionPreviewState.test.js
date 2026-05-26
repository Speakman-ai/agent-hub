import { describe, it, expect, vi } from 'vitest';
import {
  derivePaneState,
  createActivityTouch,
  clampPaneWidth,
  paneOpenStorageKey,
  paneWidthStorageKey,
  previewIdFromEvent,
  clearSessionPreviewStorage,
  previewIframeSrc,
  previewProxySessionIdFromUrl,
  withPreviewTicket,
} from './sessionPreviewState.js';

describe('derivePaneState', () => {
  it('maps a `preview` event to `ready` with the full URL preferred', () => {
    const state = derivePaneState({
      kind: 'preview',
      previewUrl: 'http://localhost:4101',
      fullUrl: 'http://localhost:4101/board',
      port: 4101,
      route: '/board',
      target: 'web',
      previewId: 'p1',
      screenshotPath: '/uploads/p1.png',
      agentReason: 'show me the new board',
    });
    expect(state.status).toBe('ready');
    expect(state.url).toBe('http://localhost:4101/board');
    expect(state.port).toBe(4101);
    expect(state.route).toBe('/board');
    expect(state.target).toBe('web');
    expect(state.previewId).toBe('p1');
    expect(state.screenshotPath).toBe('/uploads/p1.png');
    expect(state.agentReason).toBe('show me the new board');
  });

  it('falls back to previewUrl when fullUrl is missing', () => {
    const state = derivePaneState({
      kind: 'preview',
      previewUrl: 'http://localhost:4101',
      port: 4101,
    });
    expect(state.url).toBe('http://localhost:4101');
  });

  it('maps `preview_failed` to `failed` with logTail array', () => {
    const state = derivePaneState({
      kind: 'preview_failed',
      previewId: 'p2',
      error: 'health timeout',
      logTail: ['line 1', 'line 2'],
      target: 'web',
    });
    expect(state.status).toBe('failed');
    expect(state.error).toBe('health timeout');
    expect(state.logTail).toEqual(['line 1', 'line 2']);
    expect(state.previewId).toBe('p2');
  });

  it('coerces a non-array logTail to []', () => {
    const state = derivePaneState({ kind: 'preview_failed' });
    expect(state.logTail).toEqual([]);
  });

  it('maps `preview_unavailable` and preserves the wizard intent', () => {
    const state = derivePaneState({
      kind: 'preview_unavailable',
      unavailableReason: 'preview-disabled',
      wizard: { view: 'settings:preview', projectId: 'agent-hub' },
      wizardUrl: '/projects/agent-hub/settings/preview',
      target: 'web',
    });
    expect(state.status).toBe('unavailable');
    expect(state.reason).toBe('preview-disabled');
    expect(state.wizard).toEqual({ view: 'settings:preview', projectId: 'agent-hub' });
    expect(state.wizardUrl).toBe('/projects/agent-hub/settings/preview');
  });

  it('returns `idle` for null/undefined/empty inputs', () => {
    expect(derivePaneState(null)).toEqual({ status: 'idle' });
    expect(derivePaneState(undefined)).toEqual({ status: 'idle' });
    expect(derivePaneState({})).toEqual({ status: 'idle' });
    expect(derivePaneState('not an object')).toEqual({ status: 'idle' });
  });

  it('returns `idle` for an unknown kind', () => {
    expect(derivePaneState({ kind: 'preview_weird' })).toEqual({ status: 'idle' });
  });
});

describe('createActivityTouch', () => {
  it('fires once and then throttles subsequent calls inside the window', () => {
    const cb = vi.fn();
    let clock = 1000;
    const notify = createActivityTouch(cb, 30_000, () => clock);
    expect(notify()).toBe(true);
    expect(cb).toHaveBeenCalledTimes(1);
    // Rapid mousemove within the window — must not re-fire.
    clock = 1500;
    expect(notify()).toBe(false);
    clock = 2000;
    expect(notify()).toBe(false);
    expect(cb).toHaveBeenCalledTimes(1);
    // After 30 s elapses, fires again.
    clock = 31_001;
    expect(notify()).toBe(true);
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it('swallows callback errors so a flaky touch never breaks the iframe', () => {
    const cb = vi.fn(() => {
      throw new Error('runtime down');
    });
    let clock = 0;
    const notify = createActivityTouch(cb, 1000, () => clock);
    expect(() => notify()).not.toThrow();
    // Even on error, the clock advances — caller pays the 1 s cooldown.
    clock = 500;
    expect(notify()).toBe(false);
    clock = 1001;
    expect(notify()).toBe(true);
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it('treats 0 ms intervalMs as no-throttle', () => {
    const cb = vi.fn();
    let clock = 0;
    const notify = createActivityTouch(cb, 0, () => clock);
    notify();
    clock = 1;
    notify();
    clock = 2;
    notify();
    expect(cb).toHaveBeenCalledTimes(3);
  });
});

describe('clampPaneWidth', () => {
  it('returns the value when within bounds', () => {
    expect(clampPaneWidth(640)).toBe(640);
  });
  it('clamps below the min', () => {
    expect(clampPaneWidth(100, { min: 320 })).toBe(320);
  });
  it('clamps above the max', () => {
    expect(clampPaneWidth(9999, { max: 1400 })).toBe(1400);
  });
  it('returns the fallback for non-finite inputs', () => {
    expect(clampPaneWidth('not a number', { fallback: 560 })).toBe(560);
    expect(clampPaneWidth(NaN, { fallback: 560 })).toBe(560);
    expect(clampPaneWidth(Infinity, { fallback: 560, max: 1400 })).toBe(1400);
  });
});

describe('paneOpenStorageKey / paneWidthStorageKey', () => {
  it('formats per-session keys deterministically', () => {
    expect(paneOpenStorageKey('s-1')).toBe('previewPaneOpen:s-1');
    expect(paneWidthStorageKey('s-1')).toBe('previewPaneWidth:s-1');
  });
  it('returns null for falsy session ids so storage writes are skipped', () => {
    expect(paneOpenStorageKey('')).toBe(null);
    expect(paneOpenStorageKey(null)).toBe(null);
    expect(paneOpenStorageKey(undefined)).toBe(null);
    expect(paneWidthStorageKey('')).toBe(null);
  });
});

describe('previewIframeSrc', () => {
  it('appends a cache-buster query param', () => {
    expect(previewIframeSrc('http://localhost:4100/', 42)).toBe('http://localhost:4100/?_ah=42');
  });

  it('preserves an existing query string', () => {
    expect(previewIframeSrc('http://localhost:4100/?foo=1', 99)).toBe(
      'http://localhost:4100/?foo=1&_ah=99',
    );
  });
});

describe('previewProxySessionIdFromUrl', () => {
  it('extracts the session id from a hub-proxied URL', () => {
    expect(
      previewProxySessionIdFromUrl('https://hub.example.com/api/sessions/sess-1/preview/proxy/'),
    ).toBe('sess-1');
    expect(
      previewProxySessionIdFromUrl(
        'https://hub.example.com/api/sessions/abc/preview/proxy/main.js',
      ),
    ).toBe('abc');
    expect(
      previewProxySessionIdFromUrl(
        'https://hub.example.com/api/sessions/abc/preview/proxy?ticket=x',
      ),
    ).toBe('abc');
    expect(
      previewProxySessionIdFromUrl('https://hub.example.com/api/sessions/sess%2D2/preview/proxy/'),
    ).toBe('sess-2');
  });

  it('returns null for local-dev URLs and non-matching paths', () => {
    expect(previewProxySessionIdFromUrl('http://localhost:4101/')).toBeNull();
    expect(previewProxySessionIdFromUrl('http://localhost:4101/main.js')).toBeNull();
    expect(
      previewProxySessionIdFromUrl('https://hub.example.com/api/sessions/abc/preview/start'),
    ).toBeNull();
    expect(previewProxySessionIdFromUrl('')).toBeNull();
    expect(previewProxySessionIdFromUrl(null)).toBeNull();
    expect(previewProxySessionIdFromUrl(undefined)).toBeNull();
  });

  it('returns null for malformed URLs', () => {
    expect(previewProxySessionIdFromUrl('not a url')).toBeNull();
  });
});

describe('withPreviewTicket', () => {
  it('appends ticket query param', () => {
    expect(withPreviewTicket('https://hub.example.com/api/sessions/s1/preview/proxy/', 'tk')).toBe(
      'https://hub.example.com/api/sessions/s1/preview/proxy/?ticket=tk',
    );
  });

  it('preserves existing query params (e.g. the cache buster)', () => {
    expect(
      withPreviewTicket('https://hub.example.com/api/sessions/s1/preview/proxy/?_ah=42', 'tk'),
    ).toBe('https://hub.example.com/api/sessions/s1/preview/proxy/?_ah=42&ticket=tk');
  });

  it('overrides an existing ticket param (re-mint case)', () => {
    expect(
      withPreviewTicket(
        'https://hub.example.com/api/sessions/s1/preview/proxy/?ticket=stale',
        'fresh',
      ),
    ).toBe('https://hub.example.com/api/sessions/s1/preview/proxy/?ticket=fresh');
  });

  it('returns the input unchanged when ticket or url is missing', () => {
    expect(withPreviewTicket('', 'tk')).toBe('');
    expect(withPreviewTicket('https://x/y', '')).toBe('https://x/y');
    expect(withPreviewTicket(null, 'tk')).toBe(null);
    expect(withPreviewTicket('https://x/y', null)).toBe('https://x/y');
  });
});

describe('previewIdFromEvent / clearSessionPreviewStorage', () => {
  it('extracts previewId from WS payloads', () => {
    expect(previewIdFromEvent({ previewId: 'p-9' })).toBe('p-9');
    expect(previewIdFromEvent({})).toBe('');
  });

  it('removes pane open/width keys from localStorage', () => {
    window.localStorage.setItem('previewPaneOpen:s-x', 'true');
    window.localStorage.setItem('previewPaneWidth:s-x', '640');
    clearSessionPreviewStorage('s-x');
    expect(window.localStorage.getItem('previewPaneOpen:s-x')).toBeNull();
    expect(window.localStorage.getItem('previewPaneWidth:s-x')).toBeNull();
  });
});
