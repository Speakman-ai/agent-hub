// @ts-nocheck
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-native-view-shot', () => ({
  captureScreen: vi.fn(async () => 'file:///tmp/screenshot.png'),
}));

const state = vi.hoisted(() => ({ authRecord: null as any }));
vi.mock('./auth', () => ({
  getAuthRecord: () => state.authRecord,
}));

const { submitBugReport, BUG_REPORT_ENDPOINT, BUG_REPORT_PROJECT_ID, defaultReporterEmail } =
  await import('./bugReport');

let mockFetch: any;

beforeEach(() => {
  state.authRecord = null;
  mockFetch = vi.fn().mockResolvedValue({
    ok: true,
    text: async () => JSON.stringify({ status: 'received', ticketId: 'tkt-1' }),
  });
  globalThis.fetch = mockFetch;
});

function lastFormData(): FormData {
  expect(mockFetch).toHaveBeenCalledTimes(1);
  return mockFetch.mock.calls[0][1].body;
}

describe('mobile submitBugReport', () => {
  it('targets the production hub intake endpoint', () => {
    expect(BUG_REPORT_ENDPOINT).toBe('https://agenthub.surveytracker.io/api/bug-reports');
  });

  it('posts the fixed project id and authenticated reporter email when available', async () => {
    state.authRecord = { user: { username: 'Reporter@Example.COM' } };

    await submitBugReport({
      screenshotUri: '',
      title: 'Mobile bug',
      description: 'Details',
      severity: 'high',
      currentProjectId: 'other-project',
      currentAgentId: 'agent-hub-dev',
    });

    const fd = lastFormData();
    expect(fd.get('title')).toBe('Mobile bug');
    expect(fd.get('severity')).toBe('high');
    expect(fd.get('currentProjectId')).toBe(BUG_REPORT_PROJECT_ID);
    expect(fd.get('currentAgentId')).toBe('agent-hub-dev');
    expect(fd.get('reporter_email')).toBe('reporter@example.com');
    expect(defaultReporterEmail()).toBe('reporter@example.com');
  });

  it('does not send reporter_email when neither explicit nor cached email is valid', async () => {
    state.authRecord = { user: { username: 'legacy-user' } };

    await submitBugReport({ screenshotUri: '', title: 'No email' });

    expect(lastFormData().get('reporter_email')).toBeNull();
  });

  it('prefers an explicit reporterEmail over the cached user email', async () => {
    state.authRecord = { user: { username: 'cached@example.com' } };

    await submitBugReport({
      screenshotUri: '',
      title: 'Explicit email',
      reporterEmail: ' Explicit@Example.COM ',
    });

    expect(lastFormData().get('reporter_email')).toBe('explicit@example.com');
  });
});
