import { getApiBaseUrl, getAuthHeaders } from './config';

async function fetchJSON(url, options = {}) {
  const base = getApiBaseUrl();
  if (!base) throw new Error('No server configured');
  const authHeaders = getAuthHeaders();
  const res = await fetch(`${base}${url}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...authHeaders, ...(options.headers || {}) },
  });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

export const api = {
  // Agents & Sessions
  getAgents: () => fetchJSON('/agents'),
  getSessions: (agentId) => fetchJSON(`/agents/${agentId}/sessions`),
  createSession: (agentId, name) =>
    fetchJSON(`/agents/${agentId}/sessions`, {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),
  getMessages: (sessionId) => fetchJSON(`/sessions/${sessionId}/messages`),
  deleteSession: (sessionId) =>
    fetchJSON(`/sessions/${sessionId}`, { method: 'DELETE' }),
  clearAllSessions: (agentId) =>
    fetchJSON(`/agents/${agentId}/sessions`, { method: 'DELETE' }),
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
  importConfig: (data) => fetchJSON('/config/import', { method: 'POST', body: JSON.stringify(data) }),

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
    fetchJSON(`/heartbeats/${agentId}/run`, { method: 'POST' }),

  // Crons
  getCrons: () => fetchJSON('/crons'),
  getCronLogs: (id, limit = 3) =>
    fetchJSON(`/crons/${id}/logs?limit=${limit}`),
  createCron: (data) =>
    fetchJSON('/crons', { method: 'POST', body: JSON.stringify(data) }),
  updateCron: (id, data) =>
    fetchJSON(`/crons/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteCron: (id) =>
    fetchJSON(`/crons/${id}`, { method: 'DELETE' }),
  runCron: (id) =>
    fetchJSON(`/crons/${id}/run`, { method: 'POST' }),

  // Rooms
  getRooms: () => fetchJSON('/rooms'),
  getRoom: (id) => fetchJSON(`/rooms/${id}`),
  createRoom: (name) =>
    fetchJSON('/rooms', { method: 'POST', body: JSON.stringify({ name }) }),
  deleteRoom: (id) =>
    fetchJSON(`/rooms/${id}`, { method: 'DELETE' }),
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

  // Upload
  uploadImage: (dataUrl, filename) =>
    fetchJSON('/upload', {
      method: 'POST',
      body: JSON.stringify({ dataUrl, filename }),
    }),

  // Slack
  getSlackStatus: () => fetchJSON('/slack/status'),
  restartSlack: () =>
    fetchJSON('/slack/restart', { method: 'POST' }),
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

  // Message events (for session timeline)
  getMessageEvents: (messageId) => fetchJSON(`/messages/${messageId}/events`),

  // Delegations
  getDelegations: (messageId) => fetchJSON(`/delegations/${messageId}`),
  getSessionDelegations: (sessionId) => fetchJSON(`/sessions/${sessionId}/delegations`),

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
  getCardComments: (projectId, cardId) =>
    fetchJSON(`/projects/${projectId}/board/cards/${cardId}/comments`),
  addCardComment: (projectId, cardId, data) =>
    fetchJSON(`/projects/${projectId}/board/cards/${cardId}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }),

  // Wiki
  getWikiPages: (projectId) => fetchJSON(`/projects/${projectId}/wiki`),
  getWikiPage: (projectId, slug) => fetchJSON(`/projects/${projectId}/wiki/${slug}`),
  searchWiki: (projectId, query) => fetchJSON(`/projects/${projectId}/wiki?q=${encodeURIComponent(query)}`),
  getWikiPagesByCategory: (projectId, category) => fetchJSON(`/projects/${projectId}/wiki?category=${encodeURIComponent(category)}`),
  createWikiPage: (projectId, data) =>
    fetchJSON(`/projects/${projectId}/wiki`, { method: 'POST', body: JSON.stringify(data) }),
  updateWikiPage: (projectId, slug, data) =>
    fetchJSON(`/projects/${projectId}/wiki/${slug}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteWikiPage: (projectId, slug) =>
    fetchJSON(`/projects/${projectId}/wiki/${slug}`, { method: 'DELETE' }),
};
