/**
 * Persistence for agent approval requests and remembered rules. The wait
 * itself (the parked turn) lives in `approval-requests.ts`; this module only
 * reads and writes rows.
 */
import { v4 as uuidv4 } from 'uuid';
import { getOrgsDb } from './orgs.js';

export type ApprovalStatus = 'pending' | 'allowed' | 'denied' | 'cancelled';
export type ApprovalResolution =
  | 'allow_once'
  | 'always_allow'
  | 'auto_allowed'
  | 'deny'
  | 'timeout'
  | 'aborted';
export type ApprovalRuleEffect = 'allow' | 'require';

export interface ApprovalRequest {
  id: string;
  sessionId: string;
  userId: string | null;
  agentId: string;
  projectId: string | null;
  profileId: string | null;
  action: string;
  target: string;
  domain: string | null;
  details: string;
  status: ApprovalStatus;
  resolution: ApprovalResolution | null;
  ruleId: string | null;
  resolvedBy: string | null;
  requestedAt: number;
  expiresAt: number;
  resolvedAt: number | null;
}

export interface ApprovalRule {
  id: string;
  profileId: string;
  userId: string;
  domain: string;
  action: string;
  effect: ApprovalRuleEffect;
  sourceRequestId: string | null;
  createdAt: string;
}

interface RequestRow {
  id: string;
  session_id: string;
  user_id: string | null;
  agent_id: string;
  project_id: string | null;
  profile_id: string | null;
  action: string;
  target: string;
  domain: string | null;
  details: string;
  status: ApprovalStatus;
  resolution: ApprovalResolution | null;
  rule_id: string | null;
  resolved_by: string | null;
  requested_at: number;
  expires_at: number;
  resolved_at: number | null;
}

interface RuleRow {
  id: string;
  profile_id: string;
  user_id: string;
  domain: string;
  action: string;
  effect: ApprovalRuleEffect;
  source_request_id: string | null;
  created_at: string;
}

function toRequest(r: RequestRow): ApprovalRequest {
  return {
    id: r.id,
    sessionId: r.session_id,
    userId: r.user_id,
    agentId: r.agent_id,
    projectId: r.project_id,
    profileId: r.profile_id,
    action: r.action,
    target: r.target,
    domain: r.domain,
    details: r.details,
    status: r.status,
    resolution: r.resolution,
    ruleId: r.rule_id,
    resolvedBy: r.resolved_by,
    requestedAt: r.requested_at,
    expiresAt: r.expires_at,
    resolvedAt: r.resolved_at,
  };
}

function toRule(r: RuleRow): ApprovalRule {
  return {
    id: r.id,
    profileId: r.profile_id,
    userId: r.user_id,
    domain: r.domain,
    action: r.action,
    effect: r.effect,
    sourceRequestId: r.source_request_id,
    createdAt: r.created_at,
  };
}

export interface InsertApprovalRequestInput {
  sessionId: string;
  userId: string | null;
  agentId: string;
  projectId: string | null;
  profileId: string | null;
  action: string;
  target: string;
  domain: string | null;
  details: string;
  requestedAt: number;
  expiresAt: number;
  /** Insert already settled (a matching allow rule). */
  autoAllowedByRuleId?: string;
}

export function insertApprovalRequest(input: InsertApprovalRequestInput): ApprovalRequest {
  const id = uuidv4();
  const auto = input.autoAllowedByRuleId ?? null;
  getOrgsDb()
    .prepare(
      `INSERT INTO approval_requests
         (id, session_id, user_id, agent_id, project_id, profile_id, action, target, domain,
          details, status, resolution, rule_id, requested_at, expires_at, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.sessionId,
      input.userId,
      input.agentId,
      input.projectId,
      input.profileId,
      input.action,
      input.target,
      input.domain,
      input.details,
      auto ? 'allowed' : 'pending',
      auto ? 'auto_allowed' : null,
      auto,
      input.requestedAt,
      input.expiresAt,
      auto ? input.requestedAt : null,
    );
  return getApprovalRequest(id)!;
}

export function getApprovalRequest(id: string): ApprovalRequest | null {
  const row = getOrgsDb().prepare(`SELECT * FROM approval_requests WHERE id = ?`).get(id) as
    | RequestRow
    | undefined;
  return row ? toRequest(row) : null;
}

export function listApprovalRequestsForUser(
  userId: string,
  filter: { status?: ApprovalStatus; sessionId?: string; limit?: number } = {},
): ApprovalRequest[] {
  const where = ['user_id = ?'];
  const args: unknown[] = [userId];
  if (filter.status) {
    where.push('status = ?');
    args.push(filter.status);
  }
  if (filter.sessionId) {
    where.push('session_id = ?');
    args.push(filter.sessionId);
  }
  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
  const rows = getOrgsDb()
    .prepare(
      `SELECT * FROM approval_requests WHERE ${where.join(' AND ')}
       ORDER BY requested_at DESC LIMIT ${limit}`,
    )
    .all(...args) as RequestRow[];
  return rows.map(toRequest);
}

/**
 * Move a pending request to its final state. Returns null when it was not
 * pending any more, so two answers racing each other settle exactly once.
 */
export function settleApprovalRequest(
  id: string,
  outcome: {
    status: Exclude<ApprovalStatus, 'pending'>;
    resolution: ApprovalResolution;
    resolvedBy?: string | null;
    ruleId?: string | null;
  },
  now: number = Date.now(),
): ApprovalRequest | null {
  const info = getOrgsDb()
    .prepare(
      `UPDATE approval_requests
          SET status = ?, resolution = ?, resolved_by = ?, rule_id = ?, resolved_at = ?
        WHERE id = ? AND status = 'pending'`,
    )
    .run(
      outcome.status,
      outcome.resolution,
      outcome.resolvedBy ?? null,
      outcome.ruleId ?? null,
      now,
      id,
    );
  return info.changes === 1 ? getApprovalRequest(id) : null;
}

/**
 * Pending rows whose turn is gone. Run at startup: a Hub restart kills every
 * parked turn, so nothing could act on their answers.
 */
export function cancelOrphanedApprovalRequests(now: number = Date.now()): number {
  return getOrgsDb()
    .prepare(
      `UPDATE approval_requests
          SET status = 'cancelled', resolution = 'aborted', resolved_at = ?
        WHERE status = 'pending'`,
    )
    .run(now).changes;
}

/** Rule action that matches every action. Only `require` rules may use it. */
export const ANY_APPROVAL_ACTION = '*';

/** `host` is `domain` or one of its subdomains. */
export function hostWithinDomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/**
 * The rule that decides a (profile, domain, action) request. A `require`
 * rule beats any `allow` rule. `require` rules also cover subdomains and may
 * name `*` for every action; `allow` rules match the domain and action
 * exactly, so a remembered "yes" never spreads further than what was asked.
 */
export function findApprovalRule(key: {
  profileId: string;
  domain: string;
  action: string;
}): ApprovalRule | null {
  const rows = getOrgsDb()
    .prepare(
      `SELECT * FROM approval_rules
        WHERE profile_id = ? AND (action = ? OR action = ?)
        ORDER BY created_at`,
    )
    .all(key.profileId, key.action, ANY_APPROVAL_ACTION) as RuleRow[];
  const require = rows.find(
    (r) => r.effect === 'require' && hostWithinDomain(key.domain, r.domain),
  );
  if (require) return toRule(require);
  const allow = rows.find(
    (r) => r.effect === 'allow' && r.domain === key.domain && r.action === key.action,
  );
  return allow ? toRule(allow) : null;
}

/** Whether any `require` rule on this profile covers `action` (on any domain). */
export function hasRequireApprovalRule(profileId: string, action: string): boolean {
  return !!getOrgsDb()
    .prepare(
      `SELECT 1 FROM approval_rules
        WHERE profile_id = ? AND effect = 'require' AND (action = ? OR action = ?)
        LIMIT 1`,
    )
    .get(profileId, action, ANY_APPROVAL_ACTION);
}

export function saveApprovalRule(input: {
  profileId: string;
  userId: string;
  domain: string;
  action: string;
  effect?: ApprovalRuleEffect;
  sourceRequestId?: string | null;
}): ApprovalRule {
  const effect = input.effect ?? 'allow';
  const db = getOrgsDb();
  db.prepare(
    `INSERT INTO approval_rules (id, profile_id, user_id, domain, action, effect, source_request_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(profile_id, domain, action, effect) DO NOTHING`,
  ).run(
    uuidv4(),
    input.profileId,
    input.userId,
    input.domain,
    input.action,
    effect,
    input.sourceRequestId ?? null,
  );
  const row = db
    .prepare(
      `SELECT * FROM approval_rules
        WHERE profile_id = ? AND domain = ? AND action = ? AND effect = ?`,
    )
    .get(input.profileId, input.domain, input.action, effect) as RuleRow;
  return toRule(row);
}

export function listApprovalRulesForUser(userId: string): ApprovalRule[] {
  const rows = getOrgsDb()
    .prepare(`SELECT * FROM approval_rules WHERE user_id = ? ORDER BY domain, action, effect`)
    .all(userId) as RuleRow[];
  return rows.map(toRule);
}

export function deleteApprovalRuleForUser(userId: string, ruleId: string): boolean {
  return (
    getOrgsDb()
      .prepare(`DELETE FROM approval_rules WHERE id = ? AND user_id = ?`)
      .run(ruleId, userId).changes === 1
  );
}
