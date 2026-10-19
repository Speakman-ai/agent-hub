/**
 * Organization dispatch facade: an organization agent asks a linked project's agent to
 * do work. Every request is authorized against the capability's current authority, then
 * runs through the ordinary `dispatchBackgroundAgentSession` lifecycle, so the target
 * session is a normal project session owned by the acting user, in the project's default
 * (lowest) automation level. Nothing here switches the active Server.
 *
 * Requests are recorded with provenance and keyed by (initiating session, idempotency key):
 * an identical retry returns the same target session or queued request, a conflicting
 * payload fails. A target already working on an earlier dispatch from the same
 * organization user is "busy" and the request queues; queued requests are re-authorized
 * when they run, so revocation or an unlink in between turns them into `revoked`.
 */
import { createHash, randomUUID } from 'node:crypto';
import { getDb, getStmts } from './db.js';
import { getActiveOrgId } from './orgs.js';
import { findProjectForServer } from './project-model.js';
import { listBusinessOrganizationProjectLinks } from './business-organizations-store.js';
import {
  currentOrganizationAuthority,
  isOrganizationWorkspace,
  organizationCapabilityCanReadProject,
  type OrganizationCapability,
} from './organization-capabilities.js';
import {
  BackgroundSessionDispatchError,
  dispatchBackgroundAgentSession,
  isEligibleBackgroundSessionAgent,
} from './background-agent-session.js';
import { isSessionChatBusy } from './session-chat-busy.js';
import { computeSessionState } from './session-state.js';
import { isInternalSystemProject } from '../shared/utils/hub.js';
import { formatHubChatRefToken } from '../shared/utils/hubChatRefTokens.js';
import type { Agent, Project } from './types.js';

export const ORGANIZATION_DISPATCH_STATUSES = [
  'queued',
  'starting',
  'accepted',
  'rejected',
  'failed',
  'revoked',
  'expired',
] as const;
export type OrganizationDispatchStatus = (typeof ORGANIZATION_DISPATCH_STATUSES)[number];

/** Queued requests that never get a free target are dropped after a day. */
export const ORGANIZATION_DISPATCH_QUEUE_TTL_MS = 24 * 60 * 60 * 1000;
/** A kicked-off turn registers its active task asynchronously; treat it as running meanwhile. */
const KICKOFF_GRACE_MS = 2 * 60 * 1000;
const DRAIN_INTERVAL_MS = 5_000;

/** Concurrent org-dispatched sessions per (organization, acting user, target agent). */
export function organizationDispatchMaxActive(): number {
  const raw = Number(process.env.AGENT_HUB_ORG_DISPATCH_MAX_ACTIVE_PER_AGENT);
  return Number.isInteger(raw) && raw >= 1 && raw <= 20 ? raw : 1;
}

export interface OrganizationDispatchRow {
  id: string;
  server_id: string;
  organization_id: string;
  organization_agent_id: string;
  workspace_id: string;
  initiating_session_id: string;
  acting_user_id: string;
  target_project_id: string;
  target_agent_id: string;
  idempotency_key: string;
  payload_hash: string;
  session_name: string;
  prompt: string;
  status: OrganizationDispatchStatus;
  outcome_code: string | null;
  outcome_message: string | null;
  target_session_id: string | null;
  config_version: string | null;
  link_id: string | null;
  attempts: number;
  created_at: string;
  updated_at: string;
  accepted_at: string | null;
}

export interface OrganizationDispatchInput {
  projectId: string;
  agentId: string;
  prompt: string;
  name?: string | null;
  idempotencyKey: string;
}

export interface OrganizationDispatchView {
  requestId: string;
  status: OrganizationDispatchStatus;
  code: string | null;
  message: string | null;
  serverId: string;
  organizationId: string;
  organizationAgentId: string;
  initiatingSessionId: string;
  actingUserId: string;
  projectId: string;
  agentId: string;
  idempotencyKey: string;
  name: string;
  sessionId: string | null;
  ref: string | null;
  sessionState: string | null;
  statusPath: string;
  resultPath: string | null;
  createdAt: string;
  updatedAt: string;
  acceptedAt: string | null;
}

export interface OrganizationDispatchOutcome {
  httpStatus: number;
  replayed: boolean;
  view: OrganizationDispatchView;
}

/** Rejected before any record exists (bad org, conflicting reuse). */
export class OrganizationDispatchError extends Error {
  constructor(
    public readonly httpStatus: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const now = () => new Date().toISOString();

export function sessionNameForDispatch(prompt: string): string {
  const line = prompt.trim().split('\n')[0]?.trim() ?? '';
  if (line.length <= 60) return line || 'New session';
  return `${line.slice(0, 57).trimEnd()}...`;
}

function payloadHash(input: OrganizationDispatchInput): string {
  return createHash('sha256')
    .update(
      JSON.stringify([input.projectId, input.agentId, input.prompt, input.name?.trim() || null]),
    )
    .digest('hex');
}

function getRow(id: string): OrganizationDispatchRow | undefined {
  return getDb().prepare('SELECT * FROM organization_dispatch_requests WHERE id = ?').get(id) as
    | OrganizationDispatchRow
    | undefined;
}

function update(id: string, fields: Partial<OrganizationDispatchRow>): void {
  const entries = Object.entries({ ...fields, updated_at: now() });
  getDb()
    .prepare(
      `UPDATE organization_dispatch_requests SET ${entries.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`,
    )
    .run(...entries.map(([, v]) => v ?? null), id);
}

export function toDispatchView(row: OrganizationDispatchRow): OrganizationDispatchView {
  // A reserved id is not a session until the start settles.
  const sessionId =
    row.status === 'accepted' || row.status === 'failed' ? row.target_session_id : null;
  let sessionState: string | null = null;
  if (sessionId) {
    try {
      sessionState = computeSessionState(getStmts(), sessionId);
    } catch {
      sessionState = null;
    }
  }
  return {
    requestId: row.id,
    status: row.status,
    code: row.outcome_code,
    message: row.outcome_message,
    serverId: row.server_id,
    organizationId: row.organization_id,
    organizationAgentId: row.organization_agent_id,
    initiatingSessionId: row.initiating_session_id,
    actingUserId: row.acting_user_id,
    projectId: row.target_project_id,
    agentId: row.target_agent_id,
    idempotencyKey: row.idempotency_key,
    name: row.session_name,
    sessionId,
    ref: sessionId ? (formatHubChatRefToken(row.session_name, 'session', sessionId) ?? null) : null,
    sessionState,
    statusPath: `/api/organizations/${row.organization_id}/dispatches/${row.id}`,
    resultPath: sessionId
      ? `/api/organizations/${row.organization_id}/context/projects/${row.target_project_id}/sessions/${sessionId}`
      : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    acceptedAt: row.accepted_at,
  };
}

type TargetCheck =
  | { ok: true; project: Project; agent: Agent }
  | { ok: false; httpStatus: number; code: string; message: string };

/** Target validation shared by request time and queued execution time. */
function checkTarget(serverId: string, projectId: string, agentId: string): TargetCheck {
  const project = findProjectForServer(serverId, projectId);
  if (!project || isInternalSystemProject(project) || isOrganizationWorkspace(project)) {
    // Recursive organization-to-organization dispatch is not a valid target either.
    return {
      ok: false,
      httpStatus: 404,
      code: 'target_not_found',
      message: 'Project not found',
    };
  }
  const agent = (project.agents ?? []).find((a) => a.id === agentId);
  if (!agent) {
    return {
      ok: false,
      httpStatus: 404,
      code: 'agent_not_found',
      message: 'Agent not found in project',
    };
  }
  if (agent.active === false) {
    return {
      ok: false,
      httpStatus: 422,
      code: 'agent_disabled',
      message: `Agent "${agent.id}" is disabled`,
    };
  }
  if (!isEligibleBackgroundSessionAgent(agent)) {
    return {
      ok: false,
      httpStatus: 422,
      code: 'agent_ineligible',
      message: `Agent "${agent.id}" cannot host a dispatched session`,
    };
  }
  return { ok: true, project, agent };
}

/** Request-time authorization from a verified capability. Never leaks project existence. */
function checkCapability(
  grant: OrganizationCapability,
  input: OrganizationDispatchInput,
): TargetCheck {
  if (!grant.tools.includes('dispatch')) {
    return {
      ok: false,
      httpStatus: 403,
      code: 'dispatch_not_permitted',
      message: 'This organization agent is not configured to dispatch project agents',
    };
  }
  if (!organizationCapabilityCanReadProject(grant, input.projectId, 'dispatch')) {
    return {
      ok: false,
      httpStatus: 404,
      code: 'target_not_found',
      message: 'Project not found',
    };
  }
  return checkTarget(grant.serverId, input.projectId, input.agentId);
}

function isSessionActive(sessionId: string, acceptedAt: string | null): boolean {
  const stmts = getStmts();
  const task = stmts.getActiveTask.get(sessionId) as
    | { status?: string | null; pid?: number | null }
    | undefined;
  if (task) return isSessionChatBusy(sessionId, new Map(), task as never);
  const session = stmts.getSession.get(sessionId) as
    | { last_turn_error?: string | null; deleted_at?: string | null }
    | undefined;
  if (!session || session.deleted_at || session.last_turn_error) return false;
  const answered = getDb()
    .prepare("SELECT 1 FROM messages WHERE session_id = ? AND role = 'assistant' LIMIT 1")
    .get(sessionId);
  if (answered) return false;
  const started = acceptedAt ? Date.parse(acceptedAt) : NaN;
  return Number.isFinite(started) && Date.now() - started < KICKOFF_GRACE_MS;
}

function targetBusy(row: OrganizationDispatchRow): boolean {
  const running = getDb()
    .prepare(
      `SELECT target_session_id, accepted_at FROM organization_dispatch_requests
       WHERE server_id = ? AND organization_id = ? AND acting_user_id = ?
         AND target_project_id = ? AND target_agent_id = ?
         AND status IN ('accepted', 'starting')
         AND target_session_id IS NOT NULL AND id != ?`,
    )
    .all(
      row.server_id,
      row.organization_id,
      row.acting_user_id,
      row.target_project_id,
      row.target_agent_id,
      row.id,
    ) as Array<{ target_session_id: string; accepted_at: string | null }>;
  const active = running.filter((r) => isSessionActive(r.target_session_id, r.accepted_at)).length;
  return active >= organizationDispatchMaxActive();
}

/** An earlier queued request for the same target runs first. */
function olderQueued(row: OrganizationDispatchRow): boolean {
  return Boolean(
    getDb()
      .prepare(
        `SELECT 1 FROM organization_dispatch_requests
         WHERE server_id = ? AND organization_id = ? AND acting_user_id = ?
           AND target_project_id = ? AND target_agent_id = ? AND status = 'queued'
           AND id != ? AND created_at < ? LIMIT 1`,
      )
      .get(
        row.server_id,
        row.organization_id,
        row.acting_user_id,
        row.target_project_id,
        row.target_agent_id,
        row.id,
        row.created_at,
      ),
  );
}

/**
 * Start the target session. Only called after authorization and the busy check.
 *
 * The session id is reserved durably (`starting`) before the session is created, and the
 * session is created under that id. If the process dies anywhere in between, the drain
 * reconciles the reservation on restart instead of starting a second session.
 */
function execute(row: OrganizationDispatchRow, project: Project): OrganizationDispatchRow {
  const sessionId = row.target_session_id ?? randomUUID();
  update(row.id, {
    status: 'starting',
    target_session_id: sessionId,
    outcome_code: null,
    outcome_message: null,
  });
  try {
    dispatchBackgroundAgentSession(
      project,
      {
        id: row.id,
        name: row.session_name,
        prompt: row.prompt,
        ownerUserId: row.acting_user_id,
        sessionAgentId: row.target_agent_id,
        // No mode/engine/model: the project's default (manual) Finalize level applies,
        // so organization dispatch can never raise automation.
        sessionMode: null,
        engine: null,
        model: null,
        skills: [],
        runAsSession: true,
      },
      {
        sessionId,
        sessionName: row.session_name,
        onKickoffError: (message) => {
          try {
            update(row.id, {
              status: 'failed',
              outcome_code: 'kickoff_failed',
              outcome_message: message.slice(0, 500),
            });
          } catch {
            /* best effort: the session itself reports the failed turn */
          }
        },
      },
    );
  } catch (err) {
    if (!(err instanceof BackgroundSessionDispatchError)) throw err;
    // Dispatch errors are raised before the session row is written.
    update(row.id, {
      status: 'failed',
      outcome_code: err.code,
      outcome_message: err.message,
      target_session_id: null,
    });
    return getRow(row.id)!;
  }
  const at = now();
  // The kickoff error callback may already have marked the row failed; keep that.
  getDb()
    .prepare(
      `UPDATE organization_dispatch_requests
       SET status = CASE WHEN status = 'failed' THEN status ELSE 'accepted' END,
           outcome_code = CASE WHEN status = 'failed' THEN outcome_code ELSE NULL END,
           outcome_message = CASE WHEN status = 'failed' THEN outcome_message ELSE NULL END,
           accepted_at = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(at, at, row.id);
  return getRow(row.id)!;
}

/**
 * Settle a `starting` reservation left by an interrupted process. Returns the row to keep
 * processing as queued when no session was created, else null.
 */
function reconcileStarting(row: OrganizationDispatchRow): OrganizationDispatchRow | null {
  const sessionId = row.target_session_id;
  const session = sessionId ? getStmts().getSession.get(sessionId) : undefined;
  if (!sessionId || !session) {
    // Nothing was created: run it as a queued request, re-authorized, under the same id.
    update(row.id, { status: 'queued' });
    return getRow(row.id)!;
  }
  const kickedOff = getDb()
    .prepare("SELECT 1 FROM messages WHERE session_id = ? AND role = 'user' LIMIT 1")
    .get(sessionId);
  const at = now();
  if (kickedOff) {
    update(row.id, { status: 'accepted', accepted_at: row.accepted_at ?? at });
  } else {
    // The session exists but its first prompt never ran. Re-sending could double the work
    // if the turn did start, so surface it instead; the session stays the user's.
    update(row.id, {
      status: 'failed',
      outcome_code: 'interrupted',
      outcome_message: 'The Hub stopped while starting the target session; its task never ran',
      accepted_at: row.accepted_at ?? at,
    });
  }
  return null;
}

function httpStatusFor(row: OrganizationDispatchRow, replayed: boolean): number {
  if (row.status === 'queued' || row.status === 'starting') return 202;
  if (row.status === 'accepted' || (row.status === 'failed' && row.target_session_id))
    return replayed ? 200 : 201;
  if (row.outcome_code === 'no_hook') return 503;
  if (row.status === 'failed') return 422;
  return 403;
}

/**
 * Handle one dispatch request from an organization capability. `organizationId` is the
 * route's organization; it must match the capability.
 */
export function requestOrganizationDispatch(
  grant: OrganizationCapability,
  organizationId: string,
  input: OrganizationDispatchInput,
): OrganizationDispatchOutcome {
  if (grant.organizationId !== organizationId || grant.serverId !== getActiveOrgId()) {
    throw new OrganizationDispatchError(404, 'organization_not_found', 'Organization not found');
  }
  const db = getDb();
  const hash = payloadHash(input);
  const name = input.name?.trim() || sessionNameForDispatch(input.prompt);

  // better-sqlite3 is synchronous, so the lookup, the checks and the session insert
  // inside dispatchBackgroundAgentSession run without interleaving another request.
  const existing = db
    .prepare(
      `SELECT * FROM organization_dispatch_requests
       WHERE server_id = ? AND initiating_session_id = ? AND idempotency_key = ?`,
    )
    .get(grant.serverId, grant.sessionId, input.idempotencyKey) as
    | OrganizationDispatchRow
    | undefined;
  if (existing && existing.payload_hash !== hash) {
    throw new OrganizationDispatchError(
      409,
      'idempotency_conflict',
      'This idempotency key was already used for a different dispatch request',
    );
  }

  const check = checkCapability(grant, input);
  if (existing && (existing.target_session_id || existing.status === 'queued')) {
    // Replays are re-authorized: after an unlink the session stays the user's, but the
    // organization no longer gets to see it.
    if (!check.ok) {
      return {
        httpStatus: check.httpStatus,
        replayed: true,
        view: {
          ...toDispatchView(existing),
          code: check.code,
          message: check.message,
          sessionId: null,
          ref: null,
          sessionState: null,
          resultPath: null,
        },
      };
    }
    return {
      httpStatus: httpStatusFor(existing, true),
      replayed: true,
      view: toDispatchView(existing),
    };
  }

  const links = listBusinessOrganizationProjectLinks(grant.serverId, grant.organizationId);
  const fields = {
    organization_agent_id: grant.agentId,
    workspace_id: grant.workspaceId,
    acting_user_id: grant.userId,
    target_project_id: input.projectId,
    target_agent_id: input.agentId,
    session_name: name,
    prompt: input.prompt,
    config_version: grant.configVersion,
    link_id: links.get(input.projectId) ?? null,
    status: (check.ok ? 'queued' : 'rejected') as OrganizationDispatchStatus,
    outcome_code: check.ok ? null : check.code,
    outcome_message: check.ok ? null : check.message,
  };
  let row: OrganizationDispatchRow;
  if (existing) {
    // Rejected or failed attempts created no session; a retry re-evaluates in place.
    update(existing.id, { ...fields, attempts: existing.attempts + 1 });
    row = getRow(existing.id)!;
  } else {
    const id = randomUUID();
    const at = now();
    db.prepare(
      `INSERT INTO organization_dispatch_requests (
         id, server_id, organization_id, organization_agent_id, workspace_id,
         initiating_session_id, acting_user_id, target_project_id, target_agent_id,
         idempotency_key, payload_hash, session_name, prompt, status, outcome_code,
         outcome_message, config_version, link_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      grant.serverId,
      grant.organizationId,
      fields.organization_agent_id,
      fields.workspace_id,
      grant.sessionId,
      fields.acting_user_id,
      fields.target_project_id,
      fields.target_agent_id,
      input.idempotencyKey,
      hash,
      fields.session_name,
      fields.prompt,
      fields.status,
      fields.outcome_code,
      fields.outcome_message,
      fields.config_version,
      fields.link_id,
      at,
      at,
    );
    row = getRow(id)!;
  }
  if (!check.ok) {
    return { httpStatus: check.httpStatus, replayed: false, view: toDispatchView(row) };
  }
  if (targetBusy(row) || olderQueued(row)) {
    update(row.id, {
      outcome_code: 'target_busy',
      outcome_message: 'The target agent is still working on an earlier dispatch; queued',
    });
    ensureOrganizationDispatchQueue();
    row = getRow(row.id)!;
    return { httpStatus: 202, replayed: false, view: toDispatchView(row) };
  }
  row = execute(row, check.project);
  return { httpStatus: httpStatusFor(row, false), replayed: false, view: toDispatchView(row) };
}

/**
 * Re-authorize a queued request against the initiating session's current authority.
 * The configuration version and link generation must match the ones it was queued under,
 * so an unlink-and-relink or a scope change in between revokes it.
 */
function queuedStillAuthorized(row: OrganizationDispatchRow): boolean {
  const current = currentOrganizationAuthority(row.initiating_session_id);
  if (!current) return false;
  if (
    current.serverId !== row.server_id ||
    current.organizationId !== row.organization_id ||
    current.userId !== row.acting_user_id ||
    current.agentId !== row.organization_agent_id ||
    current.configVersion !== row.config_version ||
    !current.tools.includes('dispatch') ||
    !current.projectIds.includes(row.target_project_id)
  )
    return false;
  const link = listBusinessOrganizationProjectLinks(row.server_id, row.organization_id).get(
    row.target_project_id,
  );
  return link !== undefined && link === (row.link_id ?? '');
}

/** Run queued requests whose target is free. Only rows of the active Server are touched. */
export function drainOrganizationDispatchQueue(): void {
  let serverId: string;
  try {
    serverId = getActiveOrgId();
  } catch {
    return;
  }
  const rows = getDb()
    .prepare(
      `SELECT * FROM organization_dispatch_requests
       WHERE server_id = ? AND status IN ('queued', 'starting') ORDER BY created_at, id`,
    )
    .all(serverId) as OrganizationDispatchRow[];
  for (let row of rows) {
    try {
      if (row.status === 'starting') {
        const pending = reconcileStarting(row);
        if (!pending) continue;
        row = pending;
      }
      if (Date.now() - Date.parse(row.created_at) > ORGANIZATION_DISPATCH_QUEUE_TTL_MS) {
        update(row.id, {
          status: 'expired',
          outcome_code: 'queue_expired',
          outcome_message: 'The target stayed busy; the queued request expired',
          target_session_id: null,
        });
        continue;
      }
      if (!queuedStillAuthorized(row)) {
        update(row.id, {
          status: 'revoked',
          outcome_code: 'access_revoked',
          outcome_message: 'Organization access changed before the queued request ran',
          target_session_id: null,
        });
        continue;
      }
      const target = checkTarget(row.server_id, row.target_project_id, row.target_agent_id);
      if (!target.ok) {
        update(row.id, {
          status: 'failed',
          outcome_code: target.code,
          outcome_message: target.message,
          target_session_id: null,
        });
        continue;
      }
      if (targetBusy(row) || olderQueued(row)) continue;
      execute(row, target.project);
    } catch (err) {
      console.error(
        `[organization-dispatch] queued request ${row.id} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      try {
        const current = getRow(row.id);
        if (current?.status !== 'starting' || reconcileStarting(current))
          update(row.id, {
            status: 'failed',
            outcome_code: 'dispatch_error',
            outcome_message: 'The queued request could not be started',
            target_session_id: null,
          });
      } catch {
        /* keep draining */
      }
    }
  }
}

let drainTimer: ReturnType<typeof setInterval> | null = null;

/** Starts the background drain once; safe to call repeatedly. */
export function ensureOrganizationDispatchQueue(): void {
  if (drainTimer) return;
  drainTimer = setInterval(() => {
    try {
      drainOrganizationDispatchQueue();
    } catch (err) {
      console.error('[organization-dispatch] drain failed:', err);
    }
  }, DRAIN_INTERVAL_MS);
  drainTimer.unref();
}

export function stopOrganizationDispatchQueueForTests(): void {
  if (drainTimer) clearInterval(drainTimer);
  drainTimer = null;
}

export function getOrganizationDispatch(
  serverId: string,
  organizationId: string,
  requestId: string,
): OrganizationDispatchRow | null {
  const row = getRow(requestId);
  return row && row.server_id === serverId && row.organization_id === organizationId ? row : null;
}

export function listOrganizationDispatches(args: {
  serverId: string;
  organizationId: string;
  actingUserId: string;
  initiatingSessionId?: string | null;
  limit: number;
  offset: number;
}): OrganizationDispatchRow[] {
  const params: unknown[] = [args.serverId, args.organizationId, args.actingUserId];
  let where = 'server_id = ? AND organization_id = ? AND acting_user_id = ?';
  if (args.initiatingSessionId) {
    where += ' AND initiating_session_id = ?';
    params.push(args.initiatingSessionId);
  }
  return getDb()
    .prepare(
      `SELECT * FROM organization_dispatch_requests WHERE ${where}
       ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, args.limit, args.offset) as OrganizationDispatchRow[];
}
