import { getApiBaseUrl, getAuthHeaders } from './config';
import { buildNotesListUrl, buildNoteUrl } from './notesUrl';
import { uploadFile as uploadFileImpl } from './uploadFile';
import { getToken as getJwt, clearToken } from './auth';
import { normalizeSessionMessagesResponse } from './sessionMessagesResponse';

async function fetchJSON(url, options = {}) {
  const base = getApiBaseUrl();
  if (!base) throw new Error('No server configured');
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
    await clearToken().catch(() => {});
  }
  if (!res.ok) {
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
  // Agents & Sessions
  getAgents: () => fetchJSON('/agents'),
  getSessions: (agentId) => fetchJSON(`/agents/${agentId}/sessions`),
  createSession: (agentId, name, options = {}) =>
    fetchJSON(`/agents/${agentId}/sessions`, {
      method: 'POST',
      body: JSON.stringify({
        name,
        // `use_worktree` is no longer accepted on session creation —
        // Agent Hub is worktree-only for user-facing session flows.
        ...(options.askMode != null ? { ask_mode: !!options.askMode } : {}),
      }),
    }),
  getMessages: async (sessionId, opts = {}) => {
    const q = opts.limit != null ? `?limit=${encodeURIComponent(String(opts.limit))}` : '';
    const data = await fetchJSON(`/sessions/${sessionId}/messages${q}`);
    return normalizeSessionMessagesResponse(data).messages;
  },
  // Kick off an AI summary of the session transcript. The server spawns a
  // short-lived CLI invocation so this can take a while — callers should
  // surface a loading state. Returns `{ summary: string }`.
  summarizeSession: (sessionId) =>
    fetchJSON(`/sessions/${sessionId}/summarize`, { method: 'POST' }),
  deleteSession: (sessionId) => fetchJSON(`/sessions/${sessionId}`, { method: 'DELETE' }),
  // Soft-delete recovery — rows within the 7-day window, newest first.
  getArchivedSessions: (agentId) => fetchJSON(`/agents/${agentId}/archived-sessions`),
  restoreSession: (sessionId) =>
    fetchJSON(`/sessions/${sessionId}/restore`, { method: 'POST' }),
  clearAllSessions: (agentId) => fetchJSON(`/agents/${agentId}/sessions`, { method: 'DELETE' }),
  clearInactiveSessions: (agentId) =>
    fetchJSON(`/agents/${agentId}/sessions/inactive`, { method: 'DELETE' }),
  renameSession: (sessionId, name) =>
    fetchJSON(`/sessions/${sessionId}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    }),
  getSessionDetail: (sessionId) => fetchJSON(`/sessions/${sessionId}`),
  updateSession: (sessionId, data) =>
    fetchJSON(`/sessions/${sessionId}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  addSessionAgent: (sessionId, agentId) =>
    fetchJSON(`/sessions/${sessionId}/agents`, {
      method: 'POST',
      body: JSON.stringify({ agentId }),
    }),
  removeSessionAgent: (sessionId, agentId) =>
    fetchJSON(`/sessions/${sessionId}/agents/${agentId}`, { method: 'DELETE' }),
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
  // Toggle Ask Mode (read-only session). Server enforces this by spawning the
  // CLI with `--permission-mode plan` instead of `bypassPermissions`. Returns
  // the updated session row so callers can hydrate `ask_mode` in local state.
  setSessionAskMode: (sessionId, enabled) =>
    fetchJSON(`/sessions/${sessionId}/ask-mode`, {
      method: 'PUT',
      body: JSON.stringify({ enabled }),
    }),
  setSessionOrchestration: (sessionId, body) =>
    fetchJSON(`/sessions/${sessionId}/orchestration`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  // Forward the entire session transcript to a new session on another agent.
  // Mirrors the web client. Body: { targetAgentId, messageIds?, prompt?, autoStart? }
  // Returns { session, forwardedMessageId }.
  forwardSession: (sessionId, { targetAgentId, messageIds, prompt, autoStart } = {}) =>
    fetchJSON(`/sessions/${sessionId}/forward`, {
      method: 'POST',
      body: JSON.stringify({
        targetAgentId,
        ...(messageIds ? { messageIds } : {}),
        ...(prompt ? { prompt } : {}),
        ...(autoStart != null ? { autoStart: !!autoStart } : {}),
      }),
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
  deleteAgent: (agentId) => {
    const base = getApiBaseUrl();
    const authHeaders = getAuthHeaders();
    return fetch(`${base}/agents/${agentId}`, {
      method: 'DELETE',
      headers: { ...authHeaders },
    }).then((res) => {
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      return null;
    });
  },

  // Projects
  getProjects: () => fetchJSON('/projects'),
  updateProject: (projectId, data) =>
    fetchJSON(`/projects/${projectId}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteProject: (projectId) => fetchJSON(`/projects/${projectId}`, { method: 'DELETE' }),

  // Health (server version / git hash for the sidebar footer)
  getHealth: () => fetchJSON('/health'),

  // Usage
  getUsage: () => fetchJSON('/usage'),

  // Config
  getConfig: () => fetchJSON('/config'),
  getModelConfig: () => fetchJSON('/config/models'),
  updateConfig: (data) => fetchJSON('/config', { method: 'PATCH', body: JSON.stringify(data) }),
  getGeminiAuth: () => fetchJSON('/config/gemini-auth'),
  setGeminiApiKey: (apiKey) =>
    fetchJSON('/config/gemini-auth/api-key', { method: 'POST', body: JSON.stringify({ apiKey }) }),
  logoutGemini: () => fetchJSON('/config/gemini-auth', { method: 'DELETE' }),
  exportConfig: () => fetchJSON('/config/export'),
  importConfig: (data) =>
    fetchJSON('/config/import', { method: 'POST', body: JSON.stringify(data) }),

  // Heartbeats
  getHeartbeats: () => fetchJSON('/heartbeats'),
  getHeartbeatLogs: (agentId, limit = 50) =>
    fetchJSON(`/heartbeats/${agentId}/logs?limit=${limit}`),
  updateHeartbeat: (agentId, config) =>
    fetchJSON(`/heartbeats/${agentId}`, {
      method: 'PUT',
      body: JSON.stringify(config),
    }),
  runHeartbeat: (agentId) => fetchJSON(`/heartbeats/${agentId}/run`, { method: 'POST' }),

  // Crons
  getCrons: () => fetchJSON('/crons'),
  getCronLogs: (id, limit = 3) => fetchJSON(`/crons/${id}/logs?limit=${limit}`),
  createCron: (data) => fetchJSON('/crons', { method: 'POST', body: JSON.stringify(data) }),
  updateCron: (id, data) =>
    fetchJSON(`/crons/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteCron: (id) => fetchJSON(`/crons/${id}`, { method: 'DELETE' }),
  runCron: (id) => fetchJSON(`/crons/${id}/run`, { method: 'POST' }),

  // Skills & Context
  getSkills: (agentId) => fetchJSON(`/agents/${agentId}/skills`),
  getSkill: (agentId, skillId) => fetchJSON(`/agents/${agentId}/skills/${skillId}`),
  getContext: (agentId) => fetchJSON(`/agents/${agentId}/context`),
  saveContext: (agentId, filename, content) =>
    fetchJSON(`/agents/${agentId}/context/${filename}`, {
      method: 'PUT',
      body: JSON.stringify({ content }),
    }),

  uninstallSkill: (projectId, skillId) =>
    fetchJSON(`/projects/${projectId}/skills/${skillId}`, { method: 'DELETE' }),
  toggleSkill: (agentId, skillId, enabled) =>
    fetchJSON(`/agents/${agentId}/skills/${skillId}/toggle`, {
      method: 'PUT',
      body: JSON.stringify({ enabled }),
    }),
  getSkillOverrides: (agentId) => fetchJSON(`/agents/${agentId}/skills/overrides`),

  // Upload
  uploadImage: (dataUrl, filename) =>
    fetchJSON('/upload', {
      method: 'POST',
      body: JSON.stringify({ dataUrl, filename }),
    }),
  // Binary upload for videos and arbitrary files (web parity). `fileRef` is
  // `{ uri, name, type }` from expo-image-picker / expo-document-picker.
  uploadFile: (fileRef) => uploadFileImpl(fileRef),

  // Slack
  getSlackStatus: () => fetchJSON('/slack/status'),
  restartSlack: () => fetchJSON('/slack/restart', { method: 'POST' }),
  getSlackMessages: (agentId, limit = 50) =>
    fetchJSON(`/slack/messages?${agentId ? `agentId=${agentId}&` : ''}limit=${limit}`),
  // Slack bots — full CRUD (web parity). See server/routes/slack.ts.
  getSlackBots: () => fetchJSON('/slack/bots'),
  createSlackBot: (data) =>
    fetchJSON('/slack/bots', { method: 'POST', body: JSON.stringify(data) }),
  updateSlackBot: (id, data) =>
    fetchJSON(`/slack/bots/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteSlackBot: (id) => fetchJSON(`/slack/bots/${id}`, { method: 'DELETE' }),
  toggleSlackBot: (id) => fetchJSON(`/slack/bots/${id}/toggle`, { method: 'POST' }),
  testSlackBot: (id) => fetchJSON(`/slack/bots/${id}/test`, { method: 'POST' }),
  testSlackTokens: (data) =>
    fetchJSON('/slack/test-tokens', { method: 'POST', body: JSON.stringify(data) }),

  // Project secrets (Admin to read, Owner to write — server enforces roles).
  getProjectSecrets: (projectId) => fetchJSON(`/projects/${projectId}/secrets`),
  putProjectSecrets: (projectId, secrets) =>
    fetchJSON(`/projects/${projectId}/secrets`, {
      method: 'PUT',
      body: JSON.stringify({ secrets }),
    }),
  deleteProjectSecret: (projectId, key) =>
    fetchJSON(`/projects/${projectId}/secrets/${encodeURIComponent(key)}`, {
      method: 'DELETE',
    }),
  importProjectSecrets: (projectId, data) =>
    fetchJSON(`/projects/${projectId}/secrets/import`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  // Per-user CLI credentials + GitHub connection (web Settings parity).
  getMyAuth: (provider) => fetchJSON(`/auth/me/${provider}-auth`),
  putMyAuth: (provider, data) =>
    fetchJSON(`/auth/me/${provider}-auth`, { method: 'PUT', body: JSON.stringify(data) }),
  getGithubAuthStatus: () => fetchJSON('/auth/github/status'),
  disconnectGithub: () => fetchJSON('/auth/github', { method: 'DELETE' }),
  // Per-user engine/model overrides per agent.
  getMyAgentEngineOverrides: () => fetchJSON('/auth/me/agent-engine-overrides'),
  putMyAgentEngineOverride: (agentId, data) =>
    fetchJSON(`/auth/me/agent-engine-overrides/${agentId}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  deleteMyAgentEngineOverride: (agentId) =>
    fetchJSON(`/auth/me/agent-engine-overrides/${agentId}`, { method: 'DELETE' }),
  getMyAgentModelOverrides: () => fetchJSON('/auth/me/agent-model-overrides'),
  putMyAgentModelOverride: (agentId, data) =>
    fetchJSON(`/auth/me/agent-model-overrides/${agentId}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  deleteMyAgentModelOverride: (agentId) =>
    fetchJSON(`/auth/me/agent-model-overrides/${agentId}`, { method: 'DELETE' }),

  // Devices (push notifications)
  registerDevice: (token, platform = 'ios') =>
    fetchJSON('/devices', {
      method: 'POST',
      body: JSON.stringify({ token, platform }),
    }),

  // Cron sessions
  getCronSessions: () => fetchJSON('/sessions/cron'),

  shipSession: (sessionId) =>
    fetchJSON(`/sessions/${sessionId}/ship`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),

  // Finalize Code Changes — design doc: finalize-code-changes-architecture-v0
  // Returns the most-recent finalize_runs row for a session, or `{ run: null }`
  // when none exists yet. Used by the mobile FinalizeButton for both initial
  // load and (as a polling fallback) live-state tracking — there's no WS
  // bridge for `finalize_run_*` events on mobile yet.
  getLatestFinalizeRunForSession: (sessionId) =>
    fetchJSON(`/sessions/${sessionId}/finalize-runs/latest`),
  getSessionWorktreeChanges: (sessionId) =>
    fetchJSON(`/sessions/${sessionId}/worktree-changes`),
  // Kick off a finalize run for a card-linked session. Server returns the
  // run id + status (and a `reused` flag when the existing non-terminal row
  // was returned). Throws on 409 in_flight / 400 no_session etc.
  startFinalizeRun: (projectId, cardId) =>
    fetchJSON(`/projects/${projectId}/cards/${cardId}/finalize`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  startFinalizeRunForSession: (projectId, sessionId) =>
    fetchJSON(`/projects/${projectId}/sessions/${sessionId}/finalize`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  // Cancel an in-flight finalize run. v0 is "UI-only cancel" — the server
  // flips the DB row to `cancelled`; the orchestrator does not currently
  // honor an out-of-process cancel. Returns 200 `{ ok: true, status }`.
  cancelFinalizeRun: (projectId, runId) =>
    fetchJSON(`/projects/${projectId}/finalize/${runId}/cancel`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  // Push a finalized run's branch and open a PR (Push to Agent Hub / GitHub).
  // `force: true` pushes even when review + checks have not both passed.
  pushFinalizeRun: (projectId, runId, { force = false } = {}) =>
    fetchJSON(`/projects/${projectId}/finalize/${runId}/push`, {
      method: 'POST',
      body: JSON.stringify({ force }),
    }),
  // Reviewer findings for a finalize run. Returns
  // `{ threads: [...], reviewer_verdict: 'approved'|'changes_requested'|null }`.
  getReviewerThreads: (projectId, runId) =>
    fetchJSON(`/projects/${projectId}/finalize/${runId}/reviewer-threads`),
  // Finalize Code Changes — `.agent-hub/ci.yaml` setup wizard. Spawns a
  // guided chat session loaded with the `finalize-setup` skill. Returns
  // `{ sessionId, agentId, draft, session, target }`. Mirrors the web
  // client's `api.startFinalizeWizard`. Settings → Finalize on mobile is
  // the entry point; the wizard itself runs in the existing chat surface.
  startFinalizeWizard: (projectId) =>
    fetchJSON(`/projects/${projectId}/finalize/setup-wizard`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),

  // Message events (for session timeline)
  getMessageEvents: (messageId) => fetchJSON(`/messages/${messageId}/events`),

  // Delegations
  getDelegations: (messageId) => fetchJSON(`/delegations/${messageId}`),
  getSessionDelegations: (sessionId) => fetchJSON(`/sessions/${sessionId}/delegations`),

  // Handoffs — DB rows for <handoff> blocks emitted from this session.
  // Used by HandoffCard to resolve the target session id and render a
  // tappable "Open session" link + status pill (pending / delivered / failed).
  getSessionHandoffs: (sessionId) => fetchJSON(`/sessions/${sessionId}/handoffs`),

  // Queue
  getSessionQueue: (sessionId) => fetchJSON(`/sessions/${sessionId}/queue`),

  // Kanban Board
  getProjectBoard: (projectId) => fetchJSON(`/projects/${projectId}/board`),
  createKanbanCard: (projectId, data) =>
    fetchJSON(`/projects/${projectId}/board/cards`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }),
  updateKanbanCard: (projectId, cardId, data) =>
    fetchJSON(`/projects/${projectId}/board/cards/${cardId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }),
  moveKanbanCard: (projectId, cardId, data) =>
    fetchJSON(`/projects/${projectId}/board/cards/${cardId}/move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }),
  deleteKanbanCard: (projectId, cardId) =>
    fetchJSON(`/projects/${projectId}/board/cards/${cardId}`, { method: 'DELETE' }),
  addCardBlocker: (projectId, cardId, blockedByCardId) =>
    fetchJSON(`/projects/${projectId}/board/cards/${cardId}/blockers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blockedByCardId }),
    }),
  removeCardBlocker: (projectId, cardId, blockedByCardId) =>
    fetchJSON(`/projects/${projectId}/board/cards/${cardId}/blockers/${blockedByCardId}`, {
      method: 'DELETE',
    }),
  // Assign a kanban card to an agent. Server spawns a new session tied to the
  // card, moves the card into "In Progress", and returns `{ sessionId, ... }`.
  // Mirrors the web client's `api.assignCard`.
  assignCard: (projectId, cardId, agentId, opts = {}) => {
    const body = { agentId };
    if (opts.model != null && String(opts.model).trim()) body.model = String(opts.model).trim();
    if (opts.engine != null && String(opts.engine).trim())
      body.engine = String(opts.engine).trim();
    return fetchJSON(`/projects/${projectId}/board/cards/${cardId}/assign`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },
  getCardComments: (projectId, cardId) =>
    fetchJSON(`/projects/${projectId}/board/cards/${cardId}/comments`),
  addCardComment: (projectId, cardId, data) =>
    fetchJSON(`/projects/${projectId}/board/cards/${cardId}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }),

  // Epics
  getEpics: (projectId) => fetchJSON(`/projects/${projectId}/board/epics`),
  createEpic: (projectId, data) =>
    fetchJSON(`/projects/${projectId}/board/epics`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
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
  getAutonomousEpic: (projectId) => fetchJSON(`/projects/${projectId}/board/autonomous`),

  // Session insights — summary panel, skill invocations, worktree diffs.
  // `getSessionSummary` powers the session summary sheet (linked PR, agents,
  // skill usage); `getSessionChangesDiff` returns the unified diff for one
  // file in the session worktree (`file` is the repo-relative path from
  // `getSessionWorktreeChanges`).
  getSessionSummary: (sessionId) => fetchJSON(`/sessions/${sessionId}/summary`),
  getSessionSkillInvocations: (sessionId) =>
    fetchJSON(`/sessions/${sessionId}/skill-invocations`),
  getSessionChanges: (sessionId) => fetchJSON(`/sessions/${sessionId}/changes`),
  getSessionChangesDiff: (sessionId, file) =>
    fetchJSON(`/sessions/${sessionId}/changes/diff?file=${encodeURIComponent(file)}`),

  // Pull Requests (read-only viewer)
  getProjectPulls: (projectId, { state = 'open', limit = 30 } = {}) => {
    const params = new URLSearchParams();
    if (state) params.set('state', state);
    if (limit) params.set('limit', String(limit));
    const qs = params.toString();
    return fetchJSON(`/projects/${projectId}/pulls${qs ? '?' + qs : ''}`);
  },
  getProjectPullDetail: (projectId, number) => fetchJSON(`/projects/${projectId}/pulls/${number}`),
  // NOTE: `fetchJSON` on mobile doesn't implement a timeout (unlike the web
  // client). The server-side resolve spawn is fast to initiate (it returns
  // once the session is spawned, not once the agent finishes), so the default
  // React Native fetch timeout is adequate.
  resolvePR: (projectId, prNumber, { agentId } = {}) =>
    fetchJSON(`/projects/${projectId}/pulls/${prNumber}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ agentId }),
    }),
  // Pull Requests — write surface (web parity). Bodies mirror the web
  // client; see server/routes/pulls-native.ts for the contracts.
  createPull: (projectId, data) =>
    fetchJSON(`/projects/${projectId}/pulls`, { method: 'POST', body: JSON.stringify(data) }),
  updatePull: (projectId, number, data) =>
    fetchJSON(`/projects/${projectId}/pulls/${number}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  reopenPull: (projectId, number) =>
    fetchJSON(`/projects/${projectId}/pulls/${number}/reopen`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  // `data`: { event: 'APPROVE'|'REQUEST_CHANGES'|'COMMENT', body? }
  submitPullReview: (projectId, number, data) =>
    fetchJSON(`/projects/${projectId}/pulls/${number}/reviews`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  // `data`: { body, path?, line? } — path+line for inline file comments.
  addPullComment: (projectId, number, data) =>
    fetchJSON(`/projects/${projectId}/pulls/${number}/comments`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  // GitHub PR read proxy — same endpoints the web FileDiffView uses.
  getPrDiff: (prUrl) => fetchJSON(`/pr/diff?prUrl=${encodeURIComponent(prUrl)}`),
  getPrFiles: (prUrl) => fetchJSON(`/pr/files?prUrl=${encodeURIComponent(prUrl)}`),
  getPrData: (prUrl) => fetchJSON(`/pr/data?prUrl=${encodeURIComponent(prUrl)}`),
  mergePr: (prUrl) =>
    fetchJSON('/pr/merge', { method: 'POST', body: JSON.stringify({ prUrl }) }),
  closePr: (prUrl) =>
    fetchJSON('/pr/close', { method: 'POST', body: JSON.stringify({ prUrl }) }),
  // Notes (project-scoped quick-capture)
  getNotes: (projectId, query, limit) => fetchJSON(buildNotesListUrl(projectId, query, limit)),
  getNote: (projectId, noteId) => fetchJSON(buildNoteUrl(projectId, noteId)),
  createNote: (projectId, data) =>
    fetchJSON(`/projects/${projectId}/notes`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  updateNote: (projectId, noteId, data) =>
    fetchJSON(buildNoteUrl(projectId, noteId), {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  deleteNote: (projectId, noteId) =>
    fetchJSON(buildNoteUrl(projectId, noteId), { method: 'DELETE' }),

  // Support tickets — project-scoped queue, ordered by severity (server-side).
  getSupportTickets: (projectId, status) => {
    const qs = status ? `?status=${encodeURIComponent(status)}` : '';
    return fetchJSON(`/projects/${projectId}/support-tickets${qs}`);
  },
  getSupportTicket: (projectId, id) => fetchJSON(`/projects/${projectId}/support-tickets/${id}`),
  // Promote a support ticket to a To Do kanban card. Idempotent: re-converting
  // returns the existing card with `alreadyConverted: true`.
  convertSupportTicketToCard: (projectId, id) =>
    fetchJSON(`/projects/${projectId}/support-tickets/${id}/convert`, { method: 'POST' }),

  // Threads (persistent output logs for crons & heartbeats)
  getThreads: (projectId, type) => {
    const qs = type ? `?type=${encodeURIComponent(type)}` : '';
    return fetchJSON(`/projects/${projectId}/threads${qs}`);
  },
  getThread: (threadId) => fetchJSON(`/threads/${threadId}`),
  getThreadEntries: (threadId) => fetchJSON(`/threads/${threadId}/entries`),
  // Human-authored entry — used by the ThreadView composer on mobile.
  // The server stamps role='user' and author_user_id from req.authUserId.
  postThreadEntry: (threadId, content) =>
    fetchJSON(`/threads/${threadId}/entries`, {
      method: 'POST',
      body: JSON.stringify({ content }),
    }),

  // Push notification device tokens (Expo)
  registerDeviceToken: (token, platform) =>
    fetchJSON('/devices', {
      method: 'POST',
      body: JSON.stringify({ token, platform }),
    }),
  unregisterDeviceToken: (token) =>
    fetchJSON(`/devices/${encodeURIComponent(token)}`, { method: 'DELETE' }),
  getDeviceTokenPreferences: (token) =>
    fetchJSON(`/devices/${encodeURIComponent(token)}`),
  setDeviceTokenPreferences: (token, enabledEvents) =>
    fetchJSON(`/devices/${encodeURIComponent(token)}/preferences`, {
      method: 'PUT',
      body: JSON.stringify({ enabledEvents }),
    }),

  // Wiki
  getWikiPages: (projectId) => fetchJSON(`/projects/${projectId}/wiki`),
  getWikiPage: (projectId, slug) => fetchJSON(`/projects/${projectId}/wiki/${slug}`),
  searchWiki: (projectId, query) =>
    fetchJSON(`/projects/${projectId}/wiki?q=${encodeURIComponent(query)}`),
  getWikiPagesByCategory: (projectId, category) =>
    fetchJSON(`/projects/${projectId}/wiki?category=${encodeURIComponent(category)}`),
  createWikiPage: (projectId, data) =>
    fetchJSON(`/projects/${projectId}/wiki`, { method: 'POST', body: JSON.stringify(data) }),
  updateWikiPage: (projectId, slug, data) =>
    fetchJSON(`/projects/${projectId}/wiki/${slug}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteWikiPage: (projectId, slug) =>
    fetchJSON(`/projects/${projectId}/wiki/${slug}`, { method: 'DELETE' }),
};
