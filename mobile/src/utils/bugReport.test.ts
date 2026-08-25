// @ts-nocheck
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

vi.mock('react-native-view-shot', () => ({
  captureScreen: vi.fn(async () => 'file:///tmp/screenshot.png'),
}));

const state = vi.hoisted(() => ({ authRecord: null as any }));
vi.mock('./auth', () => ({
  getAuthRecord: () => state.authRecord,
}));

const { submitBugReport, BUG_REPORT_PROJECT_ID, defaultReporterEmail, resolveBugReportEndpoint } =
  await import('./bugReport');

// Configured endpoint the POST tests opt into. The default (unset env) is empty
// so a self-hosted build never phones home.
const ENDPOINT = 'https://hub.example.test/api/bug-reports';

let mockFetch: any;

beforeEach(() => {
  state.authRecord = null;
  process.env.EXPO_PUBLIC_BUG_REPORT_ENDPOINT = ENDPOINT;
  mockFetch = vi.fn().mockResolvedValue({
    ok: true,
    text: async () => JSON.stringify({ status: 'received', ticketId: 'tkt-1' }),
  });
  globalThis.fetch = mockFetch;
});

afterEach(() => {
  delete process.env.EXPO_PUBLIC_BUG_REPORT_ENDPOINT;
});

function lastFormData(): FormData {
  expect(mockFetch).toHaveBeenCalledTimes(1);
  return mockFetch.mock.calls[0][1].body;
}

describe('resolveBugReportEndpoint', () => {
  it('is empty (disabled) for unset / non-string values — no phone-home default', () => {
    // The test seam is a RAW value (not an env object) because the production
    // read is a literal `process.env.EXPO_PUBLIC_BUG_REPORT_ENDPOINT` that Metro
    // inlines — see the regression guard below.
    expect(resolveBugReportEndpoint('')).toBe('');
    expect(resolveBugReportEndpoint('   ')).toBe('');
    expect(resolveBugReportEndpoint(null)).toBe('');
    expect(resolveBugReportEndpoint(undefined as any)).not.toBeUndefined(); // resolves via default, never throws
  });

  it('normalizes the raw value (trim + strip trailing slashes)', () => {
    expect(resolveBugReportEndpoint(`${ENDPOINT}/`)).toBe(ENDPOINT);
    expect(resolveBugReportEndpoint(`  ${ENDPOINT}  `)).toBe(ENDPOINT);
  });

  it('defaults to the live EXPO_PUBLIC_BUG_REPORT_ENDPOINT when called with no arg', () => {
    // beforeEach sets process.env.EXPO_PUBLIC_BUG_REPORT_ENDPOINT = ENDPOINT.
    expect(resolveBugReportEndpoint()).toBe(ENDPOINT);
    delete process.env.EXPO_PUBLIC_BUG_REPORT_ENDPOINT;
    expect(resolveBugReportEndpoint()).toBe('');
  });

  // Regression guard for the Metro static-inlining contract: babel-preset-expo
  // rewrites EXPO_PUBLIC_* reads ONLY for a literal `process.env.EXPO_PUBLIC_X`
  // member access. Aliasing / destructuring / bracket access are NOT rewritten,
  // so a real Expo build would read `undefined` and silently disable bug
  // reporting. Vitest can't catch that (Node keeps a live process.env), so we
  // assert the source shape directly.
  it('reads the literal process.env member access so Metro inlines it', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'bugReport.ts'), 'utf8');
    expect(src).toContain('process.env.EXPO_PUBLIC_BUG_REPORT_ENDPOINT');
    // No aliased / destructured / bracket forms that the transform won't rewrite.
    expect(src).not.toMatch(/=\s*process\.env\b(?!\.EXPO_PUBLIC_BUG_REPORT_ENDPOINT)/);
    expect(src).not.toMatch(/const\s*\{[^}]*EXPO_PUBLIC_BUG_REPORT_ENDPOINT/);
    expect(src).not.toMatch(/process\.env\[/);
    expect(src).not.toMatch(/env\?\.EXPO_PUBLIC_BUG_REPORT_ENDPOINT/);
  });
});

describe('mobile submitBugReport', () => {
  it('refuses to post when no intake endpoint is configured', async () => {
    delete process.env.EXPO_PUBLIC_BUG_REPORT_ENDPOINT;
    await expect(submitBugReport({ screenshotUri: '', title: 'valid title' })).rejects.toThrow(
      /not configured/i,
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('posts to the configured intake endpoint', async () => {
    await submitBugReport({ screenshotUri: '', title: 'Endpoint check' });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toBe(ENDPOINT);
  });

  it('posts the fixed project id and authenticated reporter email when available', async () => {
    state.authRecord = { user: { email: 'Reporter@Example.COM', username: 'legacy-user' } };

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

  it('falls back to username for legacy username-as-email auth records', async () => {
    state.authRecord = { user: { username: 'Legacy@Example.COM' } };

    await submitBugReport({ screenshotUri: '', title: 'Legacy email' });

    expect(lastFormData().get('reporter_email')).toBe('legacy@example.com');
    expect(defaultReporterEmail()).toBe('legacy@example.com');
  });

  it('does not send reporter_email when neither explicit nor cached email is valid', async () => {
    state.authRecord = { user: { email: null, username: 'legacy-user' } };

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
