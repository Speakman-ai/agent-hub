/**
 * Every browser-backed observation names the surface it came from (web vs
 * preview), and refusals at the boundary point the agent at the other tool.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __registerBrowserSessionForTests,
  __resetBrowserRegistryForTests,
  DEFAULT_TIMEOUT_MS,
} from './browser.js';
import { runBrowserReActStep, surfaceObservationLines } from './browser-tools.js';
import {
  BROWSER_LOCAL_TARGET_HINT,
  PREVIEW_OFF_ORIGIN_HINT,
  isLocalTargetRefusal,
} from './browser-navigation-url.js';
import {
  __resetPreviewDocumentGuardsForTests,
  previewBrowserSessionId,
  runPreviewReActStep,
  type PreviewReactRow,
  type PreviewRuntimeForReact,
} from './preview/preview-react.js';

function makeMockPage(initialUrl = 'about:blank') {
  let currentUrl = initialUrl;
  return {
    url: () => currentUrl,
    goto: vi.fn(async (href: string) => {
      currentUrl = href;
      return null;
    }),
    __setUrl: (u: string) => {
      currentUrl = u;
    },
    evaluate: vi.fn(async () => ''),
    locator: vi.fn(() => ({ click: vi.fn(async () => {}), fill: vi.fn(async () => {}) })),
    screenshot: vi.fn(async () => Buffer.from([])),
    title: vi.fn(async () => 'T'),
    innerText: vi.fn(async () => 'Body'),
    mouse: { wheel: vi.fn(async () => {}) },
  };
}

function register(id: string, page: ReturnType<typeof makeMockPage>) {
  __registerBrowserSessionForTests({
    id,
    page,
    createdAt: Date.now(),
    timeoutMs: DEFAULT_TIMEOUT_MS,
    close: async () => {},
  });
}

const PORT = 4123;
const ORIGIN = `http://localhost:${PORT}`;
function makeRuntime(): PreviewRuntimeForReact {
  const row: PreviewReactRow = {
    id: 'grp-1',
    port: PORT,
    url: ORIGIN,
    status: 'ready',
    started_at: '2026-06-12 00:00:00',
    last_active_at: '2026-06-12 00:00:00',
  };
  return {
    getActiveBySessionId: vi.fn(() => row),
    getLogTail: vi.fn(() => []),
    touchPreview: vi.fn(),
    serverReachableUrlForPort: vi.fn((port: number) => `http://localhost:${port}`),
  };
}

beforeEach(() => {
  __resetBrowserRegistryForTests();
  __resetPreviewDocumentGuardsForTests();
});
afterEach(() => {
  __resetBrowserRegistryForTests();
  __resetPreviewDocumentGuardsForTests();
});

describe('surfaceObservationLines', () => {
  it('labels web and preview surfaces with the current URL', () => {
    expect(surfaceObservationLines('web', 'https://a.example/').join('\n')).toMatch(
      /Surface: web .*· URL: https:\/\/a\.example\//,
    );
    expect(
      surfaceObservationLines('preview', 'http://localhost:4123/x', 'http://localhost:4123').join(
        '\n',
      ),
    ).toMatch(
      /Surface: preview .*pinned to http:\/\/localhost:4123.*· URL: http:\/\/localhost:4123\/x/,
    );
    expect(surfaceObservationLines('web', null).join('\n')).toContain('(no page yet)');
  });
});

describe('browser tool observations name the web surface', () => {
  it('navigate / scroll / read_page trailers say Surface: web with the landed URL', async () => {
    const page = makeMockPage();
    register('surf-web', page);
    const nav = await runBrowserReActStep('surf-web', {
      op: 'navigate',
      url: 'https://example.org/docs',
    });
    expect(nav.hostExit).toBe(0);
    expect(nav.markdown).toContain('Surface: web');
    expect(nav.markdown).toContain('URL: https://example.org/docs');
    expect(nav.markdown).not.toContain('Surface: preview');

    const rp = await runBrowserReActStep('surf-web', { op: 'read_page' });
    expect(rp.markdown).toContain('Surface: web');
    expect(rp.markdown).toContain('URL: https://example.org/docs');

    const sc = await runBrowserReActStep('surf-web', { op: 'scroll', direction: 'down' });
    expect(sc.markdown).toContain('Surface: web');
  });

  it('a local-target refusal on the web browser points at the preview tool', async () => {
    const page = makeMockPage();
    register('surf-refuse', page);
    const r = await runBrowserReActStep('surf-refuse', {
      op: 'navigate',
      url: 'http://localhost:3000/settings',
    });
    expect(r.hostExit).toBe(1);
    expect(page.goto).not.toHaveBeenCalled();
    expect(r.markdown).toContain('Navigation to localhost is not allowed');
    expect(r.markdown).toMatch(/tool\\?":\\?"preview/);
    expect(r.markdown).toMatch(/op\\?":\\?"navigate/);

    const priv = await runBrowserReActStep('surf-refuse', {
      op: 'navigate',
      url: 'http://10.0.0.5/',
    });
    expect(priv.markdown).toContain(BROWSER_LOCAL_TARGET_HINT.slice(0, 40));
  });

  it('non-local refusals carry no preview hint', async () => {
    const page = makeMockPage();
    register('surf-scheme', page);
    const r = await runBrowserReActStep('surf-scheme', { op: 'navigate', url: 'ftp://x/' });
    expect(r.hostExit).toBe(1);
    expect(r.markdown).not.toMatch(/tool\\?":\\?"preview/);
  });

  it('isLocalTargetRefusal only matches local/private messages', () => {
    expect(isLocalTargetRefusal('Navigation to localhost is not allowed')).toBe(true);
    expect(
      isLocalTargetRefusal(
        'Navigation to private, loopback, or restricted addresses is not allowed',
      ),
    ).toBe(true);
    expect(isLocalTargetRefusal('Only http and https URLs are allowed for navigation')).toBe(false);
    expect(isLocalTargetRefusal(undefined)).toBe(false);
  });
});

describe('preview tool observations name the preview surface', () => {
  it('navigate trailer says Surface: preview pinned to the origin', async () => {
    const page = makeMockPage(`${ORIGIN}/`);
    register(previewBrowserSessionId('sess-p'), page);
    const r = await runPreviewReActStep(
      'sess-p',
      { op: 'navigate', route: '/settings' },
      { runtime: makeRuntime() },
    );
    expect(r.hostExit).toBe(0);
    expect(r.markdown).toContain('Surface: preview');
    expect(r.markdown).toContain(`pinned to ${ORIGIN}`);
    expect(r.markdown).toContain(`URL: ${ORIGIN}/settings`);
    expect(r.markdown).not.toContain('Surface: web');
  });

  it('an origin escape points at the generic browser tool for public URLs', async () => {
    const page = makeMockPage(`${ORIGIN}/`);
    register(previewBrowserSessionId('sess-esc'), page);
    page.locator.mockImplementation(() => ({
      click: vi.fn(async () => {
        page.__setUrl('https://public.example/');
      }),
      fill: vi.fn(async () => {}),
    }));
    const r = await runPreviewReActStep(
      'sess-esc',
      { op: 'click', target: '#out' },
      { runtime: makeRuntime() },
    );
    expect(r.hostExit).toBe(1);
    expect(r.markdown).toContain('off the preview origin');
    expect(r.markdown).toMatch(/tool\\?":\\?"browser/);
    expect(r.markdown).toContain(PREVIEW_OFF_ORIGIN_HINT.slice(0, 40));
  });

  it('a full URL passed as route is refused with the browser-tool pointer', async () => {
    const page = makeMockPage(`${ORIGIN}/`);
    register(previewBrowserSessionId('sess-url'), page);
    const r = await runPreviewReActStep(
      'sess-url',
      { op: 'navigate', route: 'https://public.example/' },
      { runtime: makeRuntime() },
    );
    expect(r.hostExit).toBe(1);
    expect(r.markdown).toMatch(/tool\\?":\\?"browser/);
  });
});
