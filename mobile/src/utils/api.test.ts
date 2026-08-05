// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from 'vitest';
// Stub ./config — api.js imports getApiBaseUrl + getAuthHeaders from it, and
// config.js in turn imports @react-native-async-storage/async-storage which
// doesn't resolve in a plain node test environment.
vi.mock('./config', () => ({
    getApiBaseUrl: () => 'https://example.test/api',
    getAuthHeaders: () => ({ 'X-API-Key': 'test-key' }),
}));
// Stub ./uploadFile — the binary uploader depends on expo-file-system
// which doesn't resolve in a plain node test environment. We only need to
// verify api.uploadFile forwards its argument through.
vi.mock('./uploadFile', () => ({
    uploadFile: vi.fn(async (ref: any) => ({ __mockedWith: ref })),
}));
// Stub ./auth — it pulls in @react-native-async-storage/async-storage which
// can't resolve in a plain node test environment. The tests below don't
// exercise the 401 JWT-clear path, so no-op helpers are sufficient.
vi.mock('./auth', () => ({
    getToken: () => null,
    clearToken: vi.fn(async () => { }),
}));
// Import after mocks are registered.
const { api, errorDetail } = await import('./api.js');
const uploadFileMock = (await import('./uploadFile')).uploadFile;
// Mock global fetch. Each test can override `mockFetch` to shape the response.
let mockFetch: any;
beforeEach(() => {
    mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true }),
    });
    globalThis.fetch = mockFetch;
});
/** Extract `[url, init]` from the last call to fetch. */
function lastCall() {
    expect(mockFetch).toHaveBeenCalledTimes(1);
    return mockFetch.mock.calls[0];
}
describe('api threads helpers — URL + method parity with web client', () => {
    it('getThreads(projectId) without filter → GET /projects/:id/threads', async () => {
        await api.getThreads('agent-hub');
        const [url, init] = lastCall();
        expect(url).toBe('https://example.test/api/projects/agent-hub/threads');
        expect(init?.method).toBeUndefined();
    });
    it('runSupportTicketInvestigation sends the selected engine and model', async () => {
        await api.runSupportTicketInvestigation('agent-hub', 'tkt-model', {
            engine: 'codex-cli',
            model: 'gpt-5.5',
        });
        const [url, init] = lastCall();
        expect(url).toBe('https://example.test/api/projects/agent-hub/support-tickets/tkt-model/investigate');
        expect(init?.method).toBe('POST');
        expect(JSON.parse(init.body)).toEqual({ engine: 'codex-cli', model: 'gpt-5.5' });
    });
    it('runSupportTicketInvestigation sends an empty object without a selection', async () => {
        await api.runSupportTicketInvestigation('agent-hub', 'tkt-default');
        const [url, init] = lastCall();
        expect(url).toBe('https://example.test/api/projects/agent-hub/support-tickets/tkt-default/investigate');
        expect(init?.method).toBe('POST');
        expect(JSON.parse(init.body)).toEqual({});
    });
    it('getThreads(projectId, type) appends the type query', async () => {
        await api.getThreads('agent-hub', 'cron');
        const [url] = lastCall();
        expect(url).toBe('https://example.test/api/projects/agent-hub/threads?type=cron');
    });
    it('getThreads URL-encodes the type parameter', async () => {
        await api.getThreads('agent-hub', 'heart beat');
        const [url] = lastCall();
        expect(url).toBe('https://example.test/api/projects/agent-hub/threads?type=heart%20beat');
    });
    it('getThread(threadId) → GET /threads/:id', async () => {
        await api.getThread('thread-xyz');
        const [url, init] = lastCall();
        expect(url).toBe('https://example.test/api/threads/thread-xyz');
        expect(init?.method).toBeUndefined();
    });
    it('getThreadEntries(threadId) → GET /threads/:id/entries', async () => {
        await api.getThreadEntries('thread-xyz');
        const [url, init] = lastCall();
        expect(url).toBe('https://example.test/api/threads/thread-xyz/entries');
        expect(init?.method).toBeUndefined();
    });
});

describe('mobile CLI browser auth helpers', () => {
    it('starts Claude browser login with an authenticated JSON POST', async () => {
        await api.startMyClaudeBrowserLogin();
        const [url, init] = lastCall();
        expect(url).toBe('https://example.test/api/auth/me/claude-auth/browser/login');
        expect(init.method).toBe('POST');
        expect(JSON.parse(init.body)).toEqual({});
    });
    it('uses per-user Cursor and Codex browser routes', async () => {
        await api.getMyCursorBrowserAuth();
        expect(lastCall()[0]).toBe('https://example.test/api/auth/me/cursor-auth/browser');
        mockFetch.mockClear();
        await api.startMyCodexBrowserDeviceLogin();
        const [url, init] = lastCall();
        expect(url).toBe('https://example.test/api/auth/me/codex-auth/browser/device-login');
        expect(init.method).toBe('POST');
    });
});
describe('api session helpers — URL + method + body parity with web client', () => {
    it('createSession(agentId, name) omits use_worktree (worktree-only mode)', async () => {
        await api.createSession('agent-1', 'My session');
        const [url, init] = lastCall();
        expect(url).toBe('https://example.test/api/agents/agent-1/sessions');
        expect(init.method).toBe('POST');
        expect(JSON.parse(init.body)).toEqual({ name: 'My session' });
    });
    it('createSession ignores legacy options.use_worktree (no longer forwarded)', async () => {
        await api.createSession('agent-1', 'My session', { use_worktree: false });
        const [, init] = lastCall();
        const body = JSON.parse(init.body);
        expect(body).toEqual({ name: 'My session' });
        expect(body).not.toHaveProperty('use_worktree');
    });
    it('setSessionAskMode(id, true) → PUT /sessions/:id/ask-mode with {enabled}', async () => {
        await api.setSessionAskMode('sess-4', true);
        const [url, init] = lastCall();
        expect(url).toBe('https://example.test/api/sessions/sess-4/ask-mode');
        expect(init.method).toBe('PUT');
        expect(JSON.parse(init.body)).toEqual({ enabled: true });
    });
    it('setSessionAskMode(id, false) passes enabled:false', async () => {
        await api.setSessionAskMode('sess-5', false);
        const [, init] = lastCall();
        expect(JSON.parse(init.body)).toEqual({ enabled: false });
    });
    it('setSessionMode(id, "design") → PUT /sessions/:id/mode with {mode}', async () => {
        await api.setSessionMode('sess-dm', 'design');
        const [url, init] = lastCall();
        expect(url).toBe('https://example.test/api/sessions/sess-dm/mode');
        expect(init.method).toBe('PUT');
        expect(JSON.parse(init.body)).toEqual({ mode: 'design' });
    });
    it('getSessionDesignFiles(id) → GET /sessions/:id/design-files', async () => {
        await api.getSessionDesignFiles('sess-df');
        const [url, init] = lastCall();
        expect(url).toBe('https://example.test/api/sessions/sess-df/design-files');
        expect(init.method ?? 'GET').toBe('GET');
    });
    it('setSessionOrchestration(id, body) → PUT /sessions/:id/orchestration', async () => {
        await api.setSessionOrchestration('sess-o', { phase: 'verifying', meta: { pr: 1 } });
        const [url, init] = lastCall();
        expect(url).toBe('https://example.test/api/sessions/sess-o/orchestration');
        expect(init.method).toBe('PUT');
        expect(JSON.parse(init.body)).toEqual({ phase: 'verifying', meta: { pr: 1 } });
    });
    it('createSession omits session_mode when not in consult mode', async () => {
        await api.createSession('agent-1', 'My session');
        const [, init] = lastCall();
        const body = JSON.parse(init.body);
        expect(body).toEqual({ name: 'My session' });
        expect(body).not.toHaveProperty('session_mode');
        expect(body).not.toHaveProperty('ask_mode');
    });
    it('createSession({ consultMode: true }) forwards session_mode:consult', async () => {
        await api.createSession('agent-1', 'My session', { consultMode: true });
        const [, init] = lastCall();
        expect(JSON.parse(init.body)).toEqual({
            name: 'My session',
            session_mode: 'consult',
        });
    });
    it('createSession({ consultMode: false }) omits session_mode', async () => {
        await api.createSession('agent-1', 'My session', { consultMode: false });
        const [, init] = lastCall();
        expect(JSON.parse(init.body)).toEqual({
            name: 'My session',
        });
    });
    it('createSession ignores use_worktree even when combined with consultMode', async () => {
        await api.createSession('agent-1', 'My session', {
            use_worktree: false,
            consultMode: true,
        });
        const [, init] = lastCall();
        const body = JSON.parse(init.body);
        expect(body).toEqual({ name: 'My session', session_mode: 'consult' });
        expect(body).not.toHaveProperty('use_worktree');
    });
});
describe('api updateProject — PATCH parity with web client', () => {
    it('updateProject(projectId, body) → PATCH /projects/:id', async () => {
        await api.updateProject('p1', { mode: 'workflow' });
        const [url, init] = lastCall();
        expect(url).toBe('https://example.test/api/projects/p1');
        expect(init.method).toBe('PATCH');
        expect(JSON.parse(init.body)).toEqual({ mode: 'workflow' });
    });
});

describe('api project import wizard helpers', () => {
    it('cloneProject sends the clone URL and optional target', async () => {
        await api.cloneProject({ url: 'https://github.com/acme/tool.git', targetDir: '/tmp/projects' });
        const [url, init] = lastCall();
        expect(url).toBe('https://example.test/api/projects/clone');
        expect(init.method).toBe('POST');
        expect(JSON.parse(init.body)).toEqual({ url: 'https://github.com/acme/tool.git', targetDir: '/tmp/projects' });
    });

    it('analyzeProject and onboardProject use the web wizard endpoints', async () => {
        await api.analyzeProject({ cwd: '/tmp/tool', engine: 'codex-cli', model: 'gpt-5.5' });
        expect(lastCall()[0]).toBe('https://example.test/api/projects/analyze');
        expect(JSON.parse(lastCall()[1].body)).toEqual({ cwd: '/tmp/tool', engine: 'codex-cli', model: 'gpt-5.5' });

        mockFetch.mockClear();
        await api.onboardProject({ project: { id: 'tool' }, agents: [] });
        expect(lastCall()[0]).toBe('https://example.test/api/projects/onboard');
        expect(lastCall()[1].method).toBe('POST');
    });
});

describe('api invite helpers — mobile parity with web client', () => {
    it('getInvites → GET /auth/invites', async () => {
        await api.getInvites();
        const [url, init] = lastCall();
        expect(url).toBe('https://example.test/api/auth/invites');
        expect(init.method ?? 'GET').toBe('GET');
    });
    it('createInvite → POST /auth/invites', async () => {
        await api.createInvite({ email: 'new@example.com', role: 'User' });
        const [url, init] = lastCall();
        expect(url).toBe('https://example.test/api/auth/invites');
        expect(init.method).toBe('POST');
        expect(JSON.parse(init.body)).toEqual({ email: 'new@example.com', role: 'User' });
    });
    it('sendInviteEmail → POST /auth/invites/:token/email', async () => {
        await api.sendInviteEmail('tok/1');
        const [url, init] = lastCall();
        expect(url).toBe('https://example.test/api/auth/invites/tok%2F1/email');
        expect(init.method).toBe('POST');
    });
    it('revokeInvite → DELETE /auth/invites/:token', async () => {
        await api.revokeInvite('tok/1');
        const [url, init] = lastCall();
        expect(url).toBe('https://example.test/api/auth/invites/tok%2F1');
        expect(init.method).toBe('DELETE');
    });
    it('acceptInvite → POST /auth/invites/:token/accept', async () => {
        await api.acceptInvite('tok', { email: 'new@example.com', password: 'secret' });
        const [url, init] = lastCall();
        expect(url).toBe('https://example.test/api/auth/invites/tok/accept');
        expect(init.method).toBe('POST');
        expect(JSON.parse(init.body)).toEqual({ email: 'new@example.com', password: 'secret' });
    });
});

describe('api SMTP settings helpers — mobile parity with web client', () => {
    it('getSmtpSettings → GET /config/smtp', async () => {
        await api.getSmtpSettings();
        const [url, init] = lastCall();
        expect(url).toBe('https://example.test/api/config/smtp');
        expect(init.method ?? 'GET').toBe('GET');
    });
    it('updateSmtpSettings → PATCH /config/smtp', async () => {
        await api.updateSmtpSettings({ enabled: true, host: 'smtp.example.com' });
        const [url, init] = lastCall();
        expect(url).toBe('https://example.test/api/config/smtp');
        expect(init.method).toBe('PATCH');
        expect(JSON.parse(init.body)).toEqual({ enabled: true, host: 'smtp.example.com' });
    });
    it('testSmtpSettings → POST /config/smtp/test', async () => {
        await api.testSmtpSettings({ to: 'owner@example.com' });
        const [url, init] = lastCall();
        expect(url).toBe('https://example.test/api/config/smtp/test');
        expect(init.method).toBe('POST');
        expect(JSON.parse(init.body)).toEqual({ to: 'owner@example.com' });
    });
});

describe('api Google connection helpers — mobile parity with web client', () => {
    it('getGoogleStatus → GET /auth/google/status', async () => {
        await api.getGoogleStatus();
        const [url, init] = lastCall();
        expect(url).toBe('https://example.test/api/auth/google/status');
        expect(init.method ?? 'GET').toBe('GET');
    });

    it('startGoogleOAuth includes returnTo and space-delimited incremental scopes', async () => {
        await api.startGoogleOAuth({
            returnTo: '/settings?tab=account',
            scopes: [
                'https://www.googleapis.com/auth/calendar.events',
                'https://www.googleapis.com/auth/gmail.modify',
            ],
        });
        const [url, init] = lastCall();
        expect(url).toBe('https://example.test/api/auth/google/start?returnTo=%2Fsettings%3Ftab%3Daccount&scopes=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fcalendar.events+https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fgmail.modify');
        expect(init.method ?? 'GET').toBe('GET');
    });

    it('disconnectGoogle → DELETE /auth/google/connect', async () => {
        await api.disconnectGoogle();
        const [url, init] = lastCall();
        expect(url).toBe('https://example.test/api/auth/google/connect');
        expect(init.method).toBe('DELETE');
    });

    it('listGoogleCalendarEvents → GET /google/calendar/events with range params', async () => {
        await api.listGoogleCalendarEvents({
            timeMin: '2026-07-01T00:00:00Z',
            timeMax: '2026-07-08T00:00:00Z',
            timeZone: 'America/Los_Angeles',
            maxResults: 100,
        });
        const [url, init] = lastCall();
        expect(url).toBe('https://example.test/api/google/calendar/events?timeMin=2026-07-01T00%3A00%3A00Z&timeMax=2026-07-08T00%3A00%3A00Z&timeZone=America%2FLos_Angeles&maxResults=100');
        expect(init.method ?? 'GET').toBe('GET');
    });

    it('createGoogleCalendarEvent and updateGoogleCalendarEvent hit the proxy', async () => {
        await api.createGoogleCalendarEvent({ calendarId: 'primary', event: { summary: 'One' } });
        let [url, init] = lastCall();
        expect(url).toBe('https://example.test/api/google/calendar/events');
        expect(init.method).toBe('POST');
        expect(JSON.parse(init.body)).toEqual({ calendarId: 'primary', event: { summary: 'One' } });

        mockFetch.mockClear();
        await api.updateGoogleCalendarEvent('event/1', {
            calendarId: 'primary',
            event: { summary: 'Two' },
        });
        [url, init] = lastCall();
        expect(url).toBe('https://example.test/api/google/calendar/events/event%2F1');
        expect(init.method).toBe('PATCH');
    });

    it('listGoogleDriveFiles → GET /google/drive/files with query params', async () => {
        await api.listGoogleDriveFiles({
            q: "mimeType = 'application/vnd.google-apps.spreadsheet'",
            orderBy: 'modifiedTime desc',
            pageSize: 50,
        });
        const [url, init] = lastCall();
        expect(url).toContain('https://example.test/api/google/drive/files?');
        expect(url).toContain('orderBy=modifiedTime+desc');
        expect(url).toContain('pageSize=50');
        expect(init.method ?? 'GET').toBe('GET');
    });

    it('listGoogleDriveFiles passes driveId through for a shared drive search', async () => {
        await api.listGoogleDriveFiles({ driveId: '0ASharedX' });
        const [url] = lastCall();
        expect(url).toContain('driveId=0ASharedX');
    });

    it('createGoogleDriveFile → POST /google/drive/files with Drive / Docs payload', async () => {
        await api.createGoogleDriveFile({
            name: 'Notes',
            mimeType: 'text/plain',
            targetMimeType: 'application/vnd.google-apps.document',
            content: 'hello',
        });
        const [url, init] = lastCall();
        expect(url).toBe('https://example.test/api/google/drive/files');
        expect(init.method).toBe('POST');
        expect(JSON.parse(init.body)).toEqual({
            name: 'Notes',
            mimeType: 'text/plain',
            targetMimeType: 'application/vnd.google-apps.document',
            content: 'hello',
        });
    });

    it('getGoogleSpreadsheet and readGoogleSheetValues hit the Sheets proxy', async () => {
        await api.getGoogleSpreadsheet('sheet-1');
        let [url, init] = lastCall();
        expect(url).toBe('https://example.test/api/google/sheets/sheet-1');
        expect(init.method ?? 'GET').toBe('GET');

        mockFetch.mockClear();
        await api.readGoogleSheetValues('sheet-1', { range: "'Tab1'!A1:B2" });
        [url, init] = lastCall();
        expect(url).toContain('https://example.test/api/google/sheets/sheet-1/values?range=');
        expect(init.method ?? 'GET').toBe('GET');
    });

    it('updateGoogleSheetValues → PUT and appendGoogleSheetValues → POST', async () => {
        await api.updateGoogleSheetValues('sheet-1', {
            range: "'Tab1'!A1",
            values: [['x']],
            valueInputOption: 'USER_ENTERED',
        });
        let [url, init] = lastCall();
        expect(url).toBe('https://example.test/api/google/sheets/sheet-1/values');
        expect(init.method).toBe('PUT');
        expect(JSON.parse(init.body)).toEqual({
            range: "'Tab1'!A1",
            values: [['x']],
            valueInputOption: 'USER_ENTERED',
        });

        mockFetch.mockClear();
        await api.appendGoogleSheetValues('sheet-1', { range: "'Tab1'!A1", values: [['y']] });
        [url, init] = lastCall();
        expect(url).toBe('https://example.test/api/google/sheets/sheet-1/values/append');
        expect(init.method).toBe('POST');
    });
});
describe('api deployment helpers — URL + body parity with web client', () => {
    it('getDeployConfig(projectId) → GET /projects/:id/deploy/config', async () => {
        await api.getDeployConfig('agent-hub');
        const [url, init] = lastCall();
        expect(url).toBe('https://example.test/api/projects/agent-hub/deploy/config');
        expect(init.method ?? 'GET').toBe('GET');
    });
    it('getProjectBranches(projectId) → GET /projects/:id/branches', async () => {
        await api.getProjectBranches('agent-hub');
        const [url, init] = lastCall();
        expect(url).toBe('https://example.test/api/projects/agent-hub/branches');
        expect(init.method ?? 'GET').toBe('GET');
    });
    it('startDeployWizard(projectId) → POST /projects/:id/deploy/setup-wizard', async () => {
        await api.startDeployWizard('agent-hub');
        const [url, init] = lastCall();
        expect(url).toBe('https://example.test/api/projects/agent-hub/deploy/setup-wizard');
        expect(init.method).toBe('POST');
        expect(JSON.parse(init.body)).toEqual({});
    });
    it('listDeployments includes optional query params', async () => {
        await api.listDeployments('agent-hub', { environment: 'prod', limit: 20, offset: 40 });
        const [url, init] = lastCall();
        expect(url).toBe('https://example.test/api/projects/agent-hub/deployments?environment=prod&limit=20&offset=40');
        expect(init.method ?? 'GET').toBe('GET');
    });
    it('getDeployment(projectId, deploymentId) → GET /deployments/:id', async () => {
        await api.getDeployment('agent-hub', 'dep-1');
        const [url, init] = lastCall();
        expect(url).toBe('https://example.test/api/projects/agent-hub/deployments/dep-1');
        expect(init.method ?? 'GET').toBe('GET');
    });
    it('retryReleaseNotification POSTs to the scoped retry endpoint', async () => {
        await api.retryReleaseNotification('agent-hub', 'dep-1', 'note/1');
        const [url, init] = lastCall();
        expect(url).toBe('https://example.test/api/projects/agent-hub/deployments/dep-1/release-notifications/note%2F1/retry');
        expect(init.method).toBe('POST');
        expect(JSON.parse(init.body)).toEqual({});
    });
    it('adjustDeploymentReleaseItem PUTs inclusion status and reason', async () => {
        await api.adjustDeploymentReleaseItem('agent-hub', 'dep-1', 'card-1', {
            inclusionStatus: 'excluded',
            reason: 'not customer-facing',
        });
        const [url, init] = lastCall();
        expect(url).toBe('https://example.test/api/projects/agent-hub/deployments/dep-1/release-items/card-1');
        expect(init.method).toBe('PUT');
        expect(JSON.parse(init.body)).toEqual({
            inclusionStatus: 'excluded',
            reason: 'not customer-facing',
        });
    });
    it('triggerDeployment posts environment plus ref', async () => {
        await api.triggerDeployment('agent-hub', 'prod', { ref: 'release-1' });
        const [url, init] = lastCall();
        expect(url).toBe('https://example.test/api/projects/agent-hub/deployments');
        expect(init.method).toBe('POST');
        expect(JSON.parse(init.body)).toEqual({ environment: 'prod', ref: 'release-1' });
    });
    it('rollbackDeployment posts to the selected deployment rollback action', async () => {
        await api.rollbackDeployment('agent-hub', 'dep-prev', {});
        const [url, init] = lastCall();
        expect(url).toBe('https://example.test/api/projects/agent-hub/deployments/dep-prev/rollback');
        expect(init.method).toBe('POST');
        expect(JSON.parse(init.body)).toEqual({});
    });
    it('approveDeployment posts to the selected deployment approval action', async () => {
        await api.approveDeployment('agent-hub', 'dep-gated', {});
        const [url, init] = lastCall();
        expect(url).toBe('https://example.test/api/projects/agent-hub/deployments/dep-gated/approve');
        expect(init.method).toBe('POST');
        expect(JSON.parse(init.body)).toEqual({});
    });
});
describe('api plugin key helpers', () => {
    it('setGeminiApiKey saves through the host Gemini auth endpoint', async () => {
        await api.setGeminiApiKey('AIza-test');
        const [url, init] = lastCall();
        expect(url).toBe('https://example.test/api/config/gemini-auth/api-key');
        expect(init.method).toBe('POST');
        expect(JSON.parse(init.body)).toEqual({ apiKey: 'AIza-test' });
    });
    it('logoutGemini clears the host Gemini auth endpoint', async () => {
        await api.logoutGemini();
        const [url, init] = lastCall();
        expect(url).toBe('https://example.test/api/config/gemini-auth');
        expect(init.method).toBe('DELETE');
    });
});
describe('api fetchJSON — request headers + error handling', () => {
    it('attaches the API key and JSON content-type to every call', async () => {
        await api.getThreads('agent-hub');
        const [, init] = lastCall();
        expect(init.headers).toMatchObject({
            'Content-Type': 'application/json',
            'X-API-Key': 'test-key',
        });
    });
    it('throws when the server returns non-2xx', async () => {
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: false,
            status: 500,
            json: async () => ({ error: 'boom' }),
        });
        await expect(api.getThreads('agent-hub')).rejects.toThrow(/500: boom/);
    });
});
describe('api session summarization — URL + method parity with web client', () => {
    it('summarizeSession(id) → POST /sessions/:id/summarize with no body', async () => {
        await api.summarizeSession('sess-99');
        const [url, init] = lastCall();
        expect(url).toBe('https://example.test/api/sessions/sess-99/summarize');
        expect(init.method).toBe('POST');
        expect(init.body).toBeUndefined();
    });
    it('summarizeSession attaches the API key header', async () => {
        await api.summarizeSession('sess-99');
        const [, init] = lastCall();
        expect(init.headers).toMatchObject({
            'Content-Type': 'application/json',
            'X-API-Key': 'test-key',
        });
    });
    it('summarizeSession returns the parsed JSON body from the server', async () => {
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ summary: 'Key decisions: …' }),
        });
        const result = await api.summarizeSession('sess-99');
        expect(result).toEqual({ summary: 'Key decisions: …' });
    });
    it('summarizeSession surfaces server errors', async () => {
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: false,
            status: 500,
            json: async () => ({ error: 'boom' }),
        });
        await expect(api.summarizeSession('sess-99')).rejects.toThrow(/500: boom/);
    });
});
describe('api soft-delete recovery — parity with web client', () => {
    it('getArchivedSessions(agentId) → GET /agents/:id/archived-sessions', async () => {
        await api.getArchivedSessions('agent-42');
        const [url, init] = lastCall();
        expect(url).toBe('https://example.test/api/agents/agent-42/archived-sessions');
        // fetchJSON default is GET (no method set)
        expect(init.method).toBeUndefined();
    });
    it('restoreSession(id) → POST /sessions/:id/restore with no body', async () => {
        await api.restoreSession('sess-1');
        const [url, init] = lastCall();
        expect(url).toBe('https://example.test/api/sessions/sess-1/restore');
        expect(init.method).toBe('POST');
        expect(init.body).toBeUndefined();
    });
    it('restoreSession returns the restored SessionRow', async () => {
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ id: 'sess-1', deleted_at: null, name: 'Restored' }),
        });
        const result = await api.restoreSession('sess-1');
        expect(result).toEqual({ id: 'sess-1', deleted_at: null, name: 'Restored' });
    });
    it('restoreSession surfaces 404 when already purged', async () => {
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: false,
            status: 404,
            json: async () => ({ error: 'not archived' }),
        });
        await expect(api.restoreSession('sess-ghost')).rejects.toThrow(/404: not archived/);
    });
});
describe('api upload helpers', () => {
    it('uploadImage → POST /upload with JSON body', async () => {
        await api.uploadImage('data:image/png;base64,AAA', 'shot.png');
        const [url, init] = lastCall();
        expect(url).toBe('https://example.test/api/upload');
        expect(init.method).toBe('POST');
        expect(JSON.parse(init.body)).toEqual({
            dataUrl: 'data:image/png;base64,AAA',
            filename: 'shot.png',
        });
    });
    it('uploadFile delegates to the binary uploader (fileRef pass-through)', async () => {
        (uploadFileMock as any).mockClear();
        const fileRef = { uri: 'file:///tmp/a.mp4', name: 'a.mp4', type: 'video/mp4' };
        const result = await api.uploadFile(fileRef);
        expect(uploadFileMock).toHaveBeenCalledTimes(1);
        expect(uploadFileMock).toHaveBeenCalledWith(fileRef);
        expect(result).toEqual({ __mockedWith: fileRef });
        // Crucially, uploadFile must NOT round-trip through fetchJSON — the
        // binary uploader handles its own request against /api/upload/file.
        expect(mockFetch).not.toHaveBeenCalled();
    });
});
describe('fetchJSON error body parsing — cycle/duplicate 409s surface in message', () => {
    it('includes body.error in thrown message for non-ok responses', async () => {
        mockFetch = vi.fn().mockResolvedValue({
            ok: false,
            status: 409,
            json: async () => ({ error: 'cycle' }),
        });
        globalThis.fetch = mockFetch;
        await expect(api.getAgents()).rejects.toThrow('409: cycle');
    });
    it('includes body.error "duplicate" in thrown message', async () => {
        mockFetch = vi.fn().mockResolvedValue({
            ok: false,
            status: 409,
            json: async () => ({ error: 'duplicate' }),
        });
        globalThis.fetch = mockFetch;
        await expect(api.getAgents()).rejects.toThrow('409: duplicate');
    });
    it('falls back to generic message when body is not JSON', async () => {
        mockFetch = vi.fn().mockResolvedValue({
            ok: false,
            status: 500,
            json: async () => { throw new Error('not json'); },
        });
        globalThis.fetch = mockFetch;
        await expect(api.getAgents()).rejects.toThrow('API error: 500');
    });
});
describe('api.assignCard — engine/model opts parity with web client', () => {
    it('POSTs only { agentId } when no opts are given', async () => {
        await api.assignCard('p1', 'card-1', 'agent-a');
        const [url, init] = lastCall();
        expect(url).toBe('https://example.test/api/projects/p1/board/cards/card-1/assign');
        expect(init.method).toBe('POST');
        expect(JSON.parse(init.body)).toEqual({ agentId: 'agent-a' });
    });
    it('forwards model only when set and non-blank', async () => {
        await api.assignCard('p1', 'card-1', 'agent-a', {
            model: 'claude-opus-4-8',
        });
        const [, init] = lastCall();
        expect(JSON.parse(init.body)).toEqual({
            agentId: 'agent-a',
            model: 'claude-opus-4-8',
        });
    });
    it('forwards engine only when set and non-blank', async () => {
        await api.assignCard('p1', 'card-1', 'agent-a', { engine: 'codex-cli' });
        const [, init] = lastCall();
        expect(JSON.parse(init.body)).toEqual({
            agentId: 'agent-a',
            engine: 'codex-cli',
        });
    });
    it('forwards both engine and model when both are set', async () => {
        await api.assignCard('p1', 'card-1', 'agent-a', {
            engine: 'codex-cli',
            model: 'gpt-5-codex',
        });
        const [, init] = lastCall();
        expect(JSON.parse(init.body)).toEqual({
            agentId: 'agent-a',
            engine: 'codex-cli',
            model: 'gpt-5-codex',
        });
    });
    it('trims engine/model whitespace before posting', async () => {
        await api.assignCard('p1', 'card-1', 'agent-a', {
            engine: '  codex-cli  ',
            model: '  gpt-5-codex  ',
        });
        const [, init] = lastCall();
        expect(JSON.parse(init.body)).toEqual({
            agentId: 'agent-a',
            engine: 'codex-cli',
            model: 'gpt-5-codex',
        });
    });
    it('drops blank/whitespace-only engine and model', async () => {
        await api.assignCard('p1', 'card-1', 'agent-a', {
            engine: '   ',
            model: '',
        });
        const [, init] = lastCall();
        expect(JSON.parse(init.body)).toEqual({ agentId: 'agent-a' });
    });

    it('forwards autoMerge=true and a trimmed comment', async () => {
        await api.assignCard('p1', 'card-1', 'agent-a', {
            autoMerge: true,
            comment: '  do the thing  ',
        });
        expect(JSON.parse(lastCall()[1].body)).toEqual({
            agentId: 'agent-a',
            autoMerge: true,
            comment: 'do the thing',
        });
    });

    it('forwards autoMerge=false', async () => {
        await api.assignCard('p1', 'card-1', 'agent-a', { autoMerge: false });
        expect(JSON.parse(lastCall()[1].body)).toEqual({ agentId: 'agent-a', autoMerge: false });
    });

    it('omits autoMerge when not a boolean and drops a blank comment', async () => {
        await api.assignCard('p1', 'card-1', 'agent-a', { autoMerge: null, comment: '   ' });
        expect(JSON.parse(lastCall()[1].body)).toEqual({ agentId: 'agent-a' });
    });
});
describe('api.unassignCard — parity with web client', () => {
    it('POSTs /board/cards/:id/unassign with an empty body', async () => {
        await api.unassignCard('p1', 'card-1');
        const [url, init] = lastCall();
        expect(url).toBe('https://example.test/api/projects/p1/board/cards/card-1/unassign');
        expect(init.method).toBe('POST');
        expect(JSON.parse(init.body)).toEqual({});
    });
});
describe('api.startFinalizeWizard — Finalize setup parity with web client', () => {
    it('POSTs /projects/:projectId/finalize/setup-wizard with empty body', async () => {
        await api.startFinalizeWizard('agent-hub');
        const [url, init] = lastCall();
        expect(url).toBe('https://example.test/api/projects/agent-hub/finalize/setup-wizard');
        expect(init.method).toBe('POST');
        expect(JSON.parse(init.body)).toEqual({});
    });
    it('returns the parsed response payload (sessionId / agentId / target)', async () => {
        const payload = {
            sessionId: 'sess-1',
            agentId: 'agent-a',
            target: { sessionId: 'sess-target', branch: 'feat/ci', worktreePath: '/wt' },
            session: { id: 'sess-1' },
            draft: { proposedCiYaml: 'version: 2' },
        };
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => payload,
        });
        const res = await api.startFinalizeWizard('agent-hub');
        expect(res).toEqual(payload);
    });
});
describe('api.startDevServerWizard — Dev Server setup parity with web client', () => {
    it('POSTs /projects/:projectId/dev-server/setup-wizard with empty body', async () => {
        await api.startDevServerWizard('agent-hub');
        const [url, init] = lastCall();
        expect(url).toBe('https://example.test/api/projects/agent-hub/dev-server/setup-wizard');
        expect(init.method).toBe('POST');
        expect(JSON.parse(init.body)).toEqual({});
    });
    it('getDevServerSetupDraft → GET /projects/:projectId/dev-server/setup-draft', async () => {
        await api.getDevServerSetupDraft('agent-hub');
        const [url, init] = lastCall();
        expect(url).toBe('https://example.test/api/projects/agent-hub/dev-server/setup-draft');
        expect(init?.method ?? 'GET').toBe('GET');
    });
    it('completeDevServerWizard → POST /projects/:projectId/dev-server/wizard-complete', async () => {
        await api.completeDevServerWizard('agent-hub');
        const [url, init] = lastCall();
        expect(url).toBe('https://example.test/api/projects/agent-hub/dev-server/wizard-complete');
        expect(init.method).toBe('POST');
    });
});
describe('api.getHealth — drawer footer / mount-effect contract', () => {
    // DrawerContent mounts a useEffect that calls `api.getHealth()` to populate
    // the footer's server version/git hash. Guard the contract that effect relies
    // on: `getHealth` must be a callable method on the `api` named export and must
    // issue a plain GET /health. (A missing method or wrong export would surface
    // as a runtime error only when the drawer mounts, which the node suite can't
    // render — so we pin it here.)
    it('is a function on the api named export', () => {
        expect(typeof api.getHealth).toBe('function');
    });
    it('getHealth() → GET /health and returns the parsed payload', async () => {
        const payload = { version: '2.11.0', gitHash: 'abc1234' };
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => payload,
        });
        const res = await api.getHealth();
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
        const [url, init] = globalThis.fetch.mock.calls[0];
        expect(url).toBe('https://example.test/api/health');
        expect(init?.method).toBeUndefined(); // GET
        expect(res).toEqual(payload);
    });
});
describe('api support-ticket helpers — URL + method parity with web client', () => {
    it('getSupportTicket(projectId, id) → GET detail row with release notifications', async () => {
        await api.getSupportTicket('agent-hub', 'tkt-1');
        const [url, init] = lastCall();
        expect(url).toBe('https://example.test/api/projects/agent-hub/support-tickets/tkt-1');
        expect(init?.method).toBeUndefined();
    });
    it('deleteSupportTicket(projectId, id) → DELETE /projects/:id/support-tickets/:ticketId', async () => {
        await api.deleteSupportTicket('agent-hub', 'tkt-1');
        const [url, init] = lastCall();
        expect(url).toBe('https://example.test/api/projects/agent-hub/support-tickets/tkt-1');
        expect(init?.method).toBe('DELETE');
    });
    it('convertSupportTicketToCard(projectId, id) → POST /…/support-tickets/:id/convert', async () => {
        await api.convertSupportTicketToCard('agent-hub', 'tkt-2');
        const [url, init] = lastCall();
        expect(url).toBe('https://example.test/api/projects/agent-hub/support-tickets/tkt-2/convert');
        expect(init?.method).toBe('POST');
        expect(JSON.parse(init.body)).toEqual({});
    });
    it('convertSupportTicketToCard forwards autoMerge + a trimmed comment', async () => {
        await api.convertSupportTicketToCard('agent-hub', 'tkt-3', {
            autoMerge: true,
            comment: '  ship it  ',
        });
        expect(JSON.parse(lastCall()[1].body)).toEqual({ autoMerge: true, comment: 'ship it' });
    });
    it('setSupportTicketType(projectId, id, type) → PATCH /…/support-tickets/:id', async () => {
        await api.setSupportTicketType('agent-hub', 'tkt-5', 'feature_request');
        const [url, init] = lastCall();
        expect(url).toBe('https://example.test/api/projects/agent-hub/support-tickets/tkt-5');
        expect(init?.method).toBe('PATCH');
        expect(JSON.parse(init.body)).toEqual({ type: 'feature_request' });
    });
    it('getSupportUnreadCount(projectId) → GET /…/support-tickets/unread-count', async () => {
        await api.getSupportUnreadCount('agent-hub');
        const [url, init] = lastCall();
        expect(url).toBe('https://example.test/api/projects/agent-hub/support-tickets/unread-count');
        expect(init?.method).toBeUndefined(); // GET
    });
    it('markSupportTicketRead(projectId, id) → POST /…/support-tickets/:id/read', async () => {
        await api.markSupportTicketRead('agent-hub', 'tkt-3');
        const [url, init] = lastCall();
        expect(url).toBe('https://example.test/api/projects/agent-hub/support-tickets/tkt-3/read');
        expect(init?.method).toBe('POST');
    });
    it('markSupportTicketUnread(projectId, id) → POST /…/support-tickets/:id/unread', async () => {
        await api.markSupportTicketUnread('agent-hub', 'tkt-4');
        const [url, init] = lastCall();
        expect(url).toBe('https://example.test/api/projects/agent-hub/support-tickets/tkt-4/unread');
        expect(init?.method).toBe('POST');
    });
    it('markAllSupportTicketsRead(projectId) → POST /…/support-tickets/read-all', async () => {
        await api.markAllSupportTicketsRead('agent-hub');
        const [url, init] = lastCall();
        expect(url).toBe('https://example.test/api/projects/agent-hub/support-tickets/read-all');
        expect(init?.method).toBe('POST');
    });
    it('getAllSupportTickets() with no args → GET /support-tickets (unfiltered)', async () => {
        await api.getAllSupportTickets();
        const [url] = lastCall();
        expect(url).toBe('https://example.test/api/support-tickets');
    });
    it('getAllSupportTickets(status) legacy string → GET /support-tickets?status=', async () => {
        await api.getAllSupportTickets('investigating');
        const [url] = lastCall();
        expect(url).toBe('https://example.test/api/support-tickets?status=investigating');
    });
    it('getAllSupportTickets({status, unread}) → composes status + unread query', async () => {
        await api.getAllSupportTickets({ status: 'new', unread: true });
        const [url] = lastCall();
        expect(url).toBe('https://example.test/api/support-tickets?status=new&unread=true');
    });
    it('getAllSupportTickets({unread:false}) omits the unread param', async () => {
        await api.getAllSupportTickets({ status: 'new', unread: false });
        const [url] = lastCall();
        expect(url).toBe('https://example.test/api/support-tickets?status=new');
    });
});
describe('api kanban pagination helpers — URL parity with web client', () => {
    it('getProjectBoard(projectId) without opts → GET /projects/:id/board', async () => {
        await api.getProjectBoard('agent-hub');
        const [url] = lastCall();
        expect(url).toBe('https://example.test/api/projects/agent-hub/board');
    });
    it('getProjectBoard(projectId, { limit }) appends the limit query', async () => {
        await api.getProjectBoard('agent-hub', { limit: 50 });
        const [url] = lastCall();
        expect(url).toBe('https://example.test/api/projects/agent-hub/board?limit=50');
    });
    it('getColumnCards(projectId, columnId, { limit }) → first page URL', async () => {
        await api.getColumnCards('agent-hub', 'col-1', { limit: 50 });
        const [url] = lastCall();
        expect(url).toBe('https://example.test/api/projects/agent-hub/board/columns/col-1/cards?limit=50');
    });
    it('getColumnCards forwards + URL-encodes the cursor', async () => {
        await api.getColumnCards('agent-hub', 'col-1', { cursor: 'a/b+c=', limit: 50 });
        const [url] = lastCall();
        expect(url).toBe('https://example.test/api/projects/agent-hub/board/columns/col-1/cards?cursor=a%2Fb%2Bc%3D&limit=50');
    });
    it('getColumnCards without opts → bare column cards URL', async () => {
        await api.getColumnCards('agent-hub', 'col-1');
        const [url] = lastCall();
        expect(url).toBe('https://example.test/api/projects/agent-hub/board/columns/col-1/cards');
    });
});
describe('api per-user project settings helpers — URL + method parity', () => {
    it('getProjectUserSettings(projectId) → GET /projects/:id/user-settings', async () => {
        await api.getProjectUserSettings('agent-hub');
        const [url, init] = lastCall();
        expect(url).toBe('https://example.test/api/projects/agent-hub/user-settings');
        expect(init?.method).toBeUndefined();
    });
    it('updateProjectUserSettings(projectId, data) → PUT with JSON body', async () => {
        await api.updateProjectUserSettings('agent-hub', { defaultFinalizeAutomation: 'push' });
        const [url, init] = lastCall();
        expect(url).toBe('https://example.test/api/projects/agent-hub/user-settings');
        expect(init?.method).toBe('PUT');
        expect(JSON.parse(init.body)).toEqual({ defaultFinalizeAutomation: 'push' });
    });
    it('updateProjectUserSettings forwards a null clear', async () => {
        await api.updateProjectUserSettings('agent-hub', { defaultFinalizeAutomation: null });
        const [, init] = lastCall();
        expect(JSON.parse(init.body)).toEqual({ defaultFinalizeAutomation: null });
    });
});
describe('api segmented session replay helpers — URL + method parity with web client', () => {
    it('getSessionSegments(sessionId) → GET /replays/sessions/:id/segments', async () => {
        await api.getSessionSegments('sess-1');
        const [url, init] = lastCall();
        expect(url).toBe('https://example.test/api/replays/sessions/sess-1/segments');
        expect(init?.method ?? 'GET').toBe('GET');
    });
    it('getSessionSegments URL-encodes the session id', async () => {
        await api.getSessionSegments('a/b');
        const [url] = lastCall();
        expect(url).toBe('https://example.test/api/replays/sessions/a%2Fb/segments');
    });
    it('getSessionSegmentEvents(sessionId, segmentId) → GET .../segments/:segId/events', async () => {
        await api.getSessionSegmentEvents('sess-1', 'seg-9');
        const [url, init] = lastCall();
        expect(url).toBe('https://example.test/api/replays/sessions/sess-1/segments/seg-9/events');
        expect(init?.method ?? 'GET').toBe('GET');
    });
    it('getSessionSegmentEvents URL-encodes both ids', async () => {
        await api.getSessionSegmentEvents('a/b', 'c/d');
        const [url] = lastCall();
        expect(url).toBe('https://example.test/api/replays/sessions/a%2Fb/segments/c%2Fd/events');
    });
});
describe('api replay-playlist helpers — URL + method parity with web client', () => {
    it('listReplayPlaylists → GET /projects/:p/replay-playlists', async () => {
        await api.listReplayPlaylists('proj-1');
        const [url, init] = lastCall();
        expect(url).toBe('https://example.test/api/projects/proj-1/replay-playlists');
        expect(init?.method ?? 'GET').toBe('GET');
    });
    it('getReplayPlaylist → GET /projects/:p/replay-playlists/:id', async () => {
        await api.getReplayPlaylist('proj-1', 'pl-1');
        const [url, init] = lastCall();
        expect(url).toBe('https://example.test/api/projects/proj-1/replay-playlists/pl-1');
        expect(init?.method ?? 'GET').toBe('GET');
    });
    it('createReplayPlaylist → POST with name + description', async () => {
        await api.createReplayPlaylist('proj-1', { name: 'Checkout', description: 'bugs' });
        const [url, init] = lastCall();
        expect(url).toBe('https://example.test/api/projects/proj-1/replay-playlists');
        expect(init.method).toBe('POST');
        expect(JSON.parse(init.body)).toEqual({ name: 'Checkout', description: 'bugs' });
    });
    it('createReplayPlaylist omits description when not provided', async () => {
        await api.createReplayPlaylist('proj-1', { name: 'Checkout' });
        const [, init] = lastCall();
        expect(JSON.parse(init.body)).toEqual({ name: 'Checkout' });
    });
    it('createReplayPlaylist omits a blank description (form sends trimmed "")', async () => {
        await api.createReplayPlaylist('proj-1', { name: 'Checkout', description: '' });
        const [, init] = lastCall();
        expect(JSON.parse(init.body)).toEqual({ name: 'Checkout' });
    });
    it('updateReplayPlaylist → PATCH with the given patch', async () => {
        await api.updateReplayPlaylist('proj-1', 'pl-1', { name: 'Renamed', description: null });
        const [url, init] = lastCall();
        expect(url).toBe('https://example.test/api/projects/proj-1/replay-playlists/pl-1');
        expect(init.method).toBe('PATCH');
        expect(JSON.parse(init.body)).toEqual({ name: 'Renamed', description: null });
    });
    it('deleteReplayPlaylist → DELETE', async () => {
        await api.deleteReplayPlaylist('proj-1', 'pl-1');
        const [url, init] = lastCall();
        expect(url).toBe('https://example.test/api/projects/proj-1/replay-playlists/pl-1');
        expect(init.method).toBe('DELETE');
    });
    it('addReplayPlaylistItem → POST .../items with replayId', async () => {
        await api.addReplayPlaylistItem('proj-1', 'pl-1', 'r-9');
        const [url, init] = lastCall();
        expect(url).toBe('https://example.test/api/projects/proj-1/replay-playlists/pl-1/items');
        expect(init.method).toBe('POST');
        expect(JSON.parse(init.body)).toEqual({ replayId: 'r-9' });
    });
    it('removeReplayPlaylistItem → DELETE .../items/:replayId (encoded)', async () => {
        await api.removeReplayPlaylistItem('proj-1', 'pl-1', 'r/9');
        const [url, init] = lastCall();
        expect(url).toBe('https://example.test/api/projects/proj-1/replay-playlists/pl-1/items/r%2F9');
        expect(init.method).toBe('DELETE');
    });
    it('setReplayPlaylistRetention → POST .../retention with { extend }', async () => {
        await api.setReplayPlaylistRetention('proj-1', 'pl-1', true);
        const [url, init] = lastCall();
        expect(url).toBe('https://example.test/api/projects/proj-1/replay-playlists/pl-1/retention');
        expect(init.method).toBe('POST');
        expect(JSON.parse(init.body)).toEqual({ extend: true });
    });
    it('setReplayPlaylistRetention coerces truthiness to a boolean', async () => {
        await api.setReplayPlaylistRetention('proj-1', 'pl-1', 0);
        const [, init] = lastCall();
        expect(JSON.parse(init.body)).toEqual({ extend: false });
    });
});

describe('api.linkSupportTicketToCard — mobile parity with web client', () => {
    it('POSTs the trimmed cardId + comment to the link-card endpoint', async () => {
        await api.linkSupportTicketToCard('agent-hub', 'tkt-1', {
            cardId: '  card-9  ',
            comment: '  already fixed  ',
        });
        const [url, init] = lastCall();
        expect(url).toBe('https://example.test/api/projects/agent-hub/support-tickets/tkt-1/link-card');
        expect(init.method).toBe('POST');
        expect(JSON.parse(init.body)).toEqual({ cardId: 'card-9', comment: 'already fixed' });
    });
    it('omits a blank comment', async () => {
        await api.linkSupportTicketToCard('agent-hub', 'tkt-1', { cardId: 'card-9', comment: '   ' });
        const [, init] = lastCall();
        expect(JSON.parse(init.body)).toEqual({ cardId: 'card-9' });
    });
});

describe('errorDetail', () => {
    it('prefers the human message over a machine error code', () => {
        expect(errorDetail({ error: 'no_pushable_commits', message: 'This branch has no committed changes.' }, 400)).toBe('400: This branch has no committed changes.');
    });
    it('keeps an error field that is already human copy', () => {
        expect(errorDetail({ error: 'agentId is required' }, 400)).toBe('400: agentId is required');
    });
    it('falls back to the code when no message is present', () => {
        expect(errorDetail({ error: 'no_worktree' }, 400)).toBe('400: no_worktree');
    });
    it('falls back to the status when the body carries nothing usable', () => {
        expect(errorDetail(null, 500)).toBe('API error: 500');
    });
});
describe('api.getProjectPulls — pagination params', () => {
    it('omits page on the first page and sends the requested size', async () => {
        await api.getProjectPulls('agent-hub', { state: 'open', limit: 25 });
        const [url] = lastCall();
        expect(url).toBe('https://example.test/api/projects/agent-hub/pulls?state=open&limit=25');
    });
    it('sends page for later pages', async () => {
        await api.getProjectPulls('agent-hub', { state: 'all', limit: 25, page: 3 });
        const [url] = lastCall();
        expect(url).toBe('https://example.test/api/projects/agent-hub/pulls?state=all&limit=25&page=3');
    });
});
