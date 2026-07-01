// Bug report helpers for the mobile app.
// Endpoint is intentionally hard-coded per spec — do not derive from config.
import { captureScreen } from 'react-native-view-shot';
import { getAuthRecord } from './auth';
export const BUG_REPORT_ENDPOINT = 'https://agenthub.surveytracker.io/api/bug-reports';
export const BUG_REPORT_PROJECT_ID = 'agent-hub';

function looksLikeEmail(value: any) {
    return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

export function defaultReporterEmail(record: any = getAuthRecord()) {
    const email = record?.user?.email;
    if (looksLikeEmail(email))
        return email.trim().toLowerCase();
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
export async function submitBugReport({ screenshotUri, title, description = '', severity = 'medium', sourceUrl = '', userAgent = '', appVersion = '', currentProjectId: _currentProjectId = '', currentAgentId = '', reporterEmail = '', }: any) {
    if (!title || !title.trim()) {
        throw new Error('Title is required');
    }
    if (title.length > 200) {
        throw new Error('Title must be 200 characters or fewer');
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
    if (email)
        form.append('reporter_email', email);
    const res = await fetch(BUG_REPORT_ENDPOINT, {
        method: 'POST',
        // NOTE: do NOT set Content-Type manually — RN/fetch will add the boundary
        body: form,
    });
    const text = await res.text();
    let parsed = null;
    try {
        parsed = text ? JSON.parse(text) : null;
    }
    catch {
        parsed = null;
    }
    if (!res.ok) {
        const msg = (parsed && (parsed.error || parsed.message)) ||
            `Bug report submission failed (HTTP ${res.status})`;
        throw new Error(msg);
    }
    return parsed || { sessionId: '', status: 'dispatched' };
}
