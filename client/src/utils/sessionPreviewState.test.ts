import { describe, it, expect, vi } from 'vitest';
import {
  derivePaneState,
  normalizePreviewPorts,
  createActivityTouch,
  clampPaneWidth,
  paneOpenStorageKey,
  paneWidthStorageKey,
  previewIdFromEvent,
  clearSessionPreviewStorage,
  previewIframeSrc,
  previewProxySessionIdFromUrl,
  resolvePreviewBrowserUrl,
  withPreviewTicket,
  shouldShowSessionPreviewPane,
  previewStateApiPath,
  reconcilePreviewEvent,
  resolvePreviewHydration,
  PREVIEW_DEVICE_PRESETS,
} from './sessionPreviewState';

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

  it('carries a multi-port `ports` array on a ready state (primary floated first)', () => {
    const state = derivePaneState({
      kind: 'preview',
      fullUrl: '/api/sessions/s1/preview/proxy',
      port: 4500,
      ports: [
        {
          internalPort: 8787,
          label: 'api',
          primary: false,
          url: '/api/sessions/s1/preview/proxy/p/8787',
        },
        { internalPort: 5173, label: 'web', primary: true, url: '/api/sessions/s1/preview/proxy' },
      ],
    });
    expect(state.ports).toEqual([
      { internalPort: 5173, label: 'web', primary: true, url: '/api/sessions/s1/preview/proxy' },
      {
        internalPort: 8787,
        label: 'api',
        primary: false,
        url: '/api/sessions/s1/preview/proxy/p/8787',
      },
    ]);
  });

  it('defaults `ports` to [] when the event omits it (single-port preview)', () => {
    const state = derivePaneState({
      kind: 'preview',
      fullUrl: 'http://localhost:4101',
      port: 4101,
    });
    expect(state.ports).toEqual([]);
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

describe('normalizePreviewPorts', () => {
  it('returns [] for non-array input', () => {
    expect(normalizePreviewPorts(undefined)).toEqual([]);
    expect(normalizePreviewPorts(null)).toEqual([]);
    expect(normalizePreviewPorts('nope')).toEqual([]);
  });

  it('drops entries missing internalPort or url and floats primary first', () => {
    const out = normalizePreviewPorts([
      { internalPort: 8787, label: 'api', primary: false, url: '/x/p/8787' },
      { label: 'broken', primary: true, url: '/x' }, // no internalPort → dropped
      { internalPort: 3000, label: 'db', primary: false }, // no url → dropped
      { internalPort: 5173, label: 'web', primary: true, url: '/x' },
    ]);
    expect(out).toEqual([
      { internalPort: 5173, label: 'web', primary: true, url: '/x' },
      { internalPort: 8787, label: 'api', primary: false, url: '/x/p/8787' },
    ]);
  });
});

describe('createActivityTouch', () => {
  it('fires once and then throttles subsequent calls inside the window', () => {
    const cb = vi.fn();
    let clock = 1000;
    const notify = createActivityTouch(cb, 30_000, () => clock);
    expect(notify()).toBe(true);
    expect(cb!).toHaveBeenCalledTimes(1);
    // Rapid mousemove within the window — must not re-fire.
    clock = 1500;
    expect(notify()).toBe(false);
    clock = 2000;
    expect(notify()).toBe(false);
    expect(cb!).toHaveBeenCalledTimes(1);
    // After 30 s elapses, fires again.
    clock = 31_001;
    expect(notify()).toBe(true);
    expect(cb!).toHaveBeenCalledTimes(2);
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
    expect(cb!).toHaveBeenCalledTimes(2);
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
    expect(cb!).toHaveBeenCalledTimes(3);
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

describe('PREVIEW_DEVICE_PRESETS', () => {
  it('exposes iPhone, iPad mini, and iPad presets in ascending width order', () => {
    expect(PREVIEW_DEVICE_PRESETS.map((p) => p.id)).toEqual(['iphone', 'ipad-mini', 'ipad']);
    expect(PREVIEW_DEVICE_PRESETS.map((p) => p.width)).toEqual([390, 768, 820]);
  });

  it('keeps every preset width within the clamp bounds (no silent clamping)', () => {
    for (const preset of PREVIEW_DEVICE_PRESETS) {
      expect(clampPaneWidth(preset.width)).toBe(preset.width);
    }
  });

  it('has unique ids and human labels', () => {
    const ids = PREVIEW_DEVICE_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const preset of PREVIEW_DEVICE_PRESETS) {
      expect(preset.label).toBeTruthy();
    }
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

  it('extracts session id from a path-only proxy URL', () => {
    expect(previewProxySessionIdFromUrl('/api/sessions/sess-1/preview/proxy/')).toBe('sess-1');
  });
});

describe('resolvePreviewBrowserUrl', () => {
  it('rewrites a mismatched absolute proxy host to the browsing origin', () => {
    expect(
      resolvePreviewBrowserUrl('https://hub.test/api/sessions/sess-1/preview/proxy/', {
        origin: 'https://prod.example.com',
      }),
    ).toBe('https://prod.example.com/api/sessions/sess-1/preview/proxy/');
  });

  it('resolves a path-only proxy URL against the browsing origin', () => {
    expect(
      resolvePreviewBrowserUrl('/api/sessions/sess-1/preview/proxy/', {
        origin: 'https://prod.example.com',
      }),
    ).toBe('https://prod.example.com/api/sessions/sess-1/preview/proxy/');
  });

  it('leaves local-dev localhost URLs unchanged', () => {
    expect(
      resolvePreviewBrowserUrl('http://localhost:4101/board', {
        origin: 'https://prod.example.com',
      }),
    ).toBe('http://localhost:4101/board');
  });

  it('returns a subdomain URL when subdomainBase is configured and sessionId is a UUID', () => {
    // Subdomain mode hides the path-prefix mount from the dev server
    // entirely — the iframe loads at `<sid>.<base>/...` and the app
    // sees itself at `/`, so any framework's default base config
    // works. Inner path (`/some/page`) is preserved.
    const sid = 'b371b1ba-37d3-4a10-8b44-40bd1cddcc6d';
    expect(
      resolvePreviewBrowserUrl(`/api/sessions/${sid}/preview/proxy/some/page?foo=1`, {
        subdomainBase: 'preview.agenthub.dev.example.com',
      }),
    ).toBe(`https://${sid}.preview.agenthub.dev.example.com/some/page?foo=1`);
  });

  it('falls back to path-prefix when subdomainBase is set but sessionId is not a UUID', () => {
    // Non-UUID sessionId means the server-side dispatcher would
    // refuse to parse the Host even if we built it. Falling back to
    // the path-prefix URL keeps the iframe load reaching the proxy
    // via the existing route, instead of producing a guaranteed-
    // DNS-failure subdomain URL.
    expect(
      resolvePreviewBrowserUrl('/api/sessions/non-uuid-id/preview/proxy/', {
        origin: 'https://hub.example.com',
        subdomainBase: 'preview.example.com',
      }),
    ).toBe('https://hub.example.com/api/sessions/non-uuid-id/preview/proxy/');
  });

  it('ignores subdomainBase when unset (back-compat with the path-prefix deployment)', () => {
    const sid = 'b371b1ba-37d3-4a10-8b44-40bd1cddcc6d';
    expect(
      resolvePreviewBrowserUrl(`/api/sessions/${sid}/preview/proxy/`, {
        origin: 'https://hub.example.com',
      }),
    ).toBe(`https://hub.example.com/api/sessions/${sid}/preview/proxy/`);
  });

  it('preserves query and hash when emitting subdomain URL', () => {
    const sid = 'b371b1ba-37d3-4a10-8b44-40bd1cddcc6d';
    expect(
      resolvePreviewBrowserUrl(
        `https://hub.test/api/sessions/${sid}/preview/proxy/orders?status=open#row=42`,
        { subdomainBase: 'preview.example.com' },
      ),
    ).toBe(`https://${sid}.preview.example.com/orders?status=open#row=42`);
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

  it('appends ticket to a path-only proxy URL when an origin is available', () => {
    expect(
      withPreviewTicket('/api/sessions/s1/preview/proxy/?_ah=42', 'tk', {
        origin: 'https://prod.example.com',
      }),
    ).toBe('https://prod.example.com/api/sessions/s1/preview/proxy/?_ah=42&ticket=tk');
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

describe('shouldShowSessionPreviewPane', () => {
  const project = { prEnv: { preview: { compose: { entryService: 'web' } } } };
  const startingEvent = {
    type: 'agenthub_preview',
    kind: 'preview_starting',
    sessionId: 's-1',
    previewId: 'p-1',
  };
  const readyEvent = {
    type: 'agenthub_preview',
    kind: 'preview',
    sessionId: 's-1',
    previewUrl: 'http://localhost:4101',
    previewId: 'p-1',
  };

  it('returns false when no session is active', () => {
    expect(
      shouldShowSessionPreviewPane({
        activeSessionId: null,
        project,
        activePreviewEvent: readyEvent,
        paneOpenBySession: {},
      }),
    ).toBe(false);
  });

  it('returns false when the project has no preview compose entry service', () => {
    expect(
      shouldShowSessionPreviewPane({
        activeSessionId: 's-1',
        project: { prEnv: { preview: {} } },
        activePreviewEvent: readyEvent,
        paneOpenBySession: {},
      }),
    ).toBe(false);
  });

  it('returns false when there is no active preview event (bare session)', () => {
    // Regression: previously the pane auto-opened for any session in a
    // preview-capable project, showing an empty "no app loaded" placeholder.
    // Policy is now hidden-by-default until a preview is actually
    // building or available.
    expect(
      shouldShowSessionPreviewPane({
        activeSessionId: 's-1',
        project,
        activePreviewEvent: null,
        paneOpenBySession: {},
      }),
    ).toBe(false);
  });

  it('returns true while the preview is building (preview_starting)', () => {
    expect(
      shouldShowSessionPreviewPane({
        activeSessionId: 's-1',
        project,
        activePreviewEvent: startingEvent,
        paneOpenBySession: {},
      }),
    ).toBe(true);
  });

  it('returns true once the preview is available (preview ready)', () => {
    expect(
      shouldShowSessionPreviewPane({
        activeSessionId: 's-1',
        project,
        activePreviewEvent: readyEvent,
        paneOpenBySession: {},
      }),
    ).toBe(true);
  });

  it('honors an explicit user-close (false) even when a preview event exists', () => {
    expect(
      shouldShowSessionPreviewPane({
        activeSessionId: 's-1',
        project,
        activePreviewEvent: readyEvent,
        paneOpenBySession: { 's-1': false },
      }),
    ).toBe(false);
  });

  it('treats an absent paneOpenBySession entry as "not closed" (default open)', () => {
    expect(
      shouldShowSessionPreviewPane({
        activeSessionId: 's-1',
        project,
        activePreviewEvent: readyEvent,
        paneOpenBySession: { 'other-session': false },
      }),
    ).toBe(true);
  });

  it('tolerates missing paneOpenBySession argument', () => {
    expect(
      shouldShowSessionPreviewPane({
        activeSessionId: 's-1',
        project,
        activePreviewEvent: readyEvent,
      }),
    ).toBe(true);
  });

  it('returns false on a completely empty input', () => {
    expect(shouldShowSessionPreviewPane()).toBe(false);
    expect(shouldShowSessionPreviewPane({})).toBe(false);
  });

  // Regression: dev-server projects (`prEnv.devServer`, the current process
  // model) have no compose `entryService`, so the pane gate used to reject
  // them and Start preview opened nothing — the streamed boot/terminal log
  // had no surface to render in. The gate now mirrors `isPreviewConfigured`.
  describe('dev-server project (no compose block)', () => {
    const devServerProject = { prEnv: { devServer: { startCommand: 'npm run dev' } } };

    it('opens the pane while the dev server is booting (preview_starting)', () => {
      expect(
        shouldShowSessionPreviewPane({
          activeSessionId: 's-1',
          project: devServerProject,
          activePreviewEvent: startingEvent,
          paneOpenBySession: {},
        }),
      ).toBe(true);
    });

    it('opens the pane once the dev server is ready (preview)', () => {
      expect(
        shouldShowSessionPreviewPane({
          activeSessionId: 's-1',
          project: devServerProject,
          activePreviewEvent: readyEvent,
          paneOpenBySession: {},
        }),
      ).toBe(true);
    });

    it('still honors an explicit user-close for a dev-server project', () => {
      expect(
        shouldShowSessionPreviewPane({
          activeSessionId: 's-1',
          project: devServerProject,
          activePreviewEvent: readyEvent,
          paneOpenBySession: { 's-1': false },
        }),
      ).toBe(false);
    });

    it('stays hidden when the dev-server startCommand is blank', () => {
      expect(
        shouldShowSessionPreviewPane({
          activeSessionId: 's-1',
          project: { prEnv: { devServer: { startCommand: '  ' } } },
          activePreviewEvent: readyEvent,
          paneOpenBySession: {},
        }),
      ).toBe(false);
    });
  });

  it('returns false when the project has neither dev-server nor compose config', () => {
    expect(
      shouldShowSessionPreviewPane({
        activeSessionId: 's-1',
        project: { prEnv: { preview: {} } },
        activePreviewEvent: readyEvent,
        paneOpenBySession: {},
      }),
    ).toBe(false);
  });
});

describe('previewStateApiPath', () => {
  it('builds the /api-relative hydration path for a session', () => {
    expect(previewStateApiPath('sess-1')).toBe('/sessions/sess-1/preview/state');
  });
});

describe('reconcilePreviewEvent', () => {
  // Real-world `current` always has an id by the time we'd self-heal: the
  // WS `preview_starting` (carrying the group id) replaces the synthetic
  // seed before the 5 s reconcile poll fires. The terminal events the
  // hydration endpoint returns always carry the same id.
  const starting = {
    type: 'agenthub_preview',
    kind: 'preview_starting',
    sessionId: 's1',
    previewId: 'p1',
  };
  const ready = {
    type: 'agenthub_preview',
    kind: 'preview',
    sessionId: 's1',
    previewId: 'p1',
    fullUrl: '/p',
  };
  const failed = {
    type: 'agenthub_preview',
    kind: 'preview_failed',
    sessionId: 's1',
    previewId: 'p1',
  };

  it('advances a stuck `preview_starting` pane to a fetched `preview` (ready) event of the same run', () => {
    expect(reconcilePreviewEvent(starting, ready)).toBe(ready);
  });

  it('advances a stuck `preview_starting` pane to a fetched `preview_failed` event of the same run', () => {
    expect(reconcilePreviewEvent(starting, failed)).toBe(failed);
  });

  it('leaves the current event untouched when the pane is not starting (no downgrade)', () => {
    // A pane already on `ready` must never be clobbered by a late poll.
    expect(reconcilePreviewEvent(ready, starting)).toBe(ready);
    expect(reconcilePreviewEvent(failed, ready)).toBe(failed);
  });

  it('does not apply a fetched `preview_starting` (no advancement — keep fresher live logTail)', () => {
    expect(reconcilePreviewEvent(starting, starting)).toBe(starting);
  });

  it('returns the current reference unchanged for null/garbage fetched payloads', () => {
    expect(reconcilePreviewEvent(starting, null)).toBe(starting);
    expect(reconcilePreviewEvent(starting, undefined)).toBe(starting);
    expect(reconcilePreviewEvent(starting, 'nope')).toBe(starting);
  });

  it('returns the current reference (null/idle) unchanged when there is nothing to advance', () => {
    expect(reconcilePreviewEvent(null, ready)).toBeNull();
    expect(reconcilePreviewEvent(undefined, ready)).toBeUndefined();
  });

  describe('previewId race guard', () => {
    const startingA = { type: 'agenthub_preview', kind: 'preview_starting', previewId: 'A' };
    const startingNoId = { type: 'agenthub_preview', kind: 'preview_starting', previewId: '' };
    const readyA = { type: 'agenthub_preview', kind: 'preview', previewId: 'A', fullUrl: '/p' };
    const readyB = { type: 'agenthub_preview', kind: 'preview', previewId: 'B', fullUrl: '/p' };
    const failedB = { type: 'agenthub_preview', kind: 'preview_failed', previewId: 'B' };

    it('applies a terminal event whose previewId matches the current starting run', () => {
      expect(reconcilePreviewEvent(startingA, readyA)).toBe(readyA);
    });

    it('does NOT apply a stale terminal event for an OLDER preview id', () => {
      // User restarted: pane shows run A but a delayed /preview/state
      // response for run B arrives. Mismatched ids → drop the stale event.
      expect(reconcilePreviewEvent(startingA, readyB)).toBe(startingA);
      expect(reconcilePreviewEvent(startingA, failedB)).toBe(startingA);
    });

    it('CONVERGES the synthetic seed (no previewId) to a terminal event', () => {
      // When the `preview_starting` WS frame itself was dropped, the only
      // client state is the no-id seed. The reducer applies the
      // authoritative terminal so the pane converges even though there is
      // no id to match. The stale-after-restart race for this no-id case
      // is prevented by the caller's start-generation guard (reconcile
      // effect), NOT by this reducer — see reconcilePreviewEvent docs.
      expect(reconcilePreviewEvent(startingNoId, readyB)).toBe(readyB);
      expect(reconcilePreviewEvent(startingNoId, failedB)).toBe(failedB);
    });

    it('treats a missing previewId on an identifiable current run as a non-match (no clobber)', () => {
      // Current run HAS an id but the fetched terminal lacks one → cannot
      // prove same-run, so keep current. (The hydration endpoint always
      // emits an id; this is defensive.)
      const readyNoId = { type: 'agenthub_preview', kind: 'preview', fullUrl: '/p' };
      expect(reconcilePreviewEvent(startingA, readyNoId)).toBe(startingA);
    });
  });
});

describe('resolvePreviewHydration', () => {
  const readyA = { type: 'agenthub_preview', kind: 'preview', previewId: 'A', fullUrl: '/p' };
  const readyB = { type: 'agenthub_preview', kind: 'preview', previewId: 'B', fullUrl: '/p' };
  const startingA = { type: 'agenthub_preview', kind: 'preview_starting', previewId: 'A' };

  it('returns null when the fetched event is missing/garbage', () => {
    expect(
      resolvePreviewHydration({
        currentEvent: startingA,
        seeded: false,
        fetched: null,
        seqAtRequest: 1,
        currentSeq: 1,
      }),
    ).toBeNull();
  });

  it('DISCARDS a response when the start generation advanced in-flight (user restarted)', () => {
    // The exact stale-response race: poll issued for run A (seq 1), user
    // restarts (seq 2), the A response arrives — must be dropped even
    // though the current state is again a no-id starting seed.
    expect(
      resolvePreviewHydration({
        currentEvent: undefined,
        seeded: true,
        fetched: readyA,
        seqAtRequest: 1,
        currentSeq: 2,
      }),
    ).toBeNull();
  });

  it('CONVERGES the synthetic seed to a terminal when the generation is unchanged', () => {
    // preview_starting WS frame was dropped → only the seed exists, no
    // restart happened (seq stable) → apply the authoritative terminal.
    expect(
      resolvePreviewHydration({
        currentEvent: undefined,
        seeded: true,
        fetched: readyB,
        seqAtRequest: 3,
        currentSeq: 3,
      }),
    ).toEqual({ event: readyB });
  });

  it('applies a same-id terminal over an identifiable starting run', () => {
    expect(
      resolvePreviewHydration({
        currentEvent: startingA,
        seeded: false,
        fetched: readyA,
        seqAtRequest: 1,
        currentSeq: 1,
      }),
    ).toEqual({ event: readyA });
  });

  it('does not apply a mismatched-id terminal even when the generation is unchanged', () => {
    // Same generation but a WS-driven restart gave current id A; a stale
    // terminal for B must not clobber it (reconcilePreviewEvent id-match).
    expect(
      resolvePreviewHydration({
        currentEvent: startingA,
        seeded: false,
        fetched: readyB,
        seqAtRequest: 1,
        currentSeq: 1,
      }),
    ).toBeNull();
  });

  it('returns null when there is no starting run to advance (no current, not seeded)', () => {
    expect(
      resolvePreviewHydration({
        currentEvent: undefined,
        seeded: false,
        fetched: readyA,
        seqAtRequest: 1,
        currentSeq: 1,
      }),
    ).toBeNull();
  });
});
