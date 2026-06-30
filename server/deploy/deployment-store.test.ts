/**
 * Deployment store query helpers — exercised against the shared test DB
 * (initialized once per file by test/setup.ts via AGENT_HUB_DATA_DIR).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { getDb } from '../db.js';
import {
  createDeployment,
  DeploymentReleaseItemError,
  getDeployment,
  ensureDeploymentReleaseItem,
  listDeployments,
  listDeploymentReleaseItems,
  listDeploymentsForEnvironment,
  updateDeploymentStatus,
  setDeploymentRunnerJob,
  addDeploymentStep,
  listDeploymentSteps,
  updateDeploymentStepStatus,
  ensureDeploymentEnvironment,
  getDeploymentEnvironment,
  listDeploymentEnvironments,
  acquireEnvironmentLock,
  releaseEnvironmentLock,
  setEnvironmentCurrentRef,
  recordDeploymentApproval,
  listDeploymentApprovals,
  resolveDeploymentReleaseCandidates,
} from './deployment-store.js';
import { createSupportTicket } from '../support-tickets-store.js';

const P = 'proj-deploy-test';

beforeEach(() => {
  const db = getDb();
  db.exec('DELETE FROM deployment_release_items;');
  db.exec('DELETE FROM deployment_approvals;');
  db.exec('DELETE FROM deployment_steps;');
  db.exec('DELETE FROM deployments;');
  db.exec('DELETE FROM deployment_environments;');
  db.exec('DELETE FROM kanban_cards;');
  db.exec('DELETE FROM kanban_columns;');
  db.exec('DELETE FROM kanban_boards;');
  db.exec('DELETE FROM support_tickets;');
});

function insertReleaseCard(
  args: {
    projectId?: string;
    cardId?: string;
    supportTicketId?: string | null;
    customerReportId?: string | null;
    columnName?: string;
  } = {},
): string {
  const projectId = args.projectId ?? P;
  const cardId = args.cardId ?? `card-${Math.random().toString(16).slice(2)}`;
  const boardId = `board-${cardId}`;
  const columnId = `col-${cardId}`;
  const db = getDb();
  db.prepare('INSERT INTO kanban_boards (id, project_id, name) VALUES (?, ?, ?)').run(
    boardId,
    projectId,
    'Board',
  );
  db.prepare('INSERT INTO kanban_columns (id, board_id, name, position) VALUES (?, ?, ?, ?)').run(
    columnId,
    boardId,
    args.columnName ?? 'Done',
    0,
  );
  db.prepare(
    `INSERT INTO kanban_cards
       (id, column_id, board_id, title, support_ticket_id, customer_report_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    cardId,
    columnId,
    boardId,
    'Release card',
    args.supportTicketId ?? null,
    args.customerReportId ?? null,
  );
  return cardId;
}

describe('createDeployment / getDeployment', () => {
  it('inserts a pending deployment with defaults and round-trips meta', () => {
    const d = createDeployment({
      projectId: P,
      environment: 'dev',
      ref: 'deadbeef',
      meta: { commitMessage: 'ship it' },
    });
    expect(d.status).toBe('pending');
    expect(d.trigger).toBe('manual');
    expect(d.triggered_by).toBeNull();
    expect(d.runner_job_id).toBeNull();
    expect(d.started_at).toBeNull();
    expect(d.completed_at).toBeNull();
    expect(d.created_at).toBeTruthy();

    const fetched = getDeployment(d.id);
    expect(fetched?.id).toBe(d.id);
    expect(JSON.parse(fetched!.meta as string)).toEqual({ commitMessage: 'ship it' });
  });

  it('records trigger, triggered_by, and rollback source', () => {
    const orig = createDeployment({ projectId: P, environment: 'prod', ref: 'v1' });
    const rollback = createDeployment({
      projectId: P,
      environment: 'prod',
      ref: 'v1',
      trigger: 'rollback',
      triggeredBy: 'user-7',
      sourceDeploymentId: orig.id,
    });
    expect(rollback.trigger).toBe('rollback');
    expect(rollback.triggered_by).toBe('user-7');
    expect(rollback.source_deployment_id).toBe(orig.id);
  });

  it('getDeployment returns null for an unknown id', () => {
    expect(getDeployment('nope')).toBeNull();
  });
});

describe('listing + history', () => {
  it('lists project deployments newest-first and filters by environment', () => {
    const a = createDeployment({ projectId: P, environment: 'dev', ref: 'r1' });
    const b = createDeployment({ projectId: P, environment: 'prod', ref: 'r2' });
    const c = createDeployment({ projectId: P, environment: 'dev', ref: 'r3' });

    const all = listDeployments(P);
    expect(all.map((d) => d.id)).toEqual([c.id, b.id, a.id]);

    const dev = listDeploymentsForEnvironment(P, 'dev');
    expect(dev.map((d) => d.id)).toEqual([c.id, a.id]);
  });

  it('honors limit and offset', () => {
    for (let i = 0; i < 5; i++) {
      createDeployment({ projectId: P, environment: 'dev', ref: `r${i}` });
    }
    const page = listDeployments(P, { limit: 2, offset: 1 });
    expect(page).toHaveLength(2);
  });

  it('scopes by project', () => {
    createDeployment({ projectId: P, environment: 'dev', ref: 'mine' });
    createDeployment({ projectId: 'other-proj', environment: 'dev', ref: 'theirs' });
    expect(listDeployments(P)).toHaveLength(1);
  });
});

describe('updateDeploymentStatus timing', () => {
  it('stamps started_at when entering running and completed_at on terminal', () => {
    const d = createDeployment({ projectId: P, environment: 'dev', ref: 'r' });

    const running = updateDeploymentStatus(d.id, 'running')!;
    expect(running.status).toBe('running');
    expect(running.started_at).toBeTruthy();
    expect(running.completed_at).toBeNull();
    const startedAt = running.started_at;

    const done = updateDeploymentStatus(d.id, 'success')!;
    expect(done.completed_at).toBeTruthy();
    // started_at is preserved (COALESCE), not overwritten on the second update.
    expect(done.started_at).toBe(startedAt);
  });

  it('does NOT stamp started_at when parking at awaiting_approval (no steps ran yet)', () => {
    const d = createDeployment({ projectId: P, environment: 'prod', ref: 'r' });
    const parked = updateDeploymentStatus(d.id, 'awaiting_approval')!;
    expect(parked.status).toBe('awaiting_approval');
    expect(parked.started_at).toBeNull();
    expect(parked.completed_at).toBeNull();

    // Stamped only once the (approved) deploy actually starts running.
    const running = updateDeploymentStatus(d.id, 'running')!;
    expect(running.started_at).toBeTruthy();
  });

  it('does not stamp started_at while still pending and records an error message', () => {
    const d = createDeployment({ projectId: P, environment: 'dev', ref: 'r' });
    const stillPending = updateDeploymentStatus(d.id, 'pending')!;
    expect(stillPending.started_at).toBeNull();

    const failed = updateDeploymentStatus(d.id, 'error', { error: 'boom' })!;
    expect(failed.status).toBe('error');
    expect(failed.error).toBe('boom');
    expect(failed.completed_at).toBeTruthy();
  });

  it('setDeploymentRunnerJob attaches the runner job id', () => {
    const d = createDeployment({ projectId: P, environment: 'dev', ref: 'r' });
    const updated = setDeploymentRunnerJob(d.id, 'job-123')!;
    expect(updated.runner_job_id).toBe('job-123');
  });
});

describe('deployment steps', () => {
  it('registers steps and lists them in step_order', () => {
    const d = createDeployment({ projectId: P, environment: 'dev', ref: 'r' });
    addDeploymentStep({ deploymentId: d.id, name: 'build', stepOrder: 0 });
    addDeploymentStep({ deploymentId: d.id, name: 'push', stepOrder: 1 });
    addDeploymentStep({ deploymentId: d.id, name: 'deploy', stepOrder: 2 });

    const steps = listDeploymentSteps(d.id);
    expect(steps.map((s) => s.name)).toEqual(['build', 'push', 'deploy']);
    expect(steps.every((s) => s.status === 'pending')).toBe(true);
  });

  it('transitions step status with exit code and timing', () => {
    const d = createDeployment({ projectId: P, environment: 'dev', ref: 'r' });
    const step = addDeploymentStep({ deploymentId: d.id, name: 'build', stepOrder: 0 });

    const running = updateDeploymentStepStatus(step.id, 'running')!;
    expect(running.started_at).toBeTruthy();
    expect(running.completed_at).toBeNull();

    const failed = updateDeploymentStepStatus(step.id, 'error', { exitCode: 2, error: 'bad' })!;
    expect(failed.status).toBe('error');
    expect(failed.exit_code).toBe(2);
    expect(failed.error).toBe('bad');
    expect(failed.completed_at).toBeTruthy();
  });
});

describe('deployment environments + concurrency lock', () => {
  it('ensureDeploymentEnvironment is idempotent', () => {
    const a = ensureDeploymentEnvironment(P, 'prod');
    const b = ensureDeploymentEnvironment(P, 'prod');
    expect(a.id).toBe(b.id);
    expect(listDeploymentEnvironments(P)).toHaveLength(1);
    expect(a.current_ref).toBeNull();
    expect(a.active_deployment_id).toBeNull();
  });

  it('serializes per environment: a second acquire fails while locked', () => {
    ensureDeploymentEnvironment(P, 'prod');
    const d1 = createDeployment({ projectId: P, environment: 'prod', ref: 'r1' });
    const d2 = createDeployment({ projectId: P, environment: 'prod', ref: 'r2' });

    expect(acquireEnvironmentLock(P, 'prod', d1.id)).toBe(true);
    // Lock held by d1 → d2 is rejected (the route turns this into a 409).
    expect(acquireEnvironmentLock(P, 'prod', d2.id)).toBe(false);
    expect(getDeploymentEnvironment(P, 'prod')?.active_deployment_id).toBe(d1.id);

    // Release by the holder frees the lock for the next deploy.
    expect(releaseEnvironmentLock(P, 'prod', d1.id)).toBe(true);
    expect(getDeploymentEnvironment(P, 'prod')?.active_deployment_id).toBeNull();
    expect(acquireEnvironmentLock(P, 'prod', d2.id)).toBe(true);
  });

  it('a stale releaser cannot clear a lock it does not hold', () => {
    ensureDeploymentEnvironment(P, 'prod');
    const d1 = createDeployment({ projectId: P, environment: 'prod', ref: 'r1' });
    const d2 = createDeployment({ projectId: P, environment: 'prod', ref: 'r2' });
    acquireEnvironmentLock(P, 'prod', d1.id);
    expect(releaseEnvironmentLock(P, 'prod', d2.id)).toBe(false);
    expect(getDeploymentEnvironment(P, 'prod')?.active_deployment_id).toBe(d1.id);
  });

  it('different environments lock independently', () => {
    ensureDeploymentEnvironment(P, 'dev');
    ensureDeploymentEnvironment(P, 'prod');
    const dev = createDeployment({ projectId: P, environment: 'dev', ref: 'r' });
    const prod = createDeployment({ projectId: P, environment: 'prod', ref: 'r' });
    expect(acquireEnvironmentLock(P, 'dev', dev.id)).toBe(true);
    expect(acquireEnvironmentLock(P, 'prod', prod.id)).toBe(true);
  });

  it('records the live ref on success', () => {
    ensureDeploymentEnvironment(P, 'prod');
    const d = createDeployment({ projectId: P, environment: 'prod', ref: 'v2' });
    const env = setEnvironmentCurrentRef(P, 'prod', 'v2', d.id)!;
    expect(env.current_ref).toBe('v2');
    expect(env.current_deployment_id).toBe(d.id);
  });
});

describe('deployment approvals', () => {
  it('records approvals in chronological order with role and decision', () => {
    const d = createDeployment({
      projectId: P,
      environment: 'prod',
      ref: 'r',
      status: 'awaiting_approval',
    });
    const first = recordDeploymentApproval({
      deploymentId: d.id,
      approverUserId: 'u1',
      approverRole: 'Owner',
    });
    expect(first.decision).toBe('approved');
    expect(first.approver_role).toBe('Owner');

    recordDeploymentApproval({
      deploymentId: d.id,
      approverUserId: 'u2',
      approverRole: 'Admin',
      decision: 'rejected',
      note: 'not yet',
    });

    const approvals = listDeploymentApprovals(d.id);
    expect(approvals).toHaveLength(2);
    expect(approvals.map((a) => a.approver_user_id)).toEqual(['u1', 'u2']);
    expect(approvals[1].decision).toBe('rejected');
    expect(approvals[1].note).toBe('not yet');
  });
});

describe('deployment release items', () => {
  it('inserts and reads a deployment/card release item', () => {
    const d = createDeployment({ projectId: P, environment: 'prod', ref: 'release-sha' });
    const cardId = insertReleaseCard({ cardId: 'card-basic' });

    const item = ensureDeploymentReleaseItem({ deploymentId: d.id, cardId });

    expect(item.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(item.deployment_id).toBe(d.id);
    expect(item.card_id).toBe(cardId);
    expect(item.support_ticket_id).toBeNull();
    expect(item.source).toBe('derived');
    expect(item.inclusion_status).toBe('included');
    expect(listDeploymentReleaseItems(d.id).map((row) => row.id)).toEqual([item.id]);
  });

  it('is idempotent for the same deployment/card pair', () => {
    const d = createDeployment({ projectId: P, environment: 'prod', ref: 'release-sha' });
    const cardId = insertReleaseCard({ cardId: 'card-idempotent' });

    const first = ensureDeploymentReleaseItem({ deploymentId: d.id, cardId });
    const second = ensureDeploymentReleaseItem({ deploymentId: d.id, cardId });

    expect(second.id).toBe(first.id);
    expect(listDeploymentReleaseItems(d.id)).toHaveLength(1);
  });

  it('resolves release candidates for cards in a renamed Done column', () => {
    // Regression for card #1257: releaseCardLookupSql used an exact `col.name = 'Done'`
    // match, so support tickets on cards in a renamed Done column never linked and the
    // reporter's release-notification email never queued. Done-ness must mirror
    // isColumnDone() (case-insensitive substring) for these to resolve.
    for (const columnName of ['done', 'DONE', 'Done ✅', 'Deployed / Done']) {
      const ticket = createSupportTicket({ projectId: P, body: `bug for ${columnName}` });
      const cardId = insertReleaseCard({
        cardId: `card-${columnName.replace(/[^a-z0-9]/gi, '')}`,
        supportTicketId: ticket.id,
        columnName,
      });

      const { candidates } = resolveDeploymentReleaseCandidates({
        projectId: P,
        cardIds: [cardId],
      });

      const candidate = candidates.find((c) => c.cardId === cardId);
      expect(candidate, `column "${columnName}" should resolve`).toBeDefined();
      expect(candidate?.supportTicketId).toBe(ticket.id);
    }
  });

  it('does not treat a non-Done column as a release candidate', () => {
    const ticket = createSupportTicket({ projectId: P, body: 'still in progress' });
    const cardId = insertReleaseCard({
      cardId: 'card-in-progress',
      supportTicketId: ticket.id,
      columnName: 'In Progress',
    });

    const { candidates } = resolveDeploymentReleaseCandidates({
      projectId: P,
      cardIds: [cardId],
    });

    expect(candidates.find((c) => c.cardId === cardId)).toBeUndefined();
  });

  it('derives linked support tickets from the card relationship', () => {
    const ticket = createSupportTicket({ projectId: P, body: 'customer bug' });
    const d = createDeployment({ projectId: P, environment: 'prod', ref: 'release-sha' });
    const cardId = insertReleaseCard({ cardId: 'card-ticket', supportTicketId: ticket.id });

    const item = ensureDeploymentReleaseItem({ deploymentId: d.id, cardId });

    expect(item.support_ticket_id).toBe(ticket.id);
  });

  it('rejects derived support ticket ids outside the deployment project', () => {
    const foreignTicket = createSupportTicket({ projectId: 'other-project', body: 'not mine' });
    const d = createDeployment({ projectId: P, environment: 'prod', ref: 'release-sha' });
    const cardId = insertReleaseCard({
      cardId: 'card-stale-ticket',
      supportTicketId: foreignTicket.id,
    });

    expect(() => ensureDeploymentReleaseItem({ deploymentId: d.id, cardId })).toThrow(
      DeploymentReleaseItemError,
    );
    expect(listDeploymentReleaseItems(d.id)).toHaveLength(0);
  });

  it('does not persist customer_report_id values as support_ticket_id', () => {
    const d = createDeployment({ projectId: P, environment: 'prod', ref: 'release-sha' });
    const cardId = insertReleaseCard({
      cardId: 'card-customer-report-only',
      customerReportId: 'customer-report-1',
    });

    const item = ensureDeploymentReleaseItem({ deploymentId: d.id, cardId });

    expect(item.support_ticket_id).toBeNull();
  });

  it('fills a previously-null support ticket id on a repeated ensure', () => {
    const ticket = createSupportTicket({ projectId: P, body: 'customer bug' });
    const d = createDeployment({ projectId: P, environment: 'prod', ref: 'release-sha' });
    const cardId = insertReleaseCard({ cardId: 'card-fill' });
    const first = ensureDeploymentReleaseItem({ deploymentId: d.id, cardId });
    expect(first.support_ticket_id).toBeNull();

    getDb()
      .prepare('UPDATE kanban_cards SET support_ticket_id = ? WHERE id = ?')
      .run(ticket.id, cardId);
    const filled = ensureDeploymentReleaseItem({ deploymentId: d.id, cardId });

    expect(filled.id).toBe(first.id);
    expect(filled.support_ticket_id).toBe(ticket.id);
  });

  it('records operator adjustment metadata on an existing item', () => {
    const d = createDeployment({ projectId: P, environment: 'prod', ref: 'release-sha' });
    const cardId = insertReleaseCard({ cardId: 'card-adjusted' });
    const first = ensureDeploymentReleaseItem({ deploymentId: d.id, cardId });

    const adjusted = ensureDeploymentReleaseItem({
      deploymentId: d.id,
      cardId,
      inclusionStatus: 'excluded',
      operatorAdjustment: {
        adjustedBy: 'user-1',
        note: 'not customer-facing',
        meta: { source: 'release-editor' },
        adjustedAt: '2026-06-29 04:00:00',
      },
    });

    expect(adjusted.id).toBe(first.id);
    expect(adjusted.source).toBe('operator');
    expect(adjusted.inclusion_status).toBe('excluded');
    expect(adjusted.operator_adjusted_by).toBe('user-1');
    expect(adjusted.operator_adjustment_note).toBe('not customer-facing');
    expect(JSON.parse(adjusted.operator_adjustment_meta as string)).toEqual({
      source: 'release-editor',
    });
    expect(adjusted.operator_adjusted_at).toBe('2026-06-29 04:00:00');
  });

  it('rejects cards outside the deployment project', () => {
    const d = createDeployment({ projectId: P, environment: 'prod', ref: 'release-sha' });
    const cardId = insertReleaseCard({ projectId: 'other-project', cardId: 'foreign-card' });

    expect(() => ensureDeploymentReleaseItem({ deploymentId: d.id, cardId })).toThrow(
      DeploymentReleaseItemError,
    );
    expect(listDeploymentReleaseItems(d.id)).toHaveLength(0);
  });

  it('rejects explicit support tickets outside the deployment project', () => {
    const foreignTicket = createSupportTicket({ projectId: 'other-project', body: 'not mine' });
    const d = createDeployment({ projectId: P, environment: 'prod', ref: 'release-sha' });
    const cardId = insertReleaseCard({ cardId: 'card-explicit-foreign' });

    expect(() =>
      ensureDeploymentReleaseItem({
        deploymentId: d.id,
        cardId,
        supportTicketId: foreignTicket.id,
      }),
    ).toThrow(DeploymentReleaseItemError);
    expect(listDeploymentReleaseItems(d.id)).toHaveLength(0);
  });
});
