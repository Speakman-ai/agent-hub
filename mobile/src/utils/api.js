import { getApiBaseUrl, getAuthHeaders } from './config';
import { buildNotesListUrl, buildNoteUrl } from './notesUrl';
import { uploadFile as uploadFileImpl } from './uploadFile';
import { getToken as getJwt, clearToken } from './auth';

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
        ...(options.use_worktree != null ? { use_worktree: options.use_worktree } : {}),
        ...(options.askMode != null ? { ask_mode: !!options.askMode } : {}),
      }),
    }),
  getMessages: (sessionId) => fetchJSON(`/sessions/${sessionId}/messages`),
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
  // Toggle git-worktree isolation for a session. Returns the updated session
  // row with `use_worktree`, `worktree_path`, `worktree_branch`, and
  // `git_worktree_detected` fields so callers can hydrate UI state.
  setSessionWorktree: (sessionId, enabled) =>
    fetchJSON(`/sessions/${sessionId}/worktree`, {
      method: 'PUT',
      body: JSON.stringify({ enabled }),
    }),
  // Toggle Ask Mode (read-only session). Server enforces this by spawning the
  // CLI with `--permission-mode plan` instead of `bypassPermissions`. Returns
  // the updated session row so callers can hydrate `ask_mode` in local state.
  setSessionAskMode: (sessionId, enabled) =>
    fetchJSON(`/sessions/${sessionId}/ask-mode`, {
      method: 'PUT',
      body: JSON.stringify({ enabled }),
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
  deleteProject: (projectId) => fetchJSON(`/projects/${projectId}`, { method: 'DELETE' }),

  // Usage
  getUsage: () => fetchJSON('/usage'),

  // Config
  getConfig: () => fetchJSON('/config'),
  getModelConfig: () => fetchJSON('/config/models'),
  updateConfig: (data) => fetchJSON('/config', { method: 'PATCH', body: JSON.stringify(data) }),
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
  summarizeRoom: (roomId) => fetchJSON(`/rooms/${roomId}/summarize`, { method: 'POST' }),

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
  installSkill: (projectId, skillId) =>
    fetchJSON(`/projects/${projectId}/skills/install`, {
      method: 'POST',
      body: JSON.stringify({ skillId }),
    }),
  uninstallSkill: (projectId, skillId) =>
    fetchJSON(`/projects/${projectId}/skills/${skillId}`, { method: 'DELETE' }),
  importGithubSkill: (url) =>
    fetchJSON('/skills/import-github', {
      method: 'POST',
      body: JSON.stringify({ url }),
    }),
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

  // Devices (push notifications)
  registerDevice: (token, platform = 'ios') =>
    fetchJSON('/devices', {
      method: 'POST',
      body: JSON.stringify({ token, platform }),
    }),

  // Cron sessions
  getCronSessions: () => fetchJSON('/sessions/cron'),

  // Ad-hoc PR creation from a session with pending changes
  createPrFromSession: (sessionId, { autoMerge = false, title } = {}) =>
    fetchJSON(`/sessions/${sessionId}/create-pr`, {
      method: 'POST',
      body: JSON.stringify({ autoMerge, title }),
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
  assignCard: (projectId, cardId, agentId) =>
    fetchJSON(`/projects/${projectId}/board/cards/${cardId}/assign`, {
      method: 'POST',
      body: JSON.stringify({ agentId }),
    }),
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

  // PR Captures (read-only on mobile) — list project captures and fetch one
  // with its screenshot/video artifacts. Mirrors the web CapturesPage endpoints.
  getProjectCaptures: (projectId) => fetchJSON(`/projects/${projectId}/captures`),
  getProjectCapture: (projectId, captureId) =>
    fetchJSON(`/projects/${projectId}/captures/${captureId}`),

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

  // Webhooks
  getWebhooks: () => fetchJSON('/webhooks'),
  getProjectWebhooks: (projectId) => fetchJSON(`/webhooks/project/${projectId}`),
  createWebhook: (data) =>
    fetchJSON('/webhooks', { method: 'POST', body: JSON.stringify(data) }),
  updateWebhook: (id, data) =>
    fetchJSON(`/webhooks/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteWebhook: (id) => fetchJSON(`/webhooks/${id}`, { method: 'DELETE' }),
  getWebhookLogs: (id, limit = 20) => fetchJSON(`/webhooks/${id}/logs?limit=${limit}`),
  registerWebhook: (id) => fetchJSON(`/webhooks/${id}/register`, { method: 'POST' }),
  unregisterWebhook: (id) => fetchJSON(`/webhooks/${id}/register`, { method: 'DELETE' }),
  getWebhookRegistration: (id) => fetchJSON(`/webhooks/${id}/register`),

  // Threads (persistent output logs for crons & heartbeats)
  getThreads: (projectId, type) => {
    const qs = type ? `?type=${encodeURIComponent(type)}` : '';
    return fetchJSON(`/projects/${projectId}/threads${qs}`);
  },
  getThread: (threadId) => fetchJSON(`/threads/${threadId}`),
  getThreadEntries: (threadId) => fetchJSON(`/threads/${threadId}/entries`),

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
