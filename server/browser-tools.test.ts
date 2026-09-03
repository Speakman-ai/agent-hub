import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { V3 } from '@browserbasehq/stagehand';
import { browserScreenshotDirForSession } from './browser-screenshot-store.js';
import { mergePendingContextWithCap, MAX_PENDING_CONTEXT_BYTES } from './chat.js';

const MAX_PENDING_CONTEXT_BYTES_FOR_TEST = MAX_PENDING_CONTEXT_BYTES;
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
  installPersistentDocumentNavigationGuard,
  BROWSER_ACTIVITY_SCREENSHOT_WS_MAX_CHARS,
} from './browser-tools.js';
import {
  __registerBrowserSessionForTests,
  __resetBrowserRegistryForTests,
  DEFAULT_TIMEOUT_MS,
} from './browser.js';
import { installContextFetchGuard } from './browser-context-fetch-guard.js';

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
    title: vi.fn(async () => 'Example'),
    innerText: vi.fn(async () => 'Hello body'),
    getByText: vi.fn(() => ({
      first: () => ({ click: vi.fn(async () => {}), fill: vi.fn(async () => {}) }),
    })),
    getByLabel: vi.fn(() => ({
      first: () => ({ click: vi.fn(async () => {}), fill: vi.fn(async () => {}) }),
    })),
    mouse: { wheel: vi.fn(async () => {}) },
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
  let screenshotDataDir: string;
  let prevDataDir: string | undefined;

  beforeEach(() => {
    __resetBrowserRegistryForTests();
    // Screenshot captures land on disk — keep them in a throwaway dir.
    prevDataDir = process.env.AGENT_HUB_DATA_DIR;
    screenshotDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-bt-shot-'));
    process.env.AGENT_HUB_DATA_DIR = screenshotDataDir;
  });

  afterEach(() => {
    if (prevDataDir === undefined) delete process.env.AGENT_HUB_DATA_DIR;
    else process.env.AGENT_HUB_DATA_DIR = prevDataDir;
    fs.rmSync(screenshotDataDir, { recursive: true, force: true });
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
      timeout: 30_000,
    });
    expect(r.markdown).toContain('Browser: navigate');
    expect(r.markdown).toContain('"ok": true');
  });

  it('click: natural-language target uses Playwright getByText, not Stagehand act', async () => {
    const page = makeMockPage();
    const stagehand = makeMockStagehand(page);
    const actFn = stagehand.act as ReturnType<typeof vi.fn>;
    const clickFn = vi.fn(async () => {});
    page.getByText = vi.fn(() => ({
      first: () => ({ click: clickFn, fill: vi.fn(async () => {}) }),
    }));
    __registerBrowserSessionForTests({
      id: 'click-nl',
      stagehand,
      createdAt: Date.now(),
      timeoutMs: DEFAULT_TIMEOUT_MS,
      close: async () => {},
    });
    const r = await runBrowserReActStep('click-nl', {
      op: 'click',
      target: 'the blue submit button',
    });
    expect(r.hostExit).toBe(0);
    expect(page.getByText).toHaveBeenCalledWith('the blue submit button', { exact: false });
    expect(clickFn).toHaveBeenCalled();
    expect(actFn).not.toHaveBeenCalled();
    expect(r.markdown).toContain('"method": "getByText"');
  });

  it('click: CSS selector uses locator, not getByText or act', async () => {
    const page = makeMockPage();
    const stagehand = makeMockStagehand(page);
    const actFn = stagehand.act as ReturnType<typeof vi.fn>;
    const clickFn = vi.fn(async () => {});
    page.locator = vi.fn(() => ({
      click: clickFn,
      fill: vi.fn(async () => {}),
    }));
    __registerBrowserSessionForTests({
      id: 'click-sel',
      stagehand,
      createdAt: Date.now(),
      timeoutMs: DEFAULT_TIMEOUT_MS,
      close: async () => {},
    });
    const r = await runBrowserReActStep('click-sel', { op: 'click', target: '#submit' });
    expect(r.hostExit).toBe(0);
    expect(page.locator).toHaveBeenCalledWith('#submit');
    expect(clickFn).toHaveBeenCalled();
    expect(page.getByText).not.toHaveBeenCalled();
    expect(actFn).not.toHaveBeenCalled();
    expect(r.markdown).toContain('"method": "locator"');
  });

  it('type: CSS selector fills the first visible match, skipping hidden mirror inputs', async () => {
    const page = makeMockPage();
    const stagehand = makeMockStagehand(page);
    const fillMirror = vi.fn(async () => {});
    const fillVisible = vi.fn(async () => {});
    // .first() on the visible-filtered set → the real, on-screen input.
    const visibleFirst = { click: vi.fn(async () => {}), fill: fillVisible };
    const visibleSet = {
      click: vi.fn(async () => {}),
      fill: vi.fn(async () => {}),
      first: () => visibleFirst,
    };
    // The unfiltered locator matches [hidden mirror, visible input]; a bare
    // .fill() here is the buggy path that drives the mirror / strict-throws.
    const allMatches = {
      click: vi.fn(async () => {}),
      fill: fillMirror,
      filter: vi.fn((opts: { visible?: boolean }) => (opts.visible ? visibleSet : allMatches)),
    };
    page.locator = vi.fn(() => allMatches);
    __registerBrowserSessionForTests({
      id: 'type-visible',
      stagehand,
      createdAt: Date.now(),
      timeoutMs: DEFAULT_TIMEOUT_MS,
      close: async () => {},
    });
    const r = await runBrowserReActStep('type-visible', {
      op: 'type',
      target: 'input[formcontrolname="username"]',
      text: 'admin',
    });
    expect(r.hostExit).toBe(0);
    expect(page.locator).toHaveBeenCalledWith('input[formcontrolname="username"]');
    expect(allMatches.filter).toHaveBeenCalledWith({ visible: true });
    expect(fillVisible).toHaveBeenCalledWith('admin');
    expect(fillMirror).not.toHaveBeenCalled();
    expect(r.markdown).toContain('"method": "locator"');
  });

  it('type: falls back to the bare locator when filter/first are unavailable (fake page)', async () => {
    const page = makeMockPage();
    const stagehand = makeMockStagehand(page);
    const fillFn = vi.fn(async () => {});
    // Minimal locator (no filter/first) — must still be filled directly.
    page.locator = vi.fn(() => ({ click: vi.fn(async () => {}), fill: fillFn }));
    __registerBrowserSessionForTests({
      id: 'type-fallback',
      stagehand,
      createdAt: Date.now(),
      timeoutMs: DEFAULT_TIMEOUT_MS,
      close: async () => {},
    });
    const r = await runBrowserReActStep('type-fallback', {
      op: 'type',
      target: '#username',
      text: 'admin',
    });
    expect(r.hostExit).toBe(0);
    expect(page.locator).toHaveBeenCalledWith('#username');
    expect(fillFn).toHaveBeenCalledWith('admin');
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
      timeout: 60_000,
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
      timeout: 12_345,
    });
  });

  it('back/forward: do not TDZ-crash on the session host handle', async () => {
    const page = makeMockPage();
    __registerBrowserSessionForTests({
      id: 'hist-ok',
      stagehand: makeMockStagehand(page),
      createdAt: Date.now(),
      timeoutMs: DEFAULT_TIMEOUT_MS,
      close: async () => {},
    });
    const back = await runBrowserReActStep('hist-ok', { op: 'back' });
    expect(back.hostExit).toBe(0);
    expect(page.goBack).toHaveBeenCalled();
    expect(back.markdown).not.toMatch(/before initialization/);
    const fwd = await runBrowserReActStep('hist-ok', { op: 'forward' });
    expect(fwd.hostExit).toBe(0);
    expect(page.goForward).toHaveBeenCalled();
  });

  it('extract: rejects oversize schema before snapshotting the page', async () => {
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

  it('screenshot: saves the capture to disk and reports its path', async () => {
    const page = makeMockPage();
    const pixels = Buffer.from([0xff, 0xd8, 0xff, 0xdb]);
    page.screenshot.mockResolvedValueOnce(pixels);
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

    const dir = browserScreenshotDirForSession('shot-ok', screenshotDataDir)!;
    const files = fs.readdirSync(dir);
    expect(files).toHaveLength(1);
    const abs = path.join(dir, files[0]);
    expect(fs.readFileSync(abs)).toEqual(pixels);

    // The path is what the agent gets — the bytes never enter the markdown.
    expect(r.markdown).toContain(abs);
    expect(r.markdown).toContain('Read that path with your file-reading tool');
    expect(r.markdown).toContain('Hello body');
    expect(r.markdown).not.toContain('data:image/jpeg;base64,');

    // The live chat preview still gets a data URL over the WebSocket.
    expect(r.ui?.screenshotCaptured).toBe(true);
    expect(r.ui?.screenshotWsUrl).toBeTruthy();
    expect(r.ui?.screenshotWsUrl).toContain('data:image/jpeg;base64,');
  });

  it('screenshot: reports empty visible text when the DOM body is blank', async () => {
    const page = makeMockPage();
    page.innerText.mockResolvedValueOnce('');
    page.screenshot.mockResolvedValueOnce(Buffer.from([0xff, 0xd8, 0xff, 0xdb]));
    __registerBrowserSessionForTests({
      id: 'shot-blank',
      stagehand: makeMockStagehand(page),
      createdAt: Date.now(),
      timeoutMs: DEFAULT_TIMEOUT_MS,
      close: async () => {},
    });
    const r = await runBrowserReActStep('shot-blank', { op: 'screenshot' });
    expect(r.hostExit).toBe(0);
    expect(r.markdown).toMatch(/Visible text: \(empty — the page looks blank to the DOM\)/);
  });

  it('screenshot: markdown stays tiny for a large capture (pending-context regression)', async () => {
    // A 400 KB JPEG encodes to ~547k base64 chars. Inlined as a data URL that
    // blew the 128 KiB pending-context cap, so the merge clipped the capture to
    // truncated base64 AND evicted every other observation in the same turn —
    // the agent saw a "successful" host step that returned nothing usable.
    const page = makeMockPage();
    page.screenshot.mockResolvedValueOnce(Buffer.alloc(400_000, 7));
    __registerBrowserSessionForTests({
      id: 'shot-large',
      stagehand: makeMockStagehand(page),
      createdAt: Date.now(),
      timeoutMs: DEFAULT_TIMEOUT_MS,
      close: async () => {},
    });
    const r = await runBrowserReActStep('shot-large', { op: 'screenshot' });
    expect(r.hostExit).toBe(0);

    const markdownBytes = Buffer.byteLength(r.markdown, 'utf-8');
    expect(markdownBytes).toBeLessThan(4096);
    expect(markdownBytes).toBeLessThan(MAX_PENDING_CONTEXT_BYTES_FOR_TEST);
    expect(r.markdown).not.toContain('base64,');

    // The full-resolution bytes are still on disk, unclipped.
    const dir = browserScreenshotDirForSession('shot-large', screenshotDataDir)!;
    const files = fs.readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(fs.statSync(path.join(dir, files[0])).size).toBe(400_000);

    // Too big for the WS preview, but that must not suppress the saved path.
    expect(r.ui?.screenshotWsUrl).toBeUndefined();
    expect(r.ui?.screenshotCaptured).toBe(true);
    expect(r.markdown).toContain(path.join(dir, files[0]));
  });

  it('screenshot: a merged turn of observations survives a large capture', async () => {
    // The old failure mode was collateral: mergePendingContextWithCap takes the
    // "addition dominates" branch when the addition alone exceeds the cap, and
    // that branch drops existing context entirely.
    const page = makeMockPage();
    page.screenshot.mockResolvedValueOnce(Buffer.alloc(400_000, 7));
    __registerBrowserSessionForTests({
      id: 'shot-merge',
      stagehand: makeMockStagehand(page),
      createdAt: Date.now(),
      timeoutMs: DEFAULT_TIMEOUT_MS,
      close: async () => {},
    });
    const r = await runBrowserReActStep('shot-merge', { op: 'screenshot' });
    const earlierObservation = '## Web search\nresult one\nresult two';
    const merged = mergePendingContextWithCap(earlierObservation, r.markdown);
    expect(merged).toContain('result one');
    expect(merged).toContain('## Browser: screenshot');
    expect(merged).not.toContain('[Truncated: pending context byte cap reached]');
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

  it('screenshot: persists a capture the old chat-context cap would have rejected', async () => {
    // 600 KB encodes to 800k base64 chars — over the retired 750k "chat
    // context" cap. Now that captures go to disk rather than into markdown,
    // rejecting this outright was itself a way to lose a screenshot.
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
    expect(r.hostExit).toBe(0);

    const dir = browserScreenshotDirForSession('shot-big', screenshotDataDir)!;
    const files = fs.readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(fs.statSync(path.join(dir, files[0])).size).toBe(600_000);
    expect(r.markdown).toContain(path.join(dir, files[0]));
    expect(r.markdown).toContain('<saved to file>');
    // Far too large for the live thumbnail, but that must not gate the file.
    expect(r.ui?.screenshotWsUrl).toBeUndefined();
    expect(r.ui?.screenshotCaptured).toBe(true);
  });

  it('screenshot: rejects a capture over the host memory ceiling', async () => {
    const page = makeMockPage();
    // Encodes to > BROWSER_SCREENSHOT_BASE64_MAX_CHARS.
    page.screenshot.mockResolvedValueOnce(Buffer.alloc(9_500_000, 9));
    __registerBrowserSessionForTests({
      id: 'shot-huge',
      stagehand: makeMockStagehand(page),
      createdAt: Date.now(),
      timeoutMs: DEFAULT_TIMEOUT_MS,
      close: async () => {},
    });
    const r = await runBrowserReActStep('shot-huge', { op: 'screenshot' });
    expect(r.hostExit).toBe(1);
    expect(r.markdown).toMatch(/maximum capture size/i);
    expect(fs.existsSync(browserScreenshotDirForSession('shot-huge', screenshotDataDir)!)).toBe(
      false,
    );
  });

  it('screenshot: reports honestly when the capture cannot be persisted', async () => {
    // Point the data dir at a regular file so mkdir fails.
    const blocker = path.join(screenshotDataDir, 'not-a-dir');
    fs.writeFileSync(blocker, 'x');
    process.env.AGENT_HUB_DATA_DIR = blocker;

    const page = makeMockPage();
    page.screenshot.mockResolvedValueOnce(Buffer.from([0xff, 0xd8, 0xff, 0xdb]));
    __registerBrowserSessionForTests({
      id: 'shot-nowrite',
      stagehand: makeMockStagehand(page),
      createdAt: Date.now(),
      timeoutMs: DEFAULT_TIMEOUT_MS,
      close: async () => {},
    });
    const r = await runBrowserReActStep('shot-nowrite', { op: 'screenshot' });
    expect(r.hostExit).toBe(0);
    // Must not claim a file exists when none was written.
    expect(r.markdown).not.toContain('<saved to file>');
    expect(r.markdown).toContain('<capture not persisted>');
    expect(r.markdown).toMatch(/could not be written to disk/i);
  });

  it('extract: returns a Playwright page snapshot (no nested LLM)', async () => {
    const page = makeMockPage();
    const stagehand = makeMockStagehand(page);
    const extractFn = stagehand.extract as ReturnType<typeof vi.fn>;
    __registerBrowserSessionForTests({
      id: 'ext-snap',
      stagehand,
      createdAt: Date.now(),
      timeoutMs: DEFAULT_TIMEOUT_MS,
      close: async () => {},
    });
    const r = await runBrowserReActStep('ext-snap', { op: 'extract', instruction: 'get stuff' });
    expect(r.hostExit).toBe(0);
    expect(extractFn).not.toHaveBeenCalled();
    expect(r.markdown).toContain('Hello body');
    expect(r.markdown).toMatch(/page snapshot/i);
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
    expect(page.waitForLoadState).toHaveBeenCalledWith('networkidle', { timeout: 30_000 });
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
    expect(page.mouse.wheel).not.toHaveBeenCalled();
    expect(r.markdown).toMatch(/Unknown direction/);
  });

  it('scroll: mouse.wheel failure surfaces in markdown', async () => {
    const page = makeMockPage();
    page.mouse.wheel.mockRejectedValueOnce(new Error('scroll failed'));
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
    expect(page.waitForLoadState).toHaveBeenCalledWith('networkidle', { timeout: 30_000 });
    const b = await browserWaitFixed(sh, 'selector:  .btn');
    expect(b.ok).toBe(true);
    expect(page.waitForSelector).toHaveBeenCalledWith('.btn', {
      state: 'visible',
      timeout: 30_000,
    });
  });

  it('browserScreenshot encodes JPEG and only rejects past the memory ceiling', async () => {
    const page = makeMockPage();
    page.screenshot.mockResolvedValueOnce(Buffer.from([0xff, 0xd8, 0xff]));
    const sh = asV3(makeMockStagehand(page));
    const ok = await browserScreenshot(sh);
    expect(ok.ok).toBe(true);
    expect(page.screenshot).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'jpeg', quality: 72 }),
    );

    // Comfortably past the retired 750k chat-context cap — still a valid capture.
    page.screenshot.mockResolvedValueOnce(Buffer.alloc(650_000, 1));
    const large = await browserScreenshot(sh);
    expect(large.ok).toBe(true);
    expect(large.imageBase64?.length).toBeGreaterThan(750_000);

    page.screenshot.mockResolvedValueOnce(Buffer.alloc(9_500_000, 1));
    const bad = await browserScreenshot(sh);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toMatch(/maximum capture size/i);
  });

  it('browserScroll rejects unknown direction', async () => {
    const page = makeMockPage();
    const sh = asV3(makeMockStagehand(page));
    const r = await browserScroll(sh, 'nope');
    expect(r.ok).toBe(false);
    expect(page.evaluate).not.toHaveBeenCalled();
    expect(page.scroll).not.toHaveBeenCalled();
    expect(page.mouse.wheel).not.toHaveBeenCalled();
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
      // Pin the exact default so a model bump is a deliberate, reviewed change.
      expect(resolveStagehandModelName()).toBe('anthropic/claude-sonnet-5');
    } finally {
      if (prev !== undefined) process.env.STAGEHAND_MODEL = prev;
    }
  });
});

describe('installPersistentDocumentNavigationGuard', () => {
  const PIN = 'http://localhost:4123';

  function makeCdpPage() {
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
    const page = Object.assign(makeMockPage(), { mainSession });
    return { page, send, handlers, mainSession };
  }

  it('fails off-pin Document requests at request time, before egress (real CDP event shape)', async () => {
    const { page, send, handlers } = makeCdpPage();
    const sh = asV3(makeMockStagehand(page));
    const guard = await installPersistentDocumentNavigationGuard(sh, (u) =>
      u.startsWith(`${PIN}/`),
    );
    expect(guard.installed).toBe(true);
    expect(send).toHaveBeenCalledWith('Fetch.enable', {
      patterns: [{ urlPattern: '*', requestStage: 'Request' }],
    });

    const h = handlers.get('Fetch.requestPaused')!;
    // Per the CDP spec, `resourceType` is a TOP-LEVEL Fetch.requestPaused
    // field — NOT nested inside `request`. Regression: a guard reading
    // request.resourceType treats every document navigation as a
    // subresource and continues it.
    // Metadata-style SSRF target via a click-driven document navigation.
    h({
      requestId: 'r1',
      resourceType: 'Document',
      request: { url: 'http://169.254.169.254/latest/meta-data/' },
    });
    expect(send).toHaveBeenCalledWith('Fetch.failRequest', {
      requestId: 'r1',
      errorReason: 'BlockedByClient',
    });
    // Public off-pin target is blocked too — the pin is exact.
    h({ requestId: 'r2', resourceType: 'Document', request: { url: 'https://example.com/' } });
    expect(send).toHaveBeenCalledWith('Fetch.failRequest', {
      requestId: 'r2',
      errorReason: 'BlockedByClient',
    });
    // On-pin documents continue.
    h({ requestId: 'r3', resourceType: 'Document', request: { url: `${PIN}/settings` } });
    expect(send).toHaveBeenCalledWith('Fetch.continueRequest', { requestId: 'r3' });
  });

  it('honors a nested request.resourceType as a fallback for shape drift', async () => {
    const { page, send, handlers } = makeCdpPage();
    const sh = asV3(makeMockStagehand(page));
    await installPersistentDocumentNavigationGuard(sh, () => false);
    const h = handlers.get('Fetch.requestPaused')!;
    h({ requestId: 'n1', request: { url: 'https://example.com/', resourceType: 'Document' } });
    expect(send).toHaveBeenCalledWith('Fetch.failRequest', {
      requestId: 'n1',
      errorReason: 'BlockedByClient',
    });
  });

  it('does not intercept subresource requests (same scope as navigate-time policy)', async () => {
    const { page, send, handlers } = makeCdpPage();
    const sh = asV3(makeMockStagehand(page));
    await installPersistentDocumentNavigationGuard(sh, () => false);
    const h = handlers.get('Fetch.requestPaused')!;
    h({
      requestId: 's1',
      resourceType: 'Script',
      request: { url: 'https://cdn.example.com/app.js' },
    });
    expect(send).toHaveBeenCalledWith('Fetch.continueRequest', { requestId: 's1' });
    expect(send).not.toHaveBeenCalledWith('Fetch.failRequest', expect.anything());
  });

  it('registers the pause handler BEFORE enabling Fetch (no unhandled in-flight pauses)', async () => {
    const { page, send, handlers, mainSession } = makeCdpPage();
    // While Fetch.enable is still settling, Chromium may already pause an
    // in-flight request — the handler must be attached by then.
    send.mockImplementationOnce(async (...args: unknown[]) => {
      expect(args[0]).toBe('Fetch.enable');
      expect(handlers.has('Fetch.requestPaused')).toBe(true);
      return {};
    });
    const sh = asV3(makeMockStagehand(page));
    const guard = await installPersistentDocumentNavigationGuard(sh, () => true);
    expect(guard.installed).toBe(true);
    const onOrder = mainSession.on.mock.invocationCallOrder[0]!;
    const enableOrder = send.mock.invocationCallOrder[0]!;
    expect(onOrder).toBeLessThan(enableOrder);
  });

  it('returns installed:false when the page has no CDP session', async () => {
    const sh = asV3(makeMockStagehand(makeMockPage()));
    const guard = await installPersistentDocumentNavigationGuard(sh, () => true);
    expect(guard.installed).toBe(false);
  });

  it('detaches the handler and returns installed:false when Fetch.enable fails', async () => {
    const { page, send, handlers, mainSession } = makeCdpPage();
    send.mockRejectedValueOnce(new Error('Fetch domain unavailable'));
    const sh = asV3(makeMockStagehand(page));
    const guard = await installPersistentDocumentNavigationGuard(sh, () => true);
    expect(guard.installed).toBe(false);
    // No orphaned handler left behind after the failed enable.
    expect(mainSession.off).toHaveBeenCalledWith('Fetch.requestPaused', expect.any(Function));
    expect(handlers.has('Fetch.requestPaused')).toBe(false);
  });

  it('uninstall detaches the handler and disables Fetch', async () => {
    const { page, send, handlers, mainSession } = makeCdpPage();
    const sh = asV3(makeMockStagehand(page));
    const guard = await installPersistentDocumentNavigationGuard(sh, () => true);
    expect(handlers.has('Fetch.requestPaused')).toBe(true);
    await guard.uninstall();
    expect(mainSession.off).toHaveBeenCalledWith('Fetch.requestPaused', expect.any(Function));
    expect(send).toHaveBeenCalledWith('Fetch.disable');
    expect(handlers.has('Fetch.requestPaused')).toBe(false);
  });

  it('the transient CDP session is detached on uninstall (no leaked attachment)', async () => {
    const { page, mainSession } = makeCdpPage();
    const detach = vi.fn(async () => {});
    (mainSession as unknown as { detach: () => Promise<void> }).detach = detach;
    const sh = asV3(makeMockStagehand(page));
    const guard = await installPersistentDocumentNavigationGuard(sh, () => true);
    await guard.uninstall();
    expect(detach).toHaveBeenCalledTimes(1);
  });
});

describe('browser-tools — production BrowserSession shape (single CDP Fetch owner)', () => {
  const PIN = 'http://localhost:4123';

  beforeEach(() => {
    __resetBrowserRegistryForTests();
  });

  // The production session is `{ id, page, context }` with `stagehand`
  // undefined — page is a Playwright Page and `context.newCDPSession` mints the
  // ONE Fetch client. Older tests only exercised the Stagehand-shaped fake, so
  // the dual-interceptor race and getActivePage(session) on a real page were
  // untested. This fixture is the production shape.
  async function makeProdSession(id: string) {
    const handlers = new Map<string, (p: unknown) => void>();
    const cdpSend = vi.fn(async (..._args: unknown[]) => ({}));
    const cdpSession = {
      send: cdpSend,
      on: vi.fn((evt: string, h: (p: unknown) => void) => handlers.set(evt, h)),
      off: vi.fn((evt: string) => handlers.delete(evt)),
      detach: vi.fn(async () => {}),
    };
    const newCDPSession = vi.fn(async () => cdpSession);
    const page = makeMockPage();
    const context = { newCDPSession, route: vi.fn(async () => {}), on: vi.fn() };
    // Launch installs the sole Fetch owner on the context.
    const launchGuard = await installContextFetchGuard(
      context as unknown as Parameters<typeof installContextFetchGuard>[0],
      cdpSession,
      { blockAdsTrackers: true },
    );
    const session = {
      id,
      page,
      context,
      createdAt: Date.now(),
      timeoutMs: DEFAULT_TIMEOUT_MS,
      close: async () => {},
    };
    __registerBrowserSessionForTests(session as never);
    // installContextFetchGuard consumed the launch call; reset so the rest of
    // the test can prove NO further CDP session is minted.
    newCDPSession.mockClear();
    return { session, page, context, cdpSend, handlers, newCDPSession, launchGuard };
  }

  it('navigate folds document policy into the launch guard — no second Fetch client', async () => {
    const { page, newCDPSession, cdpSend, handlers } = await makeProdSession('prod-nav');
    const r = await runBrowserReActStep('prod-nav', {
      op: 'navigate',
      url: 'https://example.com/path',
    });
    expect(r.hostExit).toBe(0);
    // getActivePage(session) resolved the real Playwright page.
    expect(page.goto).toHaveBeenCalledWith('https://example.com/path', {
      waitUntil: 'load',
      timeout: 30_000,
    });
    // The navigate-time policy rode the launch guard; it never opened a second
    // CDP Fetch session.
    expect(newCDPSession).not.toHaveBeenCalled();
    // Fetch.enable was called exactly once (at launch), not per-goto.
    const enables = cdpSend.mock.calls.filter((c) => c[0] === 'Fetch.enable');
    expect(enables).toHaveLength(1);
    // The single Fetch owner is present and armed.
    expect(handlers.has('Fetch.requestPaused')).toBe(true);
  });

  it('persistent origin pin folds in and fails off-pin Documents before egress', async () => {
    const { session, newCDPSession, cdpSend, handlers } = await makeProdSession('prod-pin');
    const guard = await installPersistentDocumentNavigationGuard(session as never, (u) =>
      u.startsWith(`${PIN}/`),
    );
    expect(guard.installed).toBe(true);
    // Folded into the existing launch guard — no new Fetch client.
    expect(newCDPSession).not.toHaveBeenCalled();

    const h = handlers.get('Fetch.requestPaused')!;
    // A redirect/click-driven document navigation to a loopback SSRF target is
    // failed at request time by the sole Fetch owner.
    h({ requestId: 'p1', resourceType: 'Document', request: { url: 'http://127.0.0.1/admin' } });
    expect(cdpSend).toHaveBeenCalledWith('Fetch.failRequest', {
      requestId: 'p1',
      errorReason: 'BlockedByClient',
    });
    // On-pin documents continue.
    h({ requestId: 'p2', resourceType: 'Document', request: { url: `${PIN}/settings` } });
    expect(cdpSend).toHaveBeenCalledWith('Fetch.continueRequest', { requestId: 'p2' });

    // Uninstalling the pin restores the launch guard rather than tearing down
    // the shared Fetch client.
    await guard.uninstall();
    expect(cdpSend).not.toHaveBeenCalledWith('Fetch.disable');
  });
});
