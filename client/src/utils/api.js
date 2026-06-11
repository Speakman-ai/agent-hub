import { getApiBase, getAuthHeaders } from './connection.js';
import { getToken as getJwt, clearToken } from './auth.js';
import { normalizeSessionMessagesResponse } from './sessionMessagesResponse.js';

// Session-scoped flag we set right before a 401-triggered reload so that the
// first request after reload (e.g. the bootstrap `getAuthStatus` probe in
// AuthGate, or the user hitting Login) can't trigger a second reload before
// the UI has a chance to render LoginScreen. Cleared as soon as any request
// succeeds.
const RECENT_401_RELOAD_KEY = 'agent-hub-401-reload';

function recentlyReloadedFor401() {
  if (typeof sessionStorage === 'undefined') return false;
  try {
    return !!sessionStorage.getItem(RECENT_401_RELOAD_KEY);
  } catch {
    return false;
  }
}

function markReloadedFor401() {
  if (typeof sessionStorage === 'undefined') return;
  try {
    sessionStorage.setItem(RECENT_401_RELOAD_KEY, String(Date.now()));
  } catch {
    /* storage full or disabled — proceed without the guard */
  }
}

function clearRecentReloadMarker() {
  if (typeof sessionStorage === 'undefined') return;
  try {
    sessionStorage.removeItem(RECENT_401_RELOAD_KEY);
  } catch {
    /* ignore */
  }
}

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
    // 401 handling — the SPA's only client-held credential is the JWT in
    // localStorage, so a 401 means either:
    //   (a) the token is stale → clear it and reload so <AuthGate /> sees
    //       `isAuthenticated() === false` and renders <LoginScreen />.
    //   (b) the token was never written (cleared, evicted, missing) but the
    //       server expects one → reload so AuthGate's getAuthStatus check
    //       can route the user to <LoginScreen />.
    //
    // Both paths need the reload to escape the "empty UI with no nav" trap.
    // The previous gate (`&& getJwt()`) only handled (a) and left users
    // stranded on (b). We use a sessionStorage marker to avoid a reload
    // loop on edge cases (e.g. an install that 401s even after auth bootstrap).
    if (res.status === 401 && typeof window !== 'undefined' && !recentlyReloadedFor401()) {
      markReloadedFor401();
      if (getJwt()) clearToken();
      window.location.reload();
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
  // Any successful request after a 401-triggered reload clears the marker so
  // a future 401 in the same browser tab will trigger a fresh reload.
  clearRecentReloadMarker();
  return res.json();
}

export const api = {
  // Projects
  getProjects: () => fetchJSON('/projects'),
  getProject: (projectId) => fetchJSON(`/projects/${projectId}`),
  createProject: (data) => fetchJSON('/projects', { method: 'POST', body: JSON.stringify(data) }),
  updateProject: (projectId, data) =>
    fetchJSON(`/projects/${projectId}`, { method: 'PATCH', body: JSON.stringify(data) }),
  // Agent Hub-hosted git (gitHost: 'agenthub') — see server/routes/git-host.ts
  getGitHostStatus: (projectId) => fetchJSON(`/projects/${projectId}/git-host`),
  enableGitHost: (projectId, importFrom) =>
    fetchJSON(`/projects/${projectId}/git-host/enable`, {
      method: 'POST',
      body: JSON.stringify(importFrom ? { importFrom } : {}),
    }),
  disableGitHost: (projectId) =>
    fetchJSON(`/projects/${projectId}/git-host/disable`, { method: 'POST' }),
  getGitHostBranches: (projectId) => fetchJSON(`/projects/${projectId}/git-host/branches`),
  deleteGitHostBranch: (projectId, branch) =>
    fetchJSON(`/projects/${projectId}/git-host/branches/${encodeURIComponent(branch)}`, {
      method: 'DELETE',
    }),
  setGitHostDefaultBranch: (projectId, branch) =>
    fetchJSON(`/projects/${projectId}/git-host/default-branch`, {
      method: 'POST',
      body: JSON.stringify({ branch }),
    }),
  getGitHostCommits: (projectId, { branch, limit = 50 } = {}) => {
    const params = new URLSearchParams();
    if (branch) params.set('branch', branch);
    params.set('limit', String(limit));
    return fetchJSON(`/projects/${projectId}/git-host/commits?${params}`);
  },
  getGitHostCommitDetail: (projectId, sha) =>
    fetchJSON(`/projects/${projectId}/git-host/commits/${encodeURIComponent(sha)}`),
  getProjectSecrets: (projectId) => fetchJSON(`/projects/${projectId}/secrets`),
  putProjectSecrets: (projectId, secrets) =>
    fetchJSON(`/projects/${projectId}/secrets`, {
      method: 'PUT',
      body: JSON.stringify({ secrets }),
    }),
  importProjectSecrets: (projectId, env, opts = {}) =>
    fetchJSON(`/projects/${projectId}/secrets/import`, {
      method: 'POST',
      body: JSON.stringify({
        env,
        mode: opts.mode || 'merge',
        defaultKind: opts.defaultKind,
      }),
    }),
  getProjectAwsProfiles: (projectId) => fetchJSON(`/projects/${projectId}/aws-profiles`),
  putProjectAwsProfiles: (projectId, profiles) =>
    fetchJSON(`/projects/${projectId}/aws-profiles`, {
      method: 'PUT',
      body: JSON.stringify({ profiles }),
    }),
  getProjectAwsSsoStatus: (projectId, profile) =>
    fetchJSON(`/projects/${projectId}/aws-sso/status?profile=${encodeURIComponent(profile)}`),
  startProjectAwsSsoLogin: (projectId, profile) =>
    fetchJSON(`/projects/${projectId}/aws-sso/login`, {
      method: 'POST',
      body: JSON.stringify({ profile }),
      timeout: 60_000,
    }),
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
  // Settings → Preview: repo scan + compose draft (no agent session).
  getPreviewEnvironmentDraft: (projectId) =>
    fetchJSON(`/projects/${projectId}/preview/environment-draft`),
  getFinalizeEnvironmentDraft: (projectId) =>
    fetchJSON(`/projects/${projectId}/finalize/environment-draft`),
  // Default guided setup — spawns wizard session; opens chat in UI.
  startPreviewWizard: (projectId) =>
    fetchJSON(`/projects/${projectId}/preview/setup-wizard`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  // Finalize Code Changes — `.agent-hub/ci.yaml` setup wizard.
  // Spawns a guided chat session loaded with the `finalize-setup`
  // skill. Returns `{ sessionId, agentId, draft, session }`.
  startFinalizeWizard: (projectId) =>
    fetchJSON(`/projects/${projectId}/finalize/setup-wizard`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  // Commit a wizard-generated ci.yaml to the worktree. The optional
  // `sessionId` overrides the "most recent project session with a
  // worktree" heuristic. Returns `{ ok, file, commit_sha, branch,
  // session_id }`.
  applyFinalizeWizardConfig: (projectId, { ciYamlContent, sessionId, secrets } = {}) =>
    fetchJSON(`/projects/${projectId}/finalize/setup-apply`, {
      method: 'POST',
      body: JSON.stringify({
        ci_yaml_content: ciYamlContent,
        ...(sessionId ? { session_id: sessionId } : {}),
        ...(secrets ? { secrets } : {}),
      }),
    }),
  // Notify Settings that the Finalize wizard finished.
  completeFinalizeWizard: (projectId) =>
    fetchJSON(`/projects/${projectId}/finalize/wizard-complete`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  // Single-path configure + secrets + compose boot test. Admin+.
  buildPreviewEnvironment: (projectId, body) =>
    fetchJSON(`/projects/${projectId}/preview/build`, {
      method: 'POST',
      body: JSON.stringify(body),
      timeout: 200_000,
    }),
  /** Boot worktree preview for a chat session (user toolbar only). */
  startSessionPreview: (sessionId, body = {}) =>
    fetchJSON(`/sessions/${sessionId}/preview/start`, {
      method: 'POST',
      body: JSON.stringify(body),
      timeout: 200_000,
    }),
  /** Clone or attach the session worktree before the first chat turn. */
  ensureSessionWorkspace: (sessionId) =>
    fetchJSON(`/sessions/${sessionId}/workspace/ensure`, {
      method: 'POST',
      body: JSON.stringify({}),
      timeout: 300_000,
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
  getMessages: async (sessionId, opts = {}) => {
    const q = opts.limit != null ? `?limit=${encodeURIComponent(String(opts.limit))}` : '';
    const data = await fetchJSON(`/sessions/${sessionId}/messages${q}`);
    return normalizeSessionMessagesResponse(data).messages;
  },
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
  /** Live git status — uncommitted or unpushed work in the session worktree. */
  getSessionWorktreeChanges: (sessionId, opts = {}) =>
    fetchJSON(`/sessions/${sessionId}/worktree-changes`, { signal: opts.signal }),
  /**
   * Most-recent Finalize run for a session. Returns `{ run: null }` when
   * the session has never triggered a Finalize run — used by the read-only
   * reviewer-threads sidecar to discover its current run id.
   *
   * `opts.signal` lets the sidecar cancel an in-flight request when the
   * caller unmounts (or the user switches sessions) so a slow response
   * can't resolve into a stale React state setter after teardown.
   */
  getLatestFinalizeRunForSession: (sessionId, opts = {}) =>
    fetchJSON(`/sessions/${sessionId}/finalize-runs/latest`, { signal: opts.signal }),
  /**
   * Start a new Finalize Code Changes run for a card. The server resolves
   * the bound session's worktree + branch + HEAD sha, idempotency-keys the
   * tuple, and either short-circuits (`reused: true`) when a non-terminal
   * row already exists or kicks off a background run. Returns
   * `{ run_id, status, reused }` on success.
   *
   * 4xx error shapes (surfaced via fetchJSON's `Error.message`):
   *   - 400 `no_session` / `no_worktree` / `no_branch` — card is not yet
   *     in a finalizable state.
   *   - 404 — project or card not found / cross-project.
   *   - 409 `in_flight` — a non-terminal run already exists for the
   *     same (project, branch, head_sha, mode).
   *
   * `mode` selects which phases run: `'full'` (default — the one Finalize
   * button: rebase + reviewer + checks). `'checks'` / `'review'` are legacy
   * single-phase modes kept for back-compat; the UI only sends `'full'`.
   */
  startFinalizeRun: (projectId, cardId, { mode = 'full' } = {}) =>
    fetchJSON(`/projects/${projectId}/cards/${cardId}/finalize`, {
      method: 'POST',
      body: JSON.stringify({ mode }),
    }),
  /**
   * Kick off Finalize for an ad-hoc session. Creates a kanban card on first
   * use when the session is not already card-linked. See `startFinalizeRun`
   * for the `mode` contract.
   */
  startFinalizeRunForSession: (projectId, sessionId, { mode = 'full' } = {}) =>
    fetchJSON(`/projects/${projectId}/sessions/${sessionId}/finalize`, {
      method: 'POST',
      body: JSON.stringify({ mode }),
    }),
  pushFinalizeRun: (projectId, runId, { force = false } = {}) =>
    fetchJSON(`/projects/${projectId}/finalize/${runId}/push`, {
      method: 'POST',
      body: JSON.stringify({ force }),
    }),
  pushSessionToGithub: (projectId, sessionId, { force = false } = {}) =>
    fetchJSON(`/projects/${projectId}/sessions/${sessionId}/push-to-github`, {
      method: 'POST',
      body: JSON.stringify({ force }),
    }),
  // Unified diff for a PR (text/plain) — GitHub or Agent Hub-native by URL.
  getPrDiffText: async (prUrl) => {
    const res = await fetch(`${getApiBase()}/pr/diff?prUrl=${encodeURIComponent(prUrl)}`, {
      headers: { ...getAuthHeaders() },
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`Diff fetch failed (${res.status})`);
    return res.text();
  },
  // Edit a native (Agent Hub-hosted) pull request's title/body.
  updateNativePr: (projectId, number, data) =>
    fetchJSON(`/projects/${projectId}/pulls/${number}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  // Create (or reuse) a native PR for a branch already pushed to the Hub.
  createNativePr: (projectId, data) =>
    fetchJSON(`/projects/${projectId}/pulls`, { method: 'POST', body: JSON.stringify(data) }),
  // AI-suggested PR title/body from the branch diff (60-90s model call).
  generatePrDescription: (projectId, headBranch) =>
    fetchJSON(`/projects/${projectId}/pulls/generate-description`, {
      method: 'POST',
      body: JSON.stringify({ headBranch }),
      timeout: 120000,
    }),
  // Recently pushed branches without an open PR (Compare & PR banner).
  getGitHostRecentPushes: (projectId) => fetchJSON(`/projects/${projectId}/git-host/recent-pushes`),
  reopenNativePr: (projectId, number) =>
    fetchJSON(`/projects/${projectId}/pulls/${number}/reopen`, { method: 'POST' }),
  requestNativePrReview: (projectId, number, requested = true) =>
    fetchJSON(`/projects/${projectId}/pulls/${number}/request-review`, {
      method: 'POST',
      body: JSON.stringify({ requested }),
    }),
  submitNativePrReview: (projectId, number, { state, body = '' }) =>
    fetchJSON(`/projects/${projectId}/pulls/${number}/reviews`, {
      method: 'POST',
      body: JSON.stringify({ state, body }),
    }),
  addNativePrComment: (projectId, number, { filePath, line, side = 'new', body }) =>
    fetchJSON(`/projects/${projectId}/pulls/${number}/comments`, {
      method: 'POST',
      body: JSON.stringify({ filePath, line, side, body }),
    }),
  deleteNativePrComment: (projectId, number, commentId) =>
    fetchJSON(`/projects/${projectId}/pulls/${number}/comments/${commentId}`, {
      method: 'DELETE',
    }),
  // Re-run a finished push/pr-ci run — all jobs, or one job when jobId set.
  rerunCiRun: (projectId, runId, jobId) =>
    fetchJSON(`/projects/${projectId}/ci-runs/${runId}/rerun`, {
      method: 'POST',
      body: JSON.stringify(jobId ? { jobId } : {}),
    }),
  // Run history (Runners page) — finalize + push-CI runs.
  getCiRuns: (projectId, { trigger = 'all', limit = 30 } = {}) =>
    fetchJSON(`/projects/${projectId}/ci-runs?trigger=${trigger}&limit=${limit}`),
  getCiRunDetail: (projectId, runId) => fetchJSON(`/projects/${projectId}/ci-runs/${runId}`),
  getFinalizeStepOutput: (projectId, runId, stepIndex, opts = {}) =>
    fetchJSON(`/projects/${projectId}/finalize/${runId}/steps/${stepIndex}/output`, {
      signal: opts.signal,
    }),
  /**
   * Cancel an in-flight Finalize run. UI-only at v0 — flips the DB row to
   * `cancelled` and broadcasts `finalize_run_phase_changed` /
   * `finalize_run_completed`. Does not interrupt an already-running
   * subprocess (the orchestrator polls its in-process CancelSignal at
   * await boundaries).
   */
  cancelFinalizeRun: (projectId, runId) =>
    fetchJSON(`/projects/${projectId}/finalize/${runId}/cancel`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  /**
   * Diff-anchored reviewer threads for a Finalize run. Read-only.
   * Returns `{ run_id, reviewer_verdict, threads }` with threads pre-sorted
   * by `file_path ASC, line_start ASC, created_at ASC` so the sidecar can
   * group by file without re-sorting.
   *
   * Accepts an optional `opts.signal` (`AbortSignal`) so the sidecar can
   * cancel pending requests on unmount / session-switch and avoid the
   * "fetched after teardown" warning in dev tools.
   */
  getReviewerThreads: (projectId, runId, opts = {}) =>
    fetchJSON(`/projects/${projectId}/finalize/${runId}/reviewer-threads`, {
      signal: opts.signal,
    }),
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
  /** Session detail with agents roster (executor + advisors). */
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
  /**
   * Link a Design Studio design to a session so its live canvas renders in a
   * preview pane beside the chat. Pass `designId: null` to clear the link.
   */
  setSessionLinkedDesign: (sessionId, designId) =>
    fetchJSON(`/sessions/${sessionId}/linked-design`, {
      method: 'PUT',
      body: JSON.stringify({ designId: designId ?? null }),
    }),
  // `setSessionWorktree` was removed when Agent Hub locked to
  // worktree-only sessions. The legacy `PUT /sessions/:id/worktree`
  // endpoint no longer exists.

  shipSession: (sessionId) =>
    fetchJSON(`/sessions/${sessionId}/ship`, {
      method: 'POST',
      body: JSON.stringify({}),
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

  getMyAgentEngineOverrides: () => fetchJSON('/auth/me/agent-engine-overrides'),
  putMyAgentEngineOverrides: (body) =>
    fetchJSON('/auth/me/agent-engine-overrides', {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  // Per-agent merge endpoints — update only one agent's entry server-side, so
  // a save can't clobber other agents' picks or a concurrent edit elsewhere.
  putMyAgentEngineOverride: (agentId, body) =>
    fetchJSON(`/auth/me/agent-engine-overrides/${encodeURIComponent(agentId)}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  deleteMyAgentEngineOverride: (agentId) =>
    fetchJSON(`/auth/me/agent-engine-overrides/${encodeURIComponent(agentId)}`, {
      method: 'DELETE',
    }),

  getMyAgentModelOverrides: () => fetchJSON('/auth/me/agent-model-overrides'),
  putMyAgentModelOverrides: (body) =>
    fetchJSON('/auth/me/agent-model-overrides', {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  putMyAgentModelOverride: (agentId, body) =>
    fetchJSON(`/auth/me/agent-model-overrides/${encodeURIComponent(agentId)}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  deleteMyAgentModelOverride: (agentId) =>
    fetchJSON(`/auth/me/agent-model-overrides/${encodeURIComponent(agentId)}`, {
      method: 'DELETE',
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

  // Shorter aliases used by the dedicated `MyCursorAuthSection` /
  // `MyCodexAuthSection` components (P5). They forward to the same
  // `/auth/me/<engine>-auth/browser/*` routes as the longer names above;
  // the alias exists so dedicated-component code reads cleanly without
  // every call repeating "Browser" in the method name.
  startMyCursorLogin: () =>
    fetchJSON('/auth/me/cursor-auth/browser/login', {
      method: 'POST',
      body: JSON.stringify({}),
      timeout: 22000,
    }),
  cancelMyCursorLogin: () =>
    fetchJSON('/auth/me/cursor-auth/browser/cancel-login', { method: 'POST' }),
  logoutMyCursor: () =>
    fetchJSON('/auth/me/cursor-auth/browser', { method: 'DELETE', timeout: 35000 }),
  startMyCodexDeviceLogin: () =>
    fetchJSON('/auth/me/codex-auth/browser/device-login', {
      method: 'POST',
      body: JSON.stringify({}),
      timeout: 50000,
    }),
  cancelMyCodexDeviceLogin: () =>
    fetchJSON('/auth/me/codex-auth/browser/cancel-login', { method: 'POST' }),
  logoutMyCodex: () =>
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
    if (opts.engine != null && String(opts.engine).trim()) body.engine = String(opts.engine).trim();
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
  purgeAllProjectPreviews: (projectId) =>
    fetchJSON(`/projects/${projectId}/previews/purge`, {
      method: 'POST',
      timeout: 120000,
    }),
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
};
