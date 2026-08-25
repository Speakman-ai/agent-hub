import { getApiBaseUrl, getAuthHeaders } from './config';
import { buildNotesListUrl, buildNoteUrl } from './notesUrl';
import { uploadFile as uploadFileImpl } from './uploadFile';
import { transcribeAudio as transcribeAudioImpl } from './transcribeAudio';
import { getToken as getJwt, clearToken } from './auth';
import { normalizeSessionMessagesResponse } from './sessionMessagesResponse';
import { isDeadSessionResponse } from '@shared/utils/authErrorCodes';
/** A machine error code (`no_pushable_commits`) rather than human copy. */
const ERROR_CODE_RE = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;
/**
 * Error text for a failed response, as surfaced in toasts. Mirrors the web
 * client: routes that pair a machine `error` code with a human `message` get
 * the message, since "400: no_pushable_commits" tells an operator nothing.
 */
export function errorDetail(body: any, status: number) {
    const code = typeof body?.error === 'string' ? body.error.trim() : '';
    const message = typeof body?.message === 'string' ? body.message.trim() : '';
    const preferred = code && !ERROR_CODE_RE.test(code) ? code : message || code;
    const detail = preferred || (body ? JSON.stringify(body) : '');
    return detail ? `${status}: ${detail}` : `API error: ${status}`;
}
async function fetchJSON(url: any, options: any = {}) {
    const base = getApiBaseUrl();
    if (!base)
        throw new Error('No server configured');
    const authHeaders = getAuthHeaders();
    const res = await fetch(`${base}${url}`, {
        ...options,
        headers: { 'Content-Type': 'application/json', ...authHeaders, ...(options.headers || {}) },
    });
    if (!res.ok) {
        // Parse the error body once (it can only be read a single time) so
        // both the dead-session check and the thrown detail can use it.
        let errBody: any = null;
        try {
            errBody = await res.json();
        }
        catch {
            /* response wasn't JSON */
        }
        // Only responses the server tagged as a dead session drop the token,
        // so the next bootstrap surfaces the login screen. We don't
        // force-reload here (no `window.location.reload` on RN); the
        // app-level gate re-renders when `needsAuth` flips on the next
        // `getAuthStatus` probe. Untagged 401s (an upstream integration the
        // caller hasn't connected) and ordinary permission 403s are left
        // alone — neither means the cached credentials are bad.
        const deadSession = isDeadSessionResponse(res.status, errBody?.code);
        if (deadSession && getJwt()) {
            await clearToken().catch(() => { });
        }
        throw new Error(errorDetail(errBody, res.status));
    }
    return res.json();
}
/**
 * Query string for the infra read routes. Mirrors `infraQuery` in
 * client/src/utils/api.ts.
 *
 * Empty and nullish values are dropped rather than sent blank: the server treats
 * `?service=` as a filter for a service literally named the empty string, so a
 * cleared chip would return nothing instead of everything. `0` is kept — it is a
 * meaningful `seenSince` ("everything ever described"), not an absent filter.
 */
export function infraQuery(params: Record<string, any>): string {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null || value === '')
            continue;
        search.set(key, String(value));
    }
    const qs = search.toString();
    return qs ? `?${qs}` : '';
}
export const api = {
    // Agents & Sessions
    getAgents: () => fetchJSON('/agents'),
    getSessions: (agentId: any) => fetchJSON(`/agents/${agentId}/sessions`),
    getSession: (sessionId: any) => fetchJSON(`/sessions/${sessionId}`),
    getSessionCredentialRequest: (sessionId: any, requestId: any) => fetchJSON(`/sessions/${sessionId}/credential-requests/${encodeURIComponent(requestId)}`),
    submitSessionCredentialRequest: (sessionId: any, requestId: any, body: any) => fetchJSON(`/sessions/${sessionId}/credential-requests/${encodeURIComponent(requestId)}`, {
        method: 'PUT',
        body: JSON.stringify(body),
    }),
    createSession: (agentId: any, name: any, options: any = {}) => fetchJSON(`/agents/${agentId}/sessions`, {
        method: 'POST',
        body: JSON.stringify({
            name,
            ...(options.consultMode ? { session_mode: 'consult' } : {}),
        }),
    }),
    getMessages: async (sessionId: any, opts: any = {}) => {
        const q = opts.limit != null ? `?limit=${encodeURIComponent(String(opts.limit))}` : '';
        const data = await fetchJSON(`/sessions/${sessionId}/messages${q}`);
        return normalizeSessionMessagesResponse(data).messages;
    },
    // Kick off an AI summary of the session transcript. The server spawns a
    // short-lived CLI invocation so this can take a while — callers should
    // surface a loading state. Returns `{ summary: string }`.
    summarizeSession: (sessionId: any) => fetchJSON(`/sessions/${sessionId}/summarize`, { method: 'POST' }),
    // Skill Builder Phase 4 — spawn the coach to extract a skill from this
    // session's transcript. Returns `{ sessionId, agentId, session }`.
    extractSkillFromSession: (sessionId: any) => fetchJSON(`/sessions/${sessionId}/extract-skill`, { method: 'POST' }),
    deleteSession: (sessionId: any) => fetchJSON(`/sessions/${sessionId}`, { method: 'DELETE' }),
    // Soft-delete recovery — rows within the 7-day window, newest first.
    getArchivedSessions: (agentId: any) => fetchJSON(`/agents/${agentId}/archived-sessions`),
    restoreSession: (sessionId: any) => fetchJSON(`/sessions/${sessionId}/restore`, { method: 'POST' }),
    clearAllSessions: (agentId: any) => fetchJSON(`/agents/${agentId}/sessions`, { method: 'DELETE' }),
    // NOTE: the bulk-clear actions (clearAllSessions / clearPushedSessions) are
    // web-only — the mobile drawer has no bulk-clear UI surface, so these
    // helpers currently have no mobile call site. They're kept in lockstep with
    // client/src/utils/api.js for parity so a future mobile bulk-clear screen can
    // use them directly. `clearPushedSessions` (renamed from the former
    // `clearInactiveSessions`) hits the pushed-only archive endpoint;
    // `clearMergedSessions` is its merged-only companion.
    clearPushedSessions: (agentId: any) => fetchJSON(`/agents/${agentId}/sessions/pushed`, { method: 'DELETE' }),
    clearMergedSessions: (agentId: any) => fetchJSON(`/agents/${agentId}/sessions/merged`, { method: 'DELETE' }),
    renameSession: (sessionId: any, name: any) => fetchJSON(`/sessions/${sessionId}`, {
        method: 'PATCH',
        body: JSON.stringify({ name }),
    }),
    getSessionDetail: (sessionId: any) => fetchJSON(`/sessions/${sessionId}`),
    updateSession: (sessionId: any, data: any) => fetchJSON(`/sessions/${sessionId}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
    }),
    addSessionAgent: (sessionId: any, agentId: any) => fetchJSON(`/sessions/${sessionId}/agents`, {
        method: 'POST',
        body: JSON.stringify({ agentId }),
    }),
    removeSessionAgent: (sessionId: any, agentId: any) => fetchJSON(`/sessions/${sessionId}/agents/${agentId}`, { method: 'DELETE' }),
    setSessionEngine: (sessionId: any, engine: any) => fetchJSON(`/sessions/${sessionId}/engine`, {
        method: 'PUT',
        body: JSON.stringify({ engine }),
    }),
    setSessionModel: (sessionId: any, model: any) => fetchJSON(`/sessions/${sessionId}/model`, {
        method: 'PUT',
        body: JSON.stringify({ model }),
    }),
    // Session mode picker: 'chat' (normal build) or 'design' (loads the design
    // skill + produces HTML/CSS/JS artifacts in the worktree). The server rejects
    // 'design' for a worktree-less session (400 design_mode_requires_worktree).
    // Returns the updated, enriched session row.
    setSessionMode: (sessionId: any, mode: any) => fetchJSON(`/sessions/${sessionId}/mode`, {
        method: 'PUT',
        body: JSON.stringify({ mode }),
    }),
    // List the design artifacts a design-mode session has produced in its
    // worktree `design/` dir. Returns `{ files: [{ path, size, mtime }] }`.
    // Mobile renders this flat list (no in-app iframe canvas) plus open-in-web.
    getSessionDesignFiles: (sessionId: any) => fetchJSON(`/sessions/${sessionId}/design-files`),
    // Session artifacts — documents the agent generated this session (PDFs,
    // scripts, reports…). Mirrors the web SessionArtifactsPane data flow.
    //   GET    /sessions/:id/artifacts               → { artifacts: [...] }
    //   GET    /sessions/:id/artifacts/:aid/content  → bytes (via artifactContent util)
    //   DELETE /sessions/:id/artifacts/:aid          → remove
    getSessionArtifacts: (sessionId: any) => fetchJSON(`/sessions/${sessionId}/artifacts`),
    deleteSessionArtifact: (sessionId: any, artifactId: any) =>
      fetchJSON(`/sessions/${sessionId}/artifacts/${artifactId}`, { method: 'DELETE' }),
    // `setSessionWorktree` was removed when Agent Hub locked to
    // worktree-only sessions. The legacy `PUT /sessions/:id/worktree`
    // endpoint no longer exists.
    // Toggle Ask Mode (read-only session). Server enforces this by spawning the
    // CLI with `--permission-mode plan` instead of `bypassPermissions`. Returns
    // the updated session row so callers can hydrate `ask_mode` in local state.
    setSessionAskMode: (sessionId: any, enabled: any) => fetchJSON(`/sessions/${sessionId}/ask-mode`, {
        method: 'PUT',
        body: JSON.stringify({ enabled }),
    }),
    // Codex reasoning ("thinking") level: 'high' (default) or 'pro' (→ xhigh).
    // Returns the updated session row so callers can hydrate `reasoning_effort`.
    setSessionReasoningEffort: (sessionId: any, effort: any) => fetchJSON(`/sessions/${sessionId}/reasoning-effort`, {
        method: 'PUT',
        body: JSON.stringify({ effort }),
    }),
    setSessionOrchestration: (sessionId: any, body: any) => fetchJSON(`/sessions/${sessionId}/orchestration`, {
        method: 'PUT',
        body: JSON.stringify(body),
    }),
    // Forward the entire session transcript to a new session on another agent.
    // Mirrors the web client. Body: { targetAgentId, messageIds?, prompt?, autoStart? }
    // Returns { session, forwardedMessageId }.
    forwardSession: (sessionId: any, { targetAgentId, messageIds, prompt, autoStart }: any = {}) => fetchJSON(`/sessions/${sessionId}/forward`, {
        method: 'POST',
        body: JSON.stringify({
            targetAgentId,
            ...(messageIds ? { messageIds } : {}),
            ...(prompt ? { prompt } : {}),
            ...(autoStart != null ? { autoStart: !!autoStart } : {}),
        }),
    }),
    // Start a follow-up session from an existing one. Unlike forward, the target
    // agent defaults to the source session's own agent and the seed is the
    // Finalize summary rather than the whole transcript.
    // Body: { targetAgentId?, prompt?, autoStart? }. Returns { session, seededMessageId }.
    startFollowUpSession: (sessionId: any, { targetAgentId, prompt, autoStart }: any = {}) => fetchJSON(`/sessions/${sessionId}/follow-up`, {
        method: 'POST',
        body: JSON.stringify({
            ...(targetAgentId ? { targetAgentId } : {}),
            ...(prompt ? { prompt } : {}),
            ...(autoStart != null ? { autoStart: !!autoStart } : {}),
        }),
    }),
    updateAgent: (agentId: any, data: any) => fetchJSON(`/agents/${agentId}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
    }),
    createAgent: (data: any) => fetchJSON('/agents', {
        method: 'POST',
        body: JSON.stringify(data),
    }),
    bulkSetAllAgentsEngine: ({ engine, model }: any) => fetchJSON('/agents/bulk-engine', {
        method: 'POST',
        body: JSON.stringify({ engine, ...(model ? { model } : {}) }),
    }),
    deleteAgent: (agentId: any) => {
        const base = getApiBaseUrl();
        const authHeaders = getAuthHeaders();
        return fetch(`${base}/agents/${agentId}`, {
            method: 'DELETE',
            headers: { ...authHeaders } as Record<string, string>,
        }).then((res: any) => {
            if (!res.ok)
                throw new Error(`API error: ${res.status}`);
            return null;
        });
    },
    // Projects
    getProjects: () => fetchJSON('/projects'),
    getProject: (projectId: any) => fetchJSON(`/projects/${projectId}`),
    createProject: (data: any) => fetchJSON('/projects', { method: 'POST', body: JSON.stringify(data) }),
    cloneProject: (data: { url: string; targetDir?: string }) => fetchJSON('/projects/clone', {
        method: 'POST',
        body: JSON.stringify(data),
    }),
    analyzeProject: (data: { cwd: string; engine?: string; model?: string }) => fetchJSON('/projects/analyze', {
        method: 'POST',
        body: JSON.stringify(data),
    }),
    onboardProject: (data: Record<string, unknown>) => fetchJSON('/projects/onboard', {
        method: 'POST',
        body: JSON.stringify(data),
    }),
    getGithubCliStatus: () => fetchJSON('/github/status'),
    detectGithubRepo: (cwd: string) => fetchJSON('/github/detect-repo', {
        method: 'POST',
        body: JSON.stringify({ cwd }),
    }),
    testGithubConnection: (owner: string, repo: string) => fetchJSON('/github/test-connection', {
        method: 'POST',
        body: JSON.stringify({ owner, repo }),
    }),
    suggestProjectSetup: (data: any) => fetchJSON('/projects/provision/suggest', { method: 'POST', body: JSON.stringify(data) }),
    provisionProject: (data: any) => fetchJSON('/projects/provision', { method: 'POST', body: JSON.stringify(data) }),
    updateProject: (projectId: any, data: any) => fetchJSON(`/projects/${projectId}`, { method: 'PATCH', body: JSON.stringify(data) }),
    // Per-project email/deployment logo override (web parity).
    getProjectEmailLogo: (projectId: string) => fetchJSON(`/projects/${projectId}/email-logo`),
    updateProjectEmailLogo: (projectId: string, dataUrl: string) => fetchJSON(`/projects/${projectId}/email-logo`, { method: 'PUT', body: JSON.stringify({ dataUrl }) }),
    deleteProjectEmailLogo: (projectId: string) => fetchJSON(`/projects/${projectId}/email-logo`, { method: 'DELETE' }),
    // Per-user, project-scoped settings (e.g. default Finalize automation level).
    getProjectUserSettings: (projectId: any) => fetchJSON(`/projects/${projectId}/user-settings`),
    updateProjectUserSettings: (projectId: any, data: any) => fetchJSON(`/projects/${projectId}/user-settings`, {
        method: 'PUT',
        body: JSON.stringify(data),
    }),
    getReleaseNotificationSettings: (projectId: any) => fetchJSON(`/projects/${projectId}/release-notification-settings`),
    updateReleaseNotificationSettings: (projectId: any, data: any) => fetchJSON(`/projects/${projectId}/release-notification-settings`, {
        method: 'PUT',
        body: JSON.stringify(data),
    }),
    resetReleaseNotificationSettings: (projectId: any) => fetchJSON(`/projects/${projectId}/release-notification-settings/reset`, {
        method: 'POST',
    }),
    listReleaseDigestRecipients: (projectId: any) => fetchJSON(`/projects/${projectId}/release-notification-settings/recipients`),
    addReleaseDigestRecipient: (projectId: any, data: any) => fetchJSON(`/projects/${projectId}/release-notification-settings/recipients`, {
        method: 'POST',
        body: JSON.stringify(data),
    }),
    updateReleaseDigestRecipient: (projectId: any, recipientId: any, data: any) => fetchJSON(`/projects/${projectId}/release-notification-settings/recipients/${encodeURIComponent(recipientId)}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
    }),
    removeReleaseDigestRecipient: (projectId: any, recipientId: any) => fetchJSON(`/projects/${projectId}/release-notification-settings/recipients/${encodeURIComponent(recipientId)}`, {
        method: 'DELETE',
    }),
    getProjectBranches: (projectId: any) => fetchJSON(`/projects/${projectId}/branches`),
    deleteProject: (projectId: any) => fetch(`${getApiBaseUrl()}/projects/${projectId}`, {
        method: 'DELETE',
        headers: { ...getAuthHeaders() } as Record<string, string> as Record<string, string>,
    }).then((res: any) => {
        if (!res.ok)
            throw new Error(`API error: ${res.status}`);
        return null;
    }),
    // Agent Hub-hosted git (gitHost: 'agenthub')
    getGitHostBranches: (projectId: any) => fetchJSON(`/projects/${projectId}/git-host/branches`),
    getGitHostCommits: (projectId: any, { branch, limit = 50 }: any = {}) => {
        const params = new URLSearchParams();
        if (branch)
            params.set('branch', branch);
        params.set('limit', String(limit));
        return fetchJSON(`/projects/${projectId}/git-host/commits?${params}`);
    },
    getGitHostCommitDetail: (projectId: any, sha: any) => fetchJSON(`/projects/${projectId}/git-host/commits/${encodeURIComponent(sha)}`),
    getGitHostMirror: (projectId: any) => fetchJSON(`/projects/${projectId}/git-host/mirror`),
    getProjectAwsProfiles: (projectId: any) => fetchJSON(`/projects/${projectId}/aws-profiles`),
    getProjectAwsSsoStatus: (projectId: any, profile: any) => fetchJSON(`/projects/${projectId}/aws-sso/status?profile=${encodeURIComponent(profile)}`),
    startProjectAwsSsoLogin: (projectId: any, profile: any) => fetchJSON(`/projects/${projectId}/aws-sso/login`, {
        method: 'POST',
        body: JSON.stringify({ profile }),
    }),
    // ── AI-assisted Dev Server (prEnv.devServer) setup wizard ──
    getDevServerSetupDraft: (projectId: any) => fetchJSON(`/projects/${projectId}/dev-server/setup-draft`),
    startDevServerWizard: (projectId: any) => fetchJSON(`/projects/${projectId}/dev-server/setup-wizard`, {
        method: 'POST',
        body: JSON.stringify({}),
    }),
    completeDevServerWizard: (projectId: any) => fetchJSON(`/projects/${projectId}/dev-server/wizard-complete`, {
        method: 'POST',
        body: JSON.stringify({}),
    }),
    getRumSetupDraft: (projectId: any) => fetchJSON(`/projects/${projectId}/rum/setup-draft`),
    startRumWizard: (projectId: any, { maskAllText = false }: any = {}) => fetchJSON(`/projects/${projectId}/rum/setup-wizard`, {
        method: 'POST',
        body: JSON.stringify({ maskAllText: !!maskAllText }),
    }),
    getRumClients: (projectId: any) => fetchJSON(`/projects/${projectId}/rum/clients`),
    createRumClient: (projectId: any, name: any) => fetchJSON(`/projects/${projectId}/rum/clients`, {
        method: 'POST',
        body: JSON.stringify({ name }),
    }),
    // ── AI logs setup wizard ──
    getLogsSetupDraft: (projectId: any) => fetchJSON(`/projects/${projectId}/logs/setup-draft`),
    startLogsWizard: (projectId: any) => fetchJSON(`/projects/${projectId}/logs/setup-wizard`, {
        method: 'POST',
        body: JSON.stringify({}),
    }),
    // ── Infrastructure (AWS monitoring) — mirrors client/src/utils/api.ts ──
    // Read surface for the Resources, Metrics and Alerts tabs, plus the alert
    // status write. Polled on an interval; there is no metric WebSocket
    // (decision INFRA-UI). All Admin-gated server-side.
    getInfraMetricPacks: (projectId: any) => fetchJSON(`/projects/${projectId}/infra/metric-packs`),
    getInfraScopes: (projectId: any) => fetchJSON(`/projects/${projectId}/infra/scopes`),
    // Cached AWS spend for the Overview tab. This read never calls AWS: the
    // server answers from a table a cron fills at most three times a day,
    // because `GetCostAndUsage` bills $0.01 per paginated request with no free
    // tier and a read-through cache would charge a cent per screen open.
    getInfraSpend: (projectId: any, params: Record<string, any> = {}) => fetchJSON(`/projects/${projectId}/infra/spend${infraQuery(params)}`),
    getInfraQuotas: (projectId: any, params: Record<string, any> = {}) => fetchJSON(`/projects/${projectId}/infra/quotas${infraQuery(params)}`),
    // AWS Health event timeline for the Overview tab. Ingest-only: the Hub never
    // calls AWS on this path, it reads what an operator-owned EventBridge rule
    // pushed at `/api/infra/health/ingest`. `ingestConfigured` is what lets the
    // timeline tell "the rule was never wired up" apart from "genuinely quiet".
    getInfraHealthEvents: (projectId: any, params: Record<string, any> = {}) => fetchJSON(`/projects/${projectId}/infra/health-events${infraQuery(params)}`),
    // Non-secret metadata about the ingest credential, plus the exact ingest
    // path and EventBridge pattern the operator pastes into their own account.
    getInfraHealthIngest: (projectId: any) => fetchJSON(`/projects/${projectId}/infra/health-ingest`),
    // Mints (or rotates) the ingest credential. This is the ONLY response that
    // ever carries the plaintext token — it cannot be read back afterwards, so a
    // caller that drops it has to rotate.
    createInfraHealthIngestToken: (projectId: any) => fetchJSON(`/projects/${projectId}/infra/health-ingest`, { method: 'POST' }),
    revokeInfraHealthIngestToken: (projectId: any) => fetchJSON(`/projects/${projectId}/infra/health-ingest`, { method: 'DELETE' }),
    // Opts the project in or out of the billed Cost Explorer poll. Returns the
    // same spend body, so the screen repaints from the response.
    updateInfraSpendConfig: (projectId: any, data: { enabled: boolean }) => fetchJSON(`/projects/${projectId}/infra/spend/config`, {
        method: 'PUT',
        body: JSON.stringify(data),
    }),
    // Live reachability probe for the designated monitoring profile. Issues one
    // `DescribeAlarms` against AWS, so call it when the view opens — never on a
    // poll timer (the constraint documented on `probeProjectMonitoringAccess`).
    getInfraMonitoringStatus: (projectId: any) => fetchJSON(`/projects/${projectId}/infra/monitoring-status`),
    listInfraResources: (projectId: any, params: Record<string, any> = {}) => fetchJSON(`/projects/${projectId}/infra/resources${infraQuery(params)}`),
    listInfraMetricSeries: (projectId: any, resourceKey: any) => fetchJSON(`/projects/${projectId}/infra/metric-series${infraQuery({ resource: resourceKey })}`),
    getInfraMetricRange: (projectId: any, params: Record<string, any>) => fetchJSON(`/projects/${projectId}/infra/metrics${infraQuery(params)}`),
    listInfraAlertRules: (projectId: any, params: Record<string, any> = {}) => fetchJSON(`/projects/${projectId}/infra/alert-rules${infraQuery(params)}`),
    listInfraAlerts: (projectId: any, params: Record<string, any> = {}) => fetchJSON(`/projects/${projectId}/infra/alerts${infraQuery(params)}`),
    getInfraAlert: (projectId: any, alertId: any) => fetchJSON(`/projects/${projectId}/infra/alerts/${encodeURIComponent(alertId)}`),
    // `resolved` closes it out, `ignored` mutes it through recurrence, `open`
    // reopens it. There is no separate reopen verb.
    setInfraAlertStatus: (projectId: any, alertId: any, status: any) => fetchJSON(`/projects/${projectId}/infra/alerts/${encodeURIComponent(alertId)}/status`, {
        method: 'PUT',
        body: JSON.stringify({ status }),
    }),
    // ── AI infrastructure setup wizard ──
    // Hub-side readiness only: which profiles exist and their types, whether a
    // monitoring profile is designated, whether scopes exist. Calls AWS zero
    // times (decision INFRA-WIZARD), so it is safe to fetch on screen open even
    // for a project whose only credentials are interactive SSO. `{ projectId, draft }`.
    getInfraSetupDraft: (projectId: any) => fetchJSON(`/projects/${projectId}/infra/setup-draft`),
    // Spawns the worktree-backed `[Infra Setup]` session that probes the account
    // read-only and proposes an allowlist. Returns `{ sessionId, agentId, draft }`.
    startInfraWizard: (projectId: any) => fetchJSON(`/projects/${projectId}/infra/setup-wizard`, {
        method: 'POST',
        body: JSON.stringify({}),
    }),
    // ── Application log sources (write-only `ahlog_` ingest creds) ──
    // Mirrors client/src/utils/api.ts. List/create/rotate/revoke/delete sources;
    // create + rotate return the plaintext `token` exactly once.
    getLogSources: (projectId: any) => fetchJSON(`/projects/${projectId}/log-sources`),
    createLogSource: (projectId: any, body: any) => fetchJSON(`/projects/${projectId}/log-sources`, {
        method: 'POST',
        body: JSON.stringify(body),
    }),
    rotateLogSource: (projectId: any, sourceId: any) => fetchJSON(`/projects/${projectId}/log-sources/${sourceId}/rotate`, { method: 'POST' }),
    revokeLogSource: (projectId: any, sourceId: any) => fetchJSON(`/projects/${projectId}/log-sources/${sourceId}/revoke`, { method: 'POST' }),
    deleteLogSource: (projectId: any, sourceId: any) => fetchJSON(`/projects/${projectId}/log-sources/${sourceId}`, { method: 'DELETE' }),
    getLogsMetrics: (projectId: any) => fetchJSON(`/projects/${projectId}/logs/metrics`),
    // ── Application log reads (LOG-QUERY) — mirrors client/src/utils/api.ts ──
    // Bounded, newest-first, cursor-paginated historical query. `params` is a
    // plain object of the query filters (severity, source, service, text, …).
    queryLogs: (projectId: any, params: Record<string, any> = {}) => {
        const search = new URLSearchParams();
        for (const [key, value] of Object.entries(params)) {
            if (value == null || value === '')
                continue;
            search.set(key, String(value));
        }
        const qs = search.toString();
        return fetchJSON(`/projects/${projectId}/logs${qs ? `?${qs}` : ''}`);
    },
    // Destructive "Clear logs" — purge every ingested record for the project.
    // Admin-gated server-side; resolves to `{ purged: <count> }`.
    clearLogs: (projectId: any) => fetchJSON(`/projects/${projectId}/logs`, { method: 'DELETE' }),
    // ── Grouped error issues (LOG-GROUP) ──
    listLogIssues: (projectId: any, params: Record<string, any> = {}) => {
        const search = new URLSearchParams();
        for (const [key, value] of Object.entries(params)) {
            if (value == null || value === '')
                continue;
            search.set(key, String(value));
        }
        const qs = search.toString();
        return fetchJSON(`/projects/${projectId}/logs/issues${qs ? `?${qs}` : ''}`);
    },
    getLogIssue: (projectId: any, issueId: any) => fetchJSON(`/projects/${projectId}/logs/issues/${encodeURIComponent(issueId)}`),
    resolveLogIssue: (projectId: any, issueId: any) => fetchJSON(`/projects/${projectId}/logs/issues/${encodeURIComponent(issueId)}/resolve`, { method: 'POST' }),
    ignoreLogIssue: (projectId: any, issueId: any) => fetchJSON(`/projects/${projectId}/logs/issues/${encodeURIComponent(issueId)}/ignore`, { method: 'POST' }),
    reopenLogIssue: (projectId: any, issueId: any) => fetchJSON(`/projects/${projectId}/logs/issues/${encodeURIComponent(issueId)}/reopen`, { method: 'POST' }),
    /** Batch triage — one transaction server-side; stale ids come back in `notFound`. */
    bulkSetLogIssueStatus: (projectId: any, issueIds: string[], status: 'open' | 'resolved' | 'ignored') => fetchJSON(`/projects/${projectId}/logs/issues/bulk-status`, { method: 'POST', body: JSON.stringify({ issueIds, status }) }),
    analyzeLogIssue: (projectId: any, issueId: any, options: { startAnother?: boolean } = {}) => fetchJSON(`/projects/${projectId}/logs/issues/${encodeURIComponent(issueId)}/analyze`, { method: 'POST', body: JSON.stringify({ startAnother: options.startAnother === true }) }),
    fixLogIssue: (projectId: any, issueId: any, options: { startAnother?: boolean } = {}) => fetchJSON(`/projects/${projectId}/logs/issues/${encodeURIComponent(issueId)}/fix`, { method: 'POST', body: JSON.stringify({ startAnother: options.startAnother === true }) }),
    // ── Replays / RUM dashboard (mirrors client/src/utils/api.ts) ──
    // Segmented (continuous) session playback. The manifest lists every segment
    // for a client-minted session in playback order (chronological across views,
    // each view opening with a fresh full snapshot at index_in_view=0); the
    // session-grouped player stitches them into one continuous timeline. Both
    // reads are authenticated + per-session authorized server-side — a leaked /
    // cross-tenant session or segment id collapses to 404. Returns the
    // SessionSegmentManifest ({ sessionId, storageLayout, projectId, segmentCount,
    // durationMs, segments: [{ segmentId, viewId, indexInView, hasFullSnapshot,
    // startTs, endTs, eventCount, byteSize, eventsUrl }] }).
    getSessionSegments: (sessionId: any) => fetchJSON(`/replays/sessions/${encodeURIComponent(sessionId)}/segments`),
    // One segment's decoded rrweb events, the player concatenates client-side.
    // Returns { sessionId, segmentId, viewId, indexInView, hasFullSnapshot,
    // events, eventCount }.
    getSessionSegmentEvents: (sessionId: any, segmentId: any) => fetchJSON(`/replays/sessions/${encodeURIComponent(sessionId)}/segments/${encodeURIComponent(segmentId)}/events`),
    // Monolithic capture metadata (defaultPageSize, eventCount, retainedUntil, …)
    // — advisory input to the in-app WebView player's progress line.
    getReplay: (replayId: any) => fetchJSON(`/replays/${encodeURIComponent(replayId)}`),
    // Flag / unflag a monolithic capture for extended retention (up to 15 months;
    // the clock starts now). Returns the updated metadata row (incl. retainedUntil).
    setReplayRetention: (replayId: any, extend: boolean) => fetchJSON(`/replays/${encodeURIComponent(replayId)}/retention`, {
        method: 'POST',
        body: JSON.stringify({ extend }),
    }),
    // One page of a monolithic capture's decoded rrweb events; the WebView player
    // walks pages and concatenates them. Returns { events, total, hasMore, ... }.
    getReplayEvents: (replayId: any, offset: any = 0, limit?: any) => {
        const params = new URLSearchParams();
        if (offset)
            params.set('offset', String(offset));
        if (limit != null)
            params.set('limit', String(limit));
        const qs = params.toString();
        return fetchJSON(`/replays/${encodeURIComponent(replayId)}/events${qs ? `?${qs}` : ''}`);
    },
    // RUM Session Explorer (session-grain, Datadog-parity). Lists the
    // rum_sessions rollup with indexed facet filters; blank/undefined values are
    // omitted server-side. Returns { sessions, total, limit, offset, hasMore }.
    listRumSessions: (projectId: any, filters: any = {}) => {
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(filters)) {
            if (value == null)
                continue;
            if (typeof value === 'string' && value.trim() === '')
                continue;
            params.set(key, String(value));
        }
        const qs = params.toString();
        return fetchJSON(`/projects/${projectId}/rum/sessions${qs ? `?${qs}` : ''}`);
    },
    // Capture-grain replays table (session_replays), each row enriched with its
    // linked support ticket. Returns { replays, total, limit, offset, hasMore,
    // filter, canViewOrphans }.
    listReplays: (projectId: any, { filter, kind, limit, offset }: any = {}) => {
        const params = new URLSearchParams();
        if (filter)
            params.set('filter', filter);
        if (kind && kind !== 'all')
            params.set('kind', kind);
        if (limit != null)
            params.set('limit', String(limit));
        if (offset)
            params.set('offset', String(offset));
        const qs = params.toString();
        return fetchJSON(`/projects/${projectId}/replays${qs ? `?${qs}` : ''}`);
    },
    // Attach a replay to a project support ticket (inverse of the ticket-first
    // flow). Returns { replay, ticket }. Forward-scaffolding — unused until the
    // mobile ticket picker is ported; the mobile Link action currently defers to
    // the web dashboard (see ReplaysScreen). Tracked in follow-up #1392.
    linkReplayToTicket: (projectId: any, replayId: any, supportTicketId: any) => fetchJSON(`/projects/${projectId}/replays/${replayId}/link`, {
        method: 'POST',
        body: JSON.stringify({ supportTicketId }),
    }),
    // Detach a replay from its support ticket (keeps project attribution).
    unlinkReplay: (projectId: any, replayId: any) => fetchJSON(`/projects/${projectId}/replays/${replayId}/link`, { method: 'DELETE' }),
    // ── Replay playlists (Datadog "playlist") — 1:1 with client/src/utils/api.ts.
    // Named, project-scoped groups of saved captures + playlist-level extended
    // retention. Backend: server/routes/replay-playlists.ts.
    listReplayPlaylists: (projectId: any) => fetchJSON(`/projects/${projectId}/replay-playlists`),
    getReplayPlaylist: (projectId: any, playlistId: any) => fetchJSON(`/projects/${projectId}/replay-playlists/${playlistId}`),
    createReplayPlaylist: (projectId: any, { name, description }: any = {}) => fetchJSON(`/projects/${projectId}/replay-playlists`, {
        method: 'POST',
        // An empty/blank description is omitted (the form always sends a trimmed
        // string) so the server stores null rather than "".
        body: JSON.stringify({ name, ...(description ? { description } : {}) }),
    }),
    updateReplayPlaylist: (projectId: any, playlistId: any, patch: any = {}) => fetchJSON(`/projects/${projectId}/replay-playlists/${playlistId}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
    }),
    deleteReplayPlaylist: (projectId: any, playlistId: any) => fetchJSON(`/projects/${projectId}/replay-playlists/${playlistId}`, { method: 'DELETE' }),
    addReplayPlaylistItem: (projectId: any, playlistId: any, replayId: any) => fetchJSON(`/projects/${projectId}/replay-playlists/${playlistId}/items`, {
        method: 'POST',
        body: JSON.stringify({ replayId }),
    }),
    removeReplayPlaylistItem: (projectId: any, playlistId: any, replayId: any) => fetchJSON(`/projects/${projectId}/replay-playlists/${playlistId}/items/${encodeURIComponent(replayId)}`, { method: 'DELETE' }),
    setReplayPlaylistRetention: (projectId: any, playlistId: any, extend: boolean) => fetchJSON(`/projects/${projectId}/replay-playlists/${playlistId}/retention`, {
        method: 'POST',
        body: JSON.stringify({ extend: !!extend }),
    }),
    getCiRuns: (projectId: any, { trigger = 'all', limit = 30 }: any = {}) => fetchJSON(`/projects/${projectId}/ci-runs?trigger=${trigger}&limit=${limit}`),
    getCiRunDetail: (projectId: any, runId: any) => fetchJSON(`/projects/${projectId}/ci-runs/${runId}`),
    getProjectStats: (projectId: any, { granularity = 'day', buckets }: any = {}) => {
        const qs = new URLSearchParams({ granularity });
        if (buckets != null) qs.set('buckets', String(buckets));
        return fetchJSON(`/projects/${projectId}/stats?${qs.toString()}`);
    },
    // Hub workflows
    getProjectWorkflows: (projectId: any) => fetchJSON(`/projects/${projectId}/workflows`),
    getProjectWorkflow: (projectId: any, workflowId: any) => fetchJSON(`/projects/${projectId}/workflows/${workflowId}`),
    createProjectWorkflow: (projectId: any, body: any) => fetchJSON(`/projects/${projectId}/workflows`, {
        method: 'POST',
        body: JSON.stringify(body),
    }),
    updateProjectWorkflow: (projectId: any, workflowId: any, body: any) => fetchJSON(`/projects/${projectId}/workflows/${workflowId}`, {
        method: 'PUT',
        body: JSON.stringify(body),
    }),
    startWorkflowRun: (projectId: any, workflowId: any, runPayload: any) => fetchJSON(`/projects/${projectId}/workflows/${workflowId}/runs`, {
        method: 'POST',
        body: JSON.stringify(runPayload === undefined ? {} : { payload: runPayload }),
    }),
    getWorkflowRuns: (projectId: any, workflowId: any, { limit }: any = {}) => {
        const q = limit != null ? `?limit=${encodeURIComponent(String(limit))}` : '';
        return fetchJSON(`/projects/${projectId}/workflows/${workflowId}/runs${q}`);
    },
    getWorkflowRunDetail: (projectId: any, workflowId: any, runId: any) => fetchJSON(`/projects/${projectId}/workflows/${workflowId}/runs/${runId}`),
    // Deployment Module — deploy.yaml environments + run actions.
    getDeployConfig: (projectId: any) => fetchJSON(`/projects/${projectId}/deploy/config`),
    getDeployEnvironments: (projectId: any) => fetchJSON(`/projects/${projectId}/deploy/environments`),
    setDeployEnvironmentEnabled: (projectId: any, environmentName: any, enabled: boolean) => fetchJSON(`/projects/${projectId}/deploy/environments/${encodeURIComponent(environmentName)}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled }),
    }),
    deleteDeployEnvironmentConfig: (projectId: any, environmentName: any) => fetchJSON(`/projects/${projectId}/deploy/environments/${encodeURIComponent(environmentName)}`, {
        method: 'DELETE',
    }),
    // Per-environment deploy triggers (deploy-triggers epic decision).
    listDeployTriggers: (projectId: any, environmentName: any) => fetchJSON(`/projects/${projectId}/deploy/environments/${encodeURIComponent(environmentName)}/triggers`),
    createDeployTrigger: (projectId: any, environmentName: any, body: any) => fetchJSON(`/projects/${projectId}/deploy/environments/${encodeURIComponent(environmentName)}/triggers`, {
        method: 'POST',
        body: JSON.stringify(body),
    }),
    updateDeployTrigger: (projectId: any, environmentName: any, triggerId: any, body: any) => fetchJSON(`/projects/${projectId}/deploy/environments/${encodeURIComponent(environmentName)}/triggers/${triggerId}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
    }),
    deleteDeployTrigger: (projectId: any, environmentName: any, triggerId: any) => fetchJSON(`/projects/${projectId}/deploy/environments/${encodeURIComponent(environmentName)}/triggers/${triggerId}`, {
        method: 'DELETE',
    }),
    listDeploySchedules: (projectId: any, environmentName: any) => fetchJSON(`/projects/${projectId}/deploy/environments/${encodeURIComponent(environmentName)}/schedules`),
    createDeploySchedule: (projectId: any, environmentName: any, body: any) => fetchJSON(`/projects/${projectId}/deploy/environments/${encodeURIComponent(environmentName)}/schedules`, {
        method: 'POST',
        body: JSON.stringify(body),
    }),
    updateDeploySchedule: (projectId: any, environmentName: any, scheduleId: any, body: any) => fetchJSON(`/projects/${projectId}/deploy/environments/${encodeURIComponent(environmentName)}/schedules/${scheduleId}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
    }),
    deleteDeploySchedule: (projectId: any, environmentName: any, scheduleId: any) => fetchJSON(`/projects/${projectId}/deploy/environments/${encodeURIComponent(environmentName)}/schedules/${scheduleId}`, {
        method: 'DELETE',
    }),
    listDeployReleaseGates: (projectId: any, environmentName: any) => fetchJSON(`/projects/${projectId}/deploy/environments/${encodeURIComponent(environmentName)}/release-gates`),
    createDeployReleaseGate: (projectId: any, environmentName: any, body: any) => fetchJSON(`/projects/${projectId}/deploy/environments/${encodeURIComponent(environmentName)}/release-gates`, {
        method: 'POST',
        body: JSON.stringify(body),
    }),
    updateDeployReleaseGate: (projectId: any, environmentName: any, gateId: any, body: any) => fetchJSON(`/projects/${projectId}/deploy/environments/${encodeURIComponent(environmentName)}/release-gates/${gateId}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
    }),
    deleteDeployReleaseGate: (projectId: any, environmentName: any, gateId: any) => fetchJSON(`/projects/${projectId}/deploy/environments/${encodeURIComponent(environmentName)}/release-gates/${gateId}`, {
        method: 'DELETE',
    }),
    getNotificationRouting: (projectId: any, environmentName: any) => fetchJSON(`/projects/${projectId}/deploy/environments/${encodeURIComponent(environmentName)}/notification-routing`),
    updateNotificationRouting: (projectId: any, environmentName: any, body: any) => fetchJSON(`/projects/${projectId}/deploy/environments/${encodeURIComponent(environmentName)}/notification-routing`, {
        method: 'PUT',
        body: JSON.stringify(body),
    }),
    startDeployWizard: (projectId: any) => fetchJSON(`/projects/${projectId}/deploy/setup-wizard`, {
        method: 'POST',
        body: JSON.stringify({}),
    }),
    listDeployments: (projectId: any, { environment, limit, offset }: any = {}) => {
        const params = new URLSearchParams();
        if (environment)
            params.set('environment', environment);
        if (limit != null)
            params.set('limit', String(limit));
        if (offset)
            params.set('offset', String(offset));
        const qs = params.toString();
        return fetchJSON(`/projects/${projectId}/deployments${qs ? `?${qs}` : ''}`);
    },
    getDeployment: (projectId: any, deploymentId: any) => fetchJSON(`/projects/${projectId}/deployments/${deploymentId}`),
    // Admin-only: who a deployment's release notifications were (or will be) sent
    // to, including recipient email (PII). Server gates with requireRole('Admin').
    getDeploymentNotificationRecipients: (projectId: any, deploymentId: any) => fetchJSON(`/projects/${projectId}/deployments/${deploymentId}/notification-recipients`),
    retryReleaseNotification: (projectId: any, deploymentId: any, notificationId: any) => fetchJSON(`/projects/${projectId}/deployments/${deploymentId}/release-notifications/${encodeURIComponent(notificationId)}/retry`, {
        method: 'POST',
        body: JSON.stringify({}),
    }),
    adjustDeploymentReleaseItem: (projectId: any, deploymentId: any, cardId: any, body: any) => fetchJSON(`/projects/${projectId}/deployments/${deploymentId}/release-items/${cardId}`, {
        method: 'PUT',
        body: JSON.stringify(body),
    }),
    triggerDeployment: (projectId: any, environment: any, body: any) => fetchJSON(`/projects/${projectId}/deployments`, {
        method: 'POST',
        body: JSON.stringify({ ...body, environment }),
    }),
    rollbackDeployment: (projectId: any, deploymentId: any, body: any = {}) => fetchJSON(`/projects/${projectId}/deployments/${deploymentId}/rollback`, {
        method: 'POST',
        body: JSON.stringify(body),
    }),
    approveDeployment: (projectId: any, deploymentId: any, body: any = {}) => fetchJSON(`/projects/${projectId}/deployments/${deploymentId}/approve`, {
        method: 'POST',
        body: JSON.stringify(body),
    }),
    // Designs (Claude Design)
    getDesigns: () => fetchJSON('/designs'),
    getDesign: (id: any) => fetchJSON(`/designs/${id}`),
    createDesign: ({ name, linkedProjectIds = [] }: any = {}) => fetchJSON('/designs', {
        method: 'POST',
        body: JSON.stringify({ name, linkedProjectIds }),
    }),
    updateDesign: (id: any, data: any) => fetchJSON(`/designs/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    deleteDesign: (id: any) => fetchJSON(`/designs/${id}`, { method: 'DELETE' }),
    getDesignMessages: (id: any) => fetchJSON(`/designs/${id}/messages`),
    getDesignStatus: (id: any) => fetchJSON(`/designs/${id}/status`),
    // Release notes
    getReleases: ({ version, refresh }: any = {}) => {
        const params = new URLSearchParams();
        if (version)
            params.set('version', version);
        if (refresh)
            params.set('refresh', '1');
        const qs = params.toString();
        return fetchJSON(`/releases${qs ? `?${qs}` : ''}`);
    },
    // Health (server version / git hash for the sidebar footer)
    getHealth: () => fetchJSON('/health'),
    // Usage
    getUsage: () => fetchJSON('/usage'),
    // Config
    getConfig: () => fetchJSON('/config'),
    getModelConfig: () => fetchJSON('/config/models'),
    updateConfig: (data: any) => fetchJSON('/config', { method: 'PATCH', body: JSON.stringify(data) }),
    getSmtpSettings: () => fetchJSON('/config/smtp'),
    updateSmtpSettings: (data: any) =>
        fetchJSON('/config/smtp', { method: 'PATCH', body: JSON.stringify(data) }),
    testSmtpSettings: (data: any = {}) =>
        fetchJSON('/config/smtp/test', { method: 'POST', body: JSON.stringify(data) }),
    getGeminiAuth: () => fetchJSON('/config/gemini-auth'),
    setGeminiApiKey: (apiKey: any) => fetchJSON('/config/gemini-auth/api-key', { method: 'POST', body: JSON.stringify({ apiKey }) }),
    logoutGemini: () => fetchJSON('/config/gemini-auth', { method: 'DELETE' }),
    exportConfig: () => fetchJSON('/config/export'),
    importConfig: (data: any) => fetchJSON('/config/import', { method: 'POST', body: JSON.stringify(data) }),

    // Crons
    getCrons: () => fetchJSON('/crons'),
    getCronLogs: (id: any, limit: any = 3) => fetchJSON(`/crons/${id}/logs?limit=${limit}`),
    createCron: (data: any) => fetchJSON('/crons', { method: 'POST', body: JSON.stringify(data) }),
    updateCron: (id: any, data: any) => fetchJSON(`/crons/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    deleteCron: (id: any) => fetchJSON(`/crons/${id}`, { method: 'DELETE' }),
    runCron: (id: any) => fetchJSON(`/crons/${id}/run`, { method: 'POST' }),
    // Skills & Context
    getProjectSkills: (projectId: any) => fetchJSON(`/projects/${projectId}/skills`),
    getProjectSkill: (projectId: any, skillId: any) => fetchJSON(`/projects/${projectId}/skills/${encodeURIComponent(skillId)}`),
    getSkills: (agentId: any) => fetchJSON(`/agents/${agentId}/skills`),
    getSkill: (agentId: any, skillId: any) => fetchJSON(`/agents/${agentId}/skills/${skillId}`),
    getContext: (agentId: any) => fetchJSON(`/agents/${agentId}/context`),
    saveContext: (agentId: any, filename: any, content: any) => fetchJSON(`/agents/${agentId}/context/${filename}`, {
        method: 'PUT',
        body: JSON.stringify({ content }),
    }),
    uninstallSkill: (projectId: any, skillId: any) => fetchJSON(`/projects/${projectId}/skills/${skillId}`, { method: 'DELETE' }),
    // Skill improvement review — agent-suggested lessons pending human review.
    // Approve promotes into `## Learned Lessons`; reject discards (optional
    // audit reason). Approve/reject require Admin+ (server-enforced).
    getSkillImprovements: (projectId: any, status = 'pending') => fetchJSON(`/projects/${projectId}/skill-improvements?status=${encodeURIComponent(status)}`),
    approveSkillImprovement: (projectId: any, skillId: any, improvementId: any) => fetchJSON(`/projects/${projectId}/skills/${encodeURIComponent(skillId)}/improvements/${encodeURIComponent(improvementId)}/approve`, { method: 'POST' }),
    rejectSkillImprovement: (projectId: any, skillId: any, improvementId: any, reason?: any) => fetchJSON(`/projects/${projectId}/skills/${encodeURIComponent(skillId)}/improvements/${encodeURIComponent(improvementId)}/reject`, { method: 'POST', body: JSON.stringify(reason ? { reason } : {}) }),
    // Global (shared) skills — visible to every agent in every project.
    getGlobalSkills: () => fetchJSON(`/global-skills`),
    getGlobalSkill: (skillId: any) => fetchJSON(`/global-skills/${encodeURIComponent(skillId)}`),
    deleteGlobalSkill: (skillId: any) => fetchJSON(`/global-skills/${encodeURIComponent(skillId)}`, { method: 'DELETE' }),
    toggleSkill: (agentId: any, skillId: any, enabled: any) => fetchJSON(`/agents/${agentId}/skills/${skillId}/toggle`, {
        method: 'PUT',
        body: JSON.stringify({ enabled }),
    }),
    getSkillOverrides: (agentId: any) => fetchJSON(`/agents/${agentId}/skills/overrides`),
    // Per-user skill credentials — stored per signed-in user and merged into CLI
    // spawns for enabled skills. Mirrors the web SkillsPage credential entry.
    getSkillCredentials: (skillId?: any) => fetchJSON(`/auth/me/skill-credentials${skillId ? `?skillId=${encodeURIComponent(skillId)}` : ''}`),
    putSkillCredential: (body: any) => fetchJSON('/auth/me/skill-credentials', { method: 'PUT', body: JSON.stringify(body) }),
    deleteSkillCredential: (id: any) => fetchJSON(`/auth/me/skill-credentials/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    // Sidebar/drawer project collapse state — persisted per user so the same
    // account sees the same collapsed projects on web, mobile, and Electron.
    // The PUT merges one project server-side so concurrent surfaces can't
    // clobber each other.
    getMySidebarCollapsedProjects: () => fetchJSON('/auth/me/sidebar-collapsed-projects'),
    putMySidebarCollapsedProject: (projectId: any, collapsed: boolean) => fetchJSON(`/auth/me/sidebar-collapsed-projects/${encodeURIComponent(projectId)}`, { method: 'PUT', body: JSON.stringify({ collapsed }) }),
    // Upload
    uploadImage: (dataUrl: any, filename: any) => fetchJSON('/upload', {
        method: 'POST',
        body: JSON.stringify({ dataUrl, filename }),
    }),
    // Binary upload for videos and arbitrary files (web parity). `fileRef` is
    // `{ uri, name, type }` from expo-image-picker / expo-document-picker.
    uploadFile: (fileRef: any) => uploadFileImpl(fileRef),
    // Voice transcription — raw audio bytes to /api/transcribe (web parity).
    transcribeAudio: (uri: any, contentType: any) => transcribeAudioImpl(uri, contentType),
    // Slack
    getSlackStatus: () => fetchJSON('/slack/status'),
    restartSlack: () => fetchJSON('/slack/restart', { method: 'POST' }),
    getSlackMessages: (agentId: any, limit: any = 50) => fetchJSON(`/slack/messages?${agentId ? `agentId=${agentId}&` : ''}limit=${limit}`),
    // Slack bots — full CRUD (web parity). See server/routes/slack.ts.
    getSlackBots: () => fetchJSON('/slack/bots'),
    createSlackBot: (data: any) => fetchJSON('/slack/bots', { method: 'POST', body: JSON.stringify(data) }),
    updateSlackBot: (id: any, data: any) => fetchJSON(`/slack/bots/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    deleteSlackBot: (id: any) => fetchJSON(`/slack/bots/${id}`, { method: 'DELETE' }),
    toggleSlackBot: (id: any) => fetchJSON(`/slack/bots/${id}/toggle`, { method: 'POST' }),
    testSlackBot: (id: any) => fetchJSON(`/slack/bots/${id}/test`, { method: 'POST' }),
    testSlackTokens: (data: any) => fetchJSON('/slack/test-tokens', { method: 'POST', body: JSON.stringify(data) }),
    // Project secrets (Admin to read, Owner to write — server enforces roles).
    getProjectSecrets: (projectId: any) => fetchJSON(`/projects/${projectId}/secrets`),
    putProjectSecrets: (projectId: any, secrets: any) => fetchJSON(`/projects/${projectId}/secrets`, {
        method: 'PUT',
        body: JSON.stringify({ secrets }),
    }),
    deleteProjectSecret: (projectId: any, key: any) => fetchJSON(`/projects/${projectId}/secrets/${encodeURIComponent(key)}`, {
        method: 'DELETE',
    }),
    importProjectSecrets: (projectId: any, data: any) => fetchJSON(`/projects/${projectId}/secrets/import`, {
        method: 'POST',
        body: JSON.stringify(data),
    }),
    // Per-user CLI credentials + OAuth connections (web Settings parity).
    getMyAuth: (provider: any) => fetchJSON(`/auth/me/${provider}-auth`),
    putMyAuth: (provider: any, data: any) => fetchJSON(`/auth/me/${provider}-auth`, { method: 'PUT', body: JSON.stringify(data) }),
    getMyClaudeAuth: () => fetchJSON('/auth/me/claude-auth'),
    putMyClaudeAuth: (body: any) => fetchJSON('/auth/me/claude-auth', { method: 'PUT', body: JSON.stringify(body) }),
    getMyClaudeBrowserAuth: () => fetchJSON('/auth/me/claude-auth/browser'),
    startMyClaudeBrowserLogin: () => fetchJSON('/auth/me/claude-auth/browser/login', { method: 'POST', body: JSON.stringify({}) }),
    cancelMyClaudeBrowserLogin: () => fetchJSON('/auth/me/claude-auth/browser/cancel-login', { method: 'POST' }),
    logoutMyClaudeBrowser: () => fetchJSON('/auth/me/claude-auth/browser', { method: 'DELETE' }),
    getMyCursorAuth: () => fetchJSON('/auth/me/cursor-auth'),
    putMyCursorAuth: (body: any) => fetchJSON('/auth/me/cursor-auth', { method: 'PUT', body: JSON.stringify(body) }),
    getMyCursorBrowserAuth: () => fetchJSON('/auth/me/cursor-auth/browser'),
    startMyCursorBrowserLogin: () => fetchJSON('/auth/me/cursor-auth/browser/login', { method: 'POST', body: JSON.stringify({}) }),
    cancelMyCursorBrowserLogin: () => fetchJSON('/auth/me/cursor-auth/browser/cancel-login', { method: 'POST' }),
    logoutMyCursorBrowser: () => fetchJSON('/auth/me/cursor-auth/browser', { method: 'DELETE' }),
    getMyCodexAuth: () => fetchJSON('/auth/me/codex-auth'),
    putMyCodexAuth: (body: any) => fetchJSON('/auth/me/codex-auth', { method: 'PUT', body: JSON.stringify(body) }),
    getMyCodexBrowserAuth: () => fetchJSON('/auth/me/codex-auth/browser'),
    startMyCodexBrowserDeviceLogin: () => fetchJSON('/auth/me/codex-auth/browser/device-login', { method: 'POST', body: JSON.stringify({}) }),
    cancelMyCodexBrowserDeviceLogin: () => fetchJSON('/auth/me/codex-auth/browser/cancel-login', { method: 'POST' }),
    logoutMyCodexBrowser: () => fetchJSON('/auth/me/codex-auth/browser', { method: 'DELETE' }),
    getGithubAuthStatus: () => fetchJSON('/auth/github/status'),
    // Mints the GitHub authorize URL for the native OAuth flow. `returnTo`
    // is the app deep-link the callback redirects back to (closes the
    // in-app browser). Auth headers ride on this call, so it must be a
    // JSON fetch — NOT the browser navigating to /start directly.
    getGithubAuthStartUrl: (returnTo: string): Promise<{ authorizeUrl: string }> =>
        fetchJSON(`/auth/github/start?returnTo=${encodeURIComponent(returnTo)}`),
    disconnectGithub: () => fetchJSON('/auth/github', { method: 'DELETE' }),
    // Cross-project personal todos (spec TODO-MODEL). Scoped server-side to the
    // authenticated user; every write broadcasts `user_todo_update` to the owner.
    listTodos: (status?: 'open' | 'done') => fetchJSON(`/me/todos${status ? `?status=${status}` : ''}`),
    createTodo: (data: any) => fetchJSON('/me/todos', { method: 'POST', body: JSON.stringify(data) }),
    updateTodo: (id: any, data: any) => fetchJSON(`/me/todos/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(data) }),
    deleteTodo: (id: any) => fetchJSON(`/me/todos/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    // Link a todo to an EXISTING card / epic / session (spec TODO-TO-TICKET);
    // RBAC-gated server-side. Unlink clears it.
    linkTodo: (id: any, data: { targetType: 'card' | 'epic' | 'session'; targetId: string; projectId?: string }) =>
      fetchJSON(`/me/todos/${encodeURIComponent(id)}/link`, { method: 'POST', body: JSON.stringify(data) }),
    unlinkTodo: (id: any) => fetchJSON(`/me/todos/${encodeURIComponent(id)}/link`, { method: 'DELETE' }),
    // Promote a todo to a NEW project ticket (spec TODO-TO-TICKET PROMOTE op).
    // Creates a real card on the target board (To Do by default), carries the
    // todo's priority unless overridden, and links the todo to the created card.
    promoteTodo: (id: any, data: { projectId: string; columnId?: string; epicId?: string; priority?: string }) =>
      fetchJSON(`/me/todos/${encodeURIComponent(id)}/promote`, { method: 'POST', body: JSON.stringify(data) }),
    getLinkedTodos: (target: { targetType: 'card' | 'epic' | 'session'; targetId: string; projectId?: string }) => {
      const params = new URLSearchParams({ targetType: target.targetType, targetId: target.targetId });
      if (target.projectId) params.set('projectId', target.projectId);
      return fetchJSON(`/me/todos/linked?${params}`);
    },
    reorderTodos: (orderedIds: any) => fetchJSON('/me/todos/reorder', { method: 'POST', body: JSON.stringify({ orderedIds }) }),
    // Per-user cross-project aggregation for the Dashboard home (spec
    // AGGREGATION). One RBAC-filtered fan-out; cached server-side, `fresh` busts
    // the cache. `date`/`tz` bracket the caller's local day for the calendar pane.
    getMeDashboard: (opts: { fresh?: boolean; date?: string; tz?: string } = {}) => {
        const params = new URLSearchParams();
        if (opts.fresh) params.set('fresh', '1');
        if (opts.date) params.set('date', opts.date);
        if (opts.tz) params.set('tz', opts.tz);
        const qs = params.toString();
        return fetchJSON(`/me/dashboard${qs ? `?${qs}` : ''}`);
    },
    getMyWork: () => fetchJSON('/me/work'),
    getHubSession: () => fetchJSON('/me/hub-session'),
    clearHubSession: () => fetchJSON('/me/hub-session/clear', { method: 'POST' }),
    getHubModel: () => fetchJSON('/me/hub-model'),
    putHubModel: (body: { engine: string; model: string }) =>
        fetchJSON('/me/hub-model', { method: 'PUT', body: JSON.stringify(body) }),
    getDailySummary: (opts: { tz?: string } = {}) => {
        const params = new URLSearchParams();
        if (opts.tz) params.set('tz', opts.tz);
        const qs = params.toString();
        return fetchJSON(`/me/daily-summary${qs ? `?${qs}` : ''}`);
    },
    generateDailySummary: (opts: { tz?: string } = {}) =>
        fetchJSON('/me/daily-summary', { method: 'POST', body: JSON.stringify({ tz: opts.tz }) }),
    getDailySummarySchedule: () => fetchJSON('/me/daily-summary/schedule'),
    setDailySummarySchedule: (schedule: { enabled: boolean; timeZone?: string; times: string[] }) =>
        fetchJSON('/me/daily-summary/schedule', { method: 'PUT', body: JSON.stringify(schedule) }),
    // Per-user Google connection (Settings -> Account). Never returns tokens.
    getGoogleStatus: () => fetchJSON('/auth/google/status'),
    // Returns { authorizeUrl }; the caller opens it in the system browser.
    // `scopes` (string or string[]) requests extra per-surface scopes for
    // incremental consent; identity scopes are always added server-side.
    startGoogleOAuth: ({ returnTo, scopes }: any = {}) => {
        const params = new URLSearchParams();
        if (returnTo)
            params.set('returnTo', returnTo);
        if (scopes)
            params.set('scopes', Array.isArray(scopes) ? scopes.join(' ') : scopes);
        const qs = params.toString();
        return fetchJSON(`/auth/google/start${qs ? `?${qs}` : ''}`);
    },
    disconnectGoogle: () => fetchJSON('/auth/google/connect', { method: 'DELETE' }),
    listGoogleCalendarEvents: ({ calendarId, timeMin, timeMax, timeZone, maxResults, pageToken, q, }: any) => {
        const params = new URLSearchParams();
        if (calendarId)
            params.set('calendarId', calendarId);
        params.set('timeMin', timeMin);
        params.set('timeMax', timeMax);
        if (timeZone)
            params.set('timeZone', timeZone);
        if (maxResults)
            params.set('maxResults', String(maxResults));
        if (pageToken)
            params.set('pageToken', pageToken);
        if (q)
            params.set('q', q);
        return fetchJSON(`/google/calendar/events?${params.toString()}`);
    },
    createGoogleCalendarEvent: (data: any) => fetchJSON('/google/calendar/events', {
        method: 'POST',
        body: JSON.stringify(data),
    }),
    updateGoogleCalendarEvent: (eventId: any, data: any) => fetchJSON(`/google/calendar/events/${encodeURIComponent(eventId)}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
    }),
    // Gmail proxy (user-scoped). Tokens stay server-side; clients never hold them.
    listGoogleGmailThreads: ({ q, labelIds, maxResults, pageToken, includeSpamTrash }: any = {}) => {
        const params = new URLSearchParams();
        if (q)
            params.set('q', q);
        if (labelIds)
            for (const id of Array.isArray(labelIds) ? labelIds : [labelIds])
                params.append('labelIds', id);
        if (maxResults)
            params.set('maxResults', String(maxResults));
        if (pageToken)
            params.set('pageToken', pageToken);
        if (includeSpamTrash !== undefined)
            params.set('includeSpamTrash', includeSpamTrash ? 'true' : 'false');
        const qs = params.toString();
        return fetchJSON(`/google/gmail/threads${qs ? `?${qs}` : ''}`);
    },
    getGoogleGmailThread: (threadId: any, { format }: any = {}) => {
        const params = new URLSearchParams();
        if (format)
            params.set('format', format);
        const qs = params.toString();
        return fetchJSON(`/google/gmail/threads/${encodeURIComponent(threadId)}${qs ? `?${qs}` : ''}`);
    },
    sendGoogleGmailMessage: (data: any) => fetchJSON('/google/gmail/messages', {
        method: 'POST',
        body: JSON.stringify(data),
    }),
    // Drive proxy (user-scoped, drive.file only). Lists and creates
    // app-accessible Drive / Docs files. Tokens stay server-side.
    listGoogleDriveFiles: ({ q, pageSize, pageToken, orderBy, driveId }: any = {}) => {
        const params = new URLSearchParams();
        if (q)
            params.set('q', q);
        if (pageSize)
            params.set('pageSize', String(pageSize));
        if (pageToken)
            params.set('pageToken', pageToken);
        if (orderBy)
            params.set('orderBy', orderBy);
        if (driveId)
            params.set('driveId', driveId);
        const qs = params.toString();
        return fetchJSON(`/google/drive/files${qs ? `?${qs}` : ''}`);
    },
    getGoogleDriveFile: (fileId: any) => fetchJSON(`/google/drive/files/${encodeURIComponent(fileId)}`),
    createGoogleDriveFile: (data: any) => fetchJSON('/google/drive/files', {
        method: 'POST',
        body: JSON.stringify(data),
    }),
    // Sheets proxy (user-scoped). Tokens stay server-side; clients never hold them.
    getGoogleSpreadsheet: (spreadsheetId: any) => fetchJSON(`/google/sheets/${encodeURIComponent(spreadsheetId)}`),
    readGoogleSheetValues: (spreadsheetId: any, { range, majorDimension, valueRenderOption, dateTimeRenderOption }: any) => {
        const params = new URLSearchParams();
        params.set('range', range);
        if (majorDimension)
            params.set('majorDimension', majorDimension);
        if (valueRenderOption)
            params.set('valueRenderOption', valueRenderOption);
        if (dateTimeRenderOption)
            params.set('dateTimeRenderOption', dateTimeRenderOption);
        return fetchJSON(`/google/sheets/${encodeURIComponent(spreadsheetId)}/values?${params.toString()}`);
    },
    updateGoogleSheetValues: (spreadsheetId: any, data: any) => fetchJSON(`/google/sheets/${encodeURIComponent(spreadsheetId)}/values`, {
        method: 'PUT',
        body: JSON.stringify(data),
    }),
    appendGoogleSheetValues: (spreadsheetId: any, data: any) => fetchJSON(`/google/sheets/${encodeURIComponent(spreadsheetId)}/values/append`, {
        method: 'POST',
        body: JSON.stringify(data),
    }),
    // Per-user engine/model overrides per agent.
    getMyAgentEngineOverrides: () => fetchJSON('/auth/me/agent-engine-overrides'),
    putMyAgentEngineOverride: (agentId: any, data: any) => fetchJSON(`/auth/me/agent-engine-overrides/${agentId}`, {
        method: 'PUT',
        body: JSON.stringify(data),
    }),
    deleteMyAgentEngineOverride: (agentId: any) => fetchJSON(`/auth/me/agent-engine-overrides/${agentId}`, { method: 'DELETE' }),
    getMyAgentModelOverrides: () => fetchJSON('/auth/me/agent-model-overrides'),
    putMyAgentModelOverride: (agentId: any, data: any) => fetchJSON(`/auth/me/agent-model-overrides/${agentId}`, {
        method: 'PUT',
        body: JSON.stringify(data),
    }),
    deleteMyAgentModelOverride: (agentId: any) => fetchJSON(`/auth/me/agent-model-overrides/${agentId}`, { method: 'DELETE' }),
    getInvites: () => fetchJSON('/auth/invites'),
    createInvite: (data: any) => fetchJSON('/auth/invites', { method: 'POST', body: JSON.stringify(data) }),
    sendInviteEmail: (token: any) => fetchJSON(`/auth/invites/${encodeURIComponent(token)}/email`, { method: 'POST' }),
    revokeInvite: (token: any) => fetchJSON(`/auth/invites/${encodeURIComponent(token)}`, { method: 'DELETE' }),
    previewInvite: (token: any) => fetchJSON(`/auth/invites/${encodeURIComponent(token)}`),
    acceptInvite: (token: any, data: any) => fetchJSON(`/auth/invites/${encodeURIComponent(token)}/accept`, {
        method: 'POST',
        body: JSON.stringify(data),
    }),
    // Devices (push notifications)
    registerDevice: (token: any, platform: any = 'ios') => fetchJSON('/devices', {
        method: 'POST',
        body: JSON.stringify({ token, platform }),
    }),
    // Cron sessions
    getCronSessions: () => fetchJSON('/sessions/cron'),
    shipSession: (sessionId: any) => fetchJSON(`/sessions/${sessionId}/ship`, {
        method: 'POST',
        body: JSON.stringify({}),
    }),
    // Finalize Code Changes — design doc: finalize-code-changes-architecture-v0
    // Returns the most-recent finalize_runs row for a session, or `{ run: null }`
    // when none exists yet. Used by the mobile FinalizeButton for both initial
    // load and (as a polling fallback) live-state tracking — there's no WS
    // bridge for `finalize_run_*` events on mobile yet.
    // `includeStale=0` skips the server's `git rev-parse HEAD` spawn — mobile
    // consumes only `run`/`steps`, not `stale`, and the spawn on this poll's
    // hot path delays queued step rows during a busy run.
    getLatestFinalizeRunForSession: (sessionId: any) => fetchJSON(`/sessions/${sessionId}/finalize-runs/latest?includeStale=0`),
    getSessionWorktreeChanges: (sessionId: any) => fetchJSON(`/sessions/${sessionId}/worktree-changes`),
    // Kick off a finalize run for a card-linked session. Server returns the
    // run id + status (and a `reused` flag when the existing non-terminal row
    // was returned). Throws on 409 in_flight / 400 no_session etc.
    startFinalizeRun: (projectId: any, cardId: any) => fetchJSON(`/projects/${projectId}/cards/${cardId}/finalize`, {
        method: 'POST',
        body: JSON.stringify({}),
    }),
    startFinalizeRunForSession: (projectId: any, sessionId: any) => fetchJSON(`/projects/${projectId}/sessions/${sessionId}/finalize`, {
        method: 'POST',
        body: JSON.stringify({}),
    }),
    // Cancel an in-flight finalize run. v0 is "UI-only cancel" — the server
    // flips the DB row to `cancelled`; the orchestrator does not currently
    // honor an out-of-process cancel. Returns 200 `{ ok: true, status }`.
    cancelFinalizeRun: (projectId: any, runId: any) => fetchJSON(`/projects/${projectId}/finalize/${runId}/cancel`, {
        method: 'POST',
        body: JSON.stringify({}),
    }),
    // Push a finalized run's branch and open a PR (Push to Agent Hub / GitHub).
    // `force: true` pushes even when review + checks have not both passed.
    pushFinalizeRun: (projectId: any, runId: any, { force = false }: any = {}) => fetchJSON(`/projects/${projectId}/finalize/${runId}/push`, {
        method: 'POST',
        body: JSON.stringify({ force }),
    }),
    // Reviewer findings for a finalize run. Returns
    // `{ threads: [...], reviewer_verdict: 'approved'|'changes_requested'|null }`.
    getReviewerThreads: (projectId: any, runId: any) => fetchJSON(`/projects/${projectId}/finalize/${runId}/reviewer-threads`),
    // Finalize Code Changes — `.agent-hub/ci.yaml` setup wizard. Spawns a
    // guided chat session loaded with the `finalize-setup` skill. Returns
    // `{ sessionId, agentId, draft, session, target }`. Mirrors the web
    // client's `api.startFinalizeWizard`. Settings → Finalize on mobile is
    // the entry point; the wizard itself runs in the existing chat surface.
    startFinalizeWizard: (projectId: any) => fetchJSON(`/projects/${projectId}/finalize/setup-wizard`, {
        method: 'POST',
        body: JSON.stringify({}),
    }),
    // Message events (for session timeline)
    getMessageEvents: (messageId: any) => fetchJSON(`/messages/${messageId}/events`),
    // Delegations
    getDelegations: (messageId: any) => fetchJSON(`/delegations/${messageId}`),
    getSessionDelegations: (sessionId: any) => fetchJSON(`/sessions/${sessionId}/delegations`),
    // Handoffs — DB rows for <handoff> blocks emitted from this session.
    // Used by HandoffCard to resolve the target session id and render a
    // tappable "Open session" link + status pill (pending / delivered / failed).
    getSessionHandoffs: (sessionId: any) => fetchJSON(`/sessions/${sessionId}/handoffs`),
    // Queue
    getSessionQueue: (sessionId: any) => fetchJSON(`/sessions/${sessionId}/queue`),
    // Kanban Board
    // Pass `{ limit }` to opt into per-column pagination: `cards` is capped to the
    // first `limit` cards per column (keyset-ordered) and the response gains a
    // `cursors` map `{ [columnId]: nextCursor|null }` (plus the always-present
    // `counts` map) for seeding per-column infinite scroll. Omit `limit` for the
    // full board (backward compatible).
    getProjectBoard: (projectId: any, opts: any = {}) => {
        const params = new URLSearchParams();
        if (opts.limit != null)
            params.set('limit', String(opts.limit));
        const qs = params.toString();
        return fetchJSON(`/projects/${projectId}/board${qs ? `?${qs}` : ''}`);
    },
    // One keyset page of a single column's cards. `cursor` is the opaque token
    // from a prior `nextCursor` (or the board's `cursors` map). Returns
    // `{ cards, nextCursor, total }`.
    getColumnCards: (projectId: any, columnId: any, opts: any = {}) => {
        const params = new URLSearchParams();
        if (opts.cursor)
            params.set('cursor', opts.cursor);
        if (opts.limit != null)
            params.set('limit', String(opts.limit));
        const qs = params.toString();
        return fetchJSON(`/projects/${projectId}/board/columns/${columnId}/cards${qs ? `?${qs}` : ''}`);
    },
    createKanbanColumn: (projectId: any, data: any) => fetchJSON(`/projects/${projectId}/board/columns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
    }),
    updateKanbanColumn: (projectId: any, columnId: any, data: any) => fetchJSON(`/projects/${projectId}/board/columns/${columnId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
    }),
    deleteKanbanColumn: (projectId: any, columnId: any) => fetchJSON(`/projects/${projectId}/board/columns/${columnId}`, {
        method: 'DELETE',
    }),
    createKanbanCard: (projectId: any, data: any) => fetchJSON(`/projects/${projectId}/board/cards`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
    }),
    updateKanbanCard: (projectId: any, cardId: any, data: any) => fetchJSON(`/projects/${projectId}/board/cards/${cardId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
    }),
    moveKanbanCard: (projectId: any, cardId: any, data: any) => fetchJSON(`/projects/${projectId}/board/cards/${cardId}/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
    }),
    deleteKanbanCard: (projectId: any, cardId: any) => fetchJSON(`/projects/${projectId}/board/cards/${cardId}`, { method: 'DELETE' }),
    addCardBlocker: (projectId: any, cardId: any, blockedByCardId: any) => fetchJSON(`/projects/${projectId}/board/cards/${cardId}/blockers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blockedByCardId }),
    }),
    removeCardBlocker: (projectId: any, cardId: any, blockedByCardId: any) => fetchJSON(`/projects/${projectId}/board/cards/${cardId}/blockers/${blockedByCardId}`, {
        method: 'DELETE',
    }),
    // Assign a kanban card to an agent. Server spawns a new session tied to the
    // card, moves the card into "In Progress", and returns `{ sessionId, ... }`.
    // Mirrors the web client's `api.assignCard`.
    assignCard: (projectId: any, cardId: any, agentId: any, opts: any = {}) => {
        const body: Record<string, any> = { agentId };
        if (opts.model != null && String(opts.model).trim())
            body.model = String(opts.model).trim();
        if (opts.engine != null && String(opts.engine).trim())
            body.engine = String(opts.engine).trim();
        if (typeof opts.autoMerge === 'boolean') body.autoMerge = opts.autoMerge;
        if (opts.comment != null && String(opts.comment).trim())
            body.comment = String(opts.comment).trim();
        return fetchJSON(`/projects/${projectId}/board/cards/${cardId}/assign`, {
            method: 'POST',
            body: JSON.stringify(body),
        });
    },
    // Clear a card's assignee and detach any linked session. Mirrors the web
    // client's `api.unassignCard`.
    unassignCard: (projectId: any, cardId: any) => fetchJSON(`/projects/${projectId}/board/cards/${cardId}/unassign`, {
        method: 'POST',
        body: JSON.stringify({}),
    }),
    getCardComments: (projectId: any, cardId: any) => fetchJSON(`/projects/${projectId}/board/cards/${cardId}/comments`),
    addCardComment: (projectId: any, cardId: any, data: any) => fetchJSON(`/projects/${projectId}/board/cards/${cardId}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
    }),
    // Epics
    getEpics: (projectId: any) => fetchJSON(`/projects/${projectId}/board/epics`),
    createEpic: (projectId: any, data: any) => fetchJSON(`/projects/${projectId}/board/epics`, {
        method: 'POST',
        body: JSON.stringify(data),
    }),
    updateEpic: (projectId: any, epicId: any, data: any) => fetchJSON(`/projects/${projectId}/board/epics/${epicId}`, {
        method: 'PUT',
        body: JSON.stringify(data),
    }),
    deleteEpic: (projectId: any, epicId: any) => fetchJSON(`/projects/${projectId}/board/epics/${epicId}`, { method: 'DELETE' }),
    getEpicPulls: (projectId: any, epicId: any) => fetchJSON(`/projects/${projectId}/board/epics/${epicId}/pulls`),
    // Epic-level start — sweeps the epic's phases left-to-right honoring each
    // phase's auto-dispatch arming. Returns `{ outcome, phaseId?, phaseName? }`.
    runEpic: (projectId: any, epicId: any) => fetchJSON(`/projects/${projectId}/board/epics/${epicId}/run`, { method: 'POST' }),
    // Scheduled epic start (node-cron + IANA timezone).
    setEpicStartSchedule: (projectId: any, epicId: any, data: { cron: string; timezone?: string | null; enabled?: boolean }) => fetchJSON(`/projects/${projectId}/board/epics/${epicId}/start-schedule`, {
        method: 'PUT',
        body: JSON.stringify(data),
    }),
    clearEpicStartSchedule: (projectId: any, epicId: any) => fetchJSON(`/projects/${projectId}/board/epics/${epicId}/start-schedule`, { method: 'DELETE' }),
    scopeEpic: (projectId: any, epicId: any, data: { agentId?: string } = {}) => fetchJSON(`/projects/${projectId}/board/epics/${epicId}/scope`, {
        method: 'POST',
        body: JSON.stringify(data),
    }),
    scopeFromNotes: (projectId: any, data: { content: string; title?: string; agentId?: string }) => fetchJSON(`/projects/${projectId}/board/scope-from-notes`, {
        method: 'POST',
        body: JSON.stringify(data),
    }),
    linkCardToEpic: (projectId: any, cardId: any, epicId: any) => fetchJSON(`/projects/${projectId}/board/cards/${cardId}/epic`, {
        method: 'POST',
        body: JSON.stringify({ epicId }),
    }),
    getAutonomousEpic: (projectId: any) => fetchJSON(`/projects/${projectId}/board/autonomous`),
    // Card templates — server-backed reusable defaults for new cards.
    // Contracts in server/routes/board.ts (/board/card-templates).
    getCardTemplates: (projectId: any) => fetchJSON(`/projects/${projectId}/board/card-templates`),
    createCardTemplate: (projectId: any, data: any) => fetchJSON(`/projects/${projectId}/board/card-templates`, {
        method: 'POST',
        body: JSON.stringify(data),
    }),
    updateCardTemplate: (projectId: any, templateId: any, data: any) => fetchJSON(`/projects/${projectId}/board/card-templates/${templateId}`, {
        method: 'PUT',
        body: JSON.stringify(data),
    }),
    deleteCardTemplate: (projectId: any, templateId: any) => fetchJSON(`/projects/${projectId}/board/card-templates/${templateId}`, {
        method: 'DELETE',
    }),
    // Phases — the epic detail (workbench) screen drives autonomous phase runs.
    // Mirrors the web client's phase methods; server contracts in
    // server/routes/board-phases.ts.
    createPhase: (projectId: any, data: any) => fetchJSON(`/projects/${projectId}/board/phases`, {
        method: 'POST',
        body: JSON.stringify(data),
    }),
    updatePhase: (projectId: any, phaseId: any, data: any) => fetchJSON(`/projects/${projectId}/board/phases/${phaseId}`, {
        method: 'PUT',
        body: JSON.stringify(data),
    }),
    deletePhase: (projectId: any, phaseId: any) => fetchJSON(`/projects/${projectId}/board/phases/${phaseId}`, { method: 'DELETE' }),
    runPhase: (projectId: any, phaseId: any) => fetchJSON(`/projects/${projectId}/board/phases/${phaseId}/run`, { method: 'POST' }),
    stopPhase: (projectId: any, phaseId: any) => fetchJSON(`/projects/${projectId}/board/phases/${phaseId}/stop`, { method: 'POST' }),
    // Reorder an epic's phases. Pass `phaseIds` for an explicit order, or
    // `sortByDependencies: true` to derive the order from the card blocker graph.
    reorderPhases: (projectId: any, epicId: string, opts: { phaseIds?: string[]; sortByDependencies?: boolean }) => fetchJSON(`/projects/${projectId}/board/phases/reorder`, {
        method: 'POST',
        body: JSON.stringify({ epicId, ...opts }),
    }),
    // Epic spec decisions — the spec-first section of the epic detail screen.
    createSpecItem: (projectId: any, data: any) => fetchJSON(`/projects/${projectId}/board/spec-items`, {
        method: 'POST',
        body: JSON.stringify(data),
    }),
    updateSpecItem: (projectId: any, specItemId: any, data: any) => fetchJSON(`/projects/${projectId}/board/spec-items/${specItemId}`, {
        method: 'PUT',
        body: JSON.stringify(data),
    }),
    decideSpecForMe: (projectId: any, specItemId: any, data: { agentId?: string } = {}) => fetchJSON(`/projects/${projectId}/board/spec-items/${specItemId}/decide-for-me`, {
        method: 'POST',
        body: JSON.stringify(data),
    }),
    // Session insights — summary panel, skill invocations, worktree diffs.
    // `getSessionSummary` powers the session summary sheet (linked PR, agents,
    // skill usage); `getSessionChangesDiff` returns the unified diff for one
    // file in the session worktree (`file` is the repo-relative path from
    // `getSessionWorktreeChanges`).
    getSessionSummary: (sessionId: any) => fetchJSON(`/sessions/${sessionId}/summary`),
    getSessionSkillInvocations: (sessionId: any) => fetchJSON(`/sessions/${sessionId}/skill-invocations`),
    getSessionChanges: (sessionId: any) => fetchJSON(`/sessions/${sessionId}/changes`),
    getSessionChangesDiff: (sessionId: any, file: any) => fetchJSON(`/sessions/${sessionId}/changes/diff?file=${encodeURIComponent(file)}`),
    // Pull Requests (read-only viewer)
    getProjectPulls: (projectId: any, { state = 'open', limit = 30, page = 1 }: any = {}) => {
        const params = new URLSearchParams();
        if (state)
            params.set('state', state);
        if (limit)
            params.set('limit', String(limit));
        if (page && page > 1)
            params.set('page', String(page));
        const qs = params.toString();
        return fetchJSON(`/projects/${projectId}/pulls${qs ? '?' + qs : ''}`);
    },
    getProjectPullDetail: (projectId: any, number: any) => fetchJSON(`/projects/${projectId}/pulls/${number}`),
    // NOTE: `fetchJSON` on mobile doesn't implement a timeout (unlike the web
    // client). The server-side resolve spawn is fast to initiate (it returns
    // once the session is spawned, not once the agent finishes), so the default
    // React Native fetch timeout is adequate.
    resolvePR: (projectId: any, prNumber: any, { agentId }: any = {}) => fetchJSON(`/projects/${projectId}/pulls/${prNumber}/resolve`, {
        method: 'POST',
        body: JSON.stringify({ agentId }),
    }),
    // Pull Requests — write surface (web parity). Bodies mirror the web
    // client; see server/routes/pulls-native.ts for the contracts.
    createPull: (projectId: any, data: any) => fetchJSON(`/projects/${projectId}/pulls`, { method: 'POST', body: JSON.stringify(data) }),
    updatePull: (projectId: any, number: any, data: any) => fetchJSON(`/projects/${projectId}/pulls/${number}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
    }),
    reopenPull: (projectId: any, number: any) => fetchJSON(`/projects/${projectId}/pulls/${number}/reopen`, {
        method: 'POST',
        body: JSON.stringify({}),
    }),
    // Arm/disarm native PR auto-merge. Returns { pr, merged }.
    setPullAutoMerge: (projectId: any, number: any, enabled: boolean) => fetchJSON(`/projects/${projectId}/pulls/${number}/auto-merge`, {
        method: 'POST',
        body: JSON.stringify({ enabled }),
    }),
    // Undo a merged PR: commits the inverse on the base branch and pushes the
    // moved branch to the GitHub mirror. Adds a commit; no history rewrite.
    revertPull: (projectId: any, number: any) => fetchJSON(`/projects/${projectId}/pulls/${number}/revert`, {
        method: 'POST',
        body: JSON.stringify({}),
    }),
    // `data`: { event: 'APPROVE'|'REQUEST_CHANGES'|'COMMENT', body? }
    submitPullReview: (projectId: any, number: any, data: any) => fetchJSON(`/projects/${projectId}/pulls/${number}/reviews`, {
        method: 'POST',
        body: JSON.stringify(data),
    }),
    // Dismiss a submitted verdict review (GitHub "Dismiss review"). One-way; a
    // reason is required. `data`: { reason }.
    dismissPullReview: (projectId: any, number: any, reviewId: any, data: any) => fetchJSON(`/projects/${projectId}/pulls/${number}/reviews/${reviewId}/dismiss`, {
        method: 'POST',
        body: JSON.stringify(data),
    }),
    // `data`: { body, path?, line? } — path+line for inline file comments.
    addPullComment: (projectId: any, number: any, data: any) => fetchJSON(`/projects/${projectId}/pulls/${number}/comments`, {
        method: 'POST',
        body: JSON.stringify(data),
    }),
    // `data`: { filePath, line, side, resolved } — collapses/expands an inline
    // comment thread on a native PR.
    setPullCommentThreadResolved: (projectId: any, number: any, data: any) => fetchJSON(`/projects/${projectId}/pulls/${number}/comment-threads/resolve`, {
        method: 'POST',
        body: JSON.stringify(data),
    }),
    // GitHub PR read proxy — same endpoints the web FileDiffView uses.
    getPrDiff: (prUrl: any) => fetchJSON(`/pr/diff?prUrl=${encodeURIComponent(prUrl)}`),
    getPrFiles: (prUrl: any) => fetchJSON(`/pr/files?prUrl=${encodeURIComponent(prUrl)}`),
    getPrData: (prUrl: any) => fetchJSON(`/pr/data?prUrl=${encodeURIComponent(prUrl)}`),
    mergePr: (prUrl: any) => fetchJSON('/pr/merge', { method: 'POST', body: JSON.stringify({ prUrl }) }),
    closePr: (prUrl: any) => fetchJSON('/pr/close', { method: 'POST', body: JSON.stringify({ prUrl }) }),
    // Notes (project-scoped quick-capture)
    getNotes: (projectId: any, query?: any, limit?: any) => fetchJSON(buildNotesListUrl(projectId, query, limit)),
    getNote: (projectId: any, noteId: any) => fetchJSON(buildNoteUrl(projectId, noteId)),
    createNote: (projectId: any, data: any) => fetchJSON(`/projects/${projectId}/notes`, {
        method: 'POST',
        body: JSON.stringify(data),
    }),
    updateNote: (projectId: any, noteId: any, data: any) => fetchJSON(buildNoteUrl(projectId, noteId), {
        method: 'PUT',
        body: JSON.stringify(data),
    }),
    deleteNote: (projectId: any, noteId: any) => fetchJSON(buildNoteUrl(projectId, noteId), { method: 'DELETE' }),
    processNote: (projectId: any, date: any, data: any) => fetchJSON(`/projects/${projectId}/notes/${date}/process`, {
        method: 'POST',
        body: JSON.stringify(data),
    }),
    getToolErrors: (projectId: any, { since, limit }: any = {}) => {
        const params = new URLSearchParams();
        if (since)
            params.set('since', since);
        if (limit)
            params.set('limit', String(limit));
        const qs = params.toString();
        return fetchJSON(`/projects/${projectId}/tool-errors${qs ? `?${qs}` : ''}`);
    },
    getJobs: ({ status, type, limit, offset }: any = {}) => {
        const params = new URLSearchParams();
        if (status)
            params.set('status', status);
        if (type)
            params.set('type', type);
        if (limit)
            params.set('limit', String(limit));
        if (offset)
            params.set('offset', String(offset));
        const qs = params.toString();
        return fetchJSON(`/jobs${qs ? `?${qs}` : ''}`);
    },
    retryJob: (id: any) => fetchJSON(`/jobs/${id}/retry`, { method: 'POST', body: JSON.stringify({}) }),
    deleteJob: (id: any) => fetchJSON(`/jobs/${id}`, { method: 'DELETE' }),
    getServerLogs: () => fetchJSON('/server-logs'),
    getMe: () => fetchJSON('/auth/me'),
    getUsers: () => fetchJSON('/auth/users'),
    startMfaEnrollment: () => fetchJSON('/auth/me/mfa/enrollment/start', { method: 'POST', body: JSON.stringify({}) }),
    confirmMfaEnrollment: (code: any) => fetchJSON('/auth/me/mfa/enrollment/confirm', {
        method: 'POST',
        body: JSON.stringify({ code }),
    }),
    regenerateMfaRecoveryCodes: (code: any) => fetchJSON('/auth/me/mfa/recovery-codes/regenerate', {
        method: 'POST',
        body: JSON.stringify({ code }),
    }),
    disableMfa: (code: any) => fetchJSON('/auth/me/mfa/disable', { method: 'POST', body: JSON.stringify({ code }) }),
    resetUserMfa: (userId: any) => fetchJSON(`/auth/users/${encodeURIComponent(userId)}/mfa/reset`, {
        method: 'POST',
        body: JSON.stringify({}),
    }),
    inviteUser: (data: any) => fetchJSON('/auth/invites', { method: 'POST', body: JSON.stringify(data) }),
    // Support tickets — project-scoped queue, ordered by severity (server-side).
    // `status` is a comma-separated list of lifecycle states; omit for the
    // default open view. `type` optionally narrows to one request type.
    getSupportTickets: (projectId: any, status: any, type: any) => {
        const params = new URLSearchParams();
        if (status)
            params.set('status', status);
        if (type)
            params.set('type', type);
        const qs = params.toString() ? `?${params}` : '';
        return fetchJSON(`/projects/${projectId}/support-tickets${qs}`);
    },
    // Cross-project support overview for the org dashboard. Accepts either a
    // bare status string (legacy) or an options object; `unread: true` keeps
    // only tickets a human hasn't viewed yet (read_at IS NULL).
    getAllSupportTickets: (opts?: any) => {
        const { status, unread } = typeof opts === 'string' || opts == null ? { status: opts, unread: false } : opts;
        const params = new URLSearchParams();
        if (status)
            params.set('status', String(status));
        if (unread)
            params.set('unread', 'true');
        const qs = params.toString();
        return fetchJSON(`/support-tickets${qs ? `?${qs}` : ''}`);
    },
    getSupportTicket: (projectId: any, id: any) => fetchJSON(`/projects/${projectId}/support-tickets/${id}`),
    runSupportTicketInvestigation: (projectId: any, id: any, selection: any = {}) => fetchJSON(`/projects/${projectId}/support-tickets/${id}/investigate`, {
        method: 'POST',
        body: JSON.stringify(selection),
    }),
    // Change a ticket's lifecycle status. Pass `wontDoReason` (required by the
    // server) when status is 'wont_do'.
    setSupportTicketStatus: (projectId: any, id: any, status: any, wontDoReason: any) => fetchJSON(`/projects/${projectId}/support-tickets/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(wontDoReason === undefined ? { status } : { status, wontDoReason }),
    }),
    setSupportTicketType: (projectId: any, id: any, type: any) => fetchJSON(`/projects/${projectId}/support-tickets/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ type }),
    }),
    // Re-rate a ticket's severity (critical | high | medium | low). Reorders the
    // queue server-side.
    setSupportTicketSeverity: (projectId: any, id: any, severity: any) => fetchJSON(`/projects/${projectId}/support-tickets/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ severity }),
    }),
    // Promote a support ticket to a To Do kanban card. The source ticket is
    // RETAINED and flagged `converted`; re-converting 409s.
    convertSupportTicketToCard: (projectId: any, id: any, opts: any = {}) => {
        const body: Record<string, any> = {};
        if (typeof opts.autoMerge === 'boolean') body.autoMerge = opts.autoMerge;
        if (opts.comment != null && String(opts.comment).trim())
            body.comment = String(opts.comment).trim();
        return fetchJSON(`/projects/${projectId}/support-tickets/${id}/convert`, {
            method: 'POST',
            body: JSON.stringify(body),
        });
    },
    // Link a support ticket to an EXISTING kanban card (the sibling of convert).
    // Stamps the ticket back-link + a comment on the target card, then flags the
    // ticket `converted` (retained, not deleted). 404 if the card isn't on the
    // board; 409 if the ticket is already converted or the card is already linked.
    linkSupportTicketToCard: (projectId: any, id: any, opts: any = {}) => {
        const body: Record<string, any> = { cardId: String(opts.cardId || '').trim() };
        if (opts.comment != null && String(opts.comment).trim())
            body.comment = String(opts.comment).trim();
        return fetchJSON(`/projects/${projectId}/support-tickets/${id}/link-card`, {
            method: 'POST',
            body: JSON.stringify(body),
        });
    },
    // Permanently delete a support ticket. The server emits a
    // support_ticket_deleted WebSocket event so open clients drop the row.
    deleteSupportTicket: (projectId: any, id: any) => fetchJSON(`/projects/${projectId}/support-tickets/${id}`, { method: 'DELETE' }),
    // Unread ticket count (read_at NULL) — drives the Support drawer badge.
    getSupportUnreadCount: (projectId: any) => fetchJSON(`/projects/${projectId}/support-tickets/unread-count`),
    // Mark a single ticket read / unread; each emits support_ticket_updated.
    markSupportTicketRead: (projectId: any, id: any) => fetchJSON(`/projects/${projectId}/support-tickets/${id}/read`, { method: 'POST' }),
    markSupportTicketUnread: (projectId: any, id: any) => fetchJSON(`/projects/${projectId}/support-tickets/${id}/unread`, { method: 'POST' }),
    // Mark every unread ticket in the project read; emits support_tickets_read_all.
    markAllSupportTicketsRead: (projectId: any) => fetchJSON(`/projects/${projectId}/support-tickets/read-all`, { method: 'POST' }),
    // Security audit — Dependabot-style dependency findings for a Hub-hosted repo.
    // `status` optionally narrows to one lifecycle state (open | fixed |
    // dismissed); omit for all. Returns { findings, openCounts } where openCounts
    // is the per-severity tally of OPEN findings that drives the Security badge.
    getSecurityFindings: (projectId: any, status: any) => {
        const qs = status ? `?status=${encodeURIComponent(status)}` : '';
        return fetchJSON(`/projects/${projectId}/security-audit/findings${qs}`);
    },
    // Run a dependency security scan now. Admin-only, Hub-hosted projects only.
    // Pass { autoPr: true } (the "Autofix" action) to also dispatch an agent
    // session that resolves the fixable findings, regardless of the project's
    // securityAutoPr.enabled setting. Returns the scan summary (incl. fixSession).
    runSecurityScan: (projectId: any, { autoPr }: any = {}) =>
        fetchJSON(`/projects/${projectId}/security-audit/scan`, {
            method: 'POST',
            body: JSON.stringify(autoPr ? { autoPr: true } : {}),
        }),
    // Dispatch an agent session to resolve the project's open findings (bump +
    // re-resolve lockfile + tests; Finalize opens the PR). Admin-only, Hub-hosted
    // projects only. Returns { sessionId, agentId, findingCount, session }.
    fixSecurityFinding: (projectId: any, id: any) =>
        fetchJSON(`/projects/${projectId}/security-audit/findings/${id}/fix`, {
            method: 'POST',
        }),
    // Dispatch a session to resolve ALL open findings, optionally scoped to a
    // severity threshold. `minSeverity` is a threshold, not an exact match: 'high'
    // covers critical AND high. Omit it to resolve everything. Admin-only,
    // Hub-hosted projects only. Returns { sessionId, agentId, findingCount, session }.
    fixAllSecurityFindings: (projectId: any, { minSeverity }: any = {}) =>
        fetchJSON(`/projects/${projectId}/security-audit/fix`, {
            method: 'POST',
            body: JSON.stringify(minSeverity ? { minSeverity } : {}),
        }),
    // Dismiss (and, unless suppress:false, suppress on future re-scans) a finding.
    // Requires Admin server-side. Returns the updated finding.
    dismissSecurityFinding: (projectId: any, id: any, { reason, suppress }: any = {}) => fetchJSON(`/projects/${projectId}/security-audit/findings/${id}/dismiss`, {
        method: 'POST',
        body: JSON.stringify({
            ...(reason ? { reason } : {}),
            ...(suppress === false ? { suppress: false } : {}),
        }),
    }),
    // Threads (persistent output logs for crons)
    getThreads: (projectId: any, type: any) => {
        const qs = type ? `?type=${encodeURIComponent(type)}` : '';
        return fetchJSON(`/projects/${projectId}/threads${qs}`);
    },
    getThread: (threadId: any) => fetchJSON(`/threads/${threadId}`),
    getThreadEntries: (threadId: any) => fetchJSON(`/threads/${threadId}/entries`),
    // Human-authored entry — used by the ThreadView composer on mobile.
    // The server stamps role='user' and author_user_id from req.authUserId.
    postThreadEntry: (threadId: any, content: any) => fetchJSON(`/threads/${threadId}/entries`, {
        method: 'POST',
        body: JSON.stringify({ content }),
    }),
    // Forward a single thread entry to an agent — creates a new session for
    // the target agent seeded with that one entry's content.
    forwardThreadEntry: (threadId: any, entryId: any, { targetAgentId, prompt, autoStart }: any = {}) => fetchJSON(`/threads/${threadId}/entries/${entryId}/forward`, {
        method: 'POST',
        body: JSON.stringify({
            targetAgentId,
            ...(prompt ? { prompt } : {}),
            ...(autoStart != null ? { autoStart: !!autoStart } : {}),
        }),
    }),
    // Push notification device tokens (Expo)
    registerDeviceToken: (token: any, platform: any) => fetchJSON('/devices', {
        method: 'POST',
        body: JSON.stringify({ token, platform }),
    }),
    unregisterDeviceToken: (token: any) => fetchJSON(`/devices/${encodeURIComponent(token)}`, { method: 'DELETE' }),
    getDeviceTokenPreferences: (token: any) => fetchJSON(`/devices/${encodeURIComponent(token)}`),
    setDeviceTokenPreferences: (token: any, enabledEvents: any) => fetchJSON(`/devices/${encodeURIComponent(token)}/preferences`, {
        method: 'PUT',
        body: JSON.stringify({ enabledEvents }),
    }),
    // Wiki
    getWikiPages: (projectId: any) => fetchJSON(`/projects/${projectId}/wiki`),
    getWikiPage: (projectId: any, slug: any) => fetchJSON(`/projects/${projectId}/wiki/${slug}`),
    searchWiki: (projectId: any, query: any) => fetchJSON(`/projects/${projectId}/wiki?q=${encodeURIComponent(query)}`),
    getWikiPagesByCategory: (projectId: any, category: any) => fetchJSON(`/projects/${projectId}/wiki?category=${encodeURIComponent(category)}`),
    createWikiPage: (projectId: any, data: any) => fetchJSON(`/projects/${projectId}/wiki`, { method: 'POST', body: JSON.stringify(data) }),
    updateWikiPage: (projectId: any, slug: any, data: any) => fetchJSON(`/projects/${projectId}/wiki/${slug}`, { method: 'PUT', body: JSON.stringify(data) }),
    deleteWikiPage: (projectId: any, slug: any) => fetchJSON(`/projects/${projectId}/wiki/${slug}`, { method: 'DELETE' }),
};
