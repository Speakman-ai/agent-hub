import { getApiBase, getAuthHeaders } from './connection.js';

async function fetchJSON(url, options = {}) {
  const base = getApiBase();
  const authHeaders = getAuthHeaders();
  const timeout = options.timeout || 15000;
  const { timeout: _t, ...fetchOpts } = options;
  const res = await fetch(`${base}${url}`, {
    ...fetchOpts,
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders,
      ...fetchOpts.headers,
    },
    signal: fetchOpts.signal || AbortSignal.timeout(timeout),
  });
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
  // Projects
  getProjects: () => fetchJSON('/projects'),
  getProject: (projectId) => fetchJSON(`/projects/${projectId}`),
  createProject: (data) => fetchJSON('/projects', { method: 'POST', body: JSON.stringify(data) }),
  updateProject: (projectId, data) =>
    fetchJSON(`/projects/${projectId}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteProject: (projectId) =>
    fetch(`${getApiBase()}/projects/${projectId}`, {
      method: 'DELETE',
      headers: { ...getAuthHeaders() },
    }).then((res) => {
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      return null;
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
  summarizeSession: (sessionId) =>
    fetchJSON(`/sessions/${sessionId}/summarize`, { method: 'POST', timeout: 120000 }),
  getMessageEvents: (messageId) => fetchJSON(`/messages/${messageId}/events`),
  deleteSession: (sessionId) => fetchJSON(`/sessions/${sessionId}`, { method: 'DELETE' }),
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
  setSessionWorktree: (sessionId, enabled) =>
    fetchJSON(`/sessions/${sessionId}/worktree`, {
      method: 'PUT',
      body: JSON.stringify({ enabled }),
    }),
  createPrFromSession: (sessionId, { autoMerge = false, title } = {}) =>
    fetchJSON(`/sessions/${sessionId}/create-pr`, {
      method: 'POST',
      body: JSON.stringify({ autoMerge, title }),
      timeout: 60000,
    }),
  setSessionAskMode: (sessionId, enabled) =>
    fetchJSON(`/sessions/${sessionId}/ask-mode`, {
      method: 'PUT',
      body: JSON.stringify({ enabled }),
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
  startClaudeOAuthLogin: (opts = {}) =>
    fetchJSON('/config/claude-auth/login', {
      method: 'POST',
      body: JSON.stringify(opts),
      timeout: 20000,
    }),
  cancelClaudeOAuthLogin: () => fetchJSON('/config/claude-auth/cancel-login', { method: 'POST' }),
  submitOAuthCallback: (code) =>
    fetchJSON('/config/claude-auth/callback', {
      method: 'POST',
      body: JSON.stringify({ code }),
    }),
  logoutClaude: () => fetchJSON('/config/claude-auth', { method: 'DELETE' }),
  setClaudeApiKey: (apiKey) =>
    fetchJSON('/config/claude-auth/api-key', { method: 'POST', body: JSON.stringify({ apiKey }) }),
  validateClaudeApiKey: (apiKey) =>
    fetchJSON('/config/claude-auth/validate-key', {
      method: 'POST',
      body: JSON.stringify({ apiKey }),
      timeout: 35000,
    }),

  // Per-project export/import
  exportProject: (projectId) => fetchJSON(`/projects/${projectId}/export`),
  importProject: (projectId, data) =>
    fetchJSON(`/projects/${projectId}/import`, { method: 'POST', body: JSON.stringify(data) }),

  // Legacy full-instance export/import
  exportConfig: () => fetchJSON('/config/export'),
  importConfig: (data) =>
    fetchJSON('/config/import', { method: 'POST', body: JSON.stringify(data) }),

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
  assignCard: (projectId, cardId, agentId) =>
    fetchJSON(`/projects/${projectId}/board/cards/${cardId}/assign`, {
      method: 'POST',
      body: JSON.stringify({ agentId }),
    }),
  deleteCard: (projectId, cardId) =>
    fetchJSON(`/projects/${projectId}/board/cards/${cardId}`, { method: 'DELETE' }),
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
};
