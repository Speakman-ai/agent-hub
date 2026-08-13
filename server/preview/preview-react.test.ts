import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  runPreviewReActStep,
  previewBrowserSessionId,
  PREVIEW_REACT_OPS,
  PREVIEW_DRIVE_OPS,
  PREVIEW_LOGS_DEFAULT_TAIL,
  PREVIEW_LOGS_MAX_TAIL,
  __resetPreviewDocumentGuardsForTests,
  resolvePreviewReactRuntime,
  type PreviewReactRow,
  type PreviewRuntimeForReact,
} from './preview-react.js';
import {
  __registerBrowserSessionForTests,
  __resetBrowserRegistryForTests,
  DEFAULT_TIMEOUT_MS,
} from '../browser.js';

const SESSION_ID = 'sess-preview-react-test';
const PORT = 4123;
const ORIGIN = `http://localhost:${PORT}`;

function makeRow(status: PreviewReactRow['status'] = 'ready'): PreviewReactRow {
  return {
    id: 'grp-1',
    port: PORT,
    url: ORIGIN,
    status,
    started_at: '2026-06-12 00:00:00',
    last_active_at: '2026-06-12 00:00:00',
  };
}

function makeRuntime(overrides?: { row?: PreviewReactRow | null; logLines?: string[] }) {
  const row = overrides && 'row' in overrides ? (overrides.row ?? null) : makeRow();
  const runtime = {
    getActiveBySessionId: vi.fn((_sessionId: string) => row),
    getLogTail: vi.fn((_groupId: string) => overrides?.logLines ?? ['line-1', 'line-2', 'line-3']),
    touchPreview: vi.fn((_groupId: string) => {}),
    serverReachableUrlForPort: vi.fn((port: number) => `http://localhost:${port}`),
  } satisfies PreviewRuntimeForReact;
  return runtime;
}

/** Stateful mock page: `goto` mutates the URL `url()` reports. */
function makeMockPage(initialUrl = 'about:blank') {
  let currentUrl = initialUrl;
  const page = {
    url: () => currentUrl,
    goto: vi.fn(async (href: string) => {
      currentUrl = href;
      return null;
    }),
    /** Test hook — simulate an in-page navigation (e.g. click escaping origin). */
    __setUrl: (u: string) => {
      currentUrl = u;
    },
    locator: vi.fn(() => ({
      click: vi.fn(async () => {}),
      fill: vi.fn(async () => {}),
    })),
    screenshot: vi.fn(async () => Buffer.from('fake-jpeg-bytes')),
    evaluate: vi.fn(async () => 'page text'),
    waitForLoadState: vi.fn(async () => {}),
    waitForSelector: vi.fn(async () => {}),
    scroll: vi.fn(async () => {}),
    goBack: vi.fn(async () => {}),
    goForward: vi.fn(async () => {}),
  };
  return page;
}

function makeMockStagehand(page: ReturnType<typeof makeMockPage>) {
  return {
    context: {
      activePage: () => page,
      pages: () => [page],
    },
    act: vi.fn(async () => {}),
    extract: vi.fn(async (): Promise<unknown> => ({ ok: true })),
  };
}

function registerPreviewBrowser(page: ReturnType<typeof makeMockPage>) {
  const stagehand = makeMockStagehand(page);
  const close = vi.fn(async () => {});
  __registerBrowserSessionForTests({
    id: previewBrowserSessionId(SESSION_ID),
    stagehand,
    createdAt: 0,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    close,
  });
  return { stagehand, close };
}

beforeEach(() => {
  __resetBrowserRegistryForTests();
  __resetPreviewDocumentGuardsForTests();
});

/** Attach a fake CDP main session so the persistent document guard installs. */
function withCdp(page: ReturnType<typeof makeMockPage>) {
  const handlers = new Map<string, (p: unknown) => void>();
  const send = vi.fn(async () => ({}));
  const mainSession = {
    send,
    on: vi.fn((evt: string, h: (p: unknown) => void) => {
      handlers.set(evt, h);
    }),
    off: vi.fn((evt: string) => {
      handlers.delete(evt);
    }),
  };
  Object.assign(page, { mainSession });
  return { handlers, send, mainSession };
}

describe('preview-react — op surface', () => {
  it('drive ops are exactly the ops that need Chromium', () => {
    const observeOps = PREVIEW_REACT_OPS.filter((op) => !PREVIEW_DRIVE_OPS.has(op));
    expect(observeOps).toEqual(['start', 'state', 'logs']);
  });

  it('rejects unknown ops with hostExit 1', async () => {
    const r = await runPreviewReActStep(SESSION_ID, { op: 'boot' }, { runtime: makeRuntime() });
    expect(r.hostExit).toBe(1);
    expect(r.hostDetail).toBe('bad_op');
    expect(r.markdown).toContain('Unsupported or missing op');
  });
});

describe('preview-react — availability gates', () => {
  it('returns hostExit 2 when the preview runtime is unwired', async () => {
    const r = await runPreviewReActStep(SESSION_ID, { op: 'state' }, { runtime: null });
    expect(r.hostExit).toBe(2);
    expect(r.hostDetail).toBe('runtime_unwired');
  });

  it('points agents at op=start when no preview is running', async () => {
    const runtime = makeRuntime({ row: null });
    const r = await runPreviewReActStep(SESSION_ID, { op: 'screenshot' }, { runtime });
    expect(r.hostExit).toBe(2);
    expect(r.hostDetail).toBe('no_preview');
    expect(r.markdown).toContain('"op":"start"');
    expect(r.markdown).toContain('Start preview');
    expect(r.markdown).not.toContain('human-only');
  });

  it('blocks drive ops while starting, pointing at op=logs', async () => {
    const runtime = makeRuntime({ row: makeRow('starting') });
    const r = await runPreviewReActStep(SESSION_ID, { op: 'click', target: '#go' }, { runtime });
    expect(r.hostExit).toBe(2);
    expect(r.hostDetail).toBe('not_ready:starting');
    expect(r.markdown).toContain('"op":"logs"');
  });

  it('blocks drive ops after failure but still serves state/logs', async () => {
    const runtime = makeRuntime({ row: makeRow('failed'), logLines: ['boom'] });
    const drive = await runPreviewReActStep(SESSION_ID, { op: 'screenshot' }, { runtime });
    expect(drive.hostExit).toBe(2);
    expect(drive.hostDetail).toBe('not_ready:failed');
    expect(drive.markdown).toContain('"op":"start"');

    const state = await runPreviewReActStep(SESSION_ID, { op: 'state' }, { runtime });
    expect(state.hostExit).toBe(0);
    expect(state.markdown).toContain('"status": "failed"');

    const logs = await runPreviewReActStep(SESSION_ID, { op: 'logs' }, { runtime });
    expect(logs.hostExit).toBe(0);
    expect(logs.markdown).toContain('boom');
  });
});

describe('preview-react — op start', () => {
  it('requests boot via startPreview when no row exists', async () => {
    const runtime = makeRuntime({ row: null });
    const startPreview = vi.fn(async () => ({ ok: true as const, started: true as const }));
    const r = await runPreviewReActStep(
      SESSION_ID,
      { op: 'start', route: '/dash', reason: 'check UI' },
      { runtime, startPreview },
    );
    expect(r.hostExit).toBe(0);
    expect(r.hostDetail).toBe('start:requested');
    expect(startPreview).toHaveBeenCalledWith({ route: '/dash', reason: 'check UI' });
    expect(r.markdown).toContain('Poll with');
  });

  it('is idempotent when preview is already ready or starting', async () => {
    for (const status of ['ready', 'starting'] as const) {
      const runtime = makeRuntime({ row: makeRow(status) });
      const startPreview = vi.fn(async () => ({ ok: true as const, started: true as const }));
      const r = await runPreviewReActStep(SESSION_ID, { op: 'start' }, { runtime, startPreview });
      expect(r.hostExit).toBe(0);
      expect(r.hostDetail).toBe(`start:already_${status}`);
      expect(startPreview).not.toHaveBeenCalled();
      expect(runtime.touchPreview).toHaveBeenCalledWith('grp-1');
    }
  });

  it('reboots a failed preview via startPreview', async () => {
    const runtime = makeRuntime({ row: makeRow('failed') });
    const startPreview = vi.fn(async () => ({ ok: true as const, started: true as const }));
    const r = await runPreviewReActStep(SESSION_ID, { op: 'start' }, { runtime, startPreview });
    expect(r.hostExit).toBe(0);
    expect(r.hostDetail).toBe('start:requested');
    expect(startPreview).toHaveBeenCalledWith({
      route: undefined,
      reason: 'Started by agent via ReAct preview tool',
    });
  });

  it('returns hostExit 2 when startPreview is unwired', async () => {
    const runtime = makeRuntime({ row: null });
    const r = await runPreviewReActStep(SESSION_ID, { op: 'start' }, { runtime });
    expect(r.hostExit).toBe(2);
    expect(r.hostDetail).toBe('start_unwired');
  });

  it('surfaces startPreview failures', async () => {
    const runtime = makeRuntime({ row: null });
    const startPreview = vi.fn(async () => ({
      ok: false as const,
      error: 'no worktree',
      statusCode: 400,
    }));
    const r = await runPreviewReActStep(SESSION_ID, { op: 'start' }, { runtime, startPreview });
    expect(r.hostExit).toBe(2);
    expect(r.hostDetail).toBe('start_failed:400');
    expect(r.markdown).toContain('no worktree');
  });
});

describe('preview-react — runtime resolver', () => {
  it('collapses all-null runtimes to null', () => {
    expect(resolvePreviewReactRuntime(SESSION_ID, [null, undefined])).toBeNull();
  });

  it('returns the runtime that owns the session row, unwrapped', async () => {
    const empty = makeRuntime({ row: null });
    const devServer = makeRuntime({ logLines: ['dev-server-line'] });
    const resolved = resolvePreviewReactRuntime(SESSION_ID, [empty, devServer]);
    expect(resolved).toBe(devServer);
    const r = await runPreviewReActStep(SESSION_ID, { op: 'logs' }, { runtime: resolved });
    expect(r.hostExit).toBe(0);
    expect(r.markdown).toContain('dev-server-line');
    expect(empty.getLogTail).not.toHaveBeenCalled();
    expect(devServer.getLogTail).toHaveBeenCalledWith('grp-1');
    expect(devServer.touchPreview).toHaveBeenCalledWith('grp-1');
  });

  it('prefers the first runtime with an active row', () => {
    const first = makeRuntime();
    const devServer = makeRuntime();
    expect(resolvePreviewReactRuntime(SESSION_ID, [first, devServer])).toBe(first);
    expect(devServer.getActiveBySessionId).not.toHaveBeenCalled();
  });

  it('falls back to the first wired runtime when no preview is active (no_preview path)', async () => {
    const first = makeRuntime({ row: null });
    const devServer = makeRuntime({ row: null });
    const resolved = resolvePreviewReactRuntime(SESSION_ID, [first, devServer]);
    expect(resolved).toBe(first);
    const r = await runPreviewReActStep(SESSION_ID, { op: 'state' }, { runtime: resolved });
    expect(r.hostExit).toBe(2);
    expect(r.hostDetail).toBe('no_preview');
  });
});

describe('preview-react — observe ops', () => {
  it('state reports status, url, and port and touches the preview', async () => {
    const runtime = makeRuntime();
    const r = await runPreviewReActStep(SESSION_ID, { op: 'state' }, { runtime });
    expect(r.hostExit).toBe(0);
    expect(r.markdown).toContain('"status": "ready"');
    expect(r.markdown).toContain(`"port": ${PORT}`);
    expect(runtime.touchPreview).toHaveBeenCalledWith('grp-1');
  });

  it('logs defaults to the documented tail and clamps oversized requests', async () => {
    const lines = Array.from({ length: 1500 }, (_, i) => `log-${i}`);
    const runtime = makeRuntime({ logLines: lines });

    const dflt = await runPreviewReActStep(SESSION_ID, { op: 'logs' }, { runtime });
    expect(dflt.hostExit).toBe(0);
    expect(dflt.markdown).toContain(`last ${PREVIEW_LOGS_DEFAULT_TAIL} lines`);
    expect(dflt.markdown).toContain('log-1499');
    expect(dflt.markdown).not.toContain('log-1299\n'); // outside default tail

    const huge = await runPreviewReActStep(SESSION_ID, { op: 'logs', tail: 999_999 }, { runtime });
    expect(huge.markdown).toContain(`last ${PREVIEW_LOGS_MAX_TAIL} lines`);
  });

  it('logs reports cleanly when nothing has been captured', async () => {
    const runtime = makeRuntime({ logLines: [] });
    const r = await runPreviewReActStep(SESSION_ID, { op: 'logs' }, { runtime });
    expect(r.hostExit).toBe(0);
    expect(r.markdown).toContain('no log lines captured yet');
  });
});

describe('preview-react — drive ops', () => {
  it('navigate resolves route against the server-reachable preview origin', async () => {
    const page = makeMockPage();
    registerPreviewBrowser(page);
    const runtime = makeRuntime();
    const r = await runPreviewReActStep(
      SESSION_ID,
      { op: 'navigate', route: '/settings' },
      { runtime },
    );
    expect(r.hostExit).toBe(0);
    expect(page.goto).toHaveBeenCalledWith(`${ORIGIN}/settings`, expect.anything());
    // Session id is passed so a container-routed env resolves its own dial
    // host rather than the Hub-wide default.
    expect(runtime.serverReachableUrlForPort).toHaveBeenCalledWith(PORT, SESSION_ID);
    // The pinned-origin allowance let a localhost target through SSRF policy.
    expect(r.markdown).toContain(`${ORIGIN}/settings`);
  });

  it('navigate rejects full URLs / routes not starting with "/"', async () => {
    registerPreviewBrowser(makeMockPage());
    const runtime = makeRuntime();
    const r = await runPreviewReActStep(
      SESSION_ID,
      { op: 'navigate', route: 'https://evil.example' },
      { runtime },
    );
    expect(r.hostExit).toBe(1);
    expect(r.hostDetail).toBe('bad_route');
  });

  it('auto-opens the preview root before acting when the page is off-origin', async () => {
    const page = makeMockPage('about:blank');
    registerPreviewBrowser(page);
    const runtime = makeRuntime();
    const r = await runPreviewReActStep(SESSION_ID, { op: 'screenshot' }, { runtime });
    expect(r.hostExit).toBe(0);
    expect(page.goto).toHaveBeenCalledWith(`${ORIGIN}/`, expect.anything());
    expect(page.screenshot).toHaveBeenCalled();
    expect(r.ui?.screenshotCaptured).toBe(true);
    expect(r.markdown).toContain('data:image/jpeg;base64,');
  });

  it('does not re-navigate when already on the preview origin', async () => {
    const page = makeMockPage(`${ORIGIN}/dashboard`);
    registerPreviewBrowser(page);
    const runtime = makeRuntime();
    const r = await runPreviewReActStep(SESSION_ID, { op: 'read_page' }, { runtime });
    expect(r.hostExit).toBe(0);
    expect(page.goto).not.toHaveBeenCalled();
  });

  it('click that escapes to a disallowed loopback target is reverted and reported', async () => {
    const page = makeMockPage(`${ORIGIN}/`);
    registerPreviewBrowser(page);
    const runtime = makeRuntime();
    // Selector click goes through page.locator; simulate the page landing on
    // ANOTHER session's preview port as a side effect.
    page.locator.mockImplementation(() => ({
      click: vi.fn(async () => {
        page.__setUrl('http://localhost:4999/secret');
      }),
      fill: vi.fn(async () => {}),
    }));
    const r = await runPreviewReActStep(SESSION_ID, { op: 'click', target: '#leak' }, { runtime });
    expect(r.hostExit).toBe(1);
    expect(r.markdown).toContain('off the preview origin');
    expect(r.markdown).toContain('http://localhost:4999');
    // Recovery navigation back to the pinned origin root.
    expect(page.goto).toHaveBeenCalledWith(`${ORIGIN}/`, expect.anything());
  });

  it('click that escapes to a PUBLIC external origin is also reverted and reported', async () => {
    // Regression: the origin pin must treat any off-origin landing as an
    // escape — public web included — not only targets the general SSRF
    // policy blocks. https://example.com passes the general policy, so a
    // policy-only guard would (wrongly) treat this as success.
    const page = makeMockPage(`${ORIGIN}/`);
    registerPreviewBrowser(page);
    const runtime = makeRuntime();
    page.locator.mockImplementation(() => ({
      click: vi.fn(async () => {
        page.__setUrl('https://example.com/landing');
      }),
      fill: vi.fn(async () => {}),
    }));
    const r = await runPreviewReActStep(
      SESSION_ID,
      { op: 'click', target: '#external-link' },
      { runtime },
    );
    expect(r.hostExit).toBe(1);
    expect(r.markdown).toContain('off the preview origin');
    expect(r.markdown).toContain('https://example.com');
    expect(page.goto).toHaveBeenCalledWith(`${ORIGIN}/`, expect.anything());
  });

  it('type that escapes off-origin (e.g. form submit redirect) is reverted and reported', async () => {
    const page = makeMockPage(`${ORIGIN}/form`);
    registerPreviewBrowser(page);
    const runtime = makeRuntime();
    page.locator.mockImplementation(() => ({
      click: vi.fn(async () => {}),
      fill: vi.fn(async () => {
        page.__setUrl('https://evil.example/phish');
      }),
    }));
    const r = await runPreviewReActStep(
      SESSION_ID,
      { op: 'type', target: '#q', text: 'hello' },
      { runtime },
    );
    expect(r.hostExit).toBe(1);
    expect(r.markdown).toContain('off the preview origin');
    expect(page.goto).toHaveBeenCalledWith(`${ORIGIN}/`, expect.anything());
  });

  it('click that stays on the preview origin is untouched by the escape guard', async () => {
    const page = makeMockPage(`${ORIGIN}/`);
    registerPreviewBrowser(page);
    const runtime = makeRuntime();
    page.locator.mockImplementation(() => ({
      click: vi.fn(async () => {
        page.__setUrl(`${ORIGIN}/details/42`);
      }),
      fill: vi.fn(async () => {}),
    }));
    const r = await runPreviewReActStep(SESSION_ID, { op: 'click', target: '#row' }, { runtime });
    expect(r.hostExit).toBe(0);
    // No recovery navigation — in-app transition is legitimate.
    expect(page.goto).not.toHaveBeenCalled();
  });

  it('type fills the target field on the preview page', async () => {
    const page = makeMockPage(`${ORIGIN}/login`);
    const fill = vi.fn(async () => {});
    page.locator.mockImplementation(() => ({ click: vi.fn(async () => {}), fill }));
    registerPreviewBrowser(page);
    const runtime = makeRuntime();
    const r = await runPreviewReActStep(
      SESSION_ID,
      { op: 'type', target: '#email', text: 'a@b.c' },
      { runtime },
    );
    expect(r.hostExit).toBe(0);
    expect(fill).toHaveBeenCalledWith('a@b.c');
  });

  it('navigate whose route 302s to a public external origin is reverted and reported', async () => {
    // Regression: browserNavigate re-checks only the general URL policy after
    // redirects, and public origins pass it — so without the origin pin a
    // preview route redirecting to https://example.com returned success and
    // left the drive browser off-origin.
    const page = makeMockPage();
    registerPreviewBrowser(page);
    const runtime = makeRuntime();
    page.goto.mockImplementation(async (href: string) => {
      // The /logout route server-redirects off-origin; everything else lands
      // where it was asked to go.
      page.__setUrl(href === `${ORIGIN}/logout` ? 'https://example.com/goodbye' : href);
      return null;
    });
    const r = await runPreviewReActStep(
      SESSION_ID,
      { op: 'navigate', route: '/logout' },
      { runtime },
    );
    expect(r.hostExit).toBe(1);
    expect(r.markdown).toContain('off the preview origin');
    expect(r.markdown).toContain('https://example.com');
    // Recovery navigation back to the pinned origin root.
    expect(page.goto).toHaveBeenCalledWith(`${ORIGIN}/`, expect.anything());
  });

  it('navigate that stays on-origin after an in-origin redirect succeeds', async () => {
    const page = makeMockPage();
    registerPreviewBrowser(page);
    const runtime = makeRuntime();
    page.goto.mockImplementation(async (href: string) => {
      page.__setUrl(href === `${ORIGIN}/old` ? `${ORIGIN}/new` : href);
      return null;
    });
    const r = await runPreviewReActStep(SESSION_ID, { op: 'navigate', route: '/old' }, { runtime });
    expect(r.hostExit).toBe(0);
    expect(r.markdown).toContain(`${ORIGIN}/new`);
  });

  it('auto-navigate before an op fails when the preview root itself redirects off-origin', async () => {
    const page = makeMockPage('about:blank');
    registerPreviewBrowser(page);
    const runtime = makeRuntime();
    page.goto.mockImplementation(async (href: string) => {
      page.__setUrl(href === `${ORIGIN}/` ? 'https://sso.example.com/login' : href);
      return null;
    });
    const r = await runPreviewReActStep(SESSION_ID, { op: 'screenshot' }, { runtime });
    expect(r.hostExit).toBe(1);
    expect(r.hostDetail).toBe('auto_navigate_failed');
    expect(r.markdown).toContain('off the preview origin');
    // The off-origin page was never screenshot.
    expect(page.screenshot).not.toHaveBeenCalled();
  });

  it('read_page after a client-side redirect off-origin drops the captured text', async () => {
    // Regression (TOCTOU): the pre-op origin check passes while the page is
    // still on the preview, then the app schedules location.href to an
    // external origin before the read runs. The captured text belongs to the
    // foreign page and must never reach the agent.
    const page = makeMockPage(`${ORIGIN}/`);
    registerPreviewBrowser(page);
    const runtime = makeRuntime();
    page.evaluate.mockImplementation(async () => {
      page.__setUrl('https://example.com/external');
      return 'EXTERNAL-PAGE-SECRET-TEXT';
    });
    const r = await runPreviewReActStep(SESSION_ID, { op: 'read_page' }, { runtime });
    expect(r.hostExit).toBe(1);
    expect(r.markdown).toContain('off the preview origin');
    expect(r.markdown).not.toContain('EXTERNAL-PAGE-SECRET-TEXT');
    // Recovery navigation back to the pinned origin root.
    expect(page.goto).toHaveBeenCalledWith(`${ORIGIN}/`, expect.anything());
  });

  it('screenshot after a client-side redirect off-origin drops the captured image', async () => {
    const page = makeMockPage(`${ORIGIN}/`);
    registerPreviewBrowser(page);
    const runtime = makeRuntime();
    page.screenshot.mockImplementation(async () => {
      page.__setUrl('https://example.com/external');
      return Buffer.from('foreign-page-pixels');
    });
    const r = await runPreviewReActStep(SESSION_ID, { op: 'screenshot' }, { runtime });
    expect(r.hostExit).toBe(1);
    expect(r.markdown).toContain('off the preview origin');
    expect(r.markdown).not.toContain('data:image/jpeg;base64,');
    expect(r.markdown).not.toContain(Buffer.from('foreign-page-pixels').toString('base64'));
    expect(r.ui?.screenshotCaptured).toBeFalsy();
    expect(r.ui?.screenshotWsUrl).toBeUndefined();
    expect(page.goto).toHaveBeenCalledWith(`${ORIGIN}/`, expect.anything());
  });

  it('extract after a client-side redirect off-origin drops the extracted data', async () => {
    const page = makeMockPage(`${ORIGIN}/`);
    const stagehandExtras = registerPreviewBrowser(page);
    const runtime = makeRuntime();
    stagehandExtras.stagehand.extract.mockImplementation(async () => {
      page.__setUrl('https://example.com/external');
      return { secret: 'EXTERNAL-EXTRACTED-DATA' };
    });
    const r = await runPreviewReActStep(SESSION_ID, { op: 'extract' }, { runtime });
    expect(r.hostExit).toBe(1);
    expect(r.markdown).toContain('off the preview origin');
    expect(r.markdown).not.toContain('EXTERNAL-EXTRACTED-DATA');
    expect(page.goto).toHaveBeenCalledWith(`${ORIGIN}/`, expect.anything());
  });

  it('observe ops on-origin still return their captured content', async () => {
    const page = makeMockPage(`${ORIGIN}/dashboard`);
    registerPreviewBrowser(page);
    const runtime = makeRuntime();
    page.evaluate.mockResolvedValue('preview dashboard text');
    const r = await runPreviewReActStep(SESSION_ID, { op: 'read_page' }, { runtime });
    expect(r.hostExit).toBe(0);
    expect(r.markdown).toContain('preview dashboard text');
  });

  it('installs a persistent request-time origin guard on the drive session', async () => {
    // Regression: post-op checks alone revert AFTER a request egressed. The
    // persistent CDP guard must fail off-origin main-frame document requests
    // at request time — clicks on links/form submits to loopback or metadata
    // hosts never leave the box.
    const page = makeMockPage(`${ORIGIN}/`);
    const cdp = withCdp(page);
    registerPreviewBrowser(page);
    const runtime = makeRuntime();
    const r = await runPreviewReActStep(SESSION_ID, { op: 'read_page' }, { runtime });
    expect(r.hostExit).toBe(0);
    expect(cdp.send).toHaveBeenCalledWith('Fetch.enable', {
      patterns: [{ urlPattern: '*', requestStage: 'Request' }],
    });

    const h = cdp.handlers.get('Fetch.requestPaused')!;
    // Click-driven document navigation to a metadata-style SSRF target.
    h({
      requestId: 'm1',
      resourceType: 'Document',
      request: { url: 'http://169.254.169.254/latest/meta-data/' },
    });
    expect(cdp.send).toHaveBeenCalledWith('Fetch.failRequest', {
      requestId: 'm1',
      errorReason: 'BlockedByClient',
    });
    // Another session's preview port — also off-pin.
    h({
      requestId: 'm2',
      resourceType: 'Document',
      request: { url: 'http://localhost:4999/secret' },
    });
    expect(cdp.send).toHaveBeenCalledWith('Fetch.failRequest', {
      requestId: 'm2',
      errorReason: 'BlockedByClient',
    });
    // In-app document navigation continues.
    h({ requestId: 'm3', resourceType: 'Document', request: { url: `${ORIGIN}/next` } });
    expect(cdp.send).toHaveBeenCalledWith('Fetch.continueRequest', { requestId: 'm3' });
  });

  it('re-pins the request guard when the preview origin changes (preview restart)', async () => {
    const page = makeMockPage(`${ORIGIN}/`);
    const cdp = withCdp(page);
    registerPreviewBrowser(page);

    const first = makeRuntime();
    await runPreviewReActStep(SESSION_ID, { op: 'read_page' }, { runtime: first });

    // Human restarts the preview; it comes back on a new port.
    const newPort = 4555;
    const newOrigin = `http://localhost:${newPort}`;
    const restartedRow = { ...makeRow(), port: newPort, url: newOrigin };
    const second = makeRuntime({ row: restartedRow });
    await runPreviewReActStep(SESSION_ID, { op: 'read_page' }, { runtime: second });

    // Old guard uninstalled, fresh one installed.
    expect(cdp.send).toHaveBeenCalledWith('Fetch.disable');
    const h = cdp.handlers.get('Fetch.requestPaused')!;
    // The OLD origin is now off-pin…
    h({ requestId: 'p1', resourceType: 'Document', request: { url: `${ORIGIN}/stale` } });
    expect(cdp.send).toHaveBeenCalledWith('Fetch.failRequest', {
      requestId: 'p1',
      errorReason: 'BlockedByClient',
    });
    // …and the new origin is allowed.
    h({ requestId: 'p2', resourceType: 'Document', request: { url: `${newOrigin}/fresh` } });
    expect(cdp.send).toHaveBeenCalledWith('Fetch.continueRequest', { requestId: 'p2' });
  });

  it('navigate with the request guard active surfaces a blocked redirect as a failed op', async () => {
    const page = makeMockPage(`${ORIGIN}/`);
    withCdp(page);
    registerPreviewBrowser(page);
    const runtime = makeRuntime();
    // The guard fails the off-origin redirect hop at request time, which
    // surfaces to goto as a net error.
    page.goto.mockRejectedValueOnce(
      new Error('net::ERR_BLOCKED_BY_CLIENT at https://example.com/'),
    );
    const r = await runPreviewReActStep(
      SESSION_ID,
      { op: 'navigate', route: '/logout' },
      { runtime },
    );
    expect(r.hostExit).toBe(1);
    expect(r.markdown).toContain('ERR_BLOCKED_BY_CLIENT');
  });

  it('close shuts down the drive browser session only', async () => {
    const { close } = registerPreviewBrowser(makeMockPage());
    const runtime = makeRuntime();
    const r = await runPreviewReActStep(SESSION_ID, { op: 'close' }, { runtime });
    expect(r.hostExit).toBe(0);
    expect(close).toHaveBeenCalled();
    // Lifecycle untouched — close never stops the managed preview itself.
    expect(runtime.touchPreview).not.toHaveBeenCalled();
  });
});
