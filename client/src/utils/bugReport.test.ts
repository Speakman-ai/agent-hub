import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  submitBugReport,
  captureScreenshot,
  BUG_REPORT_PROJECT_ID,
  defaultReporterEmail,
  resolveBugReportEndpoint,
} from './bugReport';

// captureScreenshot dynamically imports the canvas rasterizer. We must mock the
// PRO fork (html2canvas-pro) because stock html2canvas 1.4.1 throws on the
// oklch()/oklab()/color() values modern Chrome serializes into computed styles
// — the exact "unsupported color function" failure this module was switched to
// fix. Mocking 'html2canvas-pro' (not 'html2canvas') also asserts the import
// target: if the source regressed back to the stock package the dynamic import
// would resolve unmocked and the toBlob stub below would never run.
const html2canvasProMock = vi.hoisted(() => vi.fn());
vi.mock('html2canvas-pro', () => ({ default: html2canvasProMock }));

// Configured endpoint used by the POST tests. The default (unset env) is
// intentionally empty so self-hosted builds never phone home; each POST test
// stubs the env to opt into an intake hub.
const ENDPOINT = 'https://hub.example.test/api/bug-reports';

describe('resolveBugReportEndpoint', () => {
  it('is empty (disabled) when the env var is unset — no phone-home default', () => {
    expect(resolveBugReportEndpoint({})).toBe('');
    expect(resolveBugReportEndpoint(null)).toBe('');
  });

  it('reads VITE_BUG_REPORT_ENDPOINT and strips trailing slashes', () => {
    expect(resolveBugReportEndpoint({ VITE_BUG_REPORT_ENDPOINT: `${ENDPOINT}/` })).toBe(ENDPOINT);
    expect(resolveBugReportEndpoint({ VITE_BUG_REPORT_ENDPOINT: `  ${ENDPOINT}  ` })).toBe(
      ENDPOINT,
    );
  });
});

describe('submitBugReport', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubEnv('VITE_BUG_REPORT_ENDPOINT', ENDPOINT);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ status: 'dispatched' }), {
          status: 202,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
  });

  afterEach(() => {
    localStorage.clear();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('refuses to post when no intake endpoint is configured', async () => {
    vi.stubEnv('VITE_BUG_REPORT_ENDPOINT', '');
    await expect(submitBugReport({ title: 'valid title' })).rejects.toThrow(/not configured/i);
    expect(fetch!).not.toHaveBeenCalled();
  });

  it('rejects an empty title', async () => {
    await expect(submitBugReport({ title: '   ' })).rejects.toThrow(/title is required/i);
    expect(fetch!).not.toHaveBeenCalled();
  });

  it('POSTs FormData with trimmed title, description, severity, and optional ids', async () => {
    // Pass an explicit non-`agent-hub` projectId so we exercise the override:
    // the wire field MUST always be BUG_REPORT_PROJECT_ID regardless of caller input.
    await submitBugReport({
      title: '  My bug  ',
      description: 'Details here',
      severity: 'high',
      screenshotBlob: null,
      projectId: 'some-other-project',
      agentId: 'hub-frontend',
    });

    expect(fetch!).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url!).toBe(ENDPOINT);
    expect(init!.method).toBe('POST');
    expect(init!.body).toBeInstanceOf(FormData);
    const fd = init!.body;
    expect((fd as any).get('title')).toBe('My bug');
    expect((fd as any).get('description')).toBe('Details here');
    expect((fd as any).get('severity')).toBe('high');
    expect((fd as any).get('currentProjectId')).toBe(BUG_REPORT_PROJECT_ID);
    expect((fd as any).get('currentProjectId')).not.toBe('some-other-project');
    expect((fd as any).get('currentAgentId')).toBe('hub-frontend');
  });

  it('prefills reporter_email from the authenticated user email when available', async () => {
    localStorage.setItem(
      'agent-hub-jwt',
      JSON.stringify({
        token: 't',
        user: { email: 'Reporter@Example.COM', username: 'legacy-user' },
      }),
    );

    await submitBugReport({ title: 'contact me', description: '', severity: 'medium' });

    const fd = vi.mocked(fetch).mock.calls[0]![1]!.body;
    expect((fd as any).get('reporter_email')).toBe('reporter@example.com');
    expect(defaultReporterEmail()).toBe('reporter@example.com');
  });

  it('falls back to username for legacy username-as-email auth records', async () => {
    localStorage.setItem(
      'agent-hub-jwt',
      JSON.stringify({ token: 't', user: { username: 'Legacy@Example.COM' } }),
    );

    await submitBugReport({ title: 'legacy contact', description: '', severity: 'medium' });

    const fd = vi.mocked(fetch).mock.calls[0]![1]!.body;
    expect((fd as any).get('reporter_email')).toBe('legacy@example.com');
    expect(defaultReporterEmail()).toBe('legacy@example.com');
  });

  it('does not send reporter_email when the cached auth record has no valid email', async () => {
    localStorage.setItem(
      'agent-hub-jwt',
      JSON.stringify({ token: 't', user: { email: null, username: 'legacy-user' } }),
    );

    await submitBugReport({ title: 'anonymous-compatible', description: '', severity: 'medium' });

    const fd = vi.mocked(fetch).mock.calls[0]![1]!.body;
    expect((fd as any).get('reporter_email')).toBeNull();
  });

  it('sends screenshotMissReason when no screenshot blob is available', async () => {
    await submitBugReport({
      title: 'missing screenshot',
      description: '',
      severity: 'medium',
      screenshotBlob: null,
      screenshotMissReason: 'initial-capture-failed',
    });

    const fd = vi.mocked(fetch).mock.calls[0]![1]!.body;
    expect((fd as any).get('screenshot')).toBeNull();
    expect((fd as any).get('screenshotMissReason')).toBe('initial-capture-failed');
  });

  it('omits screenshotMissReason when a screenshot blob is attached', async () => {
    const blob = new Blob(['fake'], { type: 'image/png' });
    await submitBugReport({
      title: 'has screenshot',
      description: '',
      severity: 'medium',
      screenshotBlob: blob,
      screenshotMissReason: 'initial-capture-failed',
    });

    const fd = vi.mocked(fetch).mock.calls[0]![1]!.body;
    expect((fd as any).get('screenshot')).toBeInstanceOf(Blob);
    expect((fd as any).get('screenshotMissReason')).toBeNull();
  });

  it('sends replayMissReason (and no replayRef) when the capture was missing', async () => {
    await submitBugReport({
      title: 'no replay',
      description: '',
      severity: 'medium',
      replayRef: null,
      replayMissReason: 'upload-failed',
    });
    const fd = vi.mocked(fetch).mock.calls[0]![1]!.body;
    expect((fd as any).get('replayMissReason')).toBe('upload-failed');
    expect((fd as any).get('replayRef')).toBeNull();
  });

  it('sends replayRef and omits replayMissReason when a replay attached', async () => {
    await submitBugReport({
      title: 'has replay',
      description: '',
      severity: 'medium',
      replayRef: '/uploads/replay-x.json',
      replayMissReason: 'upload-failed',
    });
    const fd = vi.mocked(fetch).mock.calls[0]![1]!.body;
    expect((fd as any).get('replayRef')).toBe('/uploads/replay-x.json');
    expect((fd as any).get('replayMissReason')).toBeNull();
  });

  it('truncates title to 200 characters for the wire format', async () => {
    const long = 'x'.repeat(250);
    await submitBugReport({ title: long, description: '', severity: 'low' });
    const fd = vi.mocked(fetch).mock.calls[0]![1]!.body;
    expect((fd as any).get('title').length).toBe(200);
  });

  it('sets clientType to electron when the preload bridge is present', async () => {
    const prev = globalThis.window;
    (globalThis as any).window = {
      location: { href: 'app://index.html' },
      electronAPI: { captureBugScreenshot: vi.fn() },
    };
    try {
      await submitBugReport({ title: 'x', description: '', severity: 'medium' });
      const fd = vi.mocked(fetch).mock.calls[0]![1]!.body;
      expect((fd as any).get('clientType')).toBe('electron');
    } finally {
      (globalThis as any).window = prev;
    }
  });
});

describe('captureScreenshot', () => {
  const realWindow = globalThis.window;

  beforeEach(() => {
    html2canvasProMock.mockReset();
  });

  afterEach(() => {
    (globalThis as any).window = realWindow;
    vi.restoreAllMocks();
  });

  it('rasterizes document.body via html2canvas-pro and returns a PNG blob', async () => {
    // No Electron bridge → the web fallback path runs the canvas rasterizer.
    (globalThis as any).window = { devicePixelRatio: 2 };
    const pngBlob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
    const fakeCanvas = {
      toBlob: (cb: any, type: string) => {
        expect(type).toBe('image/png');
        cb(pngBlob);
      },
    };
    html2canvasProMock.mockResolvedValue(fakeCanvas);

    const blob = await captureScreenshot();

    expect(blob).toBe(pngBlob);
    expect(html2canvasProMock).toHaveBeenCalledTimes(1);
    // document.body is handed to the pro fork, which parses oklch()/color()
    // values stock html2canvas would reject.
    expect(html2canvasProMock.mock.calls[0]![0]).toBe(document.body);
  });

  it('prefers the Electron capture bridge over the canvas rasterizer', async () => {
    const dataUrl = `data:image/png;base64,${btoa('electron-bytes')}`;
    (globalThis as any).window = {
      electronAPI: { captureBugScreenshot: vi.fn().mockResolvedValue(dataUrl) },
    };

    const blob = await captureScreenshot();

    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe('image/png');
    expect(html2canvasProMock).not.toHaveBeenCalled();
  });

  it('rejects when the canvas cannot produce a blob', async () => {
    (globalThis as any).window = {};
    html2canvasProMock.mockResolvedValue({ toBlob: (cb: any) => cb(null) });

    await expect(captureScreenshot()).rejects.toThrow(/Failed to produce screenshot blob/);
  });
});
