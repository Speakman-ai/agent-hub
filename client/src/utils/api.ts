import { getApiBase, getAuthHeaders } from './connection';
import { getToken as getJwt, clearToken } from './auth';
import { normalizeSessionMessagesResponse } from './sessionMessagesResponse';
import type { ApiErrorBody, AgentWire, MessageWire, ProjectWire, SessionWire } from '@shared/types';
import type { DeployTriggerEvent } from './deployTriggers';

interface CreateDeployTriggerBody {
  event: DeployTriggerEvent;
  branchPattern: string;
  enabled?: boolean;
  meta?: unknown;
}

interface UpdateDeployTriggerBody {
  event?: DeployTriggerEvent;
  branchPattern?: string;
  enabled?: boolean;
  meta?: unknown;
}

interface CreateDeployScheduleBody {
  ref: string;
  cron: string;
  timezone?: string | null;
  enabled?: boolean;
  meta?: unknown;
}

interface UpdateDeployScheduleBody {
  ref?: string;
  cron?: string;
  timezone?: string | null;
  enabled?: boolean;
  meta?: unknown;
}

interface UpdateNotificationRoutingBody {
  ticketReleaseEnabled?: boolean;
  releaseDigestEnabled?: boolean;
  meta?: unknown;
}

/** Todo priority — reuses the kanban-card enum so a promote maps 1:1. */
export type TodoPriority = 'urgent' | 'high' | 'medium' | 'low';
/** Polymorphic link target type (spec TODO-TO-TICKET). */
export type TodoLinkType = 'card' | 'epic' | 'session';

/** Cross-project personal todo (spec TODO-MODEL). Mirrors `UserTodo` server-side. */
export interface UserTodoWire {
  id: string;
  userId: string;
  title: string;
  notes: string;
  status: 'open' | 'done';
  priority: TodoPriority;
  /** Day the user plans to WORK the task (scheduling "do" date, not a deadline). */
  doDate: string | null;
  doStartAt: string | null;
  doEndAt: string | null;
  /** Deprecated: retained for back-compat only; no longer written. Use `doDate`. */
  dueAt: string | null;
  position: number;
  sourceType: 'manual' | 'email' | 'calendar';
  sourceId: string | null;
  sourceMeta: Record<string, unknown> | null;
  /** Polymorphic link (card | epic | session), or null when unlinked. */
  linkedType: TodoLinkType | null;
  linkedId: string | null;
  linkedProjectId: string | null;
  /** Deprecated: superseded by linkedType/linkedId. Kept in sync for a card link. */
  linkedCardId: string | null;
  createdAt: string;
  updatedAt: string;
}

// Personal Dashboard aggregation (GET /api/me/dashboard, /api/me/work). Mirrors
// the server MeDashboardPayload / DashboardWork shapes (server/me-dashboard.ts,
// server/me-dashboard-google.ts) for the User Module home.
export type DashboardCardPriority = 'urgent' | 'high' | 'medium' | 'low';

export interface DashboardWorkCardWire {
  id: string;
  shortId: number | null;
  title: string;
  priority: DashboardCardPriority;
  columnId: string;
  columnName: string;
  isDone: boolean;
  projectId: string;
  projectName: string;
  boardId: string;
  epicId: string | null;
  prUrl: string | null;
  reviewStatus: string | null;
  sessionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DashboardWorkWire {
  cards: DashboardWorkCardWire[];
  counts: {
    total: number;
    open: number;
    byPriority: Record<DashboardCardPriority, number>;
  };
}

export interface DashboardCalendarEventWire {
  id: string | null;
  summary: string | null;
  location: string | null;
  allDay: boolean;
  start: string | null;
  end: string | null;
  htmlLink: string | null;
  hangoutLink: string | null;
}

export interface DashboardGoogleWire {
  configured: boolean;
  connected: boolean;
  email: string | null;
  reconnectRequired: boolean;
  calendar: {
    scopeGranted: boolean;
    date: string | null;
    timeZone: string | null;
    events: DashboardCalendarEventWire[];
    error: string | null;
  };
  mail: {
    scopeGranted: boolean;
    unread: number | null;
    starred: number | null;
    important: number | null;
    messages: DashboardMailMessageWire[];
    error: string | null;
  };
}

export interface DashboardMailMessageWire {
  id: string | null;
  threadId: string | null;
  from: string | null;
  subject: string | null;
  snippet: string | null;
  date: string | null;
  internalDate: string | null;
  unread: boolean;
}

export interface MeDashboardWire {
  generatedAt: string;
  work: DashboardWorkWire;
  todos: { open: UserTodoWire[]; openCount: number };
  google: DashboardGoogleWire;
}

interface CreateTodoBody {
  title: string;
  notes?: string;
  priority?: TodoPriority;
  doDate?: string | null;
  doStartAt?: string | null;
  doEndAt?: string | null;
  /** Deprecated: retained for back-compat. Prefer `doDate`. */
  dueAt?: string | null;
  // Capture provenance (spec CAPTURE-PROVENANCE) — set when a todo is captured
  // from a Gmail message / Calendar event so it can be traced back to its origin.
  sourceType?: 'manual' | 'email' | 'calendar';
  sourceId?: string | null;
  sourceMeta?: Record<string, unknown> | null;
}

interface UpdateTodoBody {
  title?: string;
  notes?: string;
  status?: 'open' | 'done';
  priority?: TodoPriority;
  doDate?: string | null;
  doStartAt?: string | null;
  doEndAt?: string | null;
  /** Deprecated: retained for back-compat. Prefer `doDate`. */
  dueAt?: string | null;
}

// Session-scoped flag we set right before a 401-triggered reload so that the
// first request after reload (e.g. the bootstrap `getAuthStatus` probe in
// AuthGate, or the user hitting Login) can't trigger a second reload before
// the UI has a chance to render LoginScreen. Cleared as soon as any request
// succeeds.
const RECENT_401_RELOAD_KEY = 'agent-hub-401-reload';

function recentlyReloadedFor401(): boolean {
  if (typeof sessionStorage === 'undefined') return false;
  try {
    return !!sessionStorage.getItem(RECENT_401_RELOAD_KEY);
  } catch {
    return false;
  }
}

function markReloadedFor401(): void {
  if (typeof sessionStorage === 'undefined') return;
  try {
    sessionStorage.setItem(RECENT_401_RELOAD_KEY, String(Date.now()));
  } catch {
    /* storage full or disabled — proceed without the guard */
  }
}

function clearRecentReloadMarker(): void {
  if (typeof sessionStorage === 'undefined') return;
  try {
    sessionStorage.removeItem(RECENT_401_RELOAD_KEY);
  } catch {
    /* ignore */
  }
}

/** Options passed to fetchJSON — extends RequestInit with a client-side timeout. */
export interface FetchJsonOptions extends Omit<RequestInit, 'signal'> {
  timeout?: number | null;
  signal?: AbortSignal;
}

async function fetchJSON<T = any>(url: string, options: FetchJsonOptions = {}): Promise<T> {
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
      ...(fetchOpts.headers as Record<string, string> | undefined),
    },
    signal: fetchOpts.signal || (timeoutMs === null ? undefined : AbortSignal.timeout(timeoutMs)),
  });
  if (!res.ok) {
    if (res.status === 401 && typeof window !== 'undefined' && !recentlyReloadedFor401()) {
      markReloadedFor401();
      if (getJwt()) clearToken();
      window.location.reload();
    }
    let detail = '';
    try {
      const body = (await res.json()) as ApiErrorBody;
      detail = body.error || body.message || JSON.stringify(body);
    } catch {
      /* response wasn't JSON */
    }
    throw new Error(detail ? `${res.status}: ${detail}` : `API error: ${res.status}`);
  }
  clearRecentReloadMarker();
  return res.json() as Promise<T>;
}

export const api = {
  // Projects
  getProjects: () => fetchJSON<ProjectWire[]>('/projects'),
  getProject: (projectId: string) => fetchJSON<ProjectWire>(`/projects/${projectId}`),
  createProject: (data: Record<string, unknown>) =>
    fetchJSON<ProjectWire>('/projects', { method: 'POST', body: JSON.stringify(data) }),
  updateProject: (projectId: string, data: Record<string, unknown>) =>
    fetchJSON<ProjectWire>(`/projects/${projectId}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  getSessionCredentialRequest: (sessionId: string, requestId: string) =>
    fetchJSON(`/sessions/${sessionId}/credential-requests/${encodeURIComponent(requestId)}`),
  submitSessionCredentialRequest: (
    sessionId: string,
    requestId: string,
    body: Record<string, unknown>,
  ) =>
    fetchJSON(`/sessions/${sessionId}/credential-requests/${encodeURIComponent(requestId)}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  // Per-project member assignment (Owner-managed visibility ACL).
  getProjectMembers: (projectId: string) =>
    fetchJSON<{
      projectId: string;
      ownerUserId: string | null;
      visibility: 'shared' | 'private';
      restricted: boolean;
      members: Array<{
        userId: string;
        username: string;
        addedBy: string | null;
        createdAt: string;
      }>;
    }>(`/projects/${projectId}/members`),
  addProjectMember: (projectId: string, userId: string) =>
    fetchJSON<{ projectId: string; userId: string; username: string }>(
      `/projects/${projectId}/members`,
      { method: 'POST', body: JSON.stringify({ userId }) },
    ),
  removeProjectMember: (projectId: string, userId: string) =>
    fetchJSON<{ projectId: string; userId: string; removed: true }>(
      `/projects/${projectId}/members/${encodeURIComponent(userId)}`,
      { method: 'DELETE' },
    ),
  // Org user roster (Admin+). Used to populate the member-assignment picker.
  getOrgUsers: () =>
    fetchJSON<{
      users: Array<{ id: string | null; username: string; role: string }>;
    }>('/auth/users'),
  // Per-user, project-scoped settings (e.g. default Finalize automation level).
  getProjectUserSettings: (projectId: any) => fetchJSON(`/projects/${projectId}/user-settings`),
  updateProjectUserSettings: (projectId: any, data: any) =>
    fetchJSON(`/projects/${projectId}/user-settings`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  getReleaseNotificationSettings: (projectId: any) =>
    fetchJSON(`/projects/${projectId}/release-notification-settings`),
  updateReleaseNotificationSettings: (projectId: any, data: any) =>
    fetchJSON(`/projects/${projectId}/release-notification-settings`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  resetReleaseNotificationSettings: (projectId: any) =>
    fetchJSON(`/projects/${projectId}/release-notification-settings/reset`, { method: 'POST' }),
  listReleaseDigestRecipients: (projectId: any) =>
    fetchJSON(`/projects/${projectId}/release-notification-settings/recipients`),
  addReleaseDigestRecipient: (projectId: any, data: any) =>
    fetchJSON(`/projects/${projectId}/release-notification-settings/recipients`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  updateReleaseDigestRecipient: (projectId: any, recipientId: any, data: any) =>
    fetchJSON(
      `/projects/${projectId}/release-notification-settings/recipients/${encodeURIComponent(
        recipientId,
      )}`,
      {
        method: 'PATCH',
        body: JSON.stringify(data),
      },
    ),
  removeReleaseDigestRecipient: (projectId: any, recipientId: any) =>
    fetchJSON(
      `/projects/${projectId}/release-notification-settings/recipients/${encodeURIComponent(
        recipientId,
      )}`,
      { method: 'DELETE' },
    ),
  getProjectBranches: (projectId: any, refresh = false) =>
    fetchJSON(`/projects/${projectId}/branches${refresh ? '?refresh=1' : ''}`),
  // Agent Hub-hosted git (gitHost: 'agenthub') — see server/routes/git-host.ts
  getGitHostStatus: (projectId: any) => fetchJSON(`/projects/${projectId}/git-host`),
  enableGitHost: (projectId: any, importFrom?: any) =>
    fetchJSON(`/projects/${projectId}/git-host/enable`, {
      method: 'POST',
      body: JSON.stringify(importFrom ? { importFrom } : {}),
    }),
  disableGitHost: (projectId: any) =>
    fetchJSON(`/projects/${projectId}/git-host/disable`, { method: 'POST' }),
  getGitHostBranches: (projectId: any) => fetchJSON(`/projects/${projectId}/git-host/branches`),
  deleteGitHostBranch: (projectId: any, branch: any) =>
    fetchJSON(`/projects/${projectId}/git-host/branches/${encodeURIComponent(branch)}`, {
      method: 'DELETE',
    }),
  setGitHostDefaultBranch: (projectId: any, branch: any) =>
    fetchJSON(`/projects/${projectId}/git-host/default-branch`, {
      method: 'POST',
      body: JSON.stringify({ branch }),
    }),
  getGitHostCommits: (projectId: any, { branch, limit = 50 }: any = {}) => {
    const params = new URLSearchParams();
    if (branch) params.set('branch', branch);
    params.set('limit', String(limit));
    return fetchJSON(`/projects/${projectId}/git-host/commits?${params}`);
  },
  getGitHostCommitDetail: (projectId: any, sha: any) =>
    fetchJSON(`/projects/${projectId}/git-host/commits/${encodeURIComponent(sha)}`),
  getGitHostReadme: (projectId: any, { branch }: any = {}) => {
    const params = new URLSearchParams();
    if (branch) params.set('branch', branch);
    const qs = params.toString();
    return fetchJSON(`/projects/${projectId}/git-host/readme${qs ? `?${qs}` : ''}`);
  },
  // GitHub mirror sync status + on-demand reconcile (two-way sync).
  getGitHostMirror: (projectId: any) => fetchJSON(`/projects/${projectId}/git-host/mirror`),
  reconcileGitHostMirror: (projectId: any) =>
    fetchJSON(`/projects/${projectId}/git-host/mirror/reconcile`, { method: 'POST' }),
  // Per-user Google connection (Settings -> Account). Never returns tokens.
  getGoogleStatus: () => fetchJSON('/auth/google/status'),
  // Returns { authorizeUrl }; the caller does a full-page redirect to it.
  // `scopes` (string or string[]) requests extra per-surface scopes for
  // incremental consent; identity scopes are always added server-side.
  startGoogleOAuth: ({
    returnTo,
    scopes,
  }: { returnTo?: string; scopes?: string | string[] } = {}) => {
    const params = new URLSearchParams();
    if (returnTo) params.set('returnTo', returnTo);
    if (scopes) params.set('scopes', Array.isArray(scopes) ? scopes.join(' ') : scopes);
    const qs = params.toString();
    return fetchJSON<{ authorizeUrl: string }>(`/auth/google/start${qs ? `?${qs}` : ''}`);
  },
  disconnectGoogle: () => fetchJSON('/auth/google/connect', { method: 'DELETE' }),
  // Cross-project personal todos (spec TODO-MODEL). Scoped server-side to the
  // authenticated user; every write broadcasts `user_todo_update` to the owner.
  listTodos: (status?: 'open' | 'done') => {
    const qs = status ? `?status=${status}` : '';
    return fetchJSON<{ todos: UserTodoWire[] }>(`/me/todos${qs}`);
  },
  createTodo: (data: CreateTodoBody) =>
    fetchJSON<{ todo: UserTodoWire }>('/me/todos', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  updateTodo: (id: string, data: UpdateTodoBody) =>
    fetchJSON<{ todo: UserTodoWire }>(`/me/todos/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  deleteTodo: (id: string) =>
    fetchJSON<{ ok: true }>(`/me/todos/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  // Link a todo to an EXISTING card / epic / session (spec TODO-TO-TICKET LINK
  // op). RBAC-gated server-side (caller must be able to see the target).
  linkTodo: (
    id: string,
    data: { targetType: TodoLinkType; targetId: string; projectId?: string },
  ) =>
    fetchJSON<{ todo: UserTodoWire }>(`/me/todos/${encodeURIComponent(id)}/link`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  unlinkTodo: (id: string) =>
    fetchJSON<{ todo: UserTodoWire }>(`/me/todos/${encodeURIComponent(id)}/link`, {
      method: 'DELETE',
    }),
  // Promote a todo to a NEW project ticket (spec TODO-TO-TICKET PROMOTE op).
  // Creates a real kanban card on the target board (To Do by default), carries
  // over the todo's priority unless overridden, stamps the card's provenance
  // back to the todo, and links the todo to the created card. Returns both.
  promoteTodo: (
    id: string,
    data: { projectId: string; columnId?: string; epicId?: string; priority?: TodoPriority },
  ) =>
    fetchJSON<{ todo: UserTodoWire; card: any }>(`/me/todos/${encodeURIComponent(id)}/promote`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  // Reverse side of the polymorphic link: the caller's own todos that point at
  // a given target (bidirectional display).
  getLinkedTodos: (target: { targetType: TodoLinkType; targetId: string; projectId?: string }) => {
    const params = new URLSearchParams({
      targetType: target.targetType,
      targetId: target.targetId,
    });
    if (target.projectId) params.set('projectId', target.projectId);
    return fetchJSON<{ todos: UserTodoWire[] }>(`/me/todos/linked?${params}`);
  },
  reorderTodos: (orderedIds: string[]) =>
    fetchJSON<{ todos: UserTodoWire[] }>('/me/todos/reorder', {
      method: 'POST',
      body: JSON.stringify({ orderedIds }),
    }),
  // Per-user cross-project aggregation for the Dashboard home (spec
  // AGGREGATION). One RBAC-filtered fan-out; cached server-side, `fresh` busts
  // the cache. `date`/`tz` bracket the caller's local day for the calendar pane.
  getMeDashboard: (opts: { fresh?: boolean; date?: string; tz?: string } = {}) => {
    const params = new URLSearchParams();
    if (opts.fresh) params.set('fresh', '1');
    if (opts.date) params.set('date', opts.date);
    if (opts.tz) params.set('tz', opts.tz);
    const qs = params.toString();
    return fetchJSON<MeDashboardWire>(`/me/dashboard${qs ? `?${qs}` : ''}`);
  },
  getMyWork: () => fetchJSON<DashboardWorkWire>('/me/work'),
  listGoogleCalendarEvents: ({
    calendarId,
    timeMin,
    timeMax,
    timeZone,
    maxResults,
    pageToken,
    q,
  }: any) => {
    const params = new URLSearchParams();
    if (calendarId) params.set('calendarId', calendarId);
    params.set('timeMin', timeMin);
    params.set('timeMax', timeMax);
    if (timeZone) params.set('timeZone', timeZone);
    if (maxResults) params.set('maxResults', String(maxResults));
    if (pageToken) params.set('pageToken', pageToken);
    if (q) params.set('q', q);
    return fetchJSON(`/google/calendar/events?${params.toString()}`);
  },
  createGoogleCalendarEvent: (data: any) =>
    fetchJSON('/google/calendar/events', { method: 'POST', body: JSON.stringify(data) }),
  updateGoogleCalendarEvent: (eventId: any, data: any) =>
    fetchJSON(`/google/calendar/events/${encodeURIComponent(eventId)}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  // Gmail proxy (user-scoped). Tokens stay server-side; clients never hold them.
  listGoogleGmailThreads: ({
    q,
    labelIds,
    maxResults,
    pageToken,
    includeSpamTrash,
  }: {
    q?: string;
    labelIds?: string | string[];
    maxResults?: number;
    pageToken?: string;
    includeSpamTrash?: boolean;
  } = {}) => {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (labelIds) {
      for (const id of Array.isArray(labelIds) ? labelIds : [labelIds])
        params.append('labelIds', id);
    }
    if (maxResults) params.set('maxResults', String(maxResults));
    if (pageToken) params.set('pageToken', pageToken);
    if (includeSpamTrash !== undefined)
      params.set('includeSpamTrash', includeSpamTrash ? 'true' : 'false');
    const qs = params.toString();
    return fetchJSON(`/google/gmail/threads${qs ? `?${qs}` : ''}`);
  },
  getGoogleGmailThread: (threadId: any, { format }: { format?: string } = {}) => {
    const params = new URLSearchParams();
    if (format) params.set('format', format);
    const qs = params.toString();
    return fetchJSON(`/google/gmail/threads/${encodeURIComponent(threadId)}${qs ? `?${qs}` : ''}`);
  },
  sendGoogleGmailMessage: (data: any) =>
    fetchJSON('/google/gmail/messages', { method: 'POST', body: JSON.stringify(data) }),
  // Drive proxy (user-scoped, drive.file only). Lists and creates
  // app-accessible Drive / Docs files. Tokens stay server-side.
  listGoogleDriveFiles: ({
    q,
    pageSize,
    pageToken,
    orderBy,
  }: {
    q?: string;
    pageSize?: number;
    pageToken?: string;
    orderBy?: string;
  } = {}) => {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (pageSize) params.set('pageSize', String(pageSize));
    if (pageToken) params.set('pageToken', pageToken);
    if (orderBy) params.set('orderBy', orderBy);
    const qs = params.toString();
    return fetchJSON(`/google/drive/files${qs ? `?${qs}` : ''}`);
  },
  getGoogleDriveFile: (fileId: any) =>
    fetchJSON(`/google/drive/files/${encodeURIComponent(fileId)}`),
  createGoogleDriveFile: (data: any) =>
    fetchJSON('/google/drive/files', { method: 'POST', body: JSON.stringify(data) }),
  // Sheets proxy (user-scoped). Tokens stay server-side; clients never hold them.
  getGoogleSpreadsheet: (spreadsheetId: any) =>
    fetchJSON(`/google/sheets/${encodeURIComponent(spreadsheetId)}`),
  readGoogleSheetValues: (
    spreadsheetId: any,
    {
      range,
      majorDimension,
      valueRenderOption,
      dateTimeRenderOption,
    }: {
      range: string;
      majorDimension?: string;
      valueRenderOption?: string;
      dateTimeRenderOption?: string;
    },
  ) => {
    const params = new URLSearchParams();
    params.set('range', range);
    if (majorDimension) params.set('majorDimension', majorDimension);
    if (valueRenderOption) params.set('valueRenderOption', valueRenderOption);
    if (dateTimeRenderOption) params.set('dateTimeRenderOption', dateTimeRenderOption);
    return fetchJSON(
      `/google/sheets/${encodeURIComponent(spreadsheetId)}/values?${params.toString()}`,
    );
  },
  updateGoogleSheetValues: (spreadsheetId: any, data: any) =>
    fetchJSON(`/google/sheets/${encodeURIComponent(spreadsheetId)}/values`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  appendGoogleSheetValues: (spreadsheetId: any, data: any) =>
    fetchJSON(`/google/sheets/${encodeURIComponent(spreadsheetId)}/values/append`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  getProjectSecrets: (projectId: any) => fetchJSON(`/projects/${projectId}/secrets`),
  putProjectSecrets: (projectId: any, secrets: any) =>
    fetchJSON(`/projects/${projectId}/secrets`, {
      method: 'PUT',
      body: JSON.stringify({ secrets }),
    }),
  importProjectSecrets: (projectId: any, env: any, opts: any = {}) =>
    fetchJSON(`/projects/${projectId}/secrets/import`, {
      method: 'POST',
      body: JSON.stringify({
        env,
        mode: opts.mode || 'merge',
        defaultKind: opts.defaultKind,
      }),
    }),
  getProjectAwsProfiles: (projectId: any) => fetchJSON(`/projects/${projectId}/aws-profiles`),
  putProjectAwsProfiles: (projectId: any, profiles: any) =>
    fetchJSON(`/projects/${projectId}/aws-profiles`, {
      method: 'PUT',
      body: JSON.stringify({ profiles }),
    }),
  getProjectAwsSsoStatus: (projectId: any, profile: any) =>
    fetchJSON(`/projects/${projectId}/aws-sso/status?profile=${encodeURIComponent(profile)}`),
  startProjectAwsSsoLogin: (projectId: any, profile: any) =>
    fetchJSON(`/projects/${projectId}/aws-sso/login`, {
      method: 'POST',
      body: JSON.stringify({ profile }),
      timeout: 60_000,
    }),
  // Persist the sidebar project order. `projectIds` must be a permutation
  // of the caller-visible project ids (see PUT /api/projects/order). The
  // server broadcasts `projects_updated` so other open clients refresh.
  reorderProjects: (projectIds: any) =>
    fetchJSON('/projects/order', {
      method: 'PUT',
      body: JSON.stringify({ projectIds }),
    }),
  // Re-detect preview defaults by sniffing the project's checkout. Pure
  // read — server does not mutate `projects.json`. Returns
  // `{ detected: { stack, startScript, port, captureRoutes, idleTTL } | null }`.
  detectProjectPreview: (projectId: any) =>
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
  testProjectPreview: (projectId: any) =>
    fetchJSON(`/projects/${projectId}/preview/test`, {
      method: 'POST',
      body: JSON.stringify({}),
      timeout: 60_000,
    }),
  // Settings → Preview: repo scan + compose draft (no agent session).
  getPreviewEnvironmentDraft: (projectId: any) =>
    fetchJSON(`/projects/${projectId}/preview/environment-draft`),
  getFinalizeEnvironmentDraft: (projectId: any) =>
    fetchJSON(`/projects/${projectId}/finalize/environment-draft`),
  // Default guided setup — spawns wizard session; opens chat in UI.
  startPreviewWizard: (projectId: any) =>
    fetchJSON(`/projects/${projectId}/preview/setup-wizard`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  // Finalize Code Changes — `.agent-hub/ci.yaml` setup wizard.
  // Spawns a guided chat session loaded with the `finalize-setup`
  // skill. Returns `{ sessionId, agentId, draft, session }`.
  startFinalizeWizard: (projectId: any) =>
    fetchJSON(`/projects/${projectId}/finalize/setup-wizard`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  // Commit a wizard-generated ci.yaml to the worktree. The optional
  // `sessionId` overrides the "most recent project session with a
  // worktree" heuristic. Returns `{ ok, file, commit_sha, branch,
  // session_id }`.
  applyFinalizeWizardConfig: (projectId: any, { ciYamlContent, sessionId, secrets }: any = {}) =>
    fetchJSON(`/projects/${projectId}/finalize/setup-apply`, {
      method: 'POST',
      body: JSON.stringify({
        ci_yaml_content: ciYamlContent,
        ...(sessionId ? { session_id: sessionId } : {}),
        ...(secrets ? { secrets } : {}),
      }),
    }),
  // Notify Settings that the Finalize wizard finished.
  completeFinalizeWizard: (projectId: any) =>
    fetchJSON(`/projects/${projectId}/finalize/wizard-complete`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  // ── AI RUM (real user monitoring) setup wizard ──────────────────
  // Read-only repo scan: framework, injection target, CSP hits,
  // already-instrumented status. Returns `{ projectId, draft }`.
  getRumSetupDraft: (projectId: any) => fetchJSON(`/projects/${projectId}/rum/setup-draft`),
  // Spawn the worktree-backed `[RUM Setup]` wizard session loaded with
  // the `rum-setup` skill. `maskAllText` (default false) is the per-target-app
  // masking policy baked into the injected recorder. Returns
  // `{ sessionId, agentId, draft, session }`.
  startRumWizard: (projectId: any, { maskAllText = false }: any = {}) =>
    fetchJSON(`/projects/${projectId}/rum/setup-wizard`, {
      method: 'POST',
      body: JSON.stringify({ maskAllText: !!maskAllText }),
    }),
  // Per-project RUM ingest clients (vendor-site `X-RUM-Token` creds).
  // List active (non-revoked) clients — metadata only, never the token.
  getRumClients: (projectId: any) => fetchJSON(`/projects/${projectId}/rum/clients`),
  // Mint a new ingest token. The plaintext `token` is returned ONCE.
  createRumClient: (projectId: any, name: any) =>
    fetchJSON(`/projects/${projectId}/rum/clients`, {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),
  // Revoke (soft-delete) an ingest client.
  revokeRumClient: (projectId: any, clientId: any) =>
    fetchJSON(`/projects/${projectId}/rum/clients/${clientId}`, { method: 'DELETE' }),
  // ── Application log sources (write-only `ahlog_` ingest credentials) ──
  // List a project's log sources — metadata only, never token material.
  getLogSources: (projectId: any) => fetchJSON(`/projects/${projectId}/log-sources`),
  // Create a source + mint its ingest token. Plaintext `token` returned ONCE.
  createLogSource: (projectId: any, body: any) =>
    fetchJSON(`/projects/${projectId}/log-sources`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  // Rotate a source's token — new plaintext `token` returned ONCE.
  rotateLogSource: (projectId: any, sourceId: any) =>
    fetchJSON(`/projects/${projectId}/log-sources/${sourceId}/rotate`, { method: 'POST' }),
  // Revoke a source's token (write-disable; row kept for audit).
  revokeLogSource: (projectId: any, sourceId: any) =>
    fetchJSON(`/projects/${projectId}/log-sources/${sourceId}/revoke`, { method: 'POST' }),
  // Delete a source and its token entirely.
  deleteLogSource: (projectId: any, sourceId: any) =>
    fetchJSON(`/projects/${projectId}/log-sources/${sourceId}`, { method: 'DELETE' }),
  // Per-project log-store health metrics (quota, retention, db bytes, …).
  getLogsMetrics: (projectId: any) => fetchJSON(`/projects/${projectId}/logs/metrics`),
  // ── Application log reads (LOG-QUERY) ──────────────────────────────────
  // Bounded, newest-first, cursor-paginated historical query. `params` is a
  // plain object of the query filters (severity, source, service, text, …).
  queryLogs: (projectId: any, params: Record<string, any> = {}) => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value == null || value === '') continue;
      search.set(key, String(value));
    }
    const qs = search.toString();
    return fetchJSON(`/projects/${projectId}/logs${qs ? `?${qs}` : ''}`);
  },
  // ── Grouped error issues (LOG-GROUP) ───────────────────────────────────
  listLogIssues: (projectId: any, params: Record<string, any> = {}) => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value == null || value === '') continue;
      search.set(key, String(value));
    }
    const qs = search.toString();
    return fetchJSON(`/projects/${projectId}/logs/issues${qs ? `?${qs}` : ''}`);
  },
  getLogIssue: (projectId: any, issueId: any) =>
    fetchJSON(`/projects/${projectId}/logs/issues/${encodeURIComponent(issueId)}`),
  resolveLogIssue: (projectId: any, issueId: any) =>
    fetchJSON(`/projects/${projectId}/logs/issues/${encodeURIComponent(issueId)}/resolve`, {
      method: 'POST',
    }),
  ignoreLogIssue: (projectId: any, issueId: any) =>
    fetchJSON(`/projects/${projectId}/logs/issues/${encodeURIComponent(issueId)}/ignore`, {
      method: 'POST',
    }),
  reopenLogIssue: (projectId: any, issueId: any) =>
    fetchJSON(`/projects/${projectId}/logs/issues/${encodeURIComponent(issueId)}/reopen`, {
      method: 'POST',
    }),
  analyzeLogIssue: (projectId: any, issueId: any) =>
    fetchJSON(`/projects/${projectId}/logs/issues/${encodeURIComponent(issueId)}/analyze`, {
      method: 'POST',
    }),
  fixLogIssue: (projectId: any, issueId: any) =>
    fetchJSON(`/projects/${projectId}/logs/issues/${encodeURIComponent(issueId)}/fix`, {
      method: 'POST',
    }),
  // Single-path configure + secrets + compose boot test. Admin+.
  buildPreviewEnvironment: (projectId: any, body: any) =>
    fetchJSON(`/projects/${projectId}/preview/build`, {
      method: 'POST',
      body: JSON.stringify(body),
      timeout: 200_000,
    }),
  /** Boot worktree preview for a chat session (user toolbar only). */
  startSessionPreview: (sessionId: any, body: any = {}) =>
    fetchJSON(`/sessions/${sessionId}/preview/start`, {
      method: 'POST',
      body: JSON.stringify(body),
      timeout: 200_000,
    }),
  /** Clone or attach the session worktree before the first chat turn. */
  ensureSessionWorkspace: (sessionId: any) =>
    fetchJSON(`/sessions/${sessionId}/workspace/ensure`, {
      method: 'POST',
      body: JSON.stringify({}),
      timeout: 300_000,
    }),
  deleteProject: (projectId: any) =>
    fetch(`${getApiBase()}/projects/${projectId}`, {
      method: 'DELETE',
      headers: { ...getAuthHeaders() },
    }).then((res: any) => {
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      return null;
    }),
  // Hub workflows (manual runs — MVP)
  getProjectWorkflows: (projectId: any) => fetchJSON(`/projects/${projectId}/workflows`),
  getProjectWorkflow: (projectId: any, workflowId: any) =>
    fetchJSON(`/projects/${projectId}/workflows/${workflowId}`),
  startWorkflowRun: (projectId: any, workflowId: any, runPayload?: any) =>
    fetchJSON(`/projects/${projectId}/workflows/${workflowId}/runs`, {
      method: 'POST',
      body: JSON.stringify(runPayload === undefined ? {} : { payload: runPayload }),
      timeout: null,
    }),
  getWorkflowRuns: (projectId: any, workflowId: any, { limit }: any = {}) => {
    const q = limit != null ? `?limit=${encodeURIComponent(String(limit))}` : '';
    return fetchJSON(`/projects/${projectId}/workflows/${workflowId}/runs${q}`);
  },
  getWorkflowRunDetail: (projectId: any, workflowId: any, runId: any) =>
    fetchJSON(`/projects/${projectId}/workflows/${workflowId}/runs/${runId}`),
  cancelWorkflowRun: (projectId: any, workflowId: any, runId: any) =>
    fetchJSON(`/projects/${projectId}/workflows/${workflowId}/runs/${runId}/cancel`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  // Deployment Module - deploy.yaml environments + run actions.
  getDeployConfig: (projectId: any) => fetchJSON(`/projects/${projectId}/deploy/config`),
  // Resolved environment view (deploy.yaml declarations + operator runtime config,
  // including orphaned rows) used by the environments management surface.
  getDeployEnvironments: (projectId: any) =>
    fetchJSON(`/projects/${projectId}/deploy/environments`),
  setDeployEnvironmentEnabled: (projectId: any, environmentName: any, enabled: boolean) =>
    fetchJSON(`/projects/${projectId}/deploy/environments/${encodeURIComponent(environmentName)}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    }),
  deleteDeployEnvironmentConfig: (projectId: any, environmentName: any) =>
    fetchJSON(`/projects/${projectId}/deploy/environments/${encodeURIComponent(environmentName)}`, {
      method: 'DELETE',
    }),
  // Per-environment deploy triggers (deploy-triggers epic decision): git-event
  // rules that enqueue a deployment when a matching push/merge updates a branch.
  listDeployTriggers: (projectId: string, environmentName: string) =>
    fetchJSON(
      `/projects/${projectId}/deploy/environments/${encodeURIComponent(environmentName)}/triggers`,
    ),
  createDeployTrigger: (
    projectId: string,
    environmentName: string,
    body: CreateDeployTriggerBody,
  ) =>
    fetchJSON(
      `/projects/${projectId}/deploy/environments/${encodeURIComponent(environmentName)}/triggers`,
      {
        method: 'POST',
        body: JSON.stringify(body),
      },
    ),
  updateDeployTrigger: (
    projectId: string,
    environmentName: string,
    triggerId: string,
    body: UpdateDeployTriggerBody,
  ) =>
    fetchJSON(
      `/projects/${projectId}/deploy/environments/${encodeURIComponent(
        environmentName,
      )}/triggers/${triggerId}`,
      {
        method: 'PATCH',
        body: JSON.stringify(body),
      },
    ),
  deleteDeployTrigger: (projectId: string, environmentName: string, triggerId: string) =>
    fetchJSON(
      `/projects/${projectId}/deploy/environments/${encodeURIComponent(
        environmentName,
      )}/triggers/${triggerId}`,
      {
        method: 'DELETE',
      },
    ),
  // Per-environment deploy schedules (deploy-scheduling epic decision): cron rules
  // that enqueue a deployment of a ref under the owner's identity. Editable
  // without touching deploy.yaml; a disabled schedule is a retained pause.
  listDeploySchedules: (projectId: string, environmentName: string) =>
    fetchJSON(
      `/projects/${projectId}/deploy/environments/${encodeURIComponent(environmentName)}/schedules`,
    ),
  createDeploySchedule: (
    projectId: string,
    environmentName: string,
    body: CreateDeployScheduleBody,
  ) =>
    fetchJSON(
      `/projects/${projectId}/deploy/environments/${encodeURIComponent(environmentName)}/schedules`,
      {
        method: 'POST',
        body: JSON.stringify(body),
      },
    ),
  updateDeploySchedule: (
    projectId: string,
    environmentName: string,
    scheduleId: string,
    body: UpdateDeployScheduleBody,
  ) =>
    fetchJSON(
      `/projects/${projectId}/deploy/environments/${encodeURIComponent(
        environmentName,
      )}/schedules/${scheduleId}`,
      {
        method: 'PATCH',
        body: JSON.stringify(body),
      },
    ),
  deleteDeploySchedule: (projectId: string, environmentName: string, scheduleId: string) =>
    fetchJSON(
      `/projects/${projectId}/deploy/environments/${encodeURIComponent(
        environmentName,
      )}/schedules/${scheduleId}`,
      {
        method: 'DELETE',
      },
    ),
  // Per-environment notification routing (notification-routing epic decision):
  // which release notification types fire on a successful deployment. Editable
  // without touching deploy.yaml; the resolved read reflects the env-name default.
  getNotificationRouting: (projectId: string, environmentName: string) =>
    fetchJSON(
      `/projects/${projectId}/deploy/environments/${encodeURIComponent(
        environmentName,
      )}/notification-routing`,
    ),
  updateNotificationRouting: (
    projectId: string,
    environmentName: string,
    body: UpdateNotificationRoutingBody,
  ) =>
    fetchJSON(
      `/projects/${projectId}/deploy/environments/${encodeURIComponent(
        environmentName,
      )}/notification-routing`,
      {
        method: 'PUT',
        body: JSON.stringify(body),
      },
    ),
  startDeployWizard: (projectId: any) =>
    fetchJSON(`/projects/${projectId}/deploy/setup-wizard`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  listDeployments: (projectId: any, { environment, limit, offset }: any = {}) => {
    const params = new URLSearchParams();
    if (environment) params.set('environment', environment);
    if (limit != null) params.set('limit', String(limit));
    if (offset) params.set('offset', String(offset));
    const qs = params.toString();
    return fetchJSON(`/projects/${projectId}/deployments${qs ? `?${qs}` : ''}`);
  },
  getDeployment: (projectId: any, deploymentId: any) =>
    fetchJSON(`/projects/${projectId}/deployments/${deploymentId}`),
  // Admin-only: who a deployment's release notifications were (or will be) sent
  // to, including recipient email (PII). Server gates with requireRole('Admin').
  getDeploymentNotificationRecipients: (projectId: any, deploymentId: any) =>
    fetchJSON(`/projects/${projectId}/deployments/${deploymentId}/notification-recipients`),
  retryReleaseNotification: (projectId: any, deploymentId: any, notificationId: any) =>
    fetchJSON(
      `/projects/${projectId}/deployments/${deploymentId}/release-notifications/${encodeURIComponent(
        notificationId,
      )}/retry`,
      {
        method: 'POST',
        body: JSON.stringify({}),
      },
    ),
  adjustDeploymentReleaseItem: (projectId: any, deploymentId: any, cardId: any, body: any) =>
    fetchJSON(`/projects/${projectId}/deployments/${deploymentId}/release-items/${cardId}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  triggerDeployment: (projectId: any, environment: any, body: any) =>
    fetchJSON(`/projects/${projectId}/deployments`, {
      method: 'POST',
      body: JSON.stringify({ ...body, environment }),
      timeout: null,
    }),
  rollbackDeployment: (projectId: any, deploymentId: any, body: any = {}) =>
    fetchJSON(`/projects/${projectId}/deployments/${deploymentId}/rollback`, {
      method: 'POST',
      body: JSON.stringify(body),
      timeout: null,
    }),
  approveDeployment: (projectId: any, deploymentId: any, body: any = {}) =>
    fetchJSON(`/projects/${projectId}/deployments/${deploymentId}/approve`, {
      method: 'POST',
      body: JSON.stringify(body),
      timeout: null,
    }),
  // AI-suggest name/appType/stack from a description (wizard idk-fill).
  suggestProjectSetup: (data: any) =>
    fetchJSON('/projects/provision/suggest', {
      method: 'POST',
      body: JSON.stringify(data),
      timeout: 90000,
    }),
  createProjectWorkflow: (projectId: any, body: any) =>
    fetchJSON(`/projects/${projectId}/workflows`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updateProjectWorkflow: (projectId: any, workflowId: any, body: any) =>
    fetchJSON(`/projects/${projectId}/workflows/${workflowId}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  rotateWorkflowWebhookSecret: (projectId: any, workflowId: any) =>
    fetchJSON(`/projects/${projectId}/workflows/${workflowId}/webhook/rotate`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),

  // Agents & Sessions
  getAgents: () => fetchJSON<AgentWire[]>('/agents'),
  getSessions: (agentId: string) => fetchJSON<SessionWire[]>(`/agents/${agentId}/sessions`),
  createSession: (
    agentId: string,
    name?: string,
    { consultMode }: { consultMode?: boolean } = {},
  ) =>
    fetchJSON<SessionWire>(`/agents/${agentId}/sessions`, {
      method: 'POST',
      body: JSON.stringify({
        name,
        ...(consultMode ? { session_mode: 'consult' } : {}),
      }),
    }),
  /**
   * Fetch session messages (oldest-first array).
   *
   * - No opts → full transcript (legacy; large sessions may be truncated).
   * - `{ limit }` → newest N via DB-side keyset pagination (reverse infinite
   *   scroll initial page).
   * - `{ limit, before }` → the page of messages immediately older than the
   *   `before` message id (scroll-up older page).
   *
   * Always resolves to a plain array so existing callers stay unchanged; the
   * caller infers "older messages exist" from whether a full page came back.
   */
  getMessages: async (
    sessionId: string,
    opts: { limit?: number; before?: string | number } = {},
  ): Promise<MessageWire[]> => {
    const params = new URLSearchParams();
    if (opts.limit != null) params.set('limit', String(opts.limit));
    if (opts.before != null) params.set('before', String(opts.before));
    if (opts.limit != null || opts.before != null) params.set('paginated', '1');
    const qs = params.toString();
    const data = await fetchJSON(`/sessions/${sessionId}/messages${qs ? `?${qs}` : ''}`);
    return normalizeSessionMessagesResponse(data).messages;
  },
  getSessionHandoffs: (sessionId: any) => fetchJSON(`/sessions/${sessionId}/handoffs`),
  /**
   * Historical delegations for this session, ordered `started_at DESC`.
   * Hydrates `delegations[sessionId]` on session load so message-anchored
   * `<delegate>` cards in past assistant messages render their real terminal
   * status (done/error/cancelled) instead of the "Queued" placeholder.
   */
  getSessionDelegations: (sessionId: any) => fetchJSON(`/sessions/${sessionId}/delegations`),
  /** Session sidebar: linked kanban card, skills, aggregated run snapshot from message events. */
  getSessionSummary: (sessionId: any) => fetchJSON(`/sessions/${sessionId}/summary`),
  /** Live git status — uncommitted or unpushed work in the session worktree. */
  getSessionWorktreeChanges: (sessionId: any, opts: any = {}) =>
    fetchJSON(`/sessions/${sessionId}/worktree-changes`, { signal: opts.signal }),
  /** Documents an agent generated during the session (Artifacts panel). */
  getSessionArtifacts: (sessionId: any, opts: any = {}) =>
    fetchJSON(`/sessions/${sessionId}/artifacts`, { signal: opts.signal }),
  deleteSessionArtifact: (sessionId: any, artifactId: any) =>
    fetchJSON(`/sessions/${sessionId}/artifacts/${artifactId}`, { method: 'DELETE' }),
  /**
   * Most-recent Finalize run for a session. Returns `{ run: null }` when
   * the session has never triggered a Finalize run — used by the read-only
   * reviewer-threads sidecar to discover its current run id.
   *
   * `opts.signal` lets the sidecar cancel an in-flight request when the
   * caller unmounts (or the user switches sessions) so a slow response
   * can't resolve into a stale React state setter after teardown.
   */
  getLatestFinalizeRunForSession: (sessionId: any, opts: any = {}) =>
    // `includeStale=0` skips the server's `git rev-parse HEAD` spawn: the UI
    // only consumes `run`/`steps`/`phases`, and the spawn on this hot-path poll
    // is what delays queued step rows from appearing during a busy run.
    fetchJSON(`/sessions/${sessionId}/finalize-runs/latest?includeStale=0`, {
      signal: opts.signal,
    }),
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
  startFinalizeRun: (projectId: any, cardId: any, { mode = 'full' }: any = {}) =>
    fetchJSON(`/projects/${projectId}/cards/${cardId}/finalize`, {
      method: 'POST',
      body: JSON.stringify({ mode }),
    }),
  /**
   * Kick off Finalize for an ad-hoc session. Creates a kanban card on first
   * use when the session is not already card-linked. See `startFinalizeRun`
   * for the `mode` contract.
   */
  startFinalizeRunForSession: (projectId: any, sessionId: any, { mode = 'full' }: any = {}) =>
    fetchJSON(`/projects/${projectId}/sessions/${sessionId}/finalize`, {
      method: 'POST',
      body: JSON.stringify({ mode }),
    }),
  pushFinalizeRun: (projectId: any, runId: any, { force = false }: any = {}) =>
    fetchJSON(`/projects/${projectId}/finalize/${runId}/push`, {
      method: 'POST',
      body: JSON.stringify({ force }),
    }),
  pushSessionToGithub: (projectId: any, sessionId: any, { force = false }: any = {}) =>
    fetchJSON(`/projects/${projectId}/sessions/${sessionId}/push-to-github`, {
      method: 'POST',
      body: JSON.stringify({ force }),
    }),
  // Unified diff for a PR (text/plain) — GitHub or Agent Hub-native by URL.
  getPrDiffText: async (prUrl: any) => {
    const res = await fetch(`${getApiBase()}/pr/diff?prUrl=${encodeURIComponent(prUrl)}`, {
      headers: { ...getAuthHeaders() },
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`Diff fetch failed (${res.status})`);
    return res.text();
  },
  // Edit a native (Agent Hub-hosted) pull request's title/body.
  updateNativePr: (projectId: any, number: any, data: any) =>
    fetchJSON(`/projects/${projectId}/pulls/${number}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  // Create (or reuse) a native PR for a branch already pushed to the Hub.
  createNativePr: (projectId: any, data: any) =>
    fetchJSON(`/projects/${projectId}/pulls`, { method: 'POST', body: JSON.stringify(data) }),
  getNativePrBranchChanges: (projectId: any, headBranch: any, baseBranch?: any) =>
    fetchJSON(`/projects/${projectId}/pulls/branch-changes`, {
      method: 'POST',
      body: JSON.stringify({
        headBranch,
        ...(baseBranch ? { baseBranch } : {}),
      }),
    }),
  // AI-suggested PR title/body from the branch diff (60-90s model call).
  generatePrDescription: (projectId: any, headBranch: any) =>
    fetchJSON(`/projects/${projectId}/pulls/generate-description`, {
      method: 'POST',
      body: JSON.stringify({ headBranch }),
      timeout: 120000,
    }),
  // Recently pushed branches without an open PR (Compare & PR banner).
  getGitHostRecentPushes: (projectId: any) =>
    fetchJSON(`/projects/${projectId}/git-host/recent-pushes`),
  reopenNativePr: (projectId: any, number: any) =>
    fetchJSON(`/projects/${projectId}/pulls/${number}/reopen`, { method: 'POST' }),
  requestNativePrReview: (projectId: any, number: any, requested: any = true) =>
    fetchJSON(`/projects/${projectId}/pulls/${number}/request-review`, {
      method: 'POST',
      body: JSON.stringify({ requested }),
    }),
  submitNativePrReview: (projectId: any, number: any, { state, body = '' }: any) =>
    fetchJSON(`/projects/${projectId}/pulls/${number}/reviews`, {
      method: 'POST',
      body: JSON.stringify({ state, body }),
    }),
  addNativePrComment: (projectId: any, number: any, { filePath, line, side = 'new', body }: any) =>
    fetchJSON(`/projects/${projectId}/pulls/${number}/comments`, {
      method: 'POST',
      body: JSON.stringify({ filePath, line, side, body }),
    }),
  deleteNativePrComment: (projectId: any, number: any, commentId: any) =>
    fetchJSON(`/projects/${projectId}/pulls/${number}/comments/${commentId}`, {
      method: 'DELETE',
    }),
  // Re-run a finished push/pr-ci run — all jobs, or one job when jobId set.
  rerunCiRun: (projectId: any, runId: any, jobId?: any) =>
    fetchJSON(`/projects/${projectId}/ci-runs/${runId}/rerun`, {
      method: 'POST',
      body: JSON.stringify(jobId ? { jobId } : {}),
    }),
  // Run history (Runners page) — finalize + push-CI runs.
  getCiRuns: (projectId: any, { trigger = 'all', limit = 30 }: any = {}) =>
    fetchJSON(`/projects/${projectId}/ci-runs?trigger=${trigger}&limit=${limit}`),
  getCiRunStats: (projectId: any, { range = 'all' }: any = {}) =>
    fetchJSON(`/projects/${projectId}/ci-runs/stats?range=${encodeURIComponent(range)}`),
  getCiRunDetail: (projectId: any, runId: any) =>
    fetchJSON(`/projects/${projectId}/ci-runs/${runId}`),
  getFinalizeStepOutput: (projectId: any, runId: any, stepIndex: any, opts: any = {}) =>
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
  cancelFinalizeRun: (projectId: any, runId: any) =>
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
  getReviewerThreads: (projectId: any, runId: any, opts: any = {}) =>
    fetchJSON(`/projects/${projectId}/finalize/${runId}/reviewer-threads`, {
      signal: opts.signal,
    }),
  /** Per-CI-job resource high-water marks (peak mem / CPU) for a finalize run. */
  getFinalizeRunResources: (projectId: any, runId: any, opts: any = {}) =>
    fetchJSON(`/projects/${projectId}/finalize/${runId}/job-resources`, {
      signal: opts.signal,
    }),
  summarizeSession: (sessionId: any) =>
    fetchJSON(`/sessions/${sessionId}/summarize`, { method: 'POST', timeout: 120000 }),
  // Skill Builder Phase 4 — spawn the coach to extract a skill from this
  // session's transcript. Returns { sessionId, agentId, session }.
  extractSkillFromSession: (sessionId: any) =>
    fetchJSON(`/sessions/${sessionId}/extract-skill`, { method: 'POST', timeout: 30000 }),
  getMessageEvents: (messageId: any) => fetchJSON(`/messages/${messageId}/events`),
  getSessionProgress: (sessionId: any) => fetchJSON(`/sessions/${sessionId}/progress`),
  deleteSession: (sessionId: any) => fetchJSON(`/sessions/${sessionId}`, { method: 'DELETE' }),
  // Soft-delete recovery — rows within the 24-hour window, newest first.
  getArchivedSessions: (agentId: any) => fetchJSON(`/agents/${agentId}/archived-sessions`),
  restoreSession: (sessionId: any) =>
    fetchJSON(`/sessions/${sessionId}/restore`, { method: 'POST' }),
  clearAllSessions: (agentId: any) =>
    fetchJSON(`/agents/${agentId}/sessions`, { method: 'DELETE' }),
  clearPushedSessions: (agentId: any) =>
    fetchJSON(`/agents/${agentId}/sessions/pushed`, { method: 'DELETE' }),
  clearMergedSessions: (agentId: any) =>
    fetchJSON(`/agents/${agentId}/sessions/merged`, { method: 'DELETE' }),
  renameSession: (sessionId: any, name: any) =>
    fetchJSON(`/sessions/${sessionId}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    }),
  /** Session detail with agents roster (executor + advisors). */
  getSessionDetail: (sessionId: string) =>
    fetchJSON<SessionWire & Record<string, unknown>>(`/sessions/${sessionId}`),
  updateSession: (sessionId: any, data: any) =>
    fetchJSON(`/sessions/${sessionId}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  addSessionAgent: (sessionId: any, agentId: any) =>
    fetchJSON(`/sessions/${sessionId}/agents`, {
      method: 'POST',
      body: JSON.stringify({ agentId }),
    }),
  removeSessionAgent: (sessionId: any, agentId: any) =>
    fetchJSON(`/sessions/${sessionId}/agents/${agentId}`, { method: 'DELETE' }),
  setSessionEngine: (sessionId: any, engine: any) =>
    fetchJSON(`/sessions/${sessionId}/engine`, {
      method: 'PUT',
      body: JSON.stringify({ engine }),
    }),
  setSessionModel: (sessionId: any, model: any) =>
    fetchJSON(`/sessions/${sessionId}/model`, {
      method: 'PUT',
      body: JSON.stringify({ model }),
    }),
  /**
   * Link a Design Studio design to a session so its live canvas renders in a
   * preview pane beside the chat. Pass `designId: null` to clear the link.
   */
  setSessionLinkedDesign: (sessionId: any, designId: any) =>
    fetchJSON(`/sessions/${sessionId}/linked-design`, {
      method: 'PUT',
      body: JSON.stringify({ designId: designId ?? null }),
    }),
  setSessionLinkedEpic: (sessionId: any, epicId: any) =>
    fetchJSON(`/sessions/${sessionId}/linked-epic`, {
      method: 'PUT',
      body: JSON.stringify({ epicId: epicId ?? null }),
    }),
  /**
   * Choose (or clear) the existing remote branch this session's worktree is
   * checked out onto. Pass `branch: null` to revert to the default fresh
   * session branch. Only accepted before the worktree is provisioned (409
   * afterward — the branch is then locked).
   */
  setSessionWorktreeBranch: (sessionId: any, branch: any) =>
    fetchJSON(`/sessions/${sessionId}/worktree-branch`, {
      method: 'PUT',
      body: JSON.stringify({ branch: branch ?? null }),
    }),
  // `setSessionWorktree` was removed when Agent Hub locked to
  // worktree-only sessions. The legacy `PUT /sessions/:id/worktree`
  // endpoint no longer exists.

  shipSession: (sessionId: any) =>
    fetchJSON(`/sessions/${sessionId}/ship`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  setSessionAskMode: (sessionId: any, enabled: any) =>
    fetchJSON(`/sessions/${sessionId}/ask-mode`, {
      method: 'PUT',
      body: JSON.stringify({ enabled }),
    }),
  /**
   * Session mode picker: 'chat' (normal build) or 'design' (loads the design
   * skill + renders the in-session canvas pane). The server rejects 'design'
   * for a worktree-less session — surface that error to the caller. Returns the
   * enriched session row.
   */
  setSessionMode: (sessionId: any, mode: any) =>
    fetchJSON(`/sessions/${sessionId}/mode`, {
      method: 'PUT',
      body: JSON.stringify({ mode }),
    }),
  /** Codex reasoning ("thinking") level: 'high' (default) or 'pro' (→ xhigh). */
  setSessionReasoningEffort: (sessionId: any, effort: any) =>
    fetchJSON(`/sessions/${sessionId}/reasoning-effort`, {
      method: 'PUT',
      body: JSON.stringify({ effort }),
    }),
  /** Outer PAV — partial updates: pass only keys you want to change; null clears. */
  setSessionOrchestration: (sessionId: any, body: any) =>
    fetchJSON(`/sessions/${sessionId}/orchestration`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  forwardSession: (sessionId: any, { targetAgentId, messageIds, prompt, autoStart }: any = {}) =>
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

  updateAgent: (agentId: any, data: any) =>
    fetchJSON(`/agents/${agentId}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  createAgent: (data: any) =>
    fetchJSON('/agents', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  bulkSetAllAgentsEngine: ({ engine, model }: any) =>
    fetchJSON('/agents/bulk-engine', {
      method: 'POST',
      body: JSON.stringify({ engine, ...(model ? { model } : {}) }),
    }),
  deleteAgent: (agentId: any) =>
    fetch(`${getApiBase()}/agents/${agentId}`, {
      method: 'DELETE',
      headers: { ...getAuthHeaders() },
    }).then((res: any) => {
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      return null;
    }),

  // MCP Servers
  getMcpServers: (agentId: any) => fetchJSON(`/agents/${agentId}/mcp-servers`),
  updateMcpServers: (agentId: any, mcpServers: any) =>
    fetchJSON(`/agents/${agentId}/mcp-servers`, {
      method: 'PUT',
      body: JSON.stringify({ mcpServers }),
    }),
  updateMcpServer: (agentId: any, serverName: any, config: any) =>
    fetchJSON(`/agents/${agentId}/mcp-servers/${encodeURIComponent(serverName)}`, {
      method: 'PUT',
      body: JSON.stringify(config),
    }),
  deleteMcpServer: (agentId: any, serverName: any) =>
    fetchJSON(`/agents/${agentId}/mcp-servers/${encodeURIComponent(serverName)}`, {
      method: 'DELETE',
    }),

  // Heartbeats
  getHeartbeats: () => fetchJSON('/heartbeats'),
  getHeartbeatLogs: (agentId: any, limit: any = 50) =>
    fetchJSON(`/heartbeats/${agentId}/logs?limit=${limit}`),
  updateHeartbeat: (agentId: any, config: any) =>
    fetchJSON(`/heartbeats/${agentId}`, {
      method: 'PUT',
      body: JSON.stringify(config),
    }),
  runHeartbeat: (agentId: any) =>
    fetchJSON(`/heartbeats/${agentId}/run`, { method: 'POST', timeout: 120000 }),

  // Cron Sessions
  getCronSessions: () => fetchJSON('/sessions/cron'),

  // Crons
  getCrons: () => fetchJSON('/crons'),
  getCronLogs: (id: any, limit: any = 3) => fetchJSON(`/crons/${id}/logs?limit=${limit}`),
  createCron: (data: any) => fetchJSON('/crons', { method: 'POST', body: JSON.stringify(data) }),
  updateCron: (id: any, data: any) =>
    fetchJSON(`/crons/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteCron: (id: any) => fetchJSON(`/crons/${id}`, { method: 'DELETE' }),
  runCron: (id: any) => fetchJSON(`/crons/${id}/run`, { method: 'POST', timeout: 120000 }),

  // Designs (Claude Design — Phase 1)
  getDesigns: () => fetchJSON('/designs'),
  getDesign: (id: any) => fetchJSON(`/designs/${id}`),
  createDesign: ({ name, linkedProjectIds = [] }: any = {}) =>
    fetchJSON('/designs', {
      method: 'POST',
      body: JSON.stringify({ name, linkedProjectIds }),
    }),
  updateDesign: (id: any, data: any) =>
    fetchJSON(`/designs/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteDesign: (id: any) => fetchJSON(`/designs/${id}`, { method: 'DELETE' }),
  getDesignMessages: (id: any) => fetchJSON(`/designs/${id}/messages`),
  getDesignStatus: (id: any) => fetchJSON(`/designs/${id}/status`),
  forwardDesign: (
    id: any,
    {
      targetAgentId,
      prompt,
      autoStart,
      includeMessages = true,
      includeFiles = true,
      messageCount,
    }: any = {},
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
  getSkills: (agentId: any) => fetchJSON(`/agents/${agentId}/skills`),
  getProjectSkills: (projectId: any) => fetchJSON(`/projects/${projectId}/skills`),
  // Project-owned read for the skill editor — works without a reference agent.
  getProjectSkill: (projectId: any, skillId: any) =>
    fetchJSON(`/projects/${projectId}/skills/${encodeURIComponent(skillId)}`),
  getSkill: (agentId: any, skillId: any) => fetchJSON(`/agents/${agentId}/skills/${skillId}`),
  getContext: (agentId: any) => fetchJSON(`/agents/${agentId}/context`),
  saveContext: (agentId: any, filename: any, content: any) =>
    fetchJSON(`/agents/${agentId}/context/${filename}`, {
      method: 'PUT',
      body: JSON.stringify({ content }),
    }),

  createProjectSkill: (projectId: any, body: any) =>
    fetchJSON(`/projects/${projectId}/skills`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updateProjectSkill: (projectId: any, skillId: any, body: any) =>
    fetchJSON(`/projects/${projectId}/skills/${encodeURIComponent(skillId)}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  uninstallSkill: (projectId: any, skillId: any) =>
    fetchJSON(`/projects/${projectId}/skills/${skillId}`, { method: 'DELETE' }),

  // Skill improvement review — agent-suggested lessons pending human review.
  // Approve promotes into the skill's `## Learned Lessons`; reject discards
  // (with optional audit reason). Approve/reject require Admin+.
  getSkillImprovements: (projectId: any, status = 'pending') =>
    fetchJSON(`/projects/${projectId}/skill-improvements?status=${encodeURIComponent(status)}`),
  approveSkillImprovement: (projectId: any, skillId: any, improvementId: any) =>
    fetchJSON(
      `/projects/${projectId}/skills/${encodeURIComponent(skillId)}/improvements/${encodeURIComponent(improvementId)}/approve`,
      { method: 'POST' },
    ),
  rejectSkillImprovement: (projectId: any, skillId: any, improvementId: any, reason?: any) =>
    fetchJSON(
      `/projects/${projectId}/skills/${encodeURIComponent(skillId)}/improvements/${encodeURIComponent(improvementId)}/reject`,
      { method: 'POST', body: JSON.stringify(reason ? { reason } : {}) },
    ),

  // Global (shared) skills — written to the data-dir global tier, visible to
  // every agent in every project (precedence: project > global > bundled).
  getGlobalSkills: () => fetchJSON(`/global-skills`),
  getGlobalSkill: (skillId: any) => fetchJSON(`/global-skills/${encodeURIComponent(skillId)}`),
  createGlobalSkill: (body: any) =>
    fetchJSON(`/global-skills`, { method: 'POST', body: JSON.stringify(body) }),
  updateGlobalSkill: (skillId: any, body: any) =>
    fetchJSON(`/global-skills/${encodeURIComponent(skillId)}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  deleteGlobalSkill: (skillId: any) =>
    fetchJSON(`/global-skills/${encodeURIComponent(skillId)}`, { method: 'DELETE' }),
  toggleSkill: (agentId: any, skillId: any, enabled: any) =>
    fetchJSON(`/agents/${agentId}/skills/${skillId}/toggle`, {
      method: 'PUT',
      body: JSON.stringify({ enabled }),
    }),
  getSkillOverrides: (agentId: any) => fetchJSON(`/agents/${agentId}/skills/overrides`),

  // Upload
  uploadImage: (dataUrl: any, filename: any) =>
    fetchJSON('/upload', {
      method: 'POST',
      body: JSON.stringify({ dataUrl, filename }),
    }),

  // Binary file upload (for videos, PDFs, and large files — avoids base64 overhead).
  // Bypasses fetchJSON because the body is a raw Blob, not JSON — so it must
  // attach auth headers itself. Omitting getAuthHeaders() here was the cause of
  // "Attachment upload failed: Authentication required" on JWT-enabled
  // deployments (the request arrived with no credentials → 401).
  uploadFile: async (file: any) => {
    const base = getApiBase();
    const resp = await fetch(`${base}/upload/file`, {
      method: 'POST',
      headers: {
        ...getAuthHeaders(),
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
  getSlackMessages: (agentId: any, limit: any = 50) =>
    fetchJSON(`/slack/messages?${agentId ? `agentId=${agentId}&` : ''}limit=${limit}`),

  // Slack bot management
  listSlackBots: () => fetchJSON('/slack/bots'),
  createSlackBot: (data: any) =>
    fetchJSON('/slack/bots', { method: 'POST', body: JSON.stringify(data) }),
  updateSlackBot: (id: any, data: any) =>
    fetchJSON(`/slack/bots/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteSlackBot: (id: any) => fetchJSON(`/slack/bots/${id}`, { method: 'DELETE' }),
  toggleSlackBot: (id: any) => fetchJSON(`/slack/bots/${id}/toggle`, { method: 'POST' }),
  testSlackBotConnection: (id: any, data?: any) =>
    fetchJSON(`/slack/bots/${id}/test`, { method: 'POST', body: JSON.stringify(data || {}) }),
  testSlackTokens: (data: any) =>
    fetchJSON('/slack/test-tokens', { method: 'POST', body: JSON.stringify(data) }),

  // Setup
  getSetupStatus: () => fetchJSON('/setup/status'),
  configureSetup: (data: any) =>
    fetchJSON('/setup/configure', { method: 'POST', body: JSON.stringify(data) }),

  // Project onboarding
  analyzeProject: (cwd: any, opts: any = {}) =>
    fetchJSON('/projects/analyze', {
      method: 'POST',
      body: JSON.stringify({ cwd, engine: opts.engine, model: opts.model }),
      timeout: 300000,
    }),
  onboardProject: (data: any) =>
    fetchJSON('/projects/onboard', { method: 'POST', body: JSON.stringify(data), timeout: 60000 }),

  // Config settings
  getConfig: () => fetchJSON('/config'),
  updateConfig: (data: any) =>
    fetchJSON('/config', { method: 'PATCH', body: JSON.stringify(data) }),
  getSmtpSettings: () => fetchJSON('/config/smtp'),
  updateSmtpSettings: (data: any) =>
    fetchJSON('/config/smtp', { method: 'PATCH', body: JSON.stringify(data) }),
  testSmtpSettings: (data: any = {}) =>
    fetchJSON('/config/smtp/test', { method: 'POST', body: JSON.stringify(data) }),
  getModelConfig: () => fetchJSON('/config/models'),

  // Per-user Claude credentials (each Hub user can attach their own
  // ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN — see PR #717). Distinct
  // from the host-wide `/config/claude-auth` surface above.
  getMyClaudeAuth: () => fetchJSON('/auth/me/claude-auth'),
  putMyClaudeAuth: (body: any) =>
    fetchJSON('/auth/me/claude-auth', { method: 'PUT', body: JSON.stringify(body) }),

  // Per-user Cursor / Gemini / Codex API keys. Each engine carries one
  // key (no OAuth/expiry round-trip), so the helpers share a uniform
  // shape: `{ apiKey: string | null }` on the wire. See PR #717 for the
  // matching Claude pattern and the per-user-cli-auth wiki page for
  // precedence rules.
  getMyCursorAuth: () => fetchJSON('/auth/me/cursor-auth'),
  putMyCursorAuth: (body: any) =>
    fetchJSON('/auth/me/cursor-auth', { method: 'PUT', body: JSON.stringify(body) }),
  getMyGeminiAuth: () => fetchJSON('/auth/me/gemini-auth'),
  putMyGeminiAuth: (body: any) =>
    fetchJSON('/auth/me/gemini-auth', { method: 'PUT', body: JSON.stringify(body) }),
  getMyCodexAuth: () => fetchJSON('/auth/me/codex-auth'),
  putMyCodexAuth: (body: any) =>
    fetchJSON('/auth/me/codex-auth', { method: 'PUT', body: JSON.stringify(body) }),
  getMyGrokAuth: () => fetchJSON('/auth/me/grok-auth'),
  putMyGrokAuth: (body: any) =>
    fetchJSON('/auth/me/grok-auth', { method: 'PUT', body: JSON.stringify(body) }),

  getMyAgentEngineOverrides: () => fetchJSON('/auth/me/agent-engine-overrides'),
  putMyAgentEngineOverrides: (body: any) =>
    fetchJSON('/auth/me/agent-engine-overrides', {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  // Per-agent merge endpoints — update only one agent's entry server-side, so
  // a save can't clobber other agents' picks or a concurrent edit elsewhere.
  putMyAgentEngineOverride: (agentId: any, body: any) =>
    fetchJSON(`/auth/me/agent-engine-overrides/${encodeURIComponent(agentId)}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  deleteMyAgentEngineOverride: (agentId: any) =>
    fetchJSON(`/auth/me/agent-engine-overrides/${encodeURIComponent(agentId)}`, {
      method: 'DELETE',
    }),

  getMyAgentModelOverrides: () => fetchJSON('/auth/me/agent-model-overrides'),
  putMyAgentModelOverrides: (body: any) =>
    fetchJSON('/auth/me/agent-model-overrides', {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  putMyAgentModelOverride: (agentId: any, body: any) =>
    fetchJSON(`/auth/me/agent-model-overrides/${encodeURIComponent(agentId)}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  deleteMyAgentModelOverride: (agentId: any) =>
    fetchJSON(`/auth/me/agent-model-overrides/${encodeURIComponent(agentId)}`, {
      method: 'DELETE',
    }),

  getSkillCredentials: (skillId: any) =>
    fetchJSON(
      `/auth/me/skill-credentials${skillId ? `?skillId=${encodeURIComponent(skillId)}` : ''}`,
    ),
  putSkillCredential: (body: any) =>
    fetchJSON('/auth/me/skill-credentials', { method: 'PUT', body: JSON.stringify(body) }),
  deleteSkillCredential: (id: any) =>
    fetchJSON(`/auth/me/skill-credentials/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  startMfaEnrollment: () =>
    fetchJSON('/auth/me/mfa/enrollment/start', { method: 'POST', body: JSON.stringify({}) }),
  confirmMfaEnrollment: (code: any) =>
    fetchJSON('/auth/me/mfa/enrollment/confirm', {
      method: 'POST',
      body: JSON.stringify({ code }),
    }),
  regenerateMfaRecoveryCodes: (code: any) =>
    fetchJSON('/auth/me/mfa/recovery-codes/regenerate', {
      method: 'POST',
      body: JSON.stringify({ code }),
    }),
  disableMfa: (code: any) =>
    fetchJSON('/auth/me/mfa/disable', { method: 'POST', body: JSON.stringify({ code }) }),
  resetUserMfa: (userId: any) =>
    fetchJSON(`/auth/users/${encodeURIComponent(userId)}/mfa/reset`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),

  getInvites: () => fetchJSON('/auth/invites'),
  createInvite: (data: any) =>
    fetchJSON('/auth/invites', { method: 'POST', body: JSON.stringify(data) }),
  sendInviteEmail: (token: any) =>
    fetchJSON(`/auth/invites/${encodeURIComponent(token)}/email`, { method: 'POST' }),
  revokeInvite: (token: any) =>
    fetchJSON(`/auth/invites/${encodeURIComponent(token)}`, { method: 'DELETE' }),
  previewInvite: (token: any) => fetchJSON(`/auth/invites/${encodeURIComponent(token)}`),
  acceptInvite: (token: any, data: any) =>
    fetchJSON(`/auth/invites/${encodeURIComponent(token)}/accept`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  // Gemini CLI Authentication
  getGeminiAuth: () => fetchJSON('/config/gemini-auth'),
  setGeminiApiKey: (apiKey: any) =>
    fetchJSON('/config/gemini-auth/api-key', { method: 'POST', body: JSON.stringify({ apiKey }) }),
  validateGeminiApiKey: (apiKey: any) =>
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

  // Grok (xAI Grok Build CLI) device-auth — consumed by `MyGrokAuthSection`.
  // Forwards to the `/auth/me/grok-auth/browser/*` routes in
  // server/routes/per-user-engine-auth.ts.
  getMyGrokBrowserAuth: () => fetchJSON('/auth/me/grok-auth/browser'),
  startMyGrokDeviceLogin: () =>
    fetchJSON('/auth/me/grok-auth/browser/device-login', {
      method: 'POST',
      body: JSON.stringify({}),
      timeout: 50000,
    }),
  cancelMyGrokDeviceLogin: () =>
    fetchJSON('/auth/me/grok-auth/browser/cancel-login', { method: 'POST' }),
  logoutMyGrok: () => fetchJSON('/auth/me/grok-auth/browser', { method: 'DELETE', timeout: 65000 }),

  // Per-project export/import
  exportProject: (projectId: any) => fetchJSON(`/projects/${projectId}/export`),
  importProject: (projectId: any, data: any) =>
    fetchJSON(`/projects/${projectId}/import`, { method: 'POST', body: JSON.stringify(data) }),
  // Create-from-export: server materializes a brand-new project using the
  // export's project block and runs the same merge logic as importProject.
  importProjectAsNew: (data: any) =>
    fetchJSON('/projects/import', { method: 'POST', body: JSON.stringify(data) }),

  // Legacy full-instance export/import
  exportConfig: () => fetchJSON('/config/export'),
  importConfig: (data: any) =>
    fetchJSON('/config/import', { method: 'POST', body: JSON.stringify(data) }),

  // Instance backup — pick-and-zip migration export.
  getInstanceBackupManifest: () => fetchJSON('/instance-backup/manifest'),
  downloadInstanceBackup: async (items: any) => {
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
  browse: (path: any) => fetchJSON(`/browse?path=${encodeURIComponent(path || '')}`),

  // Clone from GitHub
  cloneRepo: (url: any, targetDir: any) =>
    fetchJSON('/projects/clone', {
      method: 'POST',
      body: JSON.stringify({ url, targetDir }),
      timeout: 300000,
    }),

  // Kanban Board
  // Pass `{ limit }` to opt into per-column pagination: `cards` is capped to the
  // first `limit` cards per column (keyset-ordered) and the response gains a
  // `cursors` map `{ [columnId]: nextCursor|null }` for seeding infinite scroll.
  // Omit `limit` for the full board (backward compatible).
  getBoard: (projectId: any, opts: any = {}) => {
    const params = new URLSearchParams();
    if (opts.limit != null) params.set('limit', String(opts.limit));
    const qs = params.toString();
    return fetchJSON(`/projects/${projectId}/board${qs ? `?${qs}` : ''}`);
  },
  // One keyset page of a single column's cards. `cursor` is the opaque token
  // from a prior `nextCursor` (or the board's `cursors` map). Returns
  // `{ cards, nextCursor, total }`.
  getColumnCards: (projectId: any, columnId: any, opts: any = {}) => {
    const params = new URLSearchParams();
    if (opts.cursor) params.set('cursor', opts.cursor);
    if (opts.limit != null) params.set('limit', String(opts.limit));
    const qs = params.toString();
    return fetchJSON(`/projects/${projectId}/board/columns/${columnId}/cards${qs ? `?${qs}` : ''}`);
  },
  createColumn: (projectId: any, data: { name: string; color?: string | null }) =>
    fetchJSON(`/projects/${projectId}/board/columns`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  updateColumn: (
    projectId: any,
    columnId: any,
    data: { name?: string; position?: number; color?: string | null },
  ) =>
    fetchJSON(`/projects/${projectId}/board/columns/${columnId}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  reorderColumns: (projectId: any, columnIds: string[]) =>
    fetchJSON(`/projects/${projectId}/board/columns/reorder`, {
      method: 'POST',
      body: JSON.stringify({ columnIds }),
    }),
  deleteColumn: (projectId: any, columnId: any) =>
    fetchJSON(`/projects/${projectId}/board/columns/${columnId}`, { method: 'DELETE' }),
  createCard: (projectId: any, data: any) =>
    fetchJSON(`/projects/${projectId}/board/cards`, { method: 'POST', body: JSON.stringify(data) }),
  updateCard: (projectId: any, cardId: any, data: any) =>
    fetchJSON(`/projects/${projectId}/board/cards/${cardId}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  moveCard: (projectId: any, cardId: any, data: any) =>
    fetchJSON(`/projects/${projectId}/board/cards/${cardId}/move`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  assignCard: (projectId: any, cardId: any, agentId: any, opts: any = {}) => {
    const body: Record<string, any> = { agentId };
    if (opts.model != null && String(opts.model).trim()) body.model = String(opts.model).trim();
    if (opts.engine != null && String(opts.engine).trim()) body.engine = String(opts.engine).trim();
    if (typeof opts.autoMerge === 'boolean') body.autoMerge = opts.autoMerge;
    if (opts.comment != null && String(opts.comment).trim())
      body.comment = String(opts.comment).trim();
    return fetchJSON(`/projects/${projectId}/board/cards/${cardId}/assign`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },
  unassignCard: (projectId: any, cardId: any) =>
    fetchJSON(`/projects/${projectId}/board/cards/${cardId}/unassign`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  deleteCard: (projectId: any, cardId: any) =>
    fetchJSON(`/projects/${projectId}/board/cards/${cardId}`, { method: 'DELETE' }),
  addCardBlocker: (projectId: any, cardId: any, blockedByCardId: any) =>
    fetchJSON(`/projects/${projectId}/board/cards/${cardId}/blockers`, {
      method: 'POST',
      body: JSON.stringify({ blockedByCardId }),
    }),
  removeCardBlocker: (projectId: any, cardId: any, blockedByCardId: any) =>
    fetchJSON(`/projects/${projectId}/board/cards/${cardId}/blockers/${blockedByCardId}`, {
      method: 'DELETE',
    }),
  getCardComments: (projectId: any, cardId: any) =>
    fetchJSON(`/projects/${projectId}/board/cards/${cardId}/comments`),
  addCardComment: (projectId: any, cardId: any, data: any) =>
    fetchJSON(`/projects/${projectId}/board/cards/${cardId}/comments`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  // Epics
  getEpics: (projectId: any) => fetchJSON(`/projects/${projectId}/board/epics`),
  createEpic: (projectId: any, data: any) =>
    fetchJSON(`/projects/${projectId}/board/epics`, { method: 'POST', body: JSON.stringify(data) }),
  updateEpic: (projectId: any, epicId: any, data: any) =>
    fetchJSON(`/projects/${projectId}/board/epics/${epicId}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  deleteEpic: (projectId: any, epicId: any) =>
    fetchJSON(`/projects/${projectId}/board/epics/${epicId}`, { method: 'DELETE' }),
  assignEpicLeadToCards: (projectId: any, epicId: any) =>
    fetchJSON(`/projects/${projectId}/board/epics/${epicId}/assign-lead-to-cards`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),

  // Card templates
  getCardTemplates: (projectId: any) => fetchJSON(`/projects/${projectId}/board/card-templates`),
  createCardTemplate: (projectId: any, data: any) =>
    fetchJSON(`/projects/${projectId}/board/card-templates`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  updateCardTemplate: (projectId: any, templateId: any, data: any) =>
    fetchJSON(`/projects/${projectId}/board/card-templates/${templateId}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  deleteCardTemplate: (projectId: any, templateId: any) =>
    fetchJSON(`/projects/${projectId}/board/card-templates/${templateId}`, {
      method: 'DELETE',
    }),
  scopeEpic: (projectId: any, epicId: any, data: { agentId?: string } = {}) =>
    fetchJSON(`/projects/${projectId}/board/epics/${epicId}/scope`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  scopeFromNotes: (projectId: any, data: { content: string; title?: string; agentId?: string }) =>
    fetchJSON(`/projects/${projectId}/board/scope-from-notes`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  linkCardToEpic: (projectId: any, cardId: any, epicId: any) =>
    fetchJSON(`/projects/${projectId}/board/cards/${cardId}/epic`, {
      method: 'POST',
      body: JSON.stringify({ epicId }),
    }),

  // Phases
  getPhases: (projectId: any) => fetchJSON(`/projects/${projectId}/board/phases`),
  createPhase: (projectId: any, data: any) =>
    fetchJSON(`/projects/${projectId}/board/phases`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  updatePhase: (projectId: any, phaseId: any, data: any) =>
    fetchJSON(`/projects/${projectId}/board/phases/${phaseId}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  deletePhase: (projectId: any, phaseId: any) =>
    fetchJSON(`/projects/${projectId}/board/phases/${phaseId}`, { method: 'DELETE' }),
  runAutonomous: (projectId: any) =>
    fetchJSON(`/projects/${projectId}/board/autonomous/run`, { method: 'POST' }),
  runPhase: (projectId: any, phaseId: any) =>
    fetchJSON(`/projects/${projectId}/board/phases/${phaseId}/run`, { method: 'POST' }),
  stopPhase: (projectId: any, phaseId: any) =>
    fetchJSON(`/projects/${projectId}/board/phases/${phaseId}/stop`, { method: 'POST' }),
  // Reorder an epic's phases. Pass `phaseIds` for an explicit order, or
  // `sortByDependencies: true` to derive the order from the card blocker graph.
  reorderPhases: (
    projectId: any,
    epicId: string,
    opts: { phaseIds?: string[]; sortByDependencies?: boolean },
  ) =>
    fetchJSON(`/projects/${projectId}/board/phases/reorder`, {
      method: 'POST',
      body: JSON.stringify({ epicId, ...opts }),
    }),

  // Epic spec decisions
  createSpecItem: (projectId: any, data: any) =>
    fetchJSON(`/projects/${projectId}/board/spec-items`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  updateSpecItem: (projectId: any, specItemId: any, data: any) =>
    fetchJSON(`/projects/${projectId}/board/spec-items/${specItemId}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  createSpecSpike: (projectId: any, specItemId: any) =>
    fetchJSON(`/projects/${projectId}/board/spec-items/${specItemId}/spike`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  decideSpecForMe: (projectId: any, specItemId: any, data: { agentId?: string } = {}) =>
    fetchJSON(`/projects/${projectId}/board/spec-items/${specItemId}/decide-for-me`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  deleteSpecItem: (projectId: any, specItemId: any) =>
    fetchJSON(`/projects/${projectId}/board/spec-items/${specItemId}`, { method: 'DELETE' }),

  // Background tasks
  getTasks: (limit: any = 50) => fetchJSON(`/tasks?limit=${limit}`),
  getTask: (taskId: any) => fetchJSON(`/tasks/${taskId}`),
  createTask: (agentId: any, prompt: any) =>
    fetchJSON('/tasks', { method: 'POST', body: JSON.stringify({ agentId, prompt }) }),
  stopTask: (taskId: any) => fetchJSON(`/tasks/${taskId}/stop`, { method: 'POST' }),

  // Support tickets — project-scoped queue, ordered by severity (server-side).
  // `status` is a comma-separated list of lifecycle states (new | investigating
  // | converted | closed | duplicate | wont_do); omit it to get the default
  // open view. `type` optionally narrows to a single request type (e.g. bug).
  getSupportTickets: (projectId: any, status: any, type: any) => {
    const params = new URLSearchParams();
    if (status) params.set('status', status);
    if (type) params.set('type', type);
    const qs = params.toString() ? `?${params}` : '';
    return fetchJSON(`/projects/${projectId}/support-tickets${qs}`);
  },
  getSupportTicket: (projectId: any, id: any) =>
    fetchJSON(`/projects/${projectId}/support-tickets/${id}`),
  runSupportTicketInvestigation: (projectId: any, id: any, selection: any = {}) =>
    fetchJSON(`/projects/${projectId}/support-tickets/${id}/investigate`, {
      method: 'POST',
      body: JSON.stringify(selection),
    }),
  // Change a ticket's lifecycle status. Pass `wontDoReason` (required by the
  // server) when status is 'wont_do'. Returns the updated ticket and emits a
  // support_ticket_updated WebSocket event.
  setSupportTicketStatus: (projectId: any, id: any, status: any, wontDoReason: any) =>
    fetchJSON(`/projects/${projectId}/support-tickets/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(wontDoReason === undefined ? { status } : { status, wontDoReason }),
    }),
  // Reclassify a ticket's request type. Returns the updated ticket and emits a
  // support_ticket_updated WebSocket event.
  setSupportTicketType: (projectId: any, id: any, type: any) =>
    fetchJSON(`/projects/${projectId}/support-tickets/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ type }),
    }),
  // Promote a support ticket to a To Do kanban card. The source ticket is
  // RETAINED and flagged `converted` (it leaves the default open queue but is
  // not deleted). Returns { card, ticket, ticketId, converted: true }.
  // Re-converting an already-converted ticket 409s.
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
  deleteSupportTicket: (projectId: any, id: any) =>
    fetchJSON(`/projects/${projectId}/support-tickets/${id}`, { method: 'DELETE' }),
  // Number of unread tickets (read_at NULL) for the project — drives the
  // Support sidebar badge. Returns { count }.
  getSupportUnreadCount: (projectId: any) =>
    fetchJSON(`/projects/${projectId}/support-tickets/unread-count`),
  // Mark a single ticket read / unread. Each emits a support_ticket_updated
  // WebSocket event carrying the refreshed per-project unreadCount.
  markSupportTicketRead: (projectId: any, id: any) =>
    fetchJSON(`/projects/${projectId}/support-tickets/${id}/read`, { method: 'POST' }),
  markSupportTicketUnread: (projectId: any, id: any) =>
    fetchJSON(`/projects/${projectId}/support-tickets/${id}/unread`, { method: 'POST' }),
  // Mark every unread ticket in the project read. Emits a
  // support_tickets_read_all WebSocket event. Returns { marked, unreadCount }.
  markAllSupportTicketsRead: (projectId: any) =>
    fetchJSON(`/projects/${projectId}/support-tickets/read-all`, { method: 'POST' }),

  // Cross-project support overview — every project's support tickets in one
  // severity-ordered list (critical → low). Returns { tickets, projects } where
  // each ticket carries a `project_name` and `projects` is the full set of
  // projects-with-tickets (for a stable filter, independent of the active
  // filter). Optional `status` filters lifecycle state and `unread` keeps only
  // tickets a human hasn't viewed yet (read_at IS NULL) — both server-side.
  // Accepts either a bare status string (legacy) or an options object.
  getAllSupportTickets: (opts?: any) => {
    const { status, unread } =
      typeof opts === 'string' || opts == null ? { status: opts, unread: false } : opts;
    const params = new URLSearchParams();
    if (status) params.set('status', String(status));
    if (unread) params.set('unread', 'true');
    const qs = params.toString();
    return fetchJSON(`/support-tickets${qs ? `?${qs}` : ''}`);
  },

  // Security audit — Dependabot-style dependency findings for a Hub-hosted repo.
  // `status` optionally narrows to a single lifecycle state (open | fixed |
  // dismissed); omit it for every finding. Returns { findings, openCounts }
  // where openCounts is the per-severity tally of OPEN findings (independent of
  // the status filter) that drives the Security sidebar badge.
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
  // Hub-hosted projects only. Bumps the finding's package (every open vulnerable
  // version of it in that manifest) to the fixed version in one native PR.
  // Returns { opened: [...], skipped: [...] }.
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
  // Dismiss (and, unless suppress:false, suppress on future re-scans) a single
  // finding. Requires the Admin role server-side. Returns the updated finding.
  dismissSecurityFinding: (projectId: any, id: any, { reason, suppress }: any = {}) =>
    fetchJSON(`/projects/${projectId}/security-audit/findings/${id}/dismiss`, {
      method: 'POST',
      body: JSON.stringify({
        ...(reason ? { reason } : {}),
        ...(suppress === false ? { suppress: false } : {}),
      }),
    }),

  // Session replays — record-on-error rrweb captures. Metadata + paginated
  // events back the sandboxed rrweb-player playback surface. Reads are
  // authenticated + per-replay authorized server-side.
  // Server-delivered per-project replay policy (continuous-tier sample rate +
  // opt-in flag). Public endpoint — no project resolves to the default policy.
  getReplayConfig: (projectId?: string) =>
    fetchJSON(`/replays/config${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`),
  getReplay: (replayId: any) => fetchJSON(`/replays/${replayId}`),
  // Flag / unflag a capture for extended retention (up to 15 months; the clock
  // starts now). Returns the updated metadata row (incl. retainedUntil).
  setReplayRetention: (replayId: any, extend: boolean) =>
    fetchJSON(`/replays/${replayId}/retention`, {
      method: 'POST',
      body: JSON.stringify({ extend }),
    }),
  getReplayEvents: (replayId: any, offset: any = 0, limit: any) => {
    const params = new URLSearchParams();
    if (offset) params.set('offset', String(offset));
    if (limit != null) params.set('limit', String(limit));
    const qs = params.toString();
    return fetchJSON(`/replays/${replayId}/events${qs ? `?${qs}` : ''}`);
  },
  // Pointer to the replay attributed to a kanban card (e.g. carried over when a
  // bug ticket was converted). Returns { replayId, durationMs, eventCount,
  // createdAt } or throws on 404 when the card has no replay.
  getCardReplay: (projectId: any, cardId: any) =>
    fetchJSON(`/projects/${projectId}/board/cards/${cardId}/replay`),

  // Segmented (continuous) session playback. The manifest lists every segment
  // for a client-minted session in playback order (chronological across views,
  // each view opening with a fresh full snapshot at index_in_view=0); the
  // session-grouped player stitches them into one continuous timeline. Both
  // reads are authenticated + per-session authorized server-side — a leaked /
  // cross-tenant session or segment id collapses to 404. Returns the
  // SessionSegmentManifest ({ sessionId, storageLayout, projectId, segmentCount,
  // durationMs, segments: [{ segmentId, viewId, indexInView, hasFullSnapshot,
  // startTs, endTs, eventCount, byteSize, eventsUrl }] }).
  getSessionSegments: (sessionId: any) =>
    fetchJSON(`/replays/sessions/${encodeURIComponent(sessionId)}/segments`),
  // One segment's decoded rrweb events, the player concatenates client-side.
  // Returns { sessionId, segmentId, viewId, indexInView, hasFullSnapshot,
  // events, eventCount }.
  getSessionSegmentEvents: (sessionId: any, segmentId: any) =>
    fetchJSON(
      `/replays/sessions/${encodeURIComponent(sessionId)}/segments/${encodeURIComponent(
        segmentId,
      )}/events`,
    ),

  // Replays Explorer dashboard — paginated, filterable table of a project's
  // session replays, each row enriched with its linked support ticket. `filter`
  // is one of all | linked | unlinked | orphans (orphans = global unattributed
  // captures, privileged-only). Returns { replays, total, limit, offset,
  // hasMore, filter, canViewOrphans }.
  listReplays: (projectId: any, { filter, kind, limit, offset }: any = {}) => {
    const params = new URLSearchParams();
    if (filter) params.set('filter', filter);
    if (kind && kind !== 'all') params.set('kind', kind);
    if (limit != null) params.set('limit', String(limit));
    if (offset) params.set('offset', String(offset));
    const qs = params.toString();
    return fetchJSON(`/projects/${projectId}/replays${qs ? `?${qs}` : ''}`);
  },
  // RUM Session Explorer (session-grain, Datadog-parity). Lists the
  // rum_sessions rollup with indexed facet filters (user/device/browser/os/geo),
  // count/duration range bounds, and an inclusive started-at time window. Every
  // filter is optional; blank/undefined values are omitted so the server treats
  // them as no-ops. Returns { sessions, total, limit, offset, hasMore }.
  listRumSessions: (projectId: any, filters: any = {}) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) {
      if (value == null) continue;
      if (typeof value === 'string' && value.trim() === '') continue;
      params.set(key, String(value));
    }
    const qs = params.toString();
    return fetchJSON(`/projects/${projectId}/rum/sessions${qs ? `?${qs}` : ''}`);
  },
  // Attach a replay to one of the project's support tickets (the inverse of the
  // ticket-first flow). Claims an orphan into the project via the first-write
  // guard. 409s if the replay belongs to another project. Returns
  // { replay, ticket }.
  linkReplayToTicket: (projectId: any, replayId: any, supportTicketId: any) =>
    fetchJSON(`/projects/${projectId}/replays/${replayId}/link`, {
      method: 'POST',
      body: JSON.stringify({ supportTicketId }),
    }),
  // Detach a replay from its support ticket (keeps the project attribution).
  // Returns { replay }.
  unlinkReplay: (projectId: any, replayId: any) =>
    fetchJSON(`/projects/${projectId}/replays/${replayId}/link`, { method: 'DELETE' }),

  // ── Replay playlists (Datadog "playlist") ───────────────────────────
  // Named, project-scoped groups of saved captures + playlist-level extended
  // retention. Backend: server/routes/replay-playlists.ts.
  // Returns { playlists: PlaylistView[] } (each carries itemCount).
  listReplayPlaylists: (projectId: any) => fetchJSON(`/projects/${projectId}/replay-playlists`),
  // Returns a PlaylistView plus { items: PlaylistItemView[] }.
  getReplayPlaylist: (projectId: any, playlistId: any) =>
    fetchJSON(`/projects/${projectId}/replay-playlists/${playlistId}`),
  // Create a playlist. Returns the new PlaylistView (itemCount 0). An empty /
  // blank description is omitted (the form always sends a trimmed string) so the
  // server stores null rather than "".
  createReplayPlaylist: (projectId: any, { name, description }: any = {}) =>
    fetchJSON(`/projects/${projectId}/replay-playlists`, {
      method: 'POST',
      body: JSON.stringify({ name, ...(description ? { description } : {}) }),
    }),
  // Rename / edit a playlist. Only the provided fields change. Returns PlaylistView.
  updateReplayPlaylist: (projectId: any, playlistId: any, patch: any = {}) =>
    fetchJSON(`/projects/${projectId}/replay-playlists/${playlistId}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  // Delete a playlist (items cascade; member captures are untouched). 204.
  deleteReplayPlaylist: (projectId: any, playlistId: any) =>
    fetchJSON(`/projects/${projectId}/replay-playlists/${playlistId}`, { method: 'DELETE' }),
  // Add a capture to a playlist. Returns { added, ...PlaylistView, items }.
  addReplayPlaylistItem: (projectId: any, playlistId: any, replayId: any) =>
    fetchJSON(`/projects/${projectId}/replay-playlists/${playlistId}/items`, {
      method: 'POST',
      body: JSON.stringify({ replayId }),
    }),
  // Remove a capture from a playlist. 204 on success, 404 when not a member.
  removeReplayPlaylistItem: (projectId: any, playlistId: any, replayId: any) =>
    fetchJSON(
      `/projects/${projectId}/replay-playlists/${playlistId}/items/${encodeURIComponent(replayId)}`,
      { method: 'DELETE' },
    ),
  // Flag / unflag a whole playlist for extended retention. Returns PlaylistView.
  setReplayPlaylistRetention: (projectId: any, playlistId: any, extend: boolean) =>
    fetchJSON(`/projects/${projectId}/replay-playlists/${playlistId}/retention`, {
      method: 'POST',
      body: JSON.stringify({ extend: !!extend }),
    }),

  // Threads
  getThreads: (projectId: any, type: any) => {
    const qs = type ? `?type=${type}` : '';
    return fetchJSON(`/projects/${projectId}/threads${qs}`);
  },
  getThread: (threadId: any) => fetchJSON(`/threads/${threadId}`),
  getThreadEntries: (threadId: any) => fetchJSON(`/threads/${threadId}/entries`),
  // Human-authored entry — used by the ThreadView composer. The server
  // stamps `role='user'` and `author_user_id` from req.authUserId.
  postThreadEntry: (threadId: any, content: any) =>
    fetchJSON(`/threads/${threadId}/entries`, {
      method: 'POST',
      body: JSON.stringify({ content }),
    }),
  // Forward a single thread entry to an agent. Creates a new session for the
  // target agent seeded with that one entry's content as the initial message.
  forwardThreadEntry: (
    threadId: any,
    entryId: any,
    { targetAgentId, prompt, autoStart }: any = {},
  ) =>
    fetchJSON(`/threads/${threadId}/entries/${entryId}/forward`, {
      method: 'POST',
      body: JSON.stringify({
        targetAgentId,
        ...(prompt ? { prompt } : {}),
        ...(autoStart != null ? { autoStart: !!autoStart } : {}),
      }),
      timeout: 30000,
    }),
  getCronThread: (cronId: any) => fetchJSON(`/crons/${cronId}/thread`),
  getHeartbeatThread: (agentId: any) => fetchJSON(`/heartbeats/${agentId}/thread`),

  // Notes
  getNotes: (projectId: any, query?: any, limit?: any) => {
    const params = new URLSearchParams();
    if (query) params.set('q', query);
    if (limit) params.set('limit', limit);
    const qs = params.toString();
    return fetchJSON(`/projects/${projectId}/notes${qs ? '?' + qs : ''}`);
  },
  getNote: (projectId: any, noteId: any) => fetchJSON(`/projects/${projectId}/notes/${noteId}`),
  createNote: (projectId: any, data: any) =>
    fetchJSON(`/projects/${projectId}/notes`, { method: 'POST', body: JSON.stringify(data) }),
  updateNote: (projectId: any, noteId: any, data: any) =>
    fetchJSON(`/projects/${projectId}/notes/${noteId}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  deleteNote: (projectId: any, noteId: any) =>
    fetchJSON(`/projects/${projectId}/notes/${noteId}`, { method: 'DELETE' }),
  processNote: (projectId: any, date: any, data: any) =>
    fetchJSON(`/projects/${projectId}/notes/${date}/process`, {
      method: 'POST',
      body: JSON.stringify(data),
      timeout: 30000,
    }),
  getNoteProcessings: (projectId: any, limit: any) =>
    fetchJSON(`/projects/${projectId}/notes/processings${limit ? '?limit=' + limit : ''}`),
  getNoteProcessingsByDate: (projectId: any, date: any) =>
    fetchJSON(`/projects/${projectId}/notes/${date}/processings`),

  // TOOL_ERROR aggregation (stub — Session Health epic will replace with a
  // richer dashboard). Greps daily notes for TOOL_ERROR lines and returns
  // structured JSON + count buckets.
  getToolErrors: (projectId: any, { since, limit }: any = {}) => {
    const params = new URLSearchParams();
    if (since) params.set('since', since);
    if (limit) params.set('limit', String(limit));
    const qs = params.toString();
    return fetchJSON(`/projects/${projectId}/tool-errors${qs ? '?' + qs : ''}`);
  },

  // Background job queue (Admin observability surface)
  getJobs: ({ status, type, limit, offset }: any = {}) => {
    const params = new URLSearchParams();
    if (status) params.set('status', status);
    if (type) params.set('type', type);
    if (limit) params.set('limit', String(limit));
    if (offset) params.set('offset', String(offset));
    const qs = params.toString();
    return fetchJSON(`/jobs${qs ? '?' + qs : ''}`);
  },
  retryJob: (id: any) => fetchJSON(`/jobs/${id}/retry`, { method: 'POST' }),
  deleteJob: (id: any) => fetchJSON(`/jobs/${id}`, { method: 'DELETE' }),

  // Generic helpers (for endpoints without dedicated methods)
  get: (url: any) => fetchJSON(url),
  post: (url: any, data: any) =>
    fetchJSON(url, { method: 'POST', ...(data && { body: JSON.stringify(data) }) }),
  del: (url: any) =>
    fetch(`${getApiBase()}${url}`, { method: 'DELETE', headers: { ...getAuthHeaders() } }).then(
      (res: any) => {
        if (!res.ok) throw new Error(`API error: ${res.status}`);
        return res.json().catch(() => null);
      },
    ),

  // Server Logs
  getServerLogs: () => fetchJSON('/server-logs'),

  // Preview Containers
  getPreviewStatus: () => fetchJSON('/previews/status'),
  getProjectPreviews: (projectId: any) => fetchJSON(`/projects/${projectId}/previews`),
  purgeAllProjectPreviews: (projectId: any) =>
    fetchJSON(`/projects/${projectId}/previews/purge`, {
      method: 'POST',
      timeout: 120000,
    }),
  createPreview: (projectId: any, data: any) =>
    fetchJSON(`/projects/${projectId}/previews`, {
      method: 'POST',
      body: JSON.stringify(data),
      timeout: 30000,
    }),
  stopPreview: (projectId: any, previewId: any) =>
    fetchJSON(`/projects/${projectId}/previews/${previewId}/stop`, {
      method: 'POST',
      timeout: 30000,
    }),
  rebuildPreview: (projectId: any, previewId: any) =>
    fetchJSON(`/projects/${projectId}/previews/${previewId}/rebuild`, {
      method: 'POST',
      timeout: 30000,
    }),
  getPreviewLogs: (projectId: any, previewId: any, tail: any = 200) =>
    fetchJSON(`/projects/${projectId}/previews/${previewId}/logs?tail=${tail}`),
  deletePreview: (projectId: any, previewId: any) =>
    fetchJSON(`/projects/${projectId}/previews/${previewId}`, { method: 'DELETE', timeout: 30000 }),

  // Preview Captures
  capturePreview: (projectId: any, previewId: any, { skipVideo }: any = {}) =>
    fetchJSON(`/projects/${projectId}/previews/${previewId}/capture`, {
      method: 'POST',
      body: JSON.stringify({ skipVideo }),
      timeout: 30000,
    }),
  getPreviewCaptures: (projectId: any, previewId: any) =>
    fetchJSON(`/projects/${projectId}/previews/${previewId}/captures`),

  // iOS Builds
  getIosBuildStatus: () => fetchJSON('/ios-builds/status'),
  getProjectIosBuilds: (projectId: any) => fetchJSON(`/projects/${projectId}/ios-builds`),
  createIosBuild: (projectId: any, data: any) =>
    fetchJSON(`/projects/${projectId}/ios-builds`, {
      method: 'POST',
      body: JSON.stringify(data),
      timeout: 30000,
    }),
  getIosBuild: (projectId: any, buildId: any) =>
    fetchJSON(`/projects/${projectId}/ios-builds/${buildId}`),
  cancelIosBuild: (projectId: any, buildId: any) =>
    fetchJSON(`/projects/${projectId}/ios-builds/${buildId}/cancel`, {
      method: 'POST',
      timeout: 30000,
    }),
  getIosBuildLogs: (projectId: any, buildId: any) =>
    fetchJSON(`/projects/${projectId}/ios-builds/${buildId}/logs`),
  deleteIosBuild: (projectId: any, buildId: any) =>
    fetchJSON(`/projects/${projectId}/ios-builds/${buildId}`, {
      method: 'DELETE',
      timeout: 30000,
    }),
  getIosBuildArtifacts: (projectId: any, buildId: any) =>
    fetchJSON(`/projects/${projectId}/ios-builds/${buildId}/artifacts`),

  // Pull Requests (read-only viewer) — project-scoped
  getProjectPulls: (projectId: any, { state = 'open', limit = 30 }: any = {}) => {
    const params = new URLSearchParams();
    if (state) params.set('state', state);
    if (limit) params.set('limit', String(limit));
    const qs = params.toString();
    return fetchJSON(`/projects/${projectId}/pulls${qs ? '?' + qs : ''}`);
  },
  getProjectPullDetail: (projectId: any, number: any) =>
    fetchJSON(`/projects/${projectId}/pulls/${number}`),
  resolvePR: (projectId: any, prNumber: any, { agentId }: any = {}) =>
    fetchJSON(`/projects/${projectId}/pulls/${prNumber}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ agentId }),
      timeout: 60000,
    }),
  // PR Actions
  mergePr: (prUrl: any, mergeMethod: any = 'squash') =>
    fetchJSON('/pr/merge', {
      method: 'POST',
      body: JSON.stringify({ prUrl, mergeMethod }),
      timeout: 60000,
    }),
  closePr: (prUrl: any) =>
    fetchJSON('/pr/close', {
      method: 'POST',
      body: JSON.stringify({ prUrl }),
      timeout: 30000,
    }),
  getPrStatus: (prUrl: any) => fetchJSON(`/pr/status?prUrl=${encodeURIComponent(prUrl)}`),

  // Container pool observability (W4)
  getPoolMetrics: (windowHours: any = 24) => fetchJSON(`/pool/metrics?windowHours=${windowHours}`),
  getPoolAlerts: (status: any = 'active') => fetchJSON(`/pool/alerts?status=${status}`),
};

/** Typed REST client for Agent Hub API routes (base path `/api`). */
export type ApiClient = typeof api;
