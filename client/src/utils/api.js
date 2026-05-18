import { getApiBase, getAuthHeaders } from './connection.js';
import { getToken as getJwt, clearToken } from './auth.js';

async function fetchJSON(url, options = {}) {
  const base = getApiBase();
  const authHeaders = getAuthHeaders();
  const { timeout: timeoutOption, ...fetchOpts } = options;
  const timeoutMs =
    timeoutOption === null ? null : !timeoutOption || timeoutOption <= 0 ? 15000 : timeoutOption;
  const res = await fetch(`${base}${url}`, {
    ...fetchOpts,
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders,
      ...fetchOpts.headers,
    },
    signal: fetchOpts.signal || (timeoutMs === null ? undefined : AbortSignal.timeout(timeoutMs)),
  });
  if (!res.ok) {
    // If a JWT-authenticated request is rejected, the token is stale — drop
    // it and reload so <AuthGate /> can send the user back to the login
    // screen. We deliberately don't do this for apiKey-only setups.
    if (res.status === 401 && getJwt()) {
      clearToken();
      if (typeof window !== 'undefined') window.location.reload();
    }
    let detail = '';
    try {
      const body = await res.json();
      detail = body.error || body.message || JSON.stringify(body);
    } catch {
      /* response wasn't JSON */
    }
    throw new Error(detail ? `${res.status}: ${detail}` : `API error: ${res.status}`);
  }
  return res.json();
}

export const api = {
  // Projects
  getProjects: () => fetchJSON('/projects'),
  getProject: (projectId) => fetchJSON(`/projects/${projectId}`),
  createProject: (data) => fetchJSON('/projects', { method: 'POST', body: JSON.stringify(data) }),
  updateProject: (projectId, data) =>
    fetchJSON(`/projects/${projectId}`, { method: 'PATCH', body: JSON.stringify(data) }),
  // Persist the sidebar project order. `projectIds` must be a permutation
  // of the caller-visible project ids (see PUT /api/projects/order). The
  // server broadcasts `projects_updated` so other open clients refresh.
  reorderProjects: (projectIds) =>
    fetchJSON('/projects/order', {
      method: 'PUT',
      body: JSON.stringify({ projectIds }),
    }),
  // Re-detect preview defaults by sniffing the project's checkout. Pure
  // read — server does not mutate `projects.json`. Returns
  // `{ detected: { stack, startScript, port, captureRoutes, idleTTL } | null }`.
  detectProjectPreview: (projectId) =>
    fetchJSON(`/projects/${projectId}/preview/detect`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  // One-shot preview validator. Spawns the configured startScript against
  // the project's cwd, polls healthPath for 2xx with a 30s deadline, snaps
  // a screenshot, and tears down. Returns
  // `{ ok, ports: { allocated }, durationMs, screenshotUrl?, error? }`.
  // The server's own deadline is 30s health-check + ~3s grace. We set a
  // defensive 60s client-side ceiling so a hung server (network partition,
  // frozen Node process) surfaces as a recoverable AbortError in the UI
  // instead of spinning the Test button forever.
  testProjectPreview: (projectId) =>
    fetchJSON(`/projects/${projectId}/preview/test`, {
      method: 'POST',
      body: JSON.stringify({}),
      timeout: 60_000,
    }),
  // Spawn the AI-assisted preview setup wizard. Server returns
  // `{ sessionId, agentId, session }` — the client attaches to the
  // standard chat panel (`useSessionStream(sessionId)`) so the UX is
  // identical to any other agent session. Admin+.
  startPreviewWizard: (projectId) =>
    fetchJSON(`/projects/${projectId}/preview/setup-wizard`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  deleteProject: (projectId) =>
    fetch(`${getApiBase()}/projects/${projectId}`, {
      method: 'DELETE',
      headers: { ...getAuthHeaders() },
    }).then((res) => {
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      return null;
    }),
  // Hub workflows (manual runs — MVP)
  getProjectWorkflows: (projectId) => fetchJSON(`/projects/${projectId}/workflows`),
  getProjectWorkflow: (projectId, workflowId) =>
    fetchJSON(`/projects/${projectId}/workflows/${workflowId}`),
  startWorkflowRun: (projectId, workflowId, runPayload) =>
    fetchJSON(`/projects/${projectId}/workflows/${workflowId}/runs`, {
      method: 'POST',
      body: JSON.stringify(runPayload === undefined ? {} : { payload: runPayload }),
      timeout: null,
    }),
  getWorkflowRuns: (projectId, workflowId, { limit } = {}) => {
    const q = limit != null ? `?limit=${encodeURIComponent(String(limit))}` : '';
    return fetchJSON(`/projects/${projectId}/workflows/${workflowId}/runs${q}`);
  },
  getWorkflowRunDetail: (projectId, workflowId, runId) =>
    fetchJSON(`/projects/${projectId}/workflows/${workflowId}/runs/${runId}`),
  cancelWorkflowRun: (projectId, workflowId, runId) =>
    fetchJSON(`/projects/${projectId}/workflows/${workflowId}/runs/${runId}/cancel`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  createProjectWorkflow: (projectId, body) =>
    fetchJSON(`/projects/${projectId}/workflows`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updateProjectWorkflow: (projectId, workflowId, body) =>
    fetchJSON(`/projects/${projectId}/workflows/${workflowId}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  rotateWorkflowWebhookSecret: (projectId, workflowId) =>
    fetchJSON(`/projects/${projectId}/workflows/${workflowId}/webhook/rotate`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),

  // Agents & Sessions
  getAgents: () => fetchJSON('/agents'),
  getSessions: (agentId) => fetchJSON(`/agents/${agentId}/sessions`),
  createSession: (agentId, name, { askMode } = {}) =>
    fetchJSON(`/agents/${agentId}/sessions`, {
      method: 'POST',
      body: JSON.stringify({ name, ask_mode: askMode || false }),
    }),
  getMessages: (sessionId) => fetchJSON(`/sessions/${sessionId}/messages`),
  getSessionHandoffs: (sessionId) => fetchJSON(`/sessions/${sessionId}/handoffs`),
  /**
   * Historical delegations for this session, ordered `started_at DESC`.
   * Hydrates `delegations[sessionId]` on session load so message-anchored
   * `<delegate>` cards in past assistant messages render their real terminal
   * status (done/error/cancelled) instead of the "Queued" placeholder.
   */
  getSessionDelegations: (sessionId) => fetchJSON(`/sessions/${sessionId}/delegations`),
  /** Session sidebar: linked kanban card, skills, aggregated run snapshot from message events. */
  getSessionSummary: (sessionId) => fetchJSON(`/sessions/${sessionId}/summary`),
  getSessionSkillInvocations: (sessionId) => fetchJSON(`/sessions/${sessionId}/skill-invocations`),
  summarizeSession: (sessionId) =>
    fetchJSON(`/sessions/${sessionId}/summarize`, { method: 'POST', timeout: 120000 }),
  getMessageEvents: (messageId) => fetchJSON(`/messages/${messageId}/events`),
  getSessionProgress: (sessionId) => fetchJSON(`/sessions/${sessionId}/progress`),
  deleteSession: (sessionId) => fetchJSON(`/sessions/${sessionId}`, { method: 'DELETE' }),
  // Soft-delete recovery — rows within the 24-hour window, newest first.
  getArchivedSessions: (agentId) => fetchJSON(`/agents/${agentId}/archived-sessions`),
  restoreSession: (sessionId) => fetchJSON(`/sessions/${sessionId}/restore`, { method: 'POST' }),
  clearAllSessions: (agentId) => fetchJSON(`/agents/${agentId}/sessions`, { method: 'DELETE' }),
  clearInactiveSessions: (agentId) =>
    fetchJSON(`/agents/${agentId}/sessions/inactive`, { method: 'DELETE' }),
  renameSession: (sessionId, name) =>
    fetchJSON(`/sessions/${sessionId}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    }),
  setSessionEngine: (sessionId, engine) =>
    fetchJSON(`/sessions/${sessionId}/engine`, {
      method: 'PUT',
      body: JSON.stringify({ engine }),
    }),
  setSessionModel: (sessionId, model) =>
    fetchJSON(`/sessions/${sessionId}/model`, {
      method: 'PUT',
      body: JSON.stringify({ model }),
    }),
  // `setSessionWorktree` was removed when Agent Hub locked to
  // worktree-only sessions. The legacy `PUT /sessions/:id/worktree`
  // endpoint no longer exists.

  // No client fetch timeout: commit/push/gh + hooks can exceed a minute while
  // the server streams progress over the WebSocket; aborting early produced
  // false "timed out" errors even when the PR succeeded.
  createPrFromSession: (sessionId, { autoMerge = false, title } = {}) =>
    fetchJSON(`/sessions/${sessionId}/create-pr`, {
      method: 'POST',
      body: JSON.stringify({ autoMerge, title }),
      timeout: null,
    }),
  setSessionAskMode: (sessionId, enabled) =>
    fetchJSON(`/sessions/${sessionId}/ask-mode`, {
      method: 'PUT',
      body: JSON.stringify({ enabled }),
    }),
  /** Outer PAV — partial updates: pass only keys you want to change; null clears. */
  setSessionOrchestration: (sessionId, body) =>
    fetchJSON(`/sessions/${sessionId}/orchestration`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  forwardSession: (sessionId, { targetAgentId, messageIds, prompt, autoStart } = {}) =>
    fetchJSON(`/sessions/${sessionId}/forward`, {
      method: 'POST',
      body: JSON.stringify({
        targetAgentId,
        ...(messageIds ? { messageIds } : {}),
        ...(prompt ? { prompt } : {}),
        ...(autoStart != null ? { autoStart: !!autoStart } : {}),
      }),
      timeout: 30000,
    }),

  updateAgent: (agentId, data) =>
    fetchJSON(`/agents/${agentId}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  createAgent: (data) =>
    fetchJSON('/agents', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  bulkSetAllAgentsEngine: ({ engine, model }) =>
    fetchJSON('/agents/bulk-engine', {
      method: 'POST',
      body: JSON.stringify({ engine, ...(model ? { model } : {}) }),
    }),
  deleteAgent: (agentId) =>
    fetch(`${getApiBase()}/agents/${agentId}`, {
      method: 'DELETE',
      headers: { ...getAuthHeaders() },
    }).then((res) => {
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      return null;
    }),

  // MCP Servers
  getMcpServers: (agentId) => fetchJSON(`/agents/${agentId}/mcp-servers`),
  updateMcpServers: (agentId, mcpServers) =>
    fetchJSON(`/agents/${agentId}/mcp-servers`, {
      method: 'PUT',
      body: JSON.stringify({ mcpServers }),
    }),
  updateMcpServer: (agentId, serverName, config) =>
    fetchJSON(`/agents/${agentId}/mcp-servers/${encodeURIComponent(serverName)}`, {
      method: 'PUT',
      body: JSON.stringify(config),
    }),
  deleteMcpServer: (agentId, serverName) =>
    fetchJSON(`/agents/${agentId}/mcp-servers/${encodeURIComponent(serverName)}`, {
      method: 'DELETE',
    }),

  // Heartbeats
  getHeartbeats: () => fetchJSON('/heartbeats'),
  getHeartbeatLogs: (agentId, limit = 50) =>
    fetchJSON(`/heartbeats/${agentId}/logs?limit=${limit}`),
  updateHeartbeat: (agentId, config) =>
    fetchJSON(`/heartbeats/${agentId}`, {
      method: 'PUT',
      body: JSON.stringify(config),
    }),
  runHeartbeat: (agentId) =>
    fetchJSON(`/heartbeats/${agentId}/run`, { method: 'POST', timeout: 120000 }),

  // Cron Sessions
  getCronSessions: () => fetchJSON('/sessions/cron'),

  // Crons
  getCrons: () => fetchJSON('/crons'),
  getCronLogs: (id, limit = 3) => fetchJSON(`/crons/${id}/logs?limit=${limit}`),
  createCron: (data) => fetchJSON('/crons', { method: 'POST', body: JSON.stringify(data) }),
  updateCron: (id, data) =>
    fetchJSON(`/crons/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteCron: (id) => fetchJSON(`/crons/${id}`, { method: 'DELETE' }),
  runCron: (id) => fetchJSON(`/crons/${id}/run`, { method: 'POST', timeout: 120000 }),

  // Rooms
  getRooms: () => fetchJSON('/rooms'),
  getRoom: (id) => fetchJSON(`/rooms/${id}`),
  createRoom: (name) => fetchJSON('/rooms', { method: 'POST', body: JSON.stringify({ name }) }),
  deleteRoom: (id) => fetchJSON(`/rooms/${id}`, { method: 'DELETE' }),
  renameRoom: (id, name) =>
    fetchJSON(`/rooms/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) }),
  updateRoom: (id, data) =>
    fetchJSON(`/rooms/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  addRoomAgent: (roomId, agentId) =>
    fetchJSON(`/rooms/${roomId}/agents`, { method: 'POST', body: JSON.stringify({ agentId }) }),
  removeRoomAgent: (roomId, agentId) =>
    fetchJSON(`/rooms/${roomId}/agents/${agentId}`, { method: 'DELETE' }),
  getRoomMessages: (roomId) => fetchJSON(`/rooms/${roomId}/messages`),
  summarizeRoom: (roomId) =>
    fetchJSON(`/rooms/${roomId}/summarize`, { method: 'POST', timeout: 120000 }),
  getProjectRoom: (projectId) => fetchJSON(`/projects/${projectId}/room`),

  // Designs (Claude Design — Phase 1)
  getDesigns: () => fetchJSON('/designs'),
  getDesign: (id) => fetchJSON(`/designs/${id}`),
  createDesign: ({ name, linkedProjectIds = [] } = {}) =>
    fetchJSON('/designs', {
      method: 'POST',
      body: JSON.stringify({ name, linkedProjectIds }),
    }),
  updateDesign: (id, data) =>
    fetchJSON(`/designs/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteDesign: (id) => fetchJSON(`/designs/${id}`, { method: 'DELETE' }),
  getDesignMessages: (id) => fetchJSON(`/designs/${id}/messages`),
  getDesignStatus: (id) => fetchJSON(`/designs/${id}/status`),
  forwardDesign: (
    id,
    {
      targetAgentId,
      prompt,
      autoStart,
      includeMessages = true,
      includeFiles = true,
      messageCount,
    } = {},
  ) =>
    fetchJSON(`/designs/${id}/forward`, {
      method: 'POST',
      body: JSON.stringify({
        targetAgentId,
        ...(prompt ? { prompt } : {}),
        ...(autoStart != null ? { autoStart: !!autoStart } : {}),
        includeMessages: includeMessages !== false,
        includeFiles: includeFiles !== false,
        ...(Number.isFinite(messageCount) ? { messageCount } : {}),
      }),
      timeout: 30000,
    }),

  // Usage
  getUsage: () => fetchJSON('/usage'),

  // Skills & Context
  getSkills: (agentId) => fetchJSON(`/agents/${agentId}/skills`),
  getSkill: (agentId, skillId) => fetchJSON(`/agents/${agentId}/skills/${skillId}`),
  getContext: (agentId) => fetchJSON(`/agents/${agentId}/context`),
  saveContext: (agentId, filename, content) =>
    fetchJSON(`/agents/${agentId}/context/${filename}`, {
      method: 'PUT',
      body: JSON.stringify({ content }),
    }),

  // Skill Registry / Marketplace
  getRegistry: (category, q) => {
    const params = new URLSearchParams();
    if (category) params.set('category', category);
    if (q) params.set('q', q);
    const qs = params.toString();
    return fetchJSON(`/skills/registry${qs ? '?' + qs : ''}`);
  },
  getRegistrySkill: (id) => fetchJSON(`/skills/registry/${id}`),
  addToRegistry: (data) =>
    fetchJSON('/skills/registry', { method: 'POST', body: JSON.stringify(data) }),
  removeFromRegistry: (id) => fetchJSON(`/skills/registry/${id}`, { method: 'DELETE' }),
  installSkill: (projectId, skillId) =>
    fetchJSON(`/projects/${projectId}/skills/install`, {
      method: 'POST',
      body: JSON.stringify({ skillId }),
    }),
  uninstallSkill: (projectId, skillId) =>
    fetchJSON(`/projects/${projectId}/skills/${skillId}`, { method: 'DELETE' }),
  importGithubSkill: (url) =>
    fetchJSON('/skills/import-github', { method: 'POST', body: JSON.stringify({ url }) }),
  toggleSkill: (agentId, skillId, enabled) =>
    fetchJSON(`/agents/${agentId}/skills/${skillId}/toggle`, {
      method: 'PUT',
      body: JSON.stringify({ enabled }),
    }),
  getSkillOverrides: (agentId) => fetchJSON(`/agents/${agentId}/skills/overrides`),

  // ClawHub Registry (proxied via /api/clawhub/*)
  clawhubSearch: (q, limit) => {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (limit) params.set('limit', String(limit));
    const qs = params.toString();
    return fetchJSON(`/clawhub/search${qs ? '?' + qs : ''}`);
  },
  clawhubListSkills: (limit) => {
    const qs = limit ? `?limit=${encodeURIComponent(limit)}` : '';
    return fetchJSON(`/clawhub/skills${qs}`);
  },
  clawhubGetSkill: (slug) => fetchJSON(`/clawhub/skills/${encodeURIComponent(slug)}`),
  clawhubGetVersions: (slug) => fetchJSON(`/clawhub/skills/${encodeURIComponent(slug)}/versions`),
  clawhubInstall: async ({ slug, version, target, agentId }) => {
    // We bypass fetchJSON here so the `stderrTail` field from a 500
    // response can be surfaced on the thrown error (fetchJSON would
    // strip it).
    const base = getApiBase();
    const headers = {
      'Content-Type': 'application/json',
      ...getAuthHeaders(),
    };
    const res = await fetch(`${base}/clawhub/install`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ slug, version, target, agentId }),
      signal: AbortSignal.timeout(120000),
    });
    let body = null;
    try {
      body = await res.json();
    } catch {
      /* non-JSON */
    }
    if (!res.ok) {
      const message = body?.error || body?.message || `API error: ${res.status}`;
      const err = new Error(`${res.status}: ${message}`);
      if (body?.stderrTail) err.stderrTail = body.stderrTail;
      err.status = res.status;
      throw err;
    }
    return body;
  },

  // Plugin packaging
  getPluginInfo: () => fetchJSON('/skills/plugin-info'),
  exportPlugin: (data) =>
    fetchJSON('/skills/export-plugin', { method: 'POST', body: JSON.stringify(data) }),

  // Upload
  uploadImage: (dataUrl, filename) =>
    fetchJSON('/upload', {
      method: 'POST',
      body: JSON.stringify({ dataUrl, filename }),
    }),

  // Binary file upload (for videos and large files — avoids base64 overhead)
  uploadFile: async (file) => {
    const { getApiBase } = await import('./connection.js');
    const base = getApiBase();
    const resp = await fetch(`${base}/upload/file`, {
      method: 'POST',
      headers: {
        'Content-Type': file.type || 'application/octet-stream',
        'X-Filename': file.name || 'upload',
      },
      body: file,
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: resp.statusText }));
      throw new Error(err.error || resp.statusText);
    }
    return resp.json();
  },

  // Slack
  getSlackStatus: () => fetchJSON('/slack/status'),
  restartSlack: () => fetchJSON('/slack/restart', { method: 'POST' }),
  getSlackMessages: (agentId, limit = 50) =>
    fetchJSON(`/slack/messages?${agentId ? `agentId=${agentId}&` : ''}limit=${limit}`),

  // Slack bot management
  listSlackBots: () => fetchJSON('/slack/bots'),
  createSlackBot: (data) =>
    fetchJSON('/slack/bots', { method: 'POST', body: JSON.stringify(data) }),
  updateSlackBot: (id, data) =>
    fetchJSON(`/slack/bots/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteSlackBot: (id) => fetchJSON(`/slack/bots/${id}`, { method: 'DELETE' }),
  toggleSlackBot: (id) => fetchJSON(`/slack/bots/${id}/toggle`, { method: 'POST' }),
  testSlackBotConnection: (id, data) =>
    fetchJSON(`/slack/bots/${id}/test`, { method: 'POST', body: JSON.stringify(data || {}) }),
  testSlackTokens: (data) =>
    fetchJSON('/slack/test-tokens', { method: 'POST', body: JSON.stringify(data) }),

  // Setup
  getSetupStatus: () => fetchJSON('/setup/status'),
  configureSetup: (data) =>
    fetchJSON('/setup/configure', { method: 'POST', body: JSON.stringify(data) }),

  // Project onboarding
  analyzeProject: (cwd) =>
    fetchJSON('/projects/analyze', {
      method: 'POST',
      body: JSON.stringify({ cwd }),
      timeout: 300000,
    }),
  onboardProject: (data) =>
    fetchJSON('/projects/onboard', { method: 'POST', body: JSON.stringify(data), timeout: 60000 }),

  // Config settings
  getConfig: () => fetchJSON('/config'),
  updateConfig: (data) => fetchJSON('/config', { method: 'PATCH', body: JSON.stringify(data) }),
  getModelConfig: () => fetchJSON('/config/models'),

  // Claude Code Authentication
  getClaudeAuth: () => fetchJSON('/config/claude-auth'),
  logoutClaude: () => fetchJSON('/config/claude-auth', { method: 'DELETE' }),
  setClaudeApiKey: (apiKey) =>
    fetchJSON('/config/claude-auth/api-key', { method: 'POST', body: JSON.stringify({ apiKey }) }),
  setClaudeOAuthToken: (oauthToken) =>
    fetchJSON('/config/claude-auth/oauth-token', {
      method: 'POST',
      body: JSON.stringify({ oauthToken }),
    }),
  validateClaudeApiKey: (apiKey) =>
    fetchJSON('/config/claude-auth/validate-key', {
      method: 'POST',
      body: JSON.stringify({ apiKey }),
      timeout: 35000,
    }),

  // Per-user Claude credentials (each Hub user can attach their own
  // ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN — see PR #717). Distinct
  // from the host-wide `/config/claude-auth` surface above.
  getMyClaudeAuth: () => fetchJSON('/auth/me/claude-auth'),
  putMyClaudeAuth: (body) =>
    fetchJSON('/auth/me/claude-auth', { method: 'PUT', body: JSON.stringify(body) }),

  // Per-user Cursor / Gemini / Codex API keys. Each engine carries one
  // key (no OAuth/expiry round-trip), so the helpers share a uniform
  // shape: `{ apiKey: string | null }` on the wire. See PR #717 for the
  // matching Claude pattern and the per-user-cli-auth wiki page for
  // precedence rules.
  getMyCursorAuth: () => fetchJSON('/auth/me/cursor-auth'),
  putMyCursorAuth: (body) =>
    fetchJSON('/auth/me/cursor-auth', { method: 'PUT', body: JSON.stringify(body) }),
  getMyGeminiAuth: () => fetchJSON('/auth/me/gemini-auth'),
  putMyGeminiAuth: (body) =>
    fetchJSON('/auth/me/gemini-auth', { method: 'PUT', body: JSON.stringify(body) }),
  getMyCodexAuth: () => fetchJSON('/auth/me/codex-auth'),
  putMyCodexAuth: (body) =>
    fetchJSON('/auth/me/codex-auth', { method: 'PUT', body: JSON.stringify(body) }),

  getMyEngineDefaultModels: () => fetchJSON('/auth/me/engine-default-models'),
  putMyEngineDefaultModels: (body) =>
    fetchJSON('/auth/me/engine-default-models', {
      method: 'PUT',
      body: JSON.stringify(body),
    }),

  getMyAgentEngineOverrides: () => fetchJSON('/auth/me/agent-engine-overrides'),
  putMyAgentEngineOverrides: (body) =>
    fetchJSON('/auth/me/agent-engine-overrides', {
      method: 'PUT',
      body: JSON.stringify(body),
    }),

  getSkillCredentials: (skillId) =>
    fetchJSON(
      `/auth/me/skill-credentials${skillId ? `?skillId=${encodeURIComponent(skillId)}` : ''}`,
    ),
  putSkillCredential: (body) =>
    fetchJSON('/auth/me/skill-credentials', { method: 'PUT', body: JSON.stringify(body) }),
  deleteSkillCredential: (id) =>
    fetchJSON(`/auth/me/skill-credentials/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  // Gemini CLI Authentication
  getGeminiAuth: () => fetchJSON('/config/gemini-auth'),
  setGeminiApiKey: (apiKey) =>
    fetchJSON('/config/gemini-auth/api-key', { method: 'POST', body: JSON.stringify({ apiKey }) }),
  validateGeminiApiKey: (apiKey) =>
    fetchJSON('/config/gemini-auth/validate-key', {
      method: 'POST',
      body: JSON.stringify({ apiKey }),
      timeout: 35000,
    }),
  logoutGemini: () => fetchJSON('/config/gemini-auth', { method: 'DELETE' }),

  // Codex CLI Authentication — mirrors the Gemini/Claude shape. Backend is
  // server/routes/codex-auth.ts; CODEX_API_KEY / OPENAI_API_KEY are both
  // accepted. validate-key issues a real `codex exec --json` turn so the
  // timeout needs to exceed the Responses API warm-up (~30s).
  getCodexAuth: () => fetchJSON('/config/codex-auth'),
  setCodexApiKey: (apiKey) =>
    fetchJSON('/config/codex-auth/api-key', { method: 'POST', body: JSON.stringify({ apiKey }) }),
  validateCodexApiKey: (apiKey) =>
    fetchJSON('/config/codex-auth/validate-key', {
      method: 'POST',
      body: JSON.stringify({ apiKey }),
      timeout: 35000,
    }),
  logoutCodex: () => fetchJSON('/config/codex-auth', { method: 'DELETE' }),
  getCursorAuth: () => fetchJSON('/config/cursor-auth'),
  startCursorLogin: () =>
    fetchJSON('/config/cursor-auth/login', {
      method: 'POST',
      body: JSON.stringify({}),
      timeout: 22000,
    }),
  cancelCursorLogin: () => fetchJSON('/config/cursor-auth/cancel-login', { method: 'POST' }),
  logoutCursor: () => fetchJSON('/config/cursor-auth', { method: 'DELETE', timeout: 35000 }),
  startCodexDeviceLogin: () =>
    fetchJSON('/config/codex-auth/device-login', {
      method: 'POST',
      body: JSON.stringify({}),
      timeout: 50000,
    }),
  cancelCodexDeviceLogin: () => fetchJSON('/config/codex-auth/cancel-login', { method: 'POST' }),

  // Per-user "Sign in with browser" — same UX as the host-wide endpoints
  // above but pinned at a per-user HOME so each Hub user can sign in
  // under their own account (`server/routes/per-user-engine-auth.ts`).
  getMyCursorBrowserAuth: () => fetchJSON('/auth/me/cursor-auth/browser'),
  startMyCursorBrowserLogin: () =>
    fetchJSON('/auth/me/cursor-auth/browser/login', {
      method: 'POST',
      body: JSON.stringify({}),
      timeout: 22000,
    }),
  cancelMyCursorBrowserLogin: () =>
    fetchJSON('/auth/me/cursor-auth/browser/cancel-login', { method: 'POST' }),
  logoutMyCursorBrowser: () =>
    fetchJSON('/auth/me/cursor-auth/browser', { method: 'DELETE', timeout: 35000 }),
  getMyCodexBrowserAuth: () => fetchJSON('/auth/me/codex-auth/browser'),
  startMyCodexBrowserDeviceLogin: () =>
    fetchJSON('/auth/me/codex-auth/browser/device-login', {
      method: 'POST',
      body: JSON.stringify({}),
      timeout: 50000,
    }),
  cancelMyCodexBrowserDeviceLogin: () =>
    fetchJSON('/auth/me/codex-auth/browser/cancel-login', { method: 'POST' }),
  logoutMyCodexBrowser: () =>
    fetchJSON('/auth/me/codex-auth/browser', { method: 'DELETE', timeout: 65000 }),

  // Per-project export/import
  exportProject: (projectId) => fetchJSON(`/projects/${projectId}/export`),
  importProject: (projectId, data) =>
    fetchJSON(`/projects/${projectId}/import`, { method: 'POST', body: JSON.stringify(data) }),
  // Create-from-export: server materializes a brand-new project using the
  // export's project block and runs the same merge logic as importProject.
  importProjectAsNew: (data) =>
    fetchJSON('/projects/import', { method: 'POST', body: JSON.stringify(data) }),

  // Legacy full-instance export/import
  exportConfig: () => fetchJSON('/config/export'),
  importConfig: (data) =>
    fetchJSON('/config/import', { method: 'POST', body: JSON.stringify(data) }),

  // Instance backup — pick-and-zip migration export.
  getInstanceBackupManifest: () => fetchJSON('/instance-backup/manifest'),
  downloadInstanceBackup: async (items) => {
    const base = getApiBase();
    const res = await fetch(`${base}/instance-backup/bundle`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...getAuthHeaders(),
      },
      body: JSON.stringify({ items }),
    });
    if (!res.ok) {
      let detail = '';
      try {
        const body = await res.json();
        detail = body.error || body.message || JSON.stringify(body);
      } catch {
        /* not json */
      }
      throw new Error(detail ? `${res.status}: ${detail}` : `Backup failed: ${res.status}`);
    }
    const blob = await res.blob();
    const dispo = res.headers.get('content-disposition') || '';
    const m = /filename="([^"]+)"/.exec(dispo);
    const filename = m
      ? m[1]
      : `agent-hub-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`;
    return { blob, filename };
  },

  // Directory browsing (server-side)
  browse: (path) => fetchJSON(`/browse?path=${encodeURIComponent(path || '')}`),

  // Clone from GitHub
  cloneRepo: (url, targetDir) =>
    fetchJSON('/projects/clone', {
      method: 'POST',
      body: JSON.stringify({ url, targetDir }),
      timeout: 300000,
    }),

  // Kanban Board
  getBoard: (projectId) => fetchJSON(`/projects/${projectId}/board`),
  createCard: (projectId, data) =>
    fetchJSON(`/projects/${projectId}/board/cards`, { method: 'POST', body: JSON.stringify(data) }),
  updateCard: (projectId, cardId, data) =>
    fetchJSON(`/projects/${projectId}/board/cards/${cardId}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  moveCard: (projectId, cardId, data) =>
    fetchJSON(`/projects/${projectId}/board/cards/${cardId}/move`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  assignCard: (projectId, cardId, agentId, opts = {}) => {
    const body = { agentId };
    if (opts.model != null && String(opts.model).trim()) body.model = String(opts.model).trim();
    return fetchJSON(`/projects/${projectId}/board/cards/${cardId}/assign`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },
  unassignCard: (projectId, cardId) =>
    fetchJSON(`/projects/${projectId}/board/cards/${cardId}/unassign`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  deleteCard: (projectId, cardId) =>
    fetchJSON(`/projects/${projectId}/board/cards/${cardId}`, { method: 'DELETE' }),
  addCardBlocker: (projectId, cardId, blockedByCardId) =>
    fetchJSON(`/projects/${projectId}/board/cards/${cardId}/blockers`, {
      method: 'POST',
      body: JSON.stringify({ blockedByCardId }),
    }),
  removeCardBlocker: (projectId, cardId, blockedByCardId) =>
    fetchJSON(`/projects/${projectId}/board/cards/${cardId}/blockers/${blockedByCardId}`, {
      method: 'DELETE',
    }),
  getCardComments: (projectId, cardId) =>
    fetchJSON(`/projects/${projectId}/board/cards/${cardId}/comments`),
  addCardComment: (projectId, cardId, data) =>
    fetchJSON(`/projects/${projectId}/board/cards/${cardId}/comments`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  // Epics
  getEpics: (projectId) => fetchJSON(`/projects/${projectId}/board/epics`),
  createEpic: (projectId, data) =>
    fetchJSON(`/projects/${projectId}/board/epics`, { method: 'POST', body: JSON.stringify(data) }),
  updateEpic: (projectId, epicId, data) =>
    fetchJSON(`/projects/${projectId}/board/epics/${epicId}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  deleteEpic: (projectId, epicId) =>
    fetchJSON(`/projects/${projectId}/board/epics/${epicId}`, { method: 'DELETE' }),
  linkCardToEpic: (projectId, cardId, epicId) =>
    fetchJSON(`/projects/${projectId}/board/cards/${cardId}/epic`, {
      method: 'POST',
      body: JSON.stringify({ epicId }),
    }),

  // Webhooks
  getWebhooks: () => fetchJSON('/webhooks'),
  getProjectWebhooks: (projectId) => fetchJSON(`/webhooks/project/${projectId}`),
  createWebhook: (data) => fetchJSON('/webhooks', { method: 'POST', body: JSON.stringify(data) }),
  updateWebhook: (id, data) =>
    fetchJSON(`/webhooks/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteWebhook: (id) => fetchJSON(`/webhooks/${id}`, { method: 'DELETE' }),
  getWebhookLogs: (id, limit = 20) => fetchJSON(`/webhooks/${id}/logs?limit=${limit}`),
  registerWebhook: (id) => fetchJSON(`/webhooks/${id}/register`, { method: 'POST' }),
  unregisterWebhook: (id) => fetchJSON(`/webhooks/${id}/register`, { method: 'DELETE' }),
  getWebhookRegistration: (id) => fetchJSON(`/webhooks/${id}/register`),

  // Background tasks
  getTasks: (limit = 50) => fetchJSON(`/tasks?limit=${limit}`),
  getTask: (taskId) => fetchJSON(`/tasks/${taskId}`),
  createTask: (agentId, prompt) =>
    fetchJSON('/tasks', { method: 'POST', body: JSON.stringify({ agentId, prompt }) }),
  stopTask: (taskId) => fetchJSON(`/tasks/${taskId}/stop`, { method: 'POST' }),

  // Threads
  getThreads: (projectId, type) => {
    const qs = type ? `?type=${type}` : '';
    return fetchJSON(`/projects/${projectId}/threads${qs}`);
  },
  getThread: (threadId) => fetchJSON(`/threads/${threadId}`),
  getThreadEntries: (threadId) => fetchJSON(`/threads/${threadId}/entries`),
  // Human-authored entry — used by the ThreadView composer. The server
  // stamps `role='user'` and `author_user_id` from req.authUserId.
  postThreadEntry: (threadId, content) =>
    fetchJSON(`/threads/${threadId}/entries`, {
      method: 'POST',
      body: JSON.stringify({ content }),
    }),
  getCronThread: (cronId) => fetchJSON(`/crons/${cronId}/thread`),
  getHeartbeatThread: (agentId) => fetchJSON(`/heartbeats/${agentId}/thread`),

  // Notes
  getNotes: (projectId, query, limit) => {
    const params = new URLSearchParams();
    if (query) params.set('q', query);
    if (limit) params.set('limit', limit);
    const qs = params.toString();
    return fetchJSON(`/projects/${projectId}/notes${qs ? '?' + qs : ''}`);
  },
  getNote: (projectId, noteId) => fetchJSON(`/projects/${projectId}/notes/${noteId}`),
  createNote: (projectId, data) =>
    fetchJSON(`/projects/${projectId}/notes`, { method: 'POST', body: JSON.stringify(data) }),
  updateNote: (projectId, noteId, data) =>
    fetchJSON(`/projects/${projectId}/notes/${noteId}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  deleteNote: (projectId, noteId) =>
    fetchJSON(`/projects/${projectId}/notes/${noteId}`, { method: 'DELETE' }),
  processNote: (projectId, date, data) =>
    fetchJSON(`/projects/${projectId}/notes/${date}/process`, {
      method: 'POST',
      body: JSON.stringify(data),
      timeout: 30000,
    }),
  getNoteProcessings: (projectId, limit) =>
    fetchJSON(`/projects/${projectId}/notes/processings${limit ? '?limit=' + limit : ''}`),
  getNoteProcessingsByDate: (projectId, date) =>
    fetchJSON(`/projects/${projectId}/notes/${date}/processings`),

  // TOOL_ERROR aggregation (stub — Session Health epic will replace with a
  // richer dashboard). Greps daily notes for TOOL_ERROR lines and returns
  // structured JSON + count buckets.
  getToolErrors: (projectId, { since, limit } = {}) => {
    const params = new URLSearchParams();
    if (since) params.set('since', since);
    if (limit) params.set('limit', String(limit));
    const qs = params.toString();
    return fetchJSON(`/projects/${projectId}/tool-errors${qs ? '?' + qs : ''}`);
  },

  // Generic helpers (for endpoints without dedicated methods)
  get: (url) => fetchJSON(url),
  post: (url, data) =>
    fetchJSON(url, { method: 'POST', ...(data && { body: JSON.stringify(data) }) }),
  del: (url) =>
    fetch(`${getApiBase()}${url}`, { method: 'DELETE', headers: { ...getAuthHeaders() } }).then(
      (res) => {
        if (!res.ok) throw new Error(`API error: ${res.status}`);
        return res.json().catch(() => null);
      },
    ),

  // Server Logs
  getServerLogs: () => fetchJSON('/server-logs'),

  // Preview Containers
  getPreviewStatus: () => fetchJSON('/previews/status'),
  getProjectPreviews: (projectId) => fetchJSON(`/projects/${projectId}/previews`),
  createPreview: (projectId, data) =>
    fetchJSON(`/projects/${projectId}/previews`, {
      method: 'POST',
      body: JSON.stringify(data),
      timeout: 30000,
    }),
  stopPreview: (projectId, previewId) =>
    fetchJSON(`/projects/${projectId}/previews/${previewId}/stop`, {
      method: 'POST',
      timeout: 30000,
    }),
  rebuildPreview: (projectId, previewId) =>
    fetchJSON(`/projects/${projectId}/previews/${previewId}/rebuild`, {
      method: 'POST',
      timeout: 30000,
    }),
  getPreviewLogs: (projectId, previewId, tail = 200) =>
    fetchJSON(`/projects/${projectId}/previews/${previewId}/logs?tail=${tail}`),
  deletePreview: (projectId, previewId) =>
    fetchJSON(`/projects/${projectId}/previews/${previewId}`, { method: 'DELETE', timeout: 30000 }),

  // Preview Captures
  capturePreview: (projectId, previewId, { skipVideo } = {}) =>
    fetchJSON(`/projects/${projectId}/previews/${previewId}/capture`, {
      method: 'POST',
      body: JSON.stringify({ skipVideo }),
      timeout: 30000,
    }),
  getPreviewCaptures: (projectId, previewId) =>
    fetchJSON(`/projects/${projectId}/previews/${previewId}/captures`),

  // iOS Builds
  getIosBuildStatus: () => fetchJSON('/ios-builds/status'),
  getProjectIosBuilds: (projectId) => fetchJSON(`/projects/${projectId}/ios-builds`),
  createIosBuild: (projectId, data) =>
    fetchJSON(`/projects/${projectId}/ios-builds`, {
      method: 'POST',
      body: JSON.stringify(data),
      timeout: 30000,
    }),
  getIosBuild: (projectId, buildId) => fetchJSON(`/projects/${projectId}/ios-builds/${buildId}`),
  cancelIosBuild: (projectId, buildId) =>
    fetchJSON(`/projects/${projectId}/ios-builds/${buildId}/cancel`, {
      method: 'POST',
      timeout: 30000,
    }),
  getIosBuildLogs: (projectId, buildId) =>
    fetchJSON(`/projects/${projectId}/ios-builds/${buildId}/logs`),
  deleteIosBuild: (projectId, buildId) =>
    fetchJSON(`/projects/${projectId}/ios-builds/${buildId}`, {
      method: 'DELETE',
      timeout: 30000,
    }),
  getIosBuildArtifacts: (projectId, buildId) =>
    fetchJSON(`/projects/${projectId}/ios-builds/${buildId}/artifacts`),

  // Pull Requests (read-only viewer) — project-scoped
  getProjectPulls: (projectId, { state = 'open', limit = 30 } = {}) => {
    const params = new URLSearchParams();
    if (state) params.set('state', state);
    if (limit) params.set('limit', String(limit));
    const qs = params.toString();
    return fetchJSON(`/projects/${projectId}/pulls${qs ? '?' + qs : ''}`);
  },
  getProjectPullDetail: (projectId, number) => fetchJSON(`/projects/${projectId}/pulls/${number}`),
  resolvePR: (projectId, prNumber, { agentId } = {}) =>
    fetchJSON(`/projects/${projectId}/pulls/${prNumber}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ agentId }),
      timeout: 60000,
    }),
  /** Queue formal reviewer dispatch (same path as GitHub webhooks). */
  nudgePrReviewer: (projectId, prNumber) =>
    fetchJSON(`/projects/${projectId}/pulls/${prNumber}/nudge-reviewer`, {
      method: 'POST',
      body: JSON.stringify({}),
      timeout: 60000,
    }),

  // PR Actions
  mergePr: (prUrl, mergeMethod = 'squash') =>
    fetchJSON('/pr/merge', {
      method: 'POST',
      body: JSON.stringify({ prUrl, mergeMethod }),
      timeout: 60000,
    }),
  closePr: (prUrl) =>
    fetchJSON('/pr/close', {
      method: 'POST',
      body: JSON.stringify({ prUrl }),
      timeout: 30000,
    }),
  getPrStatus: (prUrl) => fetchJSON(`/pr/status?prUrl=${encodeURIComponent(prUrl)}`),

  // Container pool observability (W4)
  getPoolMetrics: (windowHours = 24) => fetchJSON(`/pool/metrics?windowHours=${windowHours}`),
  getPoolAlerts: (status = 'active') => fetchJSON(`/pool/alerts?status=${status}`),

  // MCP servers (per-user). Replaces the deleted Nango integration surface;
  // configured under Skills & Context → MCP (not Settings).
  // Distinct from the per-agent MCP methods above (`getMcpServers` etc.) —
  // those manage the agent's template under `/agents/:id/mcp-servers`; these
  // manage the authenticated user's personal connections under `/mcp-servers`.
  // Secrets round-trip masked (`••••••••`) so the UI can save partial edits
  // without re-typing values that haven't changed.
  getMcpCatalog: () => fetchJSON('/mcp-catalog'),
  listUserMcpServers: () => fetchJSON('/mcp-servers'),
  createUserMcpServer: (payload) =>
    fetchJSON('/mcp-servers', { method: 'POST', body: JSON.stringify(payload) }),
  updateUserMcpServer: (id, payload) =>
    fetchJSON(`/mcp-servers/${id}`, { method: 'PUT', body: JSON.stringify(payload) }),
  deleteUserMcpServer: (id) => fetchJSON(`/mcp-servers/${id}`, { method: 'DELETE' }),
};
