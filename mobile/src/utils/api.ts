import { getApiBaseUrl, getAuthHeaders } from './config';
import { buildNotesListUrl, buildNoteUrl } from './notesUrl';
import { uploadFile as uploadFileImpl } from './uploadFile';
import { transcribeAudio as transcribeAudioImpl } from './transcribeAudio';
import { getToken as getJwt, clearToken } from './auth';
import { normalizeSessionMessagesResponse } from './sessionMessagesResponse';
async function fetchJSON(url: any, options: any = {}) {
    const base = getApiBaseUrl();
    if (!base)
        throw new Error('No server configured');
    const authHeaders = getAuthHeaders();
    const res = await fetch(`${base}${url}`, {
        ...options,
        headers: { 'Content-Type': 'application/json', ...authHeaders, ...(options.headers || {}) },
    });
    // JWT expired / revoked — drop the cached token so the next bootstrap
    // surfaces the login screen. We don't force-reload here (no
    // `window.location.reload` on RN) — the app-level gate re-renders
    // when `needsAuth` flips on next `getAuthStatus` probe.
    if (res.status === 401 && getJwt()) {
        await clearToken().catch(() => { });
    }
    if (!res.ok) {
        let detail = '';
        try {
            const body = await res.json();
            detail = body.error || body.message || JSON.stringify(body);
        }
        catch {
            /* response wasn't JSON */
        }
        throw new Error(detail ? `${res.status}: ${detail}` : `API error: ${res.status}`);
    }
    return res.json();
}
export const api = {
    // Agents & Sessions
    getAgents: () => fetchJSON('/agents'),
    getSessions: (agentId: any) => fetchJSON(`/agents/${agentId}/sessions`),
    getSession: (sessionId: any) => fetchJSON(`/sessions/${sessionId}`),
    createSession: (agentId: any, name: any, options: any = {}) => fetchJSON(`/agents/${agentId}/sessions`, {
        method: 'POST',
        body: JSON.stringify({
            name,
            // `use_worktree` is no longer accepted on session creation —
            // Agent Hub is worktree-only for user-facing session flows.
            ...(options.askMode != null ? { ask_mode: !!options.askMode } : {}),
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
    updateProject: (projectId: any, data: any) => fetchJSON(`/projects/${projectId}`, { method: 'PATCH', body: JSON.stringify(data) }),
    // Per-user, project-scoped settings (e.g. default Finalize automation level).
    getProjectUserSettings: (projectId: any) => fetchJSON(`/projects/${projectId}/user-settings`),
    updateProjectUserSettings: (projectId: any, data: any) => fetchJSON(`/projects/${projectId}/user-settings`, {
        method: 'PUT',
        body: JSON.stringify(data),
    }),
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
    getCiRuns: (projectId: any, { trigger = 'all', limit = 30 }: any = {}) => fetchJSON(`/projects/${projectId}/ci-runs?trigger=${trigger}&limit=${limit}`),
    getCiRunDetail: (projectId: any, runId: any) => fetchJSON(`/projects/${projectId}/ci-runs/${runId}`),
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
    getGeminiAuth: () => fetchJSON('/config/gemini-auth'),
    setGeminiApiKey: (apiKey: any) => fetchJSON('/config/gemini-auth/api-key', { method: 'POST', body: JSON.stringify({ apiKey }) }),
    logoutGemini: () => fetchJSON('/config/gemini-auth', { method: 'DELETE' }),
    exportConfig: () => fetchJSON('/config/export'),
    importConfig: (data: any) => fetchJSON('/config/import', { method: 'POST', body: JSON.stringify(data) }),
    // Heartbeats
    getHeartbeats: () => fetchJSON('/heartbeats'),
    getHeartbeatLogs: (agentId: any, limit: any = 50) => fetchJSON(`/heartbeats/${agentId}/logs?limit=${limit}`),
    updateHeartbeat: (agentId: any, config: any) => fetchJSON(`/heartbeats/${agentId}`, {
        method: 'PUT',
        body: JSON.stringify(config),
    }),
    runHeartbeat: (agentId: any) => fetchJSON(`/heartbeats/${agentId}/run`, { method: 'POST' }),
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
    // Global (shared) skills — visible to every agent in every project.
    getGlobalSkills: () => fetchJSON(`/global-skills`),
    getGlobalSkill: (skillId: any) => fetchJSON(`/global-skills/${encodeURIComponent(skillId)}`),
    deleteGlobalSkill: (skillId: any) => fetchJSON(`/global-skills/${encodeURIComponent(skillId)}`, { method: 'DELETE' }),
    toggleSkill: (agentId: any, skillId: any, enabled: any) => fetchJSON(`/agents/${agentId}/skills/${skillId}/toggle`, {
        method: 'PUT',
        body: JSON.stringify({ enabled }),
    }),
    getSkillOverrides: (agentId: any) => fetchJSON(`/agents/${agentId}/skills/overrides`),
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
    // Per-user CLI credentials + GitHub connection (web Settings parity).
    getMyAuth: (provider: any) => fetchJSON(`/auth/me/${provider}-auth`),
    putMyAuth: (provider: any, data: any) => fetchJSON(`/auth/me/${provider}-auth`, { method: 'PUT', body: JSON.stringify(data) }),
    getGithubAuthStatus: () => fetchJSON('/auth/github/status'),
    disconnectGithub: () => fetchJSON('/auth/github', { method: 'DELETE' }),
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
    getLatestFinalizeRunForSession: (sessionId: any) => fetchJSON(`/sessions/${sessionId}/finalize-runs/latest`),
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
    scopeEpic: (projectId: any, epicId: any, data: { agentId?: string } = {}) => fetchJSON(`/projects/${projectId}/board/epics/${epicId}/scope`, {
        method: 'POST',
        body: JSON.stringify(data),
    }),
    linkCardToEpic: (projectId: any, cardId: any, epicId: any) => fetchJSON(`/projects/${projectId}/board/cards/${cardId}/epic`, {
        method: 'POST',
        body: JSON.stringify({ epicId }),
    }),
    getAutonomousEpic: (projectId: any) => fetchJSON(`/projects/${projectId}/board/autonomous`),
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
    getProjectPulls: (projectId: any, { state = 'open', limit = 30 }: any = {}) => {
        const params = new URLSearchParams();
        if (state)
            params.set('state', state);
        if (limit)
            params.set('limit', String(limit));
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
    // `data`: { event: 'APPROVE'|'REQUEST_CHANGES'|'COMMENT', body? }
    submitPullReview: (projectId: any, number: any, data: any) => fetchJSON(`/projects/${projectId}/pulls/${number}/reviews`, {
        method: 'POST',
        body: JSON.stringify(data),
    }),
    // `data`: { body, path?, line? } — path+line for inline file comments.
    addPullComment: (projectId: any, number: any, data: any) => fetchJSON(`/projects/${projectId}/pulls/${number}/comments`, {
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
    getServerLogs: () => fetchJSON('/server-logs'),
    getUsers: () => fetchJSON('/auth/users'),
    inviteUser: (data: any) => fetchJSON('/auth/invites', { method: 'POST', body: JSON.stringify(data) }),
    getMcpServers: (agentId: any) => fetchJSON(`/agents/${agentId}/mcp-servers`),
    updateMcpServers: (agentId: any, mcpServers: any) => fetchJSON(`/agents/${agentId}/mcp-servers`, {
        method: 'PUT',
        body: JSON.stringify({ mcpServers }),
    }),
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
    // Pass { autoPr: true } (the "Autofix" action) to also force-open
    // Dependabot-style bump PRs for fixable findings regardless of the project's
    // securityAutoPr.enabled setting. Returns the scan summary (incl. autoPr).
    runSecurityScan: (projectId: any, { autoPr }: any = {}) =>
        fetchJSON(`/projects/${projectId}/security-audit/scan`, {
            method: 'POST',
            body: JSON.stringify(autoPr ? { autoPr: true } : {}),
        }),
    // Open (or refresh) a Dependabot-style bump PR for a single finding. Admin-only,
    // Hub-hosted projects only. Bumps the finding's package to its fixed version in
    // one native PR. Returns { opened: [...], skipped: [...] }.
    fixSecurityFinding: (projectId: any, id: any) =>
        fetchJSON(`/projects/${projectId}/security-audit/findings/${id}/fix`, {
            method: 'POST',
        }),
    // Open (or refresh) the single rolling bump PR for ALL open fixable findings,
    // optionally scoped to a severity threshold. `minSeverity` is a threshold, not
    // an exact match: 'high' fixes critical AND high. Omit it to fix everything.
    // Admin-only, Hub-hosted projects only. Returns { opened: [...], skipped: [...] }.
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
    // Threads (persistent output logs for crons & heartbeats)
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
