import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { submitBugReport, BUG_REPORT_ENDPOINT, BUG_REPORT_PROJECT_ID } from './bugReport.js';

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
    expect(BUG_REPORT_ENDPOINT).toBe('https://agenthub.surveytracker.io/api/bug-reports');
  });

  it('rejects an empty title', async () => {
    await expect(submitBugReport({ title: '   ' })).rejects.toThrow(/title is required/i);
    expect(fetch).not.toHaveBeenCalled();
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

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe(BUG_REPORT_ENDPOINT);
    expect(init.method).toBe('POST');
    expect(init.body).toBeInstanceOf(FormData);
    const fd = init.body;
    expect(fd.get('title')).toBe('My bug');
    expect(fd.get('description')).toBe('Details here');
    expect(fd.get('severity')).toBe('high');
    expect(fd.get('currentProjectId')).toBe(BUG_REPORT_PROJECT_ID);
    expect(fd.get('currentProjectId')).not.toBe('some-other-project');
    expect(fd.get('currentAgentId')).toBe('hub-frontend');
  });

  it('truncates title to 200 characters for the wire format', async () => {
    const long = 'x'.repeat(250);
    await submitBugReport({ title: long, description: '', severity: 'low' });
    const fd = vi.mocked(fetch).mock.calls[0][1].body;
    expect(fd.get('title').length).toBe(200);
  });

  it('sets clientType to electron when the preload bridge is present', async () => {
    const prev = globalThis.window;
    globalThis.window = {
      location: { href: 'app://index.html' },
      electronAPI: { captureBugScreenshot: vi.fn() },
    };
    try {
      await submitBugReport({ title: 'x', description: '', severity: 'medium' });
      const fd = vi.mocked(fetch).mock.calls[0][1].body;
      expect(fd.get('clientType')).toBe('electron');
    } finally {
      globalThis.window = prev;
    }
  });
});
