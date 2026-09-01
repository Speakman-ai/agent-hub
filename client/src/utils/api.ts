import { getApiBase, getAuthHeaders } from './connection';
import { getToken as getJwt, clearToken, isLocalBundledDeployment } from './auth';
import { normalizeSessionMessagesResponse } from '@shared/utils/sessionMessagesResponse';
import { isDeadSessionResponse } from '@shared/utils/authErrorCodes';
import type { ApiErrorBody, AgentWire, MessageWire, ProjectWire, SessionWire } from '@shared/types';
import type { DeployTriggerEvent } from './deployTriggers';
import type { InfraServicePackWire } from '@shared/utils/infraPacks';
import type { InfraSpendTrendWire } from '@shared/utils/infraSpend';
import type { InfraFleetWire } from '@shared/utils/infraFleet';
import type { QuotaHeadroomResponse } from '@shared/utils/quotaHeadroom';

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

interface CreateDeployReleaseGateBody {
  ref?: string | null;
  sessionIds?: string[];
  epicIds?: string[];
  enabled?: boolean;
  meta?: unknown;
}

interface UpdateDeployReleaseGateBody {
  ref?: string | null;
  sessionIds?: string[];
  epicIds?: string[];
  enabled?: boolean;
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

export interface DailySummaryReportWire {
  date: string;
  timeZone: string;
  markdown: string;
  engine: string;
  model: string;
  generatedAt: string;
}

export interface DailySummaryWire {
  date: string;
  timeZone: string;
  report: DailySummaryReportWire | null;
}

export interface DailySummaryScheduleWire {
  enabled: boolean;
  timeZone: string;
  times: string[];
}

export interface DailySummaryScheduleResponseWire {
  schedule: DailySummaryScheduleWire | null;
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

/** A machine error code (`no_pushable_commits`) rather than human copy. */
const ERROR_CODE_RE = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;

/**
 * Error text for a failed response, as surfaced in toasts.
 *
 * Routes that pair a machine `error` code with a human `message` get the
 * message: "400: no_pushable_commits" tells an operator nothing, while the
 * message it ships with says exactly which state they are in and what to do.
 * Routes whose `error` is already a sentence keep it.
 */
export function errorDetail(body: ApiErrorBody | null, status: number): string {
  const code = typeof body?.error === 'string' ? body.error.trim() : '';
  const message = typeof body?.message === 'string' ? body.message.trim() : '';
  const preferred = code && !ERROR_CODE_RE.test(code) ? code : message || code;
  const detail = preferred || (body ? JSON.stringify(body) : '');
  return detail ? `${status}: ${detail}` : `API error: ${status}`;
}

/** Options passed to fetchJSON — extends RequestInit with a client-side timeout. */
export interface FetchJsonOptions extends Omit<RequestInit, 'signal'> {
  timeout?: number | null;
  signal?: AbortSignal;
}

/** True when `fetch` rejected because AbortSignal.timeout fired. */
export function isFetchTimeoutError(err: unknown): err is Error {
  return err instanceof Error && err.name === 'TimeoutError';
}

/**
 * Human copy for a fetchJSON AbortSignal.timeout. The browser's own
 * message is "The operation was aborted due to timeout" — no method, path,
 * or deadline — which is why these show up as mystery "signal timeout"
 * toasts and console warnings.
 */
export function fetchTimeoutMessage(method: string, url: string, timeoutMs: number): string {
  return `Request timed out after ${timeoutMs}ms: ${method} ${url}`;
}

/**
 * True when a string is a structured `fetchJSON` timeout message minted by
 * `fetchTimeoutMessage` (`Request timed out after <n>ms: <METHOD> <path>`).
 * Used to suppress the raw request-timeout toast globally while leaving
 * domain-specific timeout copy (e.g. "Preview health check timed out") alone.
 */
export function isFetchTimeoutMessage(message: unknown): boolean {
  return typeof message === 'string' && /^Request timed out after \d+ms: \S+ \S/.test(message);
}

async function fetchJSON<T = any>(url: string, options: FetchJsonOptions = {}): Promise<T> {
  const base = getApiBase();
  const authHeaders = getAuthHeaders();
  const { timeout: timeoutOption, ...fetchOpts } = options;
  const timeoutMs =
    timeoutOption === null ? null : !timeoutOption || timeoutOption <= 0 ? 15000 : timeoutOption;
  // Only remap TimeoutError when *we* attached AbortSignal.timeout. A
  // caller-supplied signal (unmount, session switch) must stay an abort.
  const usedOwnTimeout = timeoutMs !== null && !fetchOpts.signal;
  let res: Response;
  try {
    res = await fetch(`${base}${url}`, {
      ...fetchOpts,
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders,
        ...(fetchOpts.headers as Record<string, string> | undefined),
      },
      signal: fetchOpts.signal || (timeoutMs === null ? undefined : AbortSignal.timeout(timeoutMs)),
    });
  } catch (err) {
    if (usedOwnTimeout && isFetchTimeoutError(err)) {
      const timedOut = new Error(fetchTimeoutMessage(fetchOpts.method || 'GET', url, timeoutMs), {
        cause: err,
      });
      // Keep the DOM name so existing `err.name === 'TimeoutError'` checks
      // (and isFetchTimeoutError itself) still match the remapped error.
      timedOut.name = 'TimeoutError';
      throw timedOut;
    }
    throw err;
  }
  if (!res.ok) {
    // The error body can only be read once — parse it up front so both
    // the dead-session check and the thrown detail can use it.
    let errBody: ApiErrorBody | null = null;
    try {
      errBody = (await res.json()) as ApiErrorBody;
    } catch {
      /* response wasn't JSON */
    }
    // Only responses the server explicitly tagged as a dead session clear
    // the token and bounce to LoginScreen. Both statuses are scoped by
    // `code`: an untagged 401 means something other than the caller's own
    // credentials was rejected (an unconnected integration, or a route
    // whose caller has no per-user `users` row — `no_user_identity` from
    // the `/auth/me/*` engine-credential routes, which render an empty
    // state instead), and an untagged 403 is an ordinary permission error.
    // None of those mean the session died, so all surface as errors.
    //
    // Local bundled mode (Electron / `AGENT_HUB_MODE=local`): AuthGate
    // already skips LoginScreen, so a reload cannot recover auth — it
    // only remounts App, re-posts /orgs/:id/switch, and storms the
    // server. Skip the reload; leave the error for the caller.
    //
    // `isLocalBundledDeployment()` is the DEPLOYMENT identity, not an org
    // setting: the server computes the `activeOrgIsLocal` status field as
    // `process.env.AGENT_HUB_MODE === 'local'` and never reads `org.mode`
    // (which is user-editable — see PR #703 and the JSDoc in
    // server/auth.ts). So on a hosted deployment this is false no matter
    // how many orgs are in local mode, and an expired or revoked JWT there
    // still clears the token and bounces to LoginScreen. Pinned by
    // `GET /api/auth/status — activeOrgIsLocal field` in
    // server/routes/auth.test.ts (server half) and the hosted-vs-local
    // pair in utils/api.unauthorized.test.ts (client half).
    const deadSession =
      !isLocalBundledDeployment() && isDeadSessionResponse(res.status, errBody?.code);
    if (deadSession && typeof window !== 'undefined' && !recentlyReloadedFor401()) {
      markReloadedFor401();
      console.warn(
        `[api] dead session on ${fetchOpts.method || 'GET'} ${url} (${res.status}) — clearing token and reloading`,
      );
      if (getJwt()) clearToken();
      window.location.reload();
    }
    throw new Error(errorDetail(errBody, res.status));
  }
  clearRecentReloadMarker();
  return res.json() as Promise<T>;
}

/**
 * AWS Health severity, as classified server-side from the event type category.
 * Mirrors the infra alert severity vocabulary so both surfaces colour alike.
 */
export type InfraHealthSeverity = 'critical' | 'warning' | 'info';

/** AWS Health lifecycle status. Null when AWS omitted it from the payload. */
export type InfraHealthStatusCode = 'open' | 'closed' | 'upcoming' | null;

export interface InfraHealthAffectedEntityWire {
  entityValue: string;
  status?: string | null;
  lastUpdatedMs?: number | null;
}

/** One stored AWS Health event (server `serializeInfraHealthEvent`). */
export interface InfraHealthEventWire {
  id: string;
  projectId: string;
  eventArn: string;
  communicationId: string | null;
  region: string | null;
  deliveryRegion: string | null;
  detailType: string | null;
  service: string | null;
  eventTypeCode: string | null;
  eventTypeCategory: string | null;
  eventScopeCode: string | null;
  statusCode: InfraHealthStatusCode;
  severity: InfraHealthSeverity;
  startTime: number | null;
  endTime: number | null;
  lastUpdated: number | null;
  description: string | null;
  affectedEntities: InfraHealthAffectedEntityWire[];
  affectedEntityCount: number;
  /**
   * True when AWS delivered this copy to the account's *backup* Region rather
   * than the Region the event is about. AWS deliberately fans account-specific
   * events out to a second Region, so a duplicate-looking row is expected.
   */
  backupEvent: boolean;
  page: number | null;
  totalPages: number | null;
  eventTime: number | null;
  receivedAt: number;
}

export interface InfraHealthEventsResponse {
  events: InfraHealthEventWire[];
  total: number;
  /**
   * Whether a live ingest token exists. Distinguishes "the EventBridge rule was
   * never wired up" from "wired up and nothing has happened", which are very
   * different operator next-actions.
   */
  ingestConfigured: boolean;
}

/** Non-secret ingest credential metadata. Never carries the token itself. */
export interface InfraHealthIngestTokenInfoWire {
  projectId: string;
  tokenPrefix: string;
  createdAt: number;
  rotatedAt: number | null;
  revokedAt: number | null;
  lastUsedAt: number | null;
}

export interface InfraHealthIngestResponse {
  token: InfraHealthIngestTokenInfoWire | null;
  ingestPath: string;
  eventPattern: Record<string, readonly string[]>;
}

export interface InfraHealthIngestMintResponse {
  /** Plaintext credential. Returned exactly once and never readable again. */
  token: string;
  info: InfraHealthIngestTokenInfoWire;
  ingestPath: string;
  eventPattern: Record<string, readonly string[]>;
}

export interface InfraHealthIngestRevokeResponse {
  revoked: boolean;
  token: InfraHealthIngestTokenInfoWire | null;
}

/**
 * An unmet precondition between a project and unattended collection, in the
 * order an operator should resolve them. Mirrors `InfraSetupBlocker` in
 * `server/infra-setup-draft.ts`.
 */
export type InfraSetupBlockerWire =
  | 'infra-disabled'
  | 'no-profiles'
  | 'only-sso-profiles'
  | 'no-monitoring-profile'
  | 'storage-unavailable'
  | 'no-scope';

export interface InfraSetupProfileSummaryWire {
  name: string;
  type: 'sso' | 'static' | 'role';
  region?: string | null;
  monitoringCapable: boolean;
}

/**
 * The Hub-side readiness report behind the Infrastructure module's empty state.
 * The endpoint calls AWS zero times (decision INFRA-WIZARD), which is what
 * makes it cheap enough to fetch on every render of the module.
 */
export interface InfraSetupDraftWire {
  projectId: string;
  infraEnabled: boolean;
  profiles: InfraSetupProfileSummaryWire[];
  designatedMonitoringProfile: string | null;
  monitoringProfile: string | null;
  monitoringCapableProfiles: string[];
  storageReady: boolean;
  scopes: Array<Record<string, unknown>>;
  enabledScopeCount: number;
  alertRuleCount: number;
  enabledAlertRuleCount: number;
  blockers: InfraSetupBlockerWire[];
  notes: string[];
}

export interface InfraSetupDraftResponse {
  projectId: string;
  draft: InfraSetupDraftWire;
}

export interface InfraWizardStartResponse {
  sessionId: string;
  agentId: string;
  draft: InfraSetupDraftWire;
  session?: Record<string, unknown>;
}

/**
 * Query string for the infra read routes.
 *
 * Empty and nullish values are dropped rather than sent blank: the server
 * treats `?service=` as a filter for a service literally named the empty
 * string, so a cleared dropdown would return nothing instead of everything.
 */
function infraQuery(params: Record<string, unknown>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `?${qs}` : '';
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
      users: Array<{
        id: string | null;
        username?: string;
        email?: string | null;
        role: string;
      }>;
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
  // Per-project email/deployment logo override.
  getProjectEmailLogo: (projectId: string) => fetchJSON(`/projects/${projectId}/email-logo`),
  updateProjectEmailLogo: (projectId: string, dataUrl: string) =>
    fetchJSON(`/projects/${projectId}/email-logo`, {
      method: 'PUT',
      body: JSON.stringify({ dataUrl }),
    }),
  deleteProjectEmailLogo: (projectId: string) =>
    fetchJSON(`/projects/${projectId}/email-logo`, { method: 'DELETE' }),
  // Rendered branded-email preview (logo + representative digest body).
  getReleaseEmailPreview: (projectId: string) =>
    fetchJSON<{ html: string; subject: string; usingProjectLogo: boolean }>(
      `/projects/${projectId}/release-email-preview`,
    ),
  // Fetch the stored logo bytes (auth-gated route) as an object URL for preview.
  // An <img src> can't attach the auth header, so we fetch + blob it. Returns
  // null when the project has no override. Caller must revoke the URL.
  fetchProjectEmailLogoObjectUrl: async (projectId: string): Promise<string | null> => {
    const res = await fetch(`${getApiBase()}/projects/${projectId}/email-logo/raw`, {
      headers: getAuthHeaders(),
    });
    if (!res.ok) return null;
    const blob = await res.blob();
    return URL.createObjectURL(blob);
  },
  updateReleaseNotificationSettings: (projectId: any, data: any) =>
    fetchJSON(`/projects/${projectId}/release-notification-settings`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  getInfraMetricPacks: (projectId: string) =>
    fetchJSON<{ packs: InfraServicePackWire[] }>(`/projects/${projectId}/infra/metric-packs`),
  // ── AI infrastructure setup wizard ───────────────────────────────
  // Hub-side readiness only: configured AWS profiles and their types, the
  // monitoring designation, the stored allowlist, and the `blockers[]` still
  // standing between this project and unattended collection. Issues no AWS
  // calls, so the module's empty state can read it freely.
  getInfraSetupDraft: (projectId: string) =>
    fetchJSON<InfraSetupDraftResponse>(`/projects/${projectId}/infra/setup-draft`),
  // Spawn the worktree-backed `[Infra Setup]` session that probes the account
  // read-only and proposes an allowlist. Returns `{ sessionId, agentId, draft }`.
  startInfraWizard: (projectId: string) =>
    fetchJSON<InfraWizardStartResponse>(`/projects/${projectId}/infra/setup-wizard`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  getInfraScopes: (projectId: string) => fetchJSON(`/projects/${projectId}/infra/scopes`),
  updateInfraScopes: (projectId: string, data: Record<string, unknown>) =>
    fetchJSON(`/projects/${projectId}/infra/scopes`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  // Prices a hypothetical allowlist. Persists nothing and issues no AWS calls,
  // so the editor can call it on every edit.
  projectInfraCost: (projectId: string, data: Record<string, unknown>) =>
    fetchJSON(`/projects/${projectId}/infra/cost/projection`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  // Cached AWS spend for the Overview tab. This read never calls AWS: the
  // server answers from a table a cron fills at most three times a day, because
  // `GetCostAndUsage` bills $0.01 per paginated request with no free tier and a
  // read-through cache would charge a cent per page view.
  getInfraSpend: (projectId: string, params: Record<string, unknown> = {}) =>
    fetchJSON<InfraSpendTrendWire>(`/projects/${projectId}/infra/spend${infraQuery(params)}`),
  // Service quota headroom for the Overview tab. Free to call: the server joins
  // limits from the hourly ListServiceQuotas sweep to usage the metric
  // collector already stored, and never touches AWS on this path.
  getInfraQuotas: (projectId: string, params: Record<string, unknown> = {}) =>
    fetchJSON<QuotaHeadroomResponse>(`/projects/${projectId}/infra/quotas${infraQuery(params)}`),
  // AWS Health event timeline for the Overview tab. Ingest-only: the Hub never
  // calls AWS on this path, it reads what an operator-owned EventBridge rule
  // pushed at `/api/infra/health/ingest`. `ingestConfigured` is what lets the
  // timeline tell "the rule was never wired up" apart from "genuinely quiet".
  getInfraHealthEvents: (projectId: string, params: Record<string, unknown> = {}) =>
    fetchJSON<InfraHealthEventsResponse>(
      `/projects/${projectId}/infra/health-events${infraQuery(params)}`,
    ),
  // Non-secret metadata about the ingest credential, plus the exact ingest path
  // and EventBridge pattern the operator has to paste into their own account.
  getInfraHealthIngest: (projectId: string) =>
    fetchJSON<InfraHealthIngestResponse>(`/projects/${projectId}/infra/health-ingest`),
  // Mints (or rotates) the ingest credential. This is the ONLY response that
  // ever carries the plaintext token — it cannot be read back afterwards, so a
  // caller that drops it has to rotate.
  createInfraHealthIngestToken: (projectId: string) =>
    fetchJSON<InfraHealthIngestMintResponse>(`/projects/${projectId}/infra/health-ingest`, {
      method: 'POST',
    }),
  revokeInfraHealthIngestToken: (projectId: string) =>
    fetchJSON<InfraHealthIngestRevokeResponse>(`/projects/${projectId}/infra/health-ingest`, {
      method: 'DELETE',
    }),
  // Opts the project in or out of the billed Cost Explorer poll. Returns the
  // same spend body, so the panel repaints from the response rather than
  // refetching.
  updateInfraSpendConfig: (projectId: string, data: { enabled: boolean }) =>
    fetchJSON<InfraSpendTrendWire>(`/projects/${projectId}/infra/spend/config`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  // Read surface for the Resources and Metrics tabs. Polled on an interval —
  // there is no metric WebSocket (decision INFRA-UI).
  listInfraResources: (projectId: string, params: Record<string, unknown> = {}) =>
    fetchJSON(`/projects/${projectId}/infra/resources${infraQuery(params)}`),
  // The Overview dashboard: every compute resource with its headline series
  // already reduced to a latest value and a sparkline. One request for the
  // whole grid — `getInfraMetricRange` below is one resource and one metric per
  // call, so building this client-side would be resources × metrics requests.
  getInfraFleet: (projectId: string, params: Record<string, unknown> = {}) =>
    fetchJSON<InfraFleetWire>(`/projects/${projectId}/infra/fleet${infraQuery(params)}`),
  listInfraMetricSeries: (projectId: string, resourceKey: string) =>
    fetchJSON(`/projects/${projectId}/infra/metric-series${infraQuery({ resource: resourceKey })}`),
  getInfraMetricRange: (projectId: string, params: Record<string, unknown>) =>
    fetchJSON(`/projects/${projectId}/infra/metrics${infraQuery(params)}`),
  getInfraAlertRouting: (projectId: string) =>
    fetchJSON(`/projects/${projectId}/infra/alert-routing`),
  updateInfraAlertRouting: (projectId: string, data: Record<string, unknown>) =>
    fetchJSON(`/projects/${projectId}/infra/alert-routing`, {
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
  // Mirror target: link an existing GitHub repo, or create one first.
  getGitHostMirrorOwners: (projectId: any) =>
    fetchJSON(`/projects/${projectId}/git-host/mirror/owners`),
  linkGitHostMirror: (projectId: any, body: any) =>
    fetchJSON(`/projects/${projectId}/git-host/mirror/link`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  unlinkGitHostMirror: (projectId: any) =>
    fetchJSON(`/projects/${projectId}/git-host/mirror/link`, { method: 'DELETE' }),
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
  /** Persistent Hub assistant session for the signed-in user (get-or-create). */
  getHubSession: () =>
    fetchJSON<{ session: Record<string, unknown>; agent: Record<string, unknown> }>(
      '/me/hub-session',
    ),
  clearHubSession: () =>
    fetchJSON<{
      session: Record<string, unknown>;
      agent: Record<string, unknown>;
      clearedSessionId: string | null;
    }>('/me/hub-session/clear', { method: 'POST' }),
  getHubModel: () => fetchJSON<{ engine: string; model: string }>('/me/hub-model'),
  putHubModel: (body: { engine: string; model: string }) =>
    fetchJSON<{ engine: string; model: string }>('/me/hub-model', {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  getDailySummary: (opts: { tz?: string } = {}) => {
    const params = new URLSearchParams();
    if (opts.tz) params.set('tz', opts.tz);
    const qs = params.toString();
    return fetchJSON<DailySummaryWire>(`/me/daily-summary${qs ? `?${qs}` : ''}`);
  },
  generateDailySummary: (opts: { tz?: string } = {}) =>
    fetchJSON<DailySummaryWire>('/me/daily-summary', {
      method: 'POST',
      body: JSON.stringify({ tz: opts.tz }),
      // Generation spawns an LLM one-shot; the server allows up to
      // GENERATE_TIMEOUT_MS (90s) for a large hub. The default 15s client
      // timeout aborts long before that, so give it headroom past the server.
      timeout: 120_000,
    }),
  getDailySummarySchedule: () =>
    fetchJSON<DailySummaryScheduleResponseWire>('/me/daily-summary/schedule'),
  setDailySummarySchedule: (schedule: { enabled: boolean; timeZone?: string; times: string[] }) =>
    fetchJSON<DailySummaryScheduleResponseWire>('/me/daily-summary/schedule', {
      method: 'PUT',
      body: JSON.stringify(schedule),
    }),
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
    driveId,
  }: {
    q?: string;
    pageSize?: number;
    pageToken?: string;
    orderBy?: string;
    driveId?: string;
  } = {}) => {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (pageSize) params.set('pageSize', String(pageSize));
    if (pageToken) params.set('pageToken', pageToken);
    if (orderBy) params.set('orderBy', orderBy);
    if (driveId) params.set('driveId', driveId);
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
  putProjectAwsProfiles: (
    projectId: any,
    profiles: any,
    defaultProfile: any = null,
    monitoringProfile: any = null,
  ) =>
    fetchJSON(`/projects/${projectId}/aws-profiles`, {
      method: 'PUT',
      body: JSON.stringify({
        profiles,
        defaultProfile: defaultProfile || null,
        monitoringProfile: monitoringProfile || null,
      }),
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
  getFinalizeEnvironmentDraft: (projectId: any) =>
    fetchJSON(`/projects/${projectId}/finalize/environment-draft`),
  // ── AI-assisted Dev Server (prEnv.devServer) setup wizard ────────
  // Read-only repo scan: start-command candidates, package manager,
  // monorepo layout, framework/port guesses, existing config. `{ projectId, draft }`.
  getDevServerSetupDraft: (projectId: any) =>
    fetchJSON(`/projects/${projectId}/dev-server/setup-draft`),
  // Spawn the worktree-backed `[Dev Server Setup]` wizard session loaded with
  // the `dev-server-setup` skill. Returns `{ sessionId, agentId, draft, session }`.
  startDevServerWizard: (projectId: any) =>
    fetchJSON(`/projects/${projectId}/dev-server/setup-wizard`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  // Notify Settings that the Dev Server wizard finished persisting config.
  completeDevServerWizard: (projectId: any) =>
    fetchJSON(`/projects/${projectId}/dev-server/wizard-complete`, {
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
  // ── AI logs setup wizard ─────────────────────────────────────────
  // Read-only repo scan: stack, logging libs, existing OTel setup, exporter
  // target candidates, recommended approach, existing sources. `{ projectId, draft }`.
  getLogsSetupDraft: (projectId: any) => fetchJSON(`/projects/${projectId}/logs/setup-draft`),
  // Spawn the worktree-backed `[Logs Setup]` wizard session loaded with the
  // `logs-setup` skill. Returns `{ sessionId, agentId, draft, session }`.
  startLogsWizard: (projectId: any) =>
    fetchJSON(`/projects/${projectId}/logs/setup-wizard`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
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
  // Destructive "Clear logs" — purge every ingested record for the project.
  // Admin-gated server-side; resolves to `{ purged: <count> }`.
  clearLogs: (projectId: any) => fetchJSON(`/projects/${projectId}/logs`, { method: 'DELETE' }),
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
  /** Batch triage — one transaction server-side; stale ids come back in `notFound`. */
  bulkSetLogIssueStatus: (
    projectId: any,
    issueIds: string[],
    status: 'open' | 'resolved' | 'ignored',
  ) =>
    fetchJSON(`/projects/${projectId}/logs/issues/bulk-status`, {
      method: 'POST',
      body: JSON.stringify({ issueIds, status }),
    }),
  analyzeLogIssue: (projectId: any, issueId: any, options: { startAnother?: boolean } = {}) =>
    fetchJSON(`/projects/${projectId}/logs/issues/${encodeURIComponent(issueId)}/analyze`, {
      method: 'POST',
      body: JSON.stringify({ startAnother: options.startAnother === true }),
    }),
  fixLogIssue: (projectId: any, issueId: any, options: { startAnother?: boolean } = {}) =>
    fetchJSON(`/projects/${projectId}/logs/issues/${encodeURIComponent(issueId)}/fix`, {
      method: 'POST',
      body: JSON.stringify({ startAnother: options.startAnother === true }),
    }),
  /** Log tail for one Hub-owned background shell. */
  getBackgroundShellLogs: (sessionId: string, shellId: string, limit = 200) =>
    fetchJSON<{ shell: unknown; logs: string[] }>(
      `/sessions/${sessionId}/background-shells/${shellId}/logs?limit=${limit}`,
    ),
  /** SIGTERM one background shell. Its session is still woken with the result. */
  stopBackgroundShell: (sessionId: string, shellId: string) =>
    fetchJSON(`/sessions/${sessionId}/background-shells/${shellId}/stop`, { method: 'POST' }),
  /** Tear down the whole watch loop: disarm the wakes and kill the processes. */
  cancelBackgroundShellWatch: (sessionId: string) =>
    fetchJSON<{ stopped: number; shells: unknown[] }>(
      `/sessions/${sessionId}/background-shells/watch/cancel`,
      { method: 'POST' },
    ),
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
      // Server worst case is 3x60s clone retries + backoff + ~120s env boot,
      // which can exceed 300s legitimately. A 900s budget avoids aborting a
      // clone/boot that is still going to succeed.
      timeout: 900_000,
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
  // Per-environment release gates (release-gate epic decision): one-shot gates
  // that fire a single deployment once their selected sessions are all merged
  // AND their selected epics are all done, then are consumed.
  // Candidate sessions the operator may gate a release on: project-wide, and
  // server-validated so only real, in-flight (non-merged) sessions come back —
  // never a purged/corrupt session id dangling on an old board card.
  listReleaseGateSessionCandidates: (projectId: string) =>
    fetchJSON<{ projectId: string; sessions: { id: string; label: string }[] }>(
      `/projects/${projectId}/deploy/release-gate-candidates`,
    ),
  listDeployReleaseGates: (projectId: string, environmentName: string) =>
    fetchJSON(
      `/projects/${projectId}/deploy/environments/${encodeURIComponent(
        environmentName,
      )}/release-gates`,
    ),
  createDeployReleaseGate: (
    projectId: string,
    environmentName: string,
    body: CreateDeployReleaseGateBody,
  ) =>
    fetchJSON(
      `/projects/${projectId}/deploy/environments/${encodeURIComponent(
        environmentName,
      )}/release-gates`,
      {
        method: 'POST',
        body: JSON.stringify(body),
      },
    ),
  updateDeployReleaseGate: (
    projectId: string,
    environmentName: string,
    gateId: string,
    body: UpdateDeployReleaseGateBody,
  ) =>
    fetchJSON(
      `/projects/${projectId}/deploy/environments/${encodeURIComponent(
        environmentName,
      )}/release-gates/${gateId}`,
      {
        method: 'PATCH',
        body: JSON.stringify(body),
      },
    ),
  deleteDeployReleaseGate: (projectId: string, environmentName: string, gateId: string) =>
    fetchJSON(
      `/projects/${projectId}/deploy/environments/${encodeURIComponent(
        environmentName,
      )}/release-gates/${gateId}`,
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
  // AI-suggest a project name from a description (wizard idk-fill).
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
  /**
   * Fetch a single session by id. The server read-gate is permissive (org
   * admins may read non-owned sessions), so this resolves a dashboard
   * deep-link to another user's session that the owner-only list omits.
   */
  getSession: (sessionId: string) => fetchJSON<SessionWire>(`/sessions/${sessionId}`),
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
    return normalizeSessionMessagesResponse<MessageWire>(data).messages;
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
  // Arm/disarm auto-merge on a native (Agent Hub-hosted) PR. Returns
  // { pr, merged } — `merged: true` when arming an already-green PR merged it.
  setNativePrAutoMerge: (projectId: any, number: any, enabled: boolean) =>
    fetchJSON(`/projects/${projectId}/pulls/${number}/auto-merge`, {
      method: 'POST',
      body: JSON.stringify({ enabled }),
    }),
  // Undo a merged PR: commits the inverse on the base branch and pushes the
  // moved branch to the GitHub mirror. Adds a commit; never rewrites history.
  revertNativePr: (projectId: any, number: any) =>
    fetchJSON(`/projects/${projectId}/pulls/${number}/revert`, { method: 'POST' }),
  // kind: 'human' flips the human-review flag only; 'agent' dispatches the
  // project Reviewer agent only; 'both' (default) does both (legacy behavior).
  requestNativePrReview: (projectId: any, number: any, requested: any = true, kind: any = 'both') =>
    fetchJSON(`/projects/${projectId}/pulls/${number}/request-review`, {
      method: 'POST',
      body: JSON.stringify({ requested, kind }),
    }),
  // ── PR-scoped previews (native Agent Hub-hosted PRs) ────────────────
  // Launch a live preview for the session that owns the PR's head branch.
  // Returns immediately; poll getNativePrPreviewState (or the agenthub_preview
  // WS channel) for loading → ready/failed transitions.
  startNativePrPreview: (projectId: any, number: any, opts: any = {}) =>
    fetchJSON(`/projects/${projectId}/pulls/${number}/preview/start`, {
      method: 'POST',
      body: JSON.stringify(opts),
    }),
  stopNativePrPreview: (projectId: any, number: any) =>
    fetchJSON(`/projects/${projectId}/pulls/${number}/preview/stop`, { method: 'POST' }),
  getNativePrPreviewState: (projectId: any, number: any) =>
    fetchJSON(`/projects/${projectId}/pulls/${number}/preview/state`),
  submitNativePrReview: (projectId: any, number: any, { state, body = '' }: any) =>
    fetchJSON(`/projects/${projectId}/pulls/${number}/reviews`, {
      method: 'POST',
      body: JSON.stringify({ state, body }),
    }),
  // Dismiss a submitted verdict review (GitHub "Dismiss review"). One-way; a
  // reason is required. The row stays for history but stops counting toward
  // the review decision and renders collapsed with the note.
  dismissNativePrReview: (projectId: any, number: any, reviewId: any, reason: any) =>
    fetchJSON(`/projects/${projectId}/pulls/${number}/reviews/${reviewId}/dismiss`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
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
  // Resolve/unresolve the inline comment thread anchored at filePath+line+side.
  setNativePrCommentThreadResolved: (
    projectId: any,
    number: any,
    { filePath, line, side = 'new', resolved }: any,
  ) =>
    fetchJSON(`/projects/${projectId}/pulls/${number}/comment-threads/resolve`, {
      method: 'POST',
      body: JSON.stringify({ filePath, line, side, resolved }),
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
  // Per-project Stats page — daily/weekly/monthly product metrics.
  getProjectStats: (projectId: any, { granularity = 'day', buckets }: any = {}) => {
    const qs = new URLSearchParams({ granularity });
    if (buckets != null) qs.set('buckets', String(buckets));
    return fetchJSON(`/projects/${projectId}/stats?${qs.toString()}`);
  },
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
  addSessionAgent: (sessionId: any, agentId: any, model: any = null) =>
    fetchJSON(`/sessions/${sessionId}/agents`, {
      method: 'POST',
      body: JSON.stringify({ agentId, model: model || null }),
    }),
  removeSessionAgent: (sessionId: any, participantId: any) =>
    fetchJSON(`/sessions/${sessionId}/agents/${participantId}`, { method: 'DELETE' }),
  setSessionAgentModel: (sessionId: any, participantId: any, model: any) =>
    fetchJSON(`/sessions/${sessionId}/agents/${participantId}/model`, {
      method: 'PUT',
      body: JSON.stringify({ model: model || null }),
    }),
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
  /** Choose an initial branch, or switch a clean provisioned worktree. */
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
  forwardSession: (
    sessionId: any,
    { targetAgentId, messageIds, prompt, autoStart, model }: any = {},
  ) =>
    fetchJSON(`/sessions/${sessionId}/forward`, {
      method: 'POST',
      body: JSON.stringify({
        targetAgentId,
        ...(messageIds ? { messageIds } : {}),
        ...(prompt ? { prompt } : {}),
        ...(autoStart != null ? { autoStart: !!autoStart } : {}),
        ...(model ? { model } : {}),
      }),
      timeout: 30000,
    }),
  /**
   * Start a follow-up session from an existing one. Unlike forward, the target
   * agent defaults to the source session's own agent and the seed is the
   * Finalize summary rather than the whole transcript.
   */
  startFollowUpSession: (sessionId: any, { targetAgentId, prompt, autoStart }: any = {}) =>
    fetchJSON(`/sessions/${sessionId}/follow-up`, {
      method: 'POST',
      body: JSON.stringify({
        ...(targetAgentId ? { targetAgentId } : {}),
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

  // Per-project default-on skills — auto-loaded into every session in the
  // project. Reads are open; writes (POST/DELETE) require Admin+ server-side.
  getProjectDefaultSkills: (projectId: any) => fetchJSON(`/projects/${projectId}/default-skills`),
  addProjectDefaultSkill: (projectId: any, skillId: any) =>
    fetchJSON(`/projects/${projectId}/default-skills`, {
      method: 'POST',
      body: JSON.stringify({ skillId }),
    }),
  removeProjectDefaultSkill: (projectId: any, skillId: any) =>
    fetchJSON(`/projects/${projectId}/default-skills/${encodeURIComponent(skillId)}`, {
      method: 'DELETE',
    }),

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
        // Percent-encode so Unicode filenames survive the header's Latin-1
        // charset limit; the server decodes it (decodeFilenameHeader).
        'X-Filename': encodeURIComponent(file.name || 'upload'),
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
  // Persists `onboardingComplete: true`. Rejects on a non-2xx (403 for a
  // non-Owner caller, 500 if the flag can't be written) so the wizard can
  // stay open and offer a retry instead of closing over a failed write.
  completeSetup: () => fetchJSON('/setup/complete', { method: 'POST' }),

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
  //
  // A 401 from these routes is ambiguous, so the server disambiguates it:
  // `code: 'no_user_identity'` means "authenticated, but no per-user row"
  // (legacy apiKey / local-bypass gap) and fetchJSON leaves it to the
  // caller — the panels render an empty state. An untagged 401 is a real
  // dead session and still clears the token + reloads, on writes too.
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

  // Sidebar project collapse state — persisted per user so the sidebar looks
  // the same on web, mobile, and Electron. The PUT merges one project
  // server-side, so toggling in one tab can't clobber another tab's edit.
  getMySidebarCollapsedProjects: () => fetchJSON('/auth/me/sidebar-collapsed-projects'),
  putMySidebarCollapsedProject: (projectId: any, collapsed: boolean) =>
    fetchJSON(`/auth/me/sidebar-collapsed-projects/${encodeURIComponent(projectId)}`, {
      method: 'PUT',
      body: JSON.stringify({ collapsed }),
    }),

  getSkillCredentials: (skillId: any) =>
    fetchJSON(
      `/auth/me/skill-credentials${skillId ? `?skillId=${encodeURIComponent(skillId)}` : ''}`,
    ),
  putSkillCredential: (body: any) =>
    fetchJSON('/auth/me/skill-credentials', { method: 'PUT', body: JSON.stringify(body) }),
  deleteSkillCredential: (id: any) =>
    fetchJSON(`/auth/me/skill-credentials/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  // Per-user skill options — owner-declared enums (e.g. dev/prod) the signed-in
  // user selects. `selected` in each returned option is the effective value
  // (stored choice or declared default). DELETE resets a choice to its default.
  getSkillOptions: (skillId: any, agentId: any) =>
    fetchJSON(
      `/auth/me/skill-options?skillId=${encodeURIComponent(skillId)}${
        agentId ? `&agentId=${encodeURIComponent(agentId)}` : ''
      }`,
    ),
  putSkillOption: (body: any) =>
    fetchJSON('/auth/me/skill-options', { method: 'PUT', body: JSON.stringify(body) }),
  deleteSkillOption: (skillId: any, optionName: any) =>
    fetchJSON(
      `/auth/me/skill-options/${encodeURIComponent(skillId)}/${encodeURIComponent(optionName)}`,
      { method: 'DELETE' },
    ),
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
  // Every card on the board, unpaged. Used to resolve a card the paged board
  // view hasn't loaded yet (e.g. deep-linking to a card from another surface).
  getBoardCards: (projectId: any) => fetchJSON(`/projects/${projectId}/board/cards`),
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
  getEpicPulls: (projectId: any, epicId: any) =>
    fetchJSON(`/projects/${projectId}/board/epics/${epicId}/pulls`),
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
  // Re-rate a ticket's severity (critical | high | medium | low). Reorders the
  // queue server-side and emits a support_ticket_updated WebSocket event.
  setSupportTicketSeverity: (projectId: any, id: any, severity: any) =>
    fetchJSON(`/projects/${projectId}/support-tickets/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ severity }),
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
  // Link a support ticket to an EXISTING kanban card (the sibling of convert).
  // Stamps the ticket back-link + a preserving comment on the target card, then
  // flags the ticket `converted` (retained, not deleted) so it leaves the open
  // queue. Returns { card, ticket, ticketId, linked: true }. 404 if the card
  // isn't on the board; 409 if the ticket is already converted or the card is
  // already linked to another ticket.
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

  // Score-ranked voting feed — only `type=feature_request` tickets, sorted by
  // score desc, each carrying a `voting` tally { score, upvotes, downvotes,
  // myVote, comment_count }. Pass the per-browser `voterKey` so `myVote`
  // reflects this device's current vote; omit it and myVote is null.
  getVotingItems: (projectId: any, voterKey?: any) => {
    const qs = voterKey ? `?voterKey=${encodeURIComponent(String(voterKey))}` : '';
    return fetchJSON(`/projects/${projectId}/support-tickets/voting${qs}`);
  },
  // Cast, change, or retract a vote on a feature-request ticket. `value` is 1
  // (up), -1 (down), or null (retract). Returns the fresh aggregate { score,
  // upvotes, downvotes, myVote } and emits a support_ticket_vote_updated
  // WebSocket event so other clients reconcile without a refetch.
  castVote: (projectId: any, id: any, voterKey: any, value: any) =>
    fetchJSON(`/projects/${projectId}/support-tickets/${id}/vote`, {
      method: 'PUT',
      body: JSON.stringify({ voterKey, value }),
    }),

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

  // Session previews (project-scoped list + teardown)
  getProjectPreviews: (projectId: any) => fetchJSON(`/projects/${projectId}/previews`),
  purgeAllProjectPreviews: (projectId: any) =>
    fetchJSON(`/projects/${projectId}/previews/purge`, {
      method: 'POST',
      timeout: 120000,
    }),
  stopPreview: (projectId: any, previewId: any) =>
    fetchJSON(`/projects/${projectId}/previews/${previewId}/stop`, {
      method: 'POST',
      timeout: 30000,
    }),

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
  getProjectPulls: (projectId: any, { state = 'open', limit = 30, page = 1 }: any = {}) => {
    const params = new URLSearchParams();
    if (state) params.set('state', state);
    if (limit) params.set('limit', String(limit));
    if (page && page > 1) params.set('page', String(page));
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
  setPrAutoMerge: (prUrl: any, enabled: boolean, mergeMethod: any = 'squash') =>
    fetchJSON('/pr/auto-merge', {
      method: 'POST',
      body: JSON.stringify({ prUrl, enabled, mergeMethod }),
      timeout: 30000,
    }),
  getPrStatus: (prUrl: any) => fetchJSON(`/pr/status?prUrl=${encodeURIComponent(prUrl)}`),

  // Container pool observability (W4)
  getPoolMetrics: (windowHours: any = 24) => fetchJSON(`/pool/metrics?windowHours=${windowHours}`),
  getPoolAlerts: (status: any = 'active') => fetchJSON(`/pool/alerts?status=${status}`),
};

/** Typed REST client for Agent Hub API routes (base path `/api`). */
export type ApiClient = typeof api;
