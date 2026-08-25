// Bug report helpers for the mobile app.
//
// The intake endpoint is build-time configurable so a self-hosted deployment
// never phones home. Set `EXPO_PUBLIC_BUG_REPORT_ENDPOINT` (inlined by Expo at
// build time) to route reports to your own hub. Unset → bug reporting is
// disabled: `submitBugReport` throws rather than posting anywhere.
import { captureScreen } from 'react-native-view-shot';
import { getAuthRecord } from './auth';
import { trimTrailingSlashes } from '@shared/utils/trimTrailingSlashes';

/**
 * Resolve the bug-report intake endpoint from the build-time
 * `EXPO_PUBLIC_BUG_REPORT_ENDPOINT` env (trailing slashes stripped). Returns ''
 * when unset — the sovereign default: no configured hub, no telemetry leaves the
 * device.
 *
 * IMPORTANT (Metro static inlining): `babel-preset-expo` replaces
 * `EXPO_PUBLIC_*` env reads at build time ONLY when they are a LITERAL member
 * access — `process.env.EXPO_PUBLIC_BUG_REPORT_ENDPOINT`. Aliasing `process.env`
 * into a variable, destructuring, or bracket access are NOT rewritten (verified
 * against Expo's environment-variables guide), so in a real Expo build those
 * forms read `undefined` and bug reporting is silently disabled even when the
 * var is set via `eas env:create`. So the literal read lives in the default
 * parameter below; the `raw` argument is a TEST-ONLY seam (Node keeps a live
 * `process.env`, but a production build sees the inlined constant, not
 * `process.env`). Do NOT refactor this to read through an alias — see the
 * regression guard in `bugReport.test.ts`.
 */
export function resolveBugReportEndpoint(raw: any = process.env.EXPO_PUBLIC_BUG_REPORT_ENDPOINT) {
  return trimTrailingSlashes(raw);
}
export const BUG_REPORT_ENDPOINT = resolveBugReportEndpoint();
/** True when a bug-report intake endpoint is configured for this build. */
export const BUG_REPORT_ENABLED = BUG_REPORT_ENDPOINT !== '';
export const BUG_REPORT_PROJECT_ID = 'agent-hub';

function looksLikeEmail(value: any) {
  return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

export function defaultReporterEmail(record: any = getAuthRecord()) {
  const email = record?.user?.email;
  if (looksLikeEmail(email)) return email.trim().toLowerCase();
  const username = record?.user?.username;
  return looksLikeEmail(username) ? username.trim().toLowerCase() : '';
}
/**
 * Captures a PNG screenshot of the current screen and returns a local file URI.
 * Android/iOS only (react-native-view-shot captureScreen).
 * @returns {Promise<string>} file:// URI of the captured PNG
 */
export async function captureScreenshot() {
  const uri = await captureScreen({
    format: 'png',
    quality: 0.9,
    result: 'tmpfile',
  });
  return uri;
}
/**
 * POSTs a bug report as multipart/form-data to the fixed intake endpoint.
 *
 * NOTE: `currentProjectId` on the wire is intentionally fixed to
 * `BUG_REPORT_PROJECT_ID`. A `currentProjectId` arg is accepted-and-ignored
 * for backward compatibility with existing call sites; do not rely on it.
 *
 * @param {object} args
 * @param {string} args.screenshotUri file:// URI returned by captureScreenshot()
 * @param {string} args.title required, ≤200 chars
 * @param {string} [args.description]
 * @param {'low'|'medium'|'high'|'critical'} [args.severity='medium']
 * @param {string} [args.sourceUrl='']
 * @param {string} [args.userAgent='']
 * @param {string} [args.appVersion='']
 * @param {string} [args.currentProjectId=''] accepted-and-ignored; wire field is fixed
 * @param {string} [args.currentAgentId='']
 * @param {string} [args.reporterEmail]
 * @returns {Promise<{ sessionId: string, status: string }>}
 */
export async function submitBugReport({
  screenshotUri,
  title,
  description = '',
  severity = 'medium',
  sourceUrl = '',
  userAgent = '',
  appVersion = '',
  currentProjectId: _currentProjectId = '',
  currentAgentId = '',
  reporterEmail = '',
}: any) {
  if (!title || !title.trim()) {
    throw new Error('Title is required');
  }
  if (title.length > 200) {
    throw new Error('Title must be 200 characters or fewer');
  }
  // Resolve at call time (honours a stubbed env in tests); unset → refuse to phone home.
  const endpoint = resolveBugReportEndpoint();
  if (!endpoint) {
    throw new Error('Bug reporting is not configured for this deployment');
  }
  const form = new FormData();
  if (screenshotUri) {
    form.append('screenshot', {
      uri: screenshotUri,
      name: 'screenshot.png',
      type: 'image/png',
    } as any);
  }
  form.append('title', title);
  form.append('description', description || '');
  form.append('severity', severity || 'medium');
  form.append('sourceUrl', sourceUrl || '');
  form.append('userAgent', userAgent || '');
  form.append('appVersion', appVersion || '');
  form.append('clientType', 'mobile');
  form.append('currentProjectId', BUG_REPORT_PROJECT_ID);
  form.append('currentAgentId', currentAgentId || '');
  const email = looksLikeEmail(reporterEmail)
    ? reporterEmail.trim().toLowerCase()
    : defaultReporterEmail();
  if (email) form.append('reporter_email', email);
  const res = await fetch(endpoint, {
    method: 'POST',
    // NOTE: do NOT set Content-Type manually — RN/fetch will add the boundary
    body: form,
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (!res.ok) {
    const msg =
      (parsed && (parsed.error || parsed.message)) ||
      `Bug report submission failed (HTTP ${res.status})`;
    throw new Error(msg);
  }
  return parsed || { sessionId: '', status: 'dispatched' };
}
