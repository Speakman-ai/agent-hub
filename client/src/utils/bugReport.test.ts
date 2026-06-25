import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { submitBugReport, BUG_REPORT_ENDPOINT, BUG_REPORT_PROJECT_ID } from './bugReport';

describe('submitBugReport', () => {
  beforeEach(() => {
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
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('targets the production hub intake endpoint', () => {
    expect(BUG_REPORT_ENDPOINT!).toBe('https://agenthub.surveytracker.io/api/bug-reports');
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
    expect(url!).toBe(BUG_REPORT_ENDPOINT);
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
