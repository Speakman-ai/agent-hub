import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { V3 } from '@browserbasehq/stagehand';
import {
  looksLikeSelectorTarget,
  runBrowserReActStep,
  resolveStagehandModelName,
  browserNavigate,
  browserBack,
  browserForward,
  browserWaitFixed,
  browserScroll,
  browserScreenshot,
  shrinkBrowserToolResultForMarkdown,
  validateBrowserExtractSchema,
  BROWSER_TOOL_MARKDOWN_DATA_MAX_BYTES,
  BROWSER_EXTRACT_SCHEMA_MAX_KEYS_PER_NODE,
  browserToolStartLabel,
  summarizeJsonPreview,
  BROWSER_ACTIVITY_SCREENSHOT_WS_MAX_CHARS,
} from './browser-tools.js';
import {
  __registerBrowserSessionForTests,
  __resetBrowserRegistryForTests,
  DEFAULT_TIMEOUT_MS,
} from './browser.js';

function makeMockPage() {
  const goto = vi.fn(async () => null);
  const waitForLoadState = vi.fn(async () => {});
  const waitForSelector = vi.fn(async () => {});
  const scroll = vi.fn(async () => {});
  const evaluate = vi.fn(async () => '');
  const page = {
    url: () => 'https://example.com/after',
    goto,
    waitForLoadState,
    waitForSelector,
    scroll,
    evaluate,
    locator: () => ({
      click: vi.fn(async () => {}),
      fill: vi.fn(async () => {}),
    }),
    screenshot: vi.fn(async () => Buffer.from([])),
    goBack: vi.fn(async () => {}),
    goForward: vi.fn(async () => {}),
  };
  return page;
}

function makeMockStagehand(
  page: ReturnType<typeof makeMockPage>,
  extras?: { extract?: () => Promise<unknown> },
) {
  return {
    context: {
      activePage: () => page,
      pages: () => [page],
    },
    act: vi.fn(async () => {}),
    extract: vi.fn(extras?.extract ?? (async () => ({ ok: true }))),
  };
}

function asV3(sh: unknown): V3 {
  return sh as V3;
}

describe('browser-tools — looksLikeSelectorTarget', () => {
  it('treats prose with spaces as natural language', () => {
    expect(looksLikeSelectorTarget('click the blue submit button')).toBe(false);
  });

  it('recognizes common CSS and XPath patterns', () => {
    expect(looksLikeSelectorTarget('#login')).toBe(true);
    expect(looksLikeSelectorTarget('.btn-primary')).toBe(true);
    expect(looksLikeSelectorTarget('[data-testid="x"]')).toBe(true);
    expect(looksLikeSelectorTarget('//button[@type="submit"]')).toBe(true);
    expect(looksLikeSelectorTarget('iframe >> #go')).toBe(true);
    expect(looksLikeSelectorTarget('button')).toBe(true);
    expect(looksLikeSelectorTarget('div.err')).toBe(true);
  });
});

describe('browser-tools — runBrowserReActStep', () => {
  beforeEach(() => {
    __resetBrowserRegistryForTests();
  });

  it('returns error markdown when op is unknown (does not launch Chromium)', async () => {
    const r = await runBrowserReActStep('test-session-uuid', { op: 'not-a-real-op' });
    expect(r.hostExit).toBe(1);
    expect(r.markdown).toMatch(/Unsupported or missing op/);
  });

  it('navigate: blocked URL does not call page.goto', async () => {
    const page = makeMockPage();
    __registerBrowserSessionForTests({
      id: 'nav-blocked',
      stagehand: makeMockStagehand(page),
      createdAt: Date.now(),
      timeoutMs: DEFAULT_TIMEOUT_MS,
      close: async () => {},
    });
    const r = await runBrowserReActStep('nav-blocked', {
      op: 'navigate',
      url: 'http://127.0.0.1/',
    });
    expect(r.hostExit).toBe(1);
    expect(page.goto).not.toHaveBeenCalled();
    expect(r.markdown).toMatch(/not allowed/);
  });

  it('navigate: allowed https URL calls goto with normalized href', async () => {
    const page = makeMockPage();
    __registerBrowserSessionForTests({
      id: 'nav-ok',
      stagehand: makeMockStagehand(page),
      createdAt: Date.now(),
      timeoutMs: DEFAULT_TIMEOUT_MS,
      close: async () => {},
    });
    const r = await runBrowserReActStep('nav-ok', {
      op: 'navigate',
      url: 'https://example.com/path?q=1',
    });
    expect(r.hostExit).toBe(0);
    expect(page.goto).toHaveBeenCalledWith('https://example.com/path?q=1', {
      waitUntil: 'load',
      timeoutMs: 30_000,
    });
    expect(r.markdown).toContain('Browser: navigate');
    expect(r.markdown).toContain('"ok": true');
  });

  it('navigate: prefers sessionLaunchOpts.timeoutMs over cached BrowserSession.timeoutMs', async () => {
    const page = makeMockPage();
    __registerBrowserSessionForTests({
      id: 'nav-timeout-override',
      stagehand: makeMockStagehand(page),
      createdAt: Date.now(),
      timeoutMs: 5_000,
      close: async () => {},
    });
    const r = await runBrowserReActStep(
      'nav-timeout-override',
      { op: 'navigate', url: 'https://example.com/over' },
      { timeoutMs: 60_000 },
    );
    expect(r.hostExit).toBe(0);
    expect(page.goto).toHaveBeenCalledWith('https://example.com/over', {
      waitUntil: 'load',
      timeoutMs: 60_000,
    });
  });

  it('navigate: uses session.timeoutMs when sessionLaunchOpts omit timeoutMs', async () => {
    const page = makeMockPage();
    __registerBrowserSessionForTests({
      id: 'nav-timeout-session',
      stagehand: makeMockStagehand(page),
      createdAt: Date.now(),
      timeoutMs: 12_345,
      close: async () => {},
    });
    const r = await runBrowserReActStep(
      'nav-timeout-session',
      { op: 'navigate', url: 'https://example.com/session-only' },
      {},
    );
    expect(r.hostExit).toBe(0);
    expect(page.goto).toHaveBeenCalledWith('https://example.com/session-only', {
      waitUntil: 'load',
      timeoutMs: 12_345,
    });
  });

  it('extract: rejects oversize schema before Stagehand extract', async () => {
    const page = makeMockPage();
    const stagehand = makeMockStagehand(page);
    const extractFn = stagehand.extract as ReturnType<typeof vi.fn>;
    __registerBrowserSessionForTests({
      id: 'ext-schema',
      stagehand,
      createdAt: Date.now(),
      timeoutMs: DEFAULT_TIMEOUT_MS,
      close: async () => {},
    });
    const bad: Record<string, unknown> = {};
    for (let i = 0; i < BROWSER_EXTRACT_SCHEMA_MAX_KEYS_PER_NODE + 1; i++) {
      bad[`p${i}`] = { type: 'string' };
    }
    const r = await runBrowserReActStep('ext-schema', {
      op: 'extract',
      instruction: 'list items',
      schema: bad,
    });
    expect(r.hostExit).toBe(1);
    expect(extractFn).not.toHaveBeenCalled();
    expect(r.markdown).toMatch(/too many keys/);
  });

  it('screenshot: success markdown uses JPEG data URL', async () => {
    const page = makeMockPage();
    page.screenshot.mockResolvedValueOnce(Buffer.from([0xff, 0xd8, 0xff, 0xdb]));
    __registerBrowserSessionForTests({
      id: 'shot-ok',
      stagehand: makeMockStagehand(page),
      createdAt: Date.now(),
      timeoutMs: DEFAULT_TIMEOUT_MS,
      close: async () => {},
    });
    const r = await runBrowserReActStep('shot-ok', { op: 'screenshot' });
    expect(r.hostExit).toBe(0);
    expect(page.screenshot).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'jpeg', quality: 72 }),
    );
    expect(r.markdown).toContain('data:image/jpeg;base64,');
    expect(r.ui?.screenshotCaptured).toBe(true);
    expect(r.ui?.screenshotWsUrl).toBeTruthy();
  });

  it('screenshot: succeeds with screenshotCaptured but omits WS URL when data URL exceeds cap', async () => {
    const page = makeMockPage();
    const jpegBytes = 90_000;
    page.screenshot.mockResolvedValueOnce(Buffer.alloc(jpegBytes, 7));
    const dataUrlLen = `data:image/jpeg;base64,${Buffer.alloc(jpegBytes).toString('base64')}`
      .length;
    expect(dataUrlLen).toBeGreaterThan(BROWSER_ACTIVITY_SCREENSHOT_WS_MAX_CHARS);

    __registerBrowserSessionForTests({
      id: 'shot-no-ws',
      stagehand: makeMockStagehand(page),
      createdAt: Date.now(),
      timeoutMs: DEFAULT_TIMEOUT_MS,
      close: async () => {},
    });
    const r = await runBrowserReActStep('shot-no-ws', { op: 'screenshot' });
    expect(r.hostExit).toBe(0);
    expect(r.ui?.screenshotCaptured).toBe(true);
    expect(r.ui?.screenshotWsUrl).toBeUndefined();
  });

  it('screenshot: rejects encoded image over markdown cap', async () => {
    const page = makeMockPage();
    page.screenshot.mockResolvedValueOnce(Buffer.alloc(600_000, 9));
    __registerBrowserSessionForTests({
      id: 'shot-big',
      stagehand: makeMockStagehand(page),
      createdAt: Date.now(),
      timeoutMs: DEFAULT_TIMEOUT_MS,
      close: async () => {},
    });
    const r = await runBrowserReActStep('shot-big', { op: 'screenshot' });
    expect(r.hostExit).toBe(1);
    expect(r.markdown).toMatch(/maximum (encoded )?size/i);
  });

  it('extract: large JSON in result is shrunk in markdown', async () => {
    const big: Record<string, string> = {};
    const chunk = 'y'.repeat(6000);
    for (let i = 0; i < 80; i++) big[`f${i}`] = chunk;
    const page = makeMockPage();
    __registerBrowserSessionForTests({
      id: 'ext-big',
      stagehand: makeMockStagehand(page, { extract: async () => big }),
      createdAt: Date.now(),
      timeoutMs: DEFAULT_TIMEOUT_MS,
      close: async () => {},
    });
    const r = await runBrowserReActStep('ext-big', { op: 'extract', instruction: 'get stuff' });
    expect(r.hostExit).toBe(0);
    expect(r.markdown).toContain('_browserToolDataTruncated');
    expect(r.markdown).toContain('approxOriginalJsonBytes');
    expect(Buffer.byteLength(r.markdown, 'utf-8')).toBeLessThan(
      Buffer.byteLength(JSON.stringify(big), 'utf-8'),
    );
  });

  it('wait: networkidle uses waitForLoadState', async () => {
    const page = makeMockPage();
    __registerBrowserSessionForTests({
      id: 'wait-net',
      stagehand: makeMockStagehand(page),
      createdAt: Date.now(),
      timeoutMs: DEFAULT_TIMEOUT_MS,
      close: async () => {},
    });
    const r = await runBrowserReActStep('wait-net', { op: 'wait', condition: 'networkidle' });
    expect(r.hostExit).toBe(0);
    expect(page.waitForLoadState).toHaveBeenCalledWith('networkidle', 30_000);
    expect(page.waitForSelector).not.toHaveBeenCalled();
    expect(r.markdown).toContain('"kind": "networkidle"');
  });

  it('wait: bare selector uses waitForSelector', async () => {
    const page = makeMockPage();
    __registerBrowserSessionForTests({
      id: 'wait-sel',
      stagehand: makeMockStagehand(page),
      createdAt: Date.now(),
      timeoutMs: DEFAULT_TIMEOUT_MS,
      close: async () => {},
    });
    const r = await runBrowserReActStep('wait-sel', { op: 'wait', condition: '#submit' });
    expect(r.hostExit).toBe(0);
    expect(page.waitForSelector).toHaveBeenCalledWith('#submit', {
      state: 'visible',
      timeout: 30_000,
      pierceShadow: true,
    });
    expect(r.markdown).toContain('"kind": "selector"');
  });

  it('wait: propagates failure from waitForSelector', async () => {
    const page = makeMockPage();
    page.waitForSelector.mockRejectedValueOnce(new Error('timeout selector'));
    __registerBrowserSessionForTests({
      id: 'wait-fail',
      stagehand: makeMockStagehand(page),
      createdAt: Date.now(),
      timeoutMs: DEFAULT_TIMEOUT_MS,
      close: async () => {},
    });
    const r = await runBrowserReActStep('wait-fail', { op: 'wait', condition: '#gone' });
    expect(r.hostExit).toBe(1);
    expect(r.markdown).toMatch(/timeout selector/);
  });

  it('scroll: unknown direction returns error without calling page.scroll', async () => {
    const page = makeMockPage();
    __registerBrowserSessionForTests({
      id: 'scr-bad',
      stagehand: makeMockStagehand(page),
      createdAt: Date.now(),
      timeoutMs: DEFAULT_TIMEOUT_MS,
      close: async () => {},
    });
    const r = await runBrowserReActStep('scr-bad', { op: 'scroll', direction: 'sideways' });
    expect(r.hostExit).toBe(1);
    expect(page.scroll).not.toHaveBeenCalled();
    expect(r.markdown).toMatch(/Unknown direction/);
  });

  it('scroll: page.scroll failure surfaces in markdown', async () => {
    const page = makeMockPage();
    page.scroll.mockRejectedValueOnce(new Error('scroll failed'));
    __registerBrowserSessionForTests({
      id: 'scr-throw',
      stagehand: makeMockStagehand(page),
      createdAt: Date.now(),
      timeoutMs: DEFAULT_TIMEOUT_MS,
      close: async () => {},
    });
    const r = await runBrowserReActStep('scr-throw', { op: 'scroll', direction: 'down' });
    expect(r.hostExit).toBe(1);
    expect(r.markdown).toMatch(/scroll failed/);
  });
});

describe('browser-tools — validateBrowserExtractSchema', () => {
  it('accepts a small JSON schema object', () => {
    const r = validateBrowserExtractSchema({
      type: 'object',
      properties: { title: { type: 'string' } },
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.parsed.type).toBe('object');
  });

  it('rejects too many keys on one object', () => {
    const o: Record<string, unknown> = {};
    for (let i = 0; i < BROWSER_EXTRACT_SCHEMA_MAX_KEYS_PER_NODE + 1; i++) {
      o[`k${i}`] = { type: 'string' };
    }
    expect(validateBrowserExtractSchema(o).ok).toBe(false);
  });

  it('rejects excessive JSON byte size', () => {
    const r = validateBrowserExtractSchema({ blob: 'x'.repeat(50_000) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/exceeds/i);
  });

  it('rejects excessive nesting', () => {
    let inner: Record<string, unknown> = { type: 'string' };
    for (let i = 0; i < 20; i++) {
      inner = { wrap: inner };
    }
    expect(validateBrowserExtractSchema({ root: inner }).ok).toBe(false);
  });
});

describe('browser-tools — direct helpers', () => {
  beforeEach(() => {
    __resetBrowserRegistryForTests();
  });

  it('browserNavigate rejects before goto on private IP', async () => {
    const page = makeMockPage();
    const sh = asV3(makeMockStagehand(page));
    const r = await browserNavigate(sh, 'http://192.168.1.1/');
    expect(r.ok).toBe(false);
    expect(page.goto).not.toHaveBeenCalled();
  });

  it('browserNavigate rejects disallowed committed URL after goto', async () => {
    const page = makeMockPage();
    page.goto.mockResolvedValueOnce(null);
    vi.spyOn(page, 'url').mockReturnValue('http://127.0.0.1/after-redirect');
    const sh = asV3(makeMockStagehand(page));
    const r = await browserNavigate(sh, 'https://example.com/');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/landed on a disallowed URL/i);
  });

  it('browserBack rejects disallowed URL after history navigation', async () => {
    const page = makeMockPage();
    page.goBack.mockResolvedValueOnce(undefined);
    vi.spyOn(page, 'url').mockReturnValue('http://192.168.1.1/');
    const sh = asV3(makeMockStagehand(page));
    const r = await browserBack(sh);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/History navigation landed on a disallowed URL/i);
  });

  it('browserForward rejects disallowed URL after history navigation', async () => {
    const page = makeMockPage();
    page.goForward.mockResolvedValueOnce(undefined);
    vi.spyOn(page, 'url').mockReturnValue('http://127.0.0.1/');
    const sh = asV3(makeMockStagehand(page));
    const r = await browserForward(sh);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/History navigation landed on a disallowed URL/i);
  });

  it('browserWaitFixed networkidle vs selector', async () => {
    const page = makeMockPage();
    const sh = asV3(makeMockStagehand(page));
    const a = await browserWaitFixed(sh, 'network_idle');
    expect(a.ok).toBe(true);
    expect(page.waitForLoadState).toHaveBeenCalledWith('networkidle', 30_000);
    const b = await browserWaitFixed(sh, 'selector:  .btn');
    expect(b.ok).toBe(true);
    expect(page.waitForSelector).toHaveBeenCalledWith('.btn', {
      state: 'visible',
      timeout: 30_000,
      pierceShadow: true,
    });
  });

  it('browserScreenshot encodes JPEG and rejects oversize base64', async () => {
    const page = makeMockPage();
    page.screenshot.mockResolvedValueOnce(Buffer.from([0xff, 0xd8, 0xff]));
    const sh = asV3(makeMockStagehand(page));
    const ok = await browserScreenshot(sh);
    expect(ok.ok).toBe(true);
    expect(page.screenshot).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'jpeg', quality: 72 }),
    );

    page.screenshot.mockResolvedValueOnce(Buffer.alloc(650_000, 1));
    const bad = await browserScreenshot(sh);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toMatch(/maximum encoded size/i);
  });

  it('browserScroll rejects unknown direction', async () => {
    const page = makeMockPage();
    const sh = asV3(makeMockStagehand(page));
    const r = await browserScroll(sh, 'nope');
    expect(r.ok).toBe(false);
    expect(page.evaluate).not.toHaveBeenCalled();
    expect(page.scroll).not.toHaveBeenCalled();
  });
});

describe('browser-tools — shrinkBrowserToolResultForMarkdown', () => {
  it('passes through small payloads unchanged', () => {
    const r = { ok: true as const, op: 'extract' as const, data: { a: 1 } };
    expect(shrinkBrowserToolResultForMarkdown(r)).toEqual(r);
  });

  it('truncates oversized data with preview metadata', () => {
    const huge = { blob: 'z'.repeat(50_000) };
    const r = { ok: true as const, op: 'extract' as const, data: huge };
    const out = shrinkBrowserToolResultForMarkdown(r, 2000);
    expect(out.data).toMatchObject({
      _browserToolDataTruncated: true,
    });
    expect(JSON.stringify(out.data)).toContain('preview');
    expect(Buffer.byteLength(JSON.stringify(out.data), 'utf-8')).toBeLessThanOrEqual(2000 + 500);
  });

  it('respects BROWSER_TOOL_MARKDOWN_DATA_MAX_BYTES default', () => {
    const r = {
      ok: true as const,
      op: 'extract' as const,
      data: { x: 'p'.repeat(BROWSER_TOOL_MARKDOWN_DATA_MAX_BYTES * 2) },
    };
    const out = shrinkBrowserToolResultForMarkdown(r);
    expect(out.data).toMatchObject({ _browserToolDataTruncated: true });
  });
});

describe('browser-tools — browser UI copy helpers', () => {
  it('browserToolStartLabel surfaces navigation host when parseable', () => {
    expect(browserToolStartLabel({ op: 'navigate', url: 'https://github.com/repos' })).toMatch(
      /github\.com/i,
    );
  });

  it('summarizeJsonPreview clips long payloads', () => {
    const s = summarizeJsonPreview({ hay: 'Z'.repeat(200) }, 32);
    expect(s!.length).toBeLessThanOrEqual(33);
    expect(s).toContain('…');
  });
});

describe('browser-tools — resolveStagehandModelName', () => {
  it('falls back to a Stagehand-style anthropic id when STAGEHAND_MODEL is unset', () => {
    const prev = process.env.STAGEHAND_MODEL;
    delete process.env.STAGEHAND_MODEL;
    try {
      expect(resolveStagehandModelName()).toMatch(/^anthropic\//);
    } finally {
      if (prev !== undefined) process.env.STAGEHAND_MODEL = prev;
    }
  });
});
