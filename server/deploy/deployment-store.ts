/**
 * Deployment Module store — query helpers over the deployments / deployment_steps
 * / deployment_environments / deployment_approvals tables (DDL in
 * `deployment-schema.ts`, prepared statements in `db.ts`).
 *
 * This is the data layer the later phases build on:
 *   - Phase 3 orchestrator: create a deployment, register its steps, acquire the
 *     per-environment lock, stream step state, then record the live ref + release
 *     the lock on success.
 *   - Phase 4 approval gate: park `awaiting_approval`, record approvals.
 *   - Phase 5 REST: list/get history, trigger, cancel, approve, rollback.
 *
 * All functions go through the shared `getStmts()` registry, so they operate on
 * the per-org main DB the rest of the app uses.
 */
import { randomUUID } from 'crypto';
import { getDb, getStmts } from '../db.js';
import type {
  DeploymentRow,
  DeploymentStepRow,
  DeploymentEnvironmentRow,
  DeploymentApprovalRow,
  DeploymentReleaseItemDetailRow,
  DeploymentReleaseItemInclusionStatus,
  DeploymentReleaseItemRow,
  DeploymentReleaseItemSource,
} from '../types.js';

export type DeploymentStatus = DeploymentRow['status'];
export type DeploymentStepStatus = DeploymentStepRow['status'];

export class DeploymentReleaseItemError extends Error {
  constructor(
    message: string,
    public readonly reason: 'not_found' | 'cross_project' | 'invalid_ticket',
  ) {
    super(message);
    this.name = 'DeploymentReleaseItemError';
  }
}

export interface CreateDeploymentInput {
  projectId: string;
  environment: string;
  ref: string;
  /** Trigger source. Known v1 values: 'manual' | 'push' | 'rollback'. */
  trigger?: string;
  /** User id that triggered the deploy; omit for system/push-driven runs. */
  triggeredBy?: string | null;
  /** For rollback: the historical deployment whose ref this run re-runs. */
  sourceDeploymentId?: string | null;
  /** Initial status; defaults to 'pending'. */
  status?: DeploymentStatus;
  /** Free-form metadata serialized to JSON. */
  meta?: unknown;
}

export interface ListOptions {
  limit?: number;
  offset?: number;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function clampLimit(limit: number | undefined): number {
  if (limit == null || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit)));
}

function clampOffset(offset: number | undefined): number {
  if (offset == null || !Number.isFinite(offset) || offset < 0) return 0;
  return Math.floor(offset);
}

/** Create a new deploy run. Returns the inserted row. */
export function createDeployment(input: CreateDeploymentInput): DeploymentRow {
  const id = randomUUID();
  getStmts().insertDeployment.run({
    id,
    project_id: input.projectId,
    environment: input.environment,
    ref: input.ref,
    status: input.status ?? 'pending',
    trigger: input.trigger ?? 'manual',
    triggered_by: input.triggeredBy ?? null,
    source_deployment_id: input.sourceDeploymentId ?? null,
    runner_job_id: null,
    meta: input.meta == null ? null : JSON.stringify(input.meta),
  });
  return getDeployment(id) as DeploymentRow;
}

export function getDeployment(id: string): DeploymentRow | null {
  return (getStmts().getDeployment.get(id) as DeploymentRow | undefined) ?? null;
}

export function listDeployments(projectId: string, opts: ListOptions = {}): DeploymentRow[] {
  return getStmts().listDeploymentsByProject.all(
    projectId,
    clampLimit(opts.limit),
    clampOffset(opts.offset),
  ) as DeploymentRow[];
}

export function listDeploymentsForEnvironment(
  projectId: string,
  environment: string,
  opts: ListOptions = {},
): DeploymentRow[] {
  return getStmts().listDeploymentsByEnvironment.all(
    projectId,
    environment,
    clampLimit(opts.limit),
    clampOffset(opts.offset),
  ) as DeploymentRow[];
}

export function listRecoverableDeployments(): DeploymentRow[] {
  return getDb()
    .prepare(
      `SELECT d.*
         FROM deployments d
         JOIN deployment_environments e
           ON e.project_id = d.project_id
          AND e.name = d.environment
          AND e.active_deployment_id = d.id
        WHERE d.status IN ('pending', 'running')
        ORDER BY d.created_at ASC, d.rowid ASC`,
    )
    .all() as DeploymentRow[];
}

/**
 * Transition a deployment to `status`. `started_at` is stamped the first time the
 * deployment enters 'running' (when its steps actually begin) — NOT when a gated
 * deploy parks at 'awaiting_approval', so a deploy parked for approval doesn't
 * accrue bogus run duration. `completed_at` is stamped on a terminal state.
 * Returns the updated row, or null if no row matched. `error` is only meaningful
 * for status='error'.
 */
export function updateDeploymentStatus(
  id: string,
  status: DeploymentStatus,
  opts: { error?: string | null } = {},
): DeploymentRow | null {
  getStmts().updateDeploymentStatus.run({ id, status, error: opts.error ?? null });
  return getDeployment(id);
}

export function setDeploymentRunnerJob(id: string, runnerJobId: string): DeploymentRow | null {
  getStmts().setDeploymentRunnerJob.run(runnerJobId, id);
  return getDeployment(id);
}

/**
 * Record the release version a deploy's workflow published, merged into the
 * existing `meta` JSON (preserving the plan snapshot and any other keys). No-op
 * when the value is blank or already recorded, so a resumed / re-run step never
 * clobbers meta. `deploymentReleaseLabel` reads `meta.releaseVersion` first, so
 * this is what turns a commit-SHA deploy into a version in the UI and emails.
 */
export function mergeDeploymentReleaseVersion(id: string, version: string): DeploymentRow | null {
  const trimmed = version.trim();
  const row = getDeployment(id);
  if (!row || !trimmed) return row;

  let meta: Record<string, unknown> = {};
  if (row.meta) {
    try {
      const parsed = JSON.parse(row.meta);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        meta = parsed as Record<string, unknown>;
      } else {
        meta = { userMeta: parsed };
      }
    } catch {
      meta = { userMeta: row.meta };
    }
  }
  if (meta.releaseVersion === trimmed) return row;

  meta.releaseVersion = trimmed;
  getStmts().setDeploymentMeta.run(JSON.stringify(meta), id);
  return getDeployment(id);
}

function uniqueStrings(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

function placeholders(values: string[]): string {
  return values.map(() => '?').join(',');
}

export interface DeploymentReleaseCandidate {
  cardId: string | null;
  supportTicketId: string | null;
  sources: string[];
}

export interface DeploymentReleaseResolution {
  candidates: DeploymentReleaseCandidate[];
  diagnostics: {
    explicitCardIds: number;
    explicitSupportTicketIds: number;
    prUrls: number;
    sessionIds: number;
    refs: number;
    branches: number;
    resolvedItems: number;
    resolvedCards: number;
    resolvedSupportTickets: number;
    missingExplicitCardIds: string[];
    missingExplicitSupportTicketIds: string[];
  };
}

export interface ResolveDeploymentReleaseCandidatesInput {
  projectId: string;
  cardIds?: string[];
  supportTicketIds?: string[];
  prUrls?: string[];
  sessionIds?: string[];
  refs?: string[];
  branches?: string[];
}

interface ResolvedCardRow {
  card_id: string;
  support_ticket_id: string | null;
}

function releaseCardLookupSql(whereSql: string): string {
  return `
    SELECT c.id AS card_id,
           COALESCE(c.support_ticket_id, c.customer_report_id, st.id) AS support_ticket_id
      FROM kanban_cards c
      JOIN kanban_boards b
        ON b.id = c.board_id
       AND b.project_id = ?
      JOIN kanban_columns col
        ON col.id = c.column_id
       -- Done-ness mirrors isColumnDone() (kanban-blockers.ts): a case-insensitive
       -- substring match on "done", not an exact "Done". Operators rename the Done
       -- column freely ("done", "Done ✅", "Deployed / Done"); an exact match here
       -- silently failed to resolve those cards' support tickets, so release-notification
       -- emails never queued for the reporter (see card #1257).
       AND lower(col.name) LIKE '%done%'
 LEFT JOIN support_tickets st
        ON st.project_id = b.project_id
       AND st.converted_card_id = c.id
     WHERE ${whereSql}`;
}

function resolveReleaseCardsByIds(projectId: string, cardIds: string[]): ResolvedCardRow[] {
  const ids = uniqueStrings(cardIds);
  if (!ids.length) return [];
  return getDb()
    .prepare(releaseCardLookupSql(`c.id IN (${placeholders(ids)})`))
    .all(projectId, ...ids) as ResolvedCardRow[];
}

function resolveReleaseCardsByPrUrls(projectId: string, prUrls: string[]): ResolvedCardRow[] {
  const urls = uniqueStrings(prUrls);
  if (!urls.length) return [];
  return getDb()
    .prepare(releaseCardLookupSql(`c.pr_url IN (${placeholders(urls)})`))
    .all(projectId, ...urls) as ResolvedCardRow[];
}

function resolveReleaseCardsBySessionIds(
  projectId: string,
  sessionIds: string[],
): ResolvedCardRow[] {
  const ids = uniqueStrings(sessionIds);
  if (!ids.length) return [];
  return getDb()
    .prepare(releaseCardLookupSql(`c.session_id IN (${placeholders(ids)})`))
    .all(projectId, ...ids) as ResolvedCardRow[];
}

function resolveReleaseCardsByFinalizeSql(
  projectId: string,
  whereSql: string,
  values: string[],
): ResolvedCardRow[] {
  const bindValues = values.map((value) => value.trim()).filter(Boolean);
  if (!bindValues.length) return [];
  return getDb()
    .prepare(
      releaseCardLookupSql(`c.id IN (
        SELECT DISTINCT fr.card_id
          FROM finalize_runs fr
         WHERE fr.project_id = ?
           AND fr.status = 'pushed'
           AND fr.card_id IS NOT NULL
           AND ${whereSql}
      )`),
    )
    .all(projectId, projectId, ...bindValues) as ResolvedCardRow[];
}

function addReleaseCandidate(
  candidates: Map<string, DeploymentReleaseCandidate>,
  row: { card_id?: string | null; support_ticket_id?: string | null },
  source: string,
): void {
  const cardId = row.card_id ?? null;
  const supportTicketId = row.support_ticket_id ?? null;
  if (!cardId && !supportTicketId) return;
  const key = cardId ? `card:${cardId}` : `ticket:${supportTicketId}`;
  const existing = candidates.get(key);
  if (existing) {
    if (!existing.sources.includes(source)) existing.sources.push(source);
    if (!existing.supportTicketId && supportTicketId) existing.supportTicketId = supportTicketId;
    return;
  }
  candidates.set(key, {
    cardId,
    supportTicketId,
    sources: [source],
  });
}

function addReleaseCardRows(
  candidates: Map<string, DeploymentReleaseCandidate>,
  rows: ResolvedCardRow[],
  source: string,
): void {
  for (const row of rows) addReleaseCandidate(candidates, row, source);
}

function addSupportTicketRows(
  projectId: string,
  candidates: Map<string, DeploymentReleaseCandidate>,
  supportTicketIds: string[],
): string[] {
  const ids = uniqueStrings(supportTicketIds);
  if (!ids.length) return [];
  const rows = getDb()
    .prepare(
      `SELECT id, converted_card_id
         FROM support_tickets
        WHERE project_id = ?
          AND id IN (${placeholders(ids)})`,
    )
    .all(projectId, ...ids) as Array<{ id: string; converted_card_id: string | null }>;
  const found = new Set(rows.map((row) => row.id));
  for (const row of rows) {
    if (row.converted_card_id) {
      addReleaseCardRows(
        candidates,
        resolveReleaseCardsByIds(projectId, [row.converted_card_id]),
        'explicit_ticket_card',
      );
    }
    const alreadyLinked = [...candidates.values()].some(
      (candidate) => candidate.supportTicketId === row.id,
    );
    if (!alreadyLinked) {
      addReleaseCandidate(candidates, { support_ticket_id: row.id }, 'explicit_ticket');
    }
  }
  return ids.filter((id) => !found.has(id));
}

export function resolveDeploymentReleaseCandidates(
  input: ResolveDeploymentReleaseCandidatesInput,
): DeploymentReleaseResolution {
  const projectId = input.projectId;
  const cardIds = uniqueStrings(input.cardIds);
  const supportTicketIds = uniqueStrings(input.supportTicketIds);
  const prUrls = uniqueStrings(input.prUrls);
  const sessionIds = uniqueStrings(input.sessionIds);
  const refs = uniqueStrings(input.refs);
  const branches = uniqueStrings(input.branches);
  const candidates = new Map<string, DeploymentReleaseCandidate>();

  const explicitCardRows = resolveReleaseCardsByIds(projectId, cardIds);
  addReleaseCardRows(candidates, explicitCardRows, 'explicit_card');
  addReleaseCardRows(candidates, resolveReleaseCardsByPrUrls(projectId, prUrls), 'card_pr_url');
  addReleaseCardRows(
    candidates,
    resolveReleaseCardsBySessionIds(projectId, sessionIds),
    'card_session',
  );
  addReleaseCardRows(
    candidates,
    resolveReleaseCardsByFinalizeSql(projectId, `fr.pr_url IN (${placeholders(prUrls)})`, prUrls),
    'finalize_pr_url',
  );
  addReleaseCardRows(
    candidates,
    resolveReleaseCardsByFinalizeSql(
      projectId,
      `fr.session_id IN (${placeholders(sessionIds)})`,
      sessionIds,
    ),
    'finalize_session',
  );
  addReleaseCardRows(
    candidates,
    resolveReleaseCardsByFinalizeSql(
      projectId,
      `(fr.head_sha IN (${placeholders(refs)}) OR fr.validated_head_sha IN (${placeholders(refs)}))`,
      [...refs, ...refs],
    ),
    'finalize_ref',
  );
  addReleaseCardRows(
    candidates,
    resolveReleaseCardsByFinalizeSql(
      projectId,
      `fr.branch IN (${placeholders(branches)})`,
      branches,
    ),
    'finalize_branch',
  );
  const missingExplicitSupportTicketIds = addSupportTicketRows(
    projectId,
    candidates,
    supportTicketIds,
  );
  const foundExplicitCards = new Set(explicitCardRows.map((row) => row.card_id));
  const resolved = [...candidates.values()];

  return {
    candidates: resolved,
    diagnostics: {
      explicitCardIds: cardIds.length,
      explicitSupportTicketIds: supportTicketIds.length,
      prUrls: prUrls.length,
      sessionIds: sessionIds.length,
      refs: refs.length,
      branches: branches.length,
      resolvedItems: resolved.length,
      resolvedCards: resolved.filter((candidate) => candidate.cardId).length,
      resolvedSupportTickets: resolved.filter((candidate) => candidate.supportTicketId).length,
      missingExplicitCardIds: cardIds.filter((id) => !foundExplicitCards.has(id)),
      missingExplicitSupportTicketIds,
    },
  };
}

export function recordDeploymentReleaseItems(input: {
  deployment: Pick<DeploymentRow, 'id' | 'project_id'>;
  candidates: DeploymentReleaseCandidate[];
}): DeploymentReleaseItemRow[] {
  for (const candidate of input.candidates) {
    if (!candidate.cardId) continue;
    ensureDeploymentReleaseItem({
      deploymentId: input.deployment.id,
      cardId: candidate.cardId,
      supportTicketId: candidate.supportTicketId,
      source: 'derived',
    });
  }
  return listDeploymentReleaseItems(input.deployment.id);
}

export interface AddDeploymentStepInput {
  deploymentId: string;
  name: string;
  stepOrder: number;
  status?: DeploymentStepStatus;
}

/** Register a step row for a deployment (mirrors the deploy.yaml step list). */
export function addDeploymentStep(input: AddDeploymentStepInput): DeploymentStepRow {
  const id = randomUUID();
  getStmts().insertDeploymentStep.run(
    id,
    input.deploymentId,
    input.name,
    input.stepOrder,
    input.status ?? 'pending',
  );
  return getStmts().getDeploymentStep.get(id) as DeploymentStepRow;
}

export function listDeploymentSteps(deploymentId: string): DeploymentStepRow[] {
  return getStmts().listDeploymentSteps.all(deploymentId) as DeploymentStepRow[];
}

export function updateDeploymentStepStatus(
  id: string,
  status: DeploymentStepStatus,
  opts: { exitCode?: number | null; error?: string | null } = {},
): DeploymentStepRow | null {
  getStmts().updateDeploymentStepStatus.run({
    id,
    status,
    exit_code: opts.exitCode ?? null,
    error: opts.error ?? null,
  });
  return (getStmts().getDeploymentStep.get(id) as DeploymentStepRow | undefined) ?? null;
}

/**
 * Persist the dispatched GitHub Actions run a `github_workflow` step polled to
 * completion (run id / url / conclusion), recovered from the step output marker.
 * Independent of the step's status update so it can be recorded for both a
 * succeeded and a failed workflow run.
 */
export function setDeploymentStepGithubRun(
  id: string,
  run: {
    runId?: string | null;
    url?: string | null;
    conclusion?: string | null;
  },
): DeploymentStepRow | null {
  getStmts().setDeploymentStepGithubRun.run({
    id,
    github_run_id: run.runId ?? null,
    github_run_url: run.url ?? null,
    github_conclusion: run.conclusion ?? null,
  });
  return (getStmts().getDeploymentStep.get(id) as DeploymentStepRow | undefined) ?? null;
}

/**
 * Ensure a `deployment_environments` row exists for (project, name) and return
 * it. Idempotent — a pre-existing row keeps its live-ref / lock columns.
 */
export function ensureDeploymentEnvironment(
  projectId: string,
  name: string,
): DeploymentEnvironmentRow {
  getStmts().upsertDeploymentEnvironment.run(randomUUID(), projectId, name);
  return getDeploymentEnvironment(projectId, name) as DeploymentEnvironmentRow;
}

export function getDeploymentEnvironment(
  projectId: string,
  name: string,
): DeploymentEnvironmentRow | null {
  return (
    (getStmts().getDeploymentEnvironment.get(projectId, name) as
      | DeploymentEnvironmentRow
      | undefined) ?? null
  );
}

export function listDeploymentEnvironments(projectId: string): DeploymentEnvironmentRow[] {
  return getStmts().listDeploymentEnvironments.all(projectId) as DeploymentEnvironmentRow[];
}

/**
 * Try to acquire the per-environment concurrency lock for `deploymentId`. The
 * environment row must already exist (call `ensureDeploymentEnvironment` first).
 * Returns true if the lock was acquired, false if another deploy holds it (the
 * caller rejects the trigger 409). Atomic: the UPDATE only matches when
 * `active_deployment_id IS NULL`.
 */
export function acquireEnvironmentLock(
  projectId: string,
  name: string,
  deploymentId: string,
): boolean {
  const res = getStmts().acquireDeploymentEnvironmentLock.run({
    project_id: projectId,
    name,
    deployment_id: deploymentId,
  });
  return res.changes > 0;
}

/**
 * Release the lock, but only if `deploymentId` currently holds it. Returns true
 * if released. A stale releaser (a deploy that already lost the lock) is a no-op.
 */
export function releaseEnvironmentLock(
  projectId: string,
  name: string,
  deploymentId: string,
): boolean {
  const res = getStmts().releaseDeploymentEnvironmentLock.run({
    project_id: projectId,
    name,
    deployment_id: deploymentId,
  });
  return res.changes > 0;
}

/** Record the ref now live in an environment (called on a successful deploy). */
export function setEnvironmentCurrentRef(
  projectId: string,
  name: string,
  ref: string,
  deploymentId: string,
): DeploymentEnvironmentRow | null {
  getStmts().setDeploymentEnvironmentCurrentRef.run({
    project_id: projectId,
    name,
    current_ref: ref,
    current_deployment_id: deploymentId,
  });
  return getDeploymentEnvironment(projectId, name);
}

export interface RecordApprovalInput {
  deploymentId: string;
  approverUserId: string;
  /** Org role held at approval time (Owner / Admin). */
  approverRole: string;
  decision?: 'approved' | 'rejected';
  note?: string | null;
}

/** Record an approval/rejection decision for a gated deployment. */
export function recordDeploymentApproval(input: RecordApprovalInput): DeploymentApprovalRow {
  const id = randomUUID();
  getStmts().insertDeploymentApproval.run(
    id,
    input.deploymentId,
    input.approverUserId,
    input.approverRole,
    input.decision ?? 'approved',
    input.note ?? null,
  );
  return getStmts()
    .listDeploymentApprovals.all(input.deploymentId)
    .find((r) => (r as DeploymentApprovalRow).id === id) as DeploymentApprovalRow;
}

/**
 * Atomically claim a parked gated deployment for approval/resume and insert the
 * approval audit row. Returns null when another approver already claimed it.
 */
export function claimDeploymentApproval(input: RecordApprovalInput): DeploymentApprovalRow | null {
  const claim = getDb().transaction((approval: RecordApprovalInput) => {
    const res = getStmts().claimDeploymentForApproval.run({ id: approval.deploymentId });
    if (res.changes === 0) return null;
    return recordDeploymentApproval(approval);
  });
  return claim(input) as DeploymentApprovalRow | null;
}

export interface EnsureDeploymentReleaseItemInput {
  deploymentId: string;
  cardId: string;
  supportTicketId?: string | null;
  source?: DeploymentReleaseItemSource;
  inclusionStatus?: DeploymentReleaseItemInclusionStatus;
  operatorAdjustment?: {
    adjustedBy?: string | null;
    note?: string | null;
    meta?: unknown;
    adjustedAt?: string | null;
  } | null;
}

interface ScopedReleaseCardRow {
  project_id: string;
  card_id: string;
  support_ticket_id: string | null;
}

function scopedReleaseCard(deploymentId: string, cardId: string): ScopedReleaseCardRow {
  const row = getStmts().getScopedDeploymentReleaseCard.get(cardId, deploymentId) as
    | ScopedReleaseCardRow
    | undefined;
  if (row) return row;
  const deployment = getDeployment(deploymentId);
  if (!deployment) {
    throw new DeploymentReleaseItemError(`deployment not found: ${deploymentId}`, 'not_found');
  }
  throw new DeploymentReleaseItemError(
    `card ${cardId} does not belong to deployment project ${deployment.project_id}`,
    'cross_project',
  );
}

function scopedReleaseTicket(deploymentId: string, supportTicketId: string): string {
  const row = getStmts().getScopedDeploymentReleaseTicket.get(deploymentId, supportTicketId) as
    | { id: string }
    | undefined;
  if (!row) {
    throw new DeploymentReleaseItemError(
      `support ticket ${supportTicketId} does not belong to the deployment project`,
      'invalid_ticket',
    );
  }
  return row.id;
}

function resolveReleaseSupportTicketId(input: {
  deploymentId: string;
  explicitSupportTicketId?: string | null;
  card: ScopedReleaseCardRow;
}): string | null {
  if (input.explicitSupportTicketId !== undefined && input.explicitSupportTicketId !== null) {
    return scopedReleaseTicket(input.deploymentId, input.explicitSupportTicketId);
  }
  if (input.explicitSupportTicketId === null) return null;
  return input.card.support_ticket_id
    ? scopedReleaseTicket(input.deploymentId, input.card.support_ticket_id)
    : null;
}

export function getDeploymentReleaseItem(id: string): DeploymentReleaseItemRow | null {
  return (
    (getStmts().getDeploymentReleaseItem.get(id) as DeploymentReleaseItemRow | undefined) ?? null
  );
}

export function getDeploymentReleaseItemByDeploymentCard(
  deploymentId: string,
  cardId: string,
): DeploymentReleaseItemRow | null {
  return (
    (getStmts().getDeploymentReleaseItemByDeploymentCard.get(deploymentId, cardId) as
      | DeploymentReleaseItemRow
      | undefined) ?? null
  );
}

export function listDeploymentReleaseItems(deploymentId: string): DeploymentReleaseItemRow[] {
  return getStmts().listDeploymentReleaseItems.all(deploymentId) as DeploymentReleaseItemRow[];
}

export function listDeploymentReleaseItemsWithContext(
  deploymentId: string,
): DeploymentReleaseItemDetailRow[] {
  return getStmts().listDeploymentReleaseItemsWithContext.all(
    deploymentId,
  ) as DeploymentReleaseItemDetailRow[];
}

export function listIncludedDeploymentReleaseItems(
  deploymentId: string,
): DeploymentReleaseItemRow[] {
  return listDeploymentReleaseItems(deploymentId).filter(
    (item) => item.inclusion_status === 'included',
  );
}

export interface SetDeploymentReleaseItemInclusionInput {
  deploymentId: string;
  cardId: string;
  inclusionStatus: DeploymentReleaseItemInclusionStatus;
  adjustedBy?: string | null;
  note: string;
  meta?: unknown;
  supportTicketId?: string | null;
}

export function setDeploymentReleaseItemInclusion(
  input: SetDeploymentReleaseItemInclusionInput,
): DeploymentReleaseItemRow {
  return ensureDeploymentReleaseItem({
    deploymentId: input.deploymentId,
    cardId: input.cardId,
    supportTicketId: input.supportTicketId,
    source: 'operator',
    inclusionStatus: input.inclusionStatus,
    operatorAdjustment: {
      adjustedBy: input.adjustedBy ?? null,
      note: input.note,
      meta: input.meta,
    },
  });
}

/**
 * Ensure a deployment/card release item exists. If supportTicketId is omitted,
 * it is derived from the card's durable support-ticket link.
 * Repeated calls for the same deployment/card return the same row and only fill
 * a previously-null support_ticket_id or apply an explicit operator adjustment.
 */
export function ensureDeploymentReleaseItem(
  input: EnsureDeploymentReleaseItemInput,
): DeploymentReleaseItemRow {
  const ensure = getDb().transaction((value: EnsureDeploymentReleaseItemInput) => {
    const card = scopedReleaseCard(value.deploymentId, value.cardId);
    const supportTicketId = resolveReleaseSupportTicketId({
      deploymentId: value.deploymentId,
      explicitSupportTicketId: value.supportTicketId,
      card,
    });
    const source = value.source ?? (value.operatorAdjustment ? 'operator' : 'derived');
    const inclusionStatus = value.inclusionStatus ?? 'included';
    const operatorAdjustedAt =
      value.operatorAdjustment !== undefined && value.operatorAdjustment !== null
        ? (value.operatorAdjustment.adjustedAt ?? null)
        : null;

    getStmts().insertDeploymentReleaseItem.run({
      id: randomUUID(),
      deployment_id: value.deploymentId,
      card_id: value.cardId,
      support_ticket_id: supportTicketId,
      source,
      inclusion_status: inclusionStatus,
      operator_adjusted_by: value.operatorAdjustment?.adjustedBy ?? null,
      operator_adjustment_note: value.operatorAdjustment?.note ?? null,
      operator_adjustment_meta:
        value.operatorAdjustment?.meta === undefined
          ? null
          : JSON.stringify(value.operatorAdjustment.meta),
      operator_adjusted_at: operatorAdjustedAt,
    });

    if (supportTicketId) {
      getStmts().updateDeploymentReleaseItemTicket.run(
        supportTicketId,
        value.deploymentId,
        value.cardId,
      );
    }
    if (value.operatorAdjustment) {
      getStmts().updateDeploymentReleaseItemAdjustment.run({
        deployment_id: value.deploymentId,
        card_id: value.cardId,
        source,
        inclusion_status: inclusionStatus,
        operator_adjusted_by: value.operatorAdjustment.adjustedBy ?? null,
        operator_adjustment_note: value.operatorAdjustment.note ?? null,
        operator_adjustment_meta:
          value.operatorAdjustment.meta === undefined
            ? null
            : JSON.stringify(value.operatorAdjustment.meta),
        operator_adjusted_at: operatorAdjustedAt,
      });
    }

    return getDeploymentReleaseItemByDeploymentCard(
      value.deploymentId,
      value.cardId,
    ) as DeploymentReleaseItemRow;
  });
  return ensure(input) as DeploymentReleaseItemRow;
}

export function listDeploymentApprovals(deploymentId: string): DeploymentApprovalRow[] {
  return getStmts().listDeploymentApprovals.all(deploymentId) as DeploymentApprovalRow[];
}
