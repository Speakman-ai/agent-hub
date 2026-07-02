import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { EmailMessage, EmailSendResult } from './email-sender.js';
import type { ReleaseDigestRunner } from './release-digest.js';
import type { AppConfig } from './types.js';

const sendEmailMock = vi.hoisted(() =>
  vi.fn(
    async (_message: EmailMessage): Promise<EmailSendResult> => ({
      sent: false,
      reason: 'smtp_not_configured',
    }),
  ),
);

vi.mock('./email-sender.js', () => ({
  sendEmail: sendEmailMock,
  sendEmailResult: sendEmailMock,
}));

import { getDb, getStmts } from './db.js';
import { wipeTables } from './test/destructive-db.js';
import {
  createDeployment,
  ensureDeploymentReleaseItem,
  updateDeploymentStatus,
} from './deploy/deployment-store.js';
import { createSupportTicket } from './support-tickets-store.js';
import { addReleaseDigestRecipient } from './release-notification-settings.js';
import { upsertNotificationRouting } from './deploy/deployment-notification-routing-store.js';
import {
  deliverReleaseNotificationOutboxBatch,
  enqueueReleaseNotificationOutbox,
  enqueueReleaseNotificationsForDeployment,
  listReleaseNotificationOutboxByDeployment,
  listRetryEligibleReleaseNotificationOutbox,
  markReleaseNotificationOutboxError,
  retryReleaseNotificationOutbox,
} from './release-notification-outbox.js';

const P = 'release-outbox-test';

beforeEach(() => {
  // wipeTables refuses to run against a non-scratch (non-tmpdir) database —
  // see server/test/destructive-db.ts and the 2026-07-01 prod wipe incident.
  wipeTables(getDb(), [
    'release_notification_outbox',
    'deployment_release_items',
    'deployment_steps',
    'deployments',
    'deployment_environments',
    'release_digest_recipients',
    'release_notification_settings',
    'kanban_cards',
    'kanban_columns',
    'kanban_boards',
    'support_tickets',
    'deployment_env_notification_routing',
  ]);
  sendEmailMock.mockReset();
  sendEmailMock.mockResolvedValue({ sent: false, reason: 'smtp_not_configured' });
});

function insertReleaseCard(args: {
  cardId: string;
  title?: string;
  supportTicketId?: string | null;
}): string {
  const boardId = `board-${args.cardId}`;
  const columnId = `col-${args.cardId}`;
  const db = getDb();
  db.prepare('INSERT INTO kanban_boards (id, project_id, name) VALUES (?, ?, ?)').run(
    boardId,
    P,
    'Board',
  );
  db.prepare('INSERT INTO kanban_columns (id, board_id, name, position) VALUES (?, ?, ?, ?)').run(
    columnId,
    boardId,
    'Done',
    0,
  );
  db.prepare(
    `INSERT INTO kanban_cards
       (id, column_id, board_id, title, description, support_ticket_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    args.cardId,
    columnId,
    boardId,
    args.title ?? 'Customer-visible fix',
    'Internal notes are not copied into outbox rows.',
    args.supportTicketId ?? null,
  );
  return args.cardId;
}

function successfulProductionDeployment() {
  const deployment = createDeployment({ projectId: P, environment: 'production', ref: 'abc123' });
  return updateDeploymentStatus(deployment.id, 'success')!;
}

describe('release notification outbox', () => {
  it('enqueues reporter and digest notifications idempotently from final release items', async () => {
    const ticket = createSupportTicket({
      projectId: P,
      subject: 'CSV export is broken',
      body: 'Cannot export CSV.',
      reporterEmail: 'Reporter@Example.COM',
    });
    const deployment = successfulProductionDeployment();
    const cardId = insertReleaseCard({ cardId: 'card-outbox-1', supportTicketId: ticket.id });
    ensureDeploymentReleaseItem({ deploymentId: deployment.id, cardId });
    addReleaseDigestRecipient({ projectId: P, email: 'Ops@Example.COM' });

    const first = await enqueueReleaseNotificationsForDeployment(deployment);
    const second = await enqueueReleaseNotificationsForDeployment(deployment);
    const rows = listReleaseNotificationOutboxByDeployment(deployment.id);

    expect(first).toHaveLength(2);
    expect(second.map((row) => row.id).sort()).toEqual(first.map((row) => row.id).sort());
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.notification_type).sort()).toEqual([
      'release_digest',
      'ticket_release',
    ]);
    expect(rows.map((row) => row.status)).toEqual(['pending', 'pending']);
    expect(rows.map((row) => row.attempts)).toEqual([0, 0]);
    expect(rows.find((row) => row.notification_type === 'ticket_release')).toMatchObject({
      recipient_email: 'reporter@example.com',
      support_ticket_id: ticket.id,
    });
    expect(rows.find((row) => row.notification_type === 'release_digest')).toMatchObject({
      recipient_email: 'ops@example.com',
      support_ticket_id: null,
    });
  });

  it('uses the model-generated release digest for recipient outbox rows', async () => {
    const ticket = createSupportTicket({
      projectId: P,
      subject: 'CSV export is broken',
      body: 'Cannot export CSV.',
      reporterEmail: 'Reporter@Example.COM',
    });
    const deployment = successfulProductionDeployment();
    const cardId = insertReleaseCard({
      cardId: 'card-outbox-generated-digest',
      title: 'Fix CSV export internals',
      supportTicketId: ticket.id,
    });
    ensureDeploymentReleaseItem({ deploymentId: deployment.id, cardId });
    addReleaseDigestRecipient({ projectId: P, email: 'Ops@Example.COM' });
    const releaseDigestRunner: ReleaseDigestRunner = vi.fn(async ({ prompt }) => {
      expect(prompt).toContain('Fix CSV export internals');
      return '## Release digest\n\nCSV exports now include the customer-selected rows.';
    });

    const rows = await enqueueReleaseNotificationsForDeployment(deployment, {
      cfg: { openaiApiKey: 'sk-test' } as AppConfig,
      releaseDigestRunner,
    });
    const duplicateRows = await enqueueReleaseNotificationsForDeployment(deployment, {
      cfg: { openaiApiKey: 'sk-test' } as AppConfig,
      releaseDigestRunner,
    });

    expect(releaseDigestRunner).toHaveBeenCalledTimes(1);
    const digest = rows.find((row) => row.notification_type === 'release_digest');
    const duplicateDigest = duplicateRows.find((row) => row.notification_type === 'release_digest');
    expect(duplicateDigest?.id).toBe(digest?.id);
    expect(digest?.body_text).toBe(
      '## Release digest\n\nCSV exports now include the customer-selected rows.',
    );
    expect(digest?.body_text).not.toContain('1. Fix CSV export internals');
  });

  it('keeps sent rows out of retry eligibility and preserves failure state for retry', () => {
    const deployment = successfulProductionDeployment();
    const retryable = enqueueReleaseNotificationOutbox({
      projectId: P,
      deploymentId: deployment.id,
      notificationType: 'release_digest',
      idempotencyKey: 'retryable-key',
      recipientEmail: 'ops@example.com',
      subject: 'Digest',
      bodyText: 'Digest body',
    });
    const sent = enqueueReleaseNotificationOutbox({
      projectId: P,
      deploymentId: deployment.id,
      notificationType: 'release_digest',
      idempotencyKey: 'sent-key',
      recipientEmail: 'sent@example.com',
      subject: 'Digest',
      bodyText: 'Digest body',
    });
    getDb()
      .prepare(
        "UPDATE release_notification_outbox SET status = 'sent', sent_at = datetime('now') WHERE id = ?",
      )
      .run(sent.id);

    const failed = markReleaseNotificationOutboxError(retryable.id, 'temporary smtp failure')!;

    expect(failed.status).toBe('error');
    expect(failed.last_error).toBe('temporary smtp failure');
    expect(failed.next_attempt_at).toBeTruthy();
    expect(listRetryEligibleReleaseNotificationOutbox()).toEqual([]);
    getDb()
      .prepare(
        "UPDATE release_notification_outbox SET next_attempt_at = datetime('now', '-1 minute') WHERE id = ?",
      )
      .run(retryable.id);
    expect(listRetryEligibleReleaseNotificationOutbox().map((row) => row.id)).toEqual([
      retryable.id,
    ]);
  });

  it('does not report retry success when the row is no longer failed', () => {
    const deployment = successfulProductionDeployment();
    const retryable = enqueueReleaseNotificationOutbox({
      projectId: P,
      deploymentId: deployment.id,
      notificationType: 'release_digest',
      idempotencyKey: 'stale-retry-state-key',
      recipientEmail: 'ops@example.com',
      subject: 'Digest',
      bodyText: 'Digest body',
    });
    markReleaseNotificationOutboxError(retryable.id, 'temporary smtp failure');
    getDb()
      .prepare("UPDATE release_notification_outbox SET status = 'pending' WHERE id = ?")
      .run(retryable.id);

    expect(retryReleaseNotificationOutbox(retryable.id)).toBeNull();
    expect(listReleaseNotificationOutboxByDeployment(deployment.id)).toContainEqual(
      expect.objectContaining({
        id: retryable.id,
        status: 'pending',
        last_error: 'temporary smtp failure',
      }),
    );
  });

  it('falls back to the default retry limit for non-finite limits', () => {
    const deployment = successfulProductionDeployment();
    for (let i = 0; i < 30; i++) {
      enqueueReleaseNotificationOutbox({
        projectId: P,
        deploymentId: deployment.id,
        notificationType: 'release_digest',
        idempotencyKey: `non-finite-limit-${i}`,
        recipientEmail: `ops-${i}@example.com`,
        subject: 'Digest',
        bodyText: 'Digest body',
      });
    }

    expect(listRetryEligibleReleaseNotificationOutbox(Number.NaN)).toHaveLength(25);
    expect(listRetryEligibleReleaseNotificationOutbox(Number.POSITIVE_INFINITY)).toHaveLength(25);
  });

  it('honors retry backoff due time and max attempt cap', () => {
    const deployment = successfulProductionDeployment();
    const due = enqueueReleaseNotificationOutbox({
      projectId: P,
      deploymentId: deployment.id,
      notificationType: 'release_digest',
      idempotencyKey: 'due-error-key',
      recipientEmail: 'due@example.com',
      subject: 'Digest',
      bodyText: 'Digest body',
    });
    const capped = enqueueReleaseNotificationOutbox({
      projectId: P,
      deploymentId: deployment.id,
      notificationType: 'release_digest',
      idempotencyKey: 'capped-error-key',
      recipientEmail: 'capped@example.com',
      subject: 'Digest',
      bodyText: 'Digest body',
    });
    getDb()
      .prepare(
        `UPDATE release_notification_outbox
            SET status = 'error', attempts = 4, next_attempt_at = datetime('now', '-1 minute')
          WHERE id = ?`,
      )
      .run(due.id);
    getDb()
      .prepare(
        `UPDATE release_notification_outbox
            SET status = 'error', attempts = 5, next_attempt_at = datetime('now', '-1 minute')
          WHERE id = ?`,
      )
      .run(capped.id);

    expect(listRetryEligibleReleaseNotificationOutbox().map((row) => row.id)).toEqual([due.id]);
  });

  it('reclaims stale sending rows without retrying fresh in-flight claims', async () => {
    const deployment = successfulProductionDeployment();
    const fresh = enqueueReleaseNotificationOutbox({
      projectId: P,
      deploymentId: deployment.id,
      notificationType: 'release_digest',
      idempotencyKey: 'fresh-sending-key',
      recipientEmail: 'fresh@example.com',
      subject: 'Digest',
      bodyText: 'Digest body',
    });
    const stale = enqueueReleaseNotificationOutbox({
      projectId: P,
      deploymentId: deployment.id,
      notificationType: 'release_digest',
      idempotencyKey: 'stale-sending-key',
      recipientEmail: 'stale@example.com',
      subject: 'Digest',
      bodyText: 'Digest body',
    });
    getDb()
      .prepare(
        `UPDATE release_notification_outbox
            SET status = 'sending', attempts = 1
          WHERE id = ?`,
      )
      .run(fresh.id);
    getDb()
      .prepare(
        `UPDATE release_notification_outbox
            SET status = 'sending', attempts = 1, updated_at = datetime('now', '-16 minutes')
          WHERE id = ?`,
      )
      .run(stale.id);

    expect(listRetryEligibleReleaseNotificationOutbox().map((row) => row.id)).toEqual([stale.id]);

    const delivered = await deliverReleaseNotificationOutboxBatch();

    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      id: stale.id,
      status: 'error',
      attempts: 2,
      last_error: 'smtp_not_configured',
    });
    expect(listReleaseNotificationOutboxByDeployment(deployment.id)).toContainEqual(
      expect.objectContaining({
        id: fresh.id,
        status: 'sending',
        attempts: 1,
        last_error: null,
      }),
    );
  });

  it('ignores terminal updates from stale delivery attempts', () => {
    const deployment = successfulProductionDeployment();
    const sent = enqueueReleaseNotificationOutbox({
      projectId: P,
      deploymentId: deployment.id,
      notificationType: 'release_digest',
      idempotencyKey: 'stale-error-after-sent-key',
      recipientEmail: 'sent@example.com',
      subject: 'Digest',
      bodyText: 'Digest body',
    });
    const failed = enqueueReleaseNotificationOutbox({
      projectId: P,
      deploymentId: deployment.id,
      notificationType: 'release_digest',
      idempotencyKey: 'stale-sent-after-error-key',
      recipientEmail: 'failed@example.com',
      subject: 'Digest',
      bodyText: 'Digest body',
    });
    getDb()
      .prepare("UPDATE release_notification_outbox SET status = 'sending', attempts = 1")
      .run();

    expect(getStmts().markReleaseNotificationOutboxSent.run(sent.id, 2).changes).toBe(0);
    expect(getStmts().markReleaseNotificationOutboxSent.run(sent.id, 1).changes).toBe(1);
    expect(
      getStmts().markReleaseNotificationOutboxDeliveryError.run(
        null,
        'old attempt failed late',
        sent.id,
        1,
      ).changes,
    ).toBe(0);
    expect(listReleaseNotificationOutboxByDeployment(deployment.id)).toContainEqual(
      expect.objectContaining({
        id: sent.id,
        status: 'sent',
        last_error: null,
      }),
    );

    expect(
      getStmts().markReleaseNotificationOutboxDeliveryError.run(
        null,
        'newer attempt failed',
        failed.id,
        1,
      ).changes,
    ).toBe(1);
    expect(
      getStmts().markReleaseNotificationOutboxDeliveryError.run(
        null,
        'same attempt failed again late',
        failed.id,
        1,
      ).changes,
    ).toBe(0);
    expect(getStmts().markReleaseNotificationOutboxSent.run(failed.id, 1).changes).toBe(0);
    expect(listReleaseNotificationOutboxByDeployment(deployment.id)).toContainEqual(
      expect.objectContaining({
        id: failed.id,
        status: 'error',
        sent_at: null,
        last_error: 'newer attempt failed',
      }),
    );
  });

  it('records smtp_not_configured as a retryable failed delivery attempt', async () => {
    const deployment = successfulProductionDeployment();
    const queued = enqueueReleaseNotificationOutbox({
      projectId: P,
      deploymentId: deployment.id,
      notificationType: 'release_digest',
      idempotencyKey: 'smtp-disabled-key',
      recipientEmail: 'ops@example.com',
      subject: 'Digest',
      bodyText: 'Digest body',
    });

    const delivered = await deliverReleaseNotificationOutboxBatch();

    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      id: queued.id,
      status: 'error',
      attempts: 1,
      last_error: 'smtp_not_configured',
      sent_at: null,
      next_attempt_at: expect.any(String),
    });
    expect(listRetryEligibleReleaseNotificationOutbox()).toEqual([]);
    getDb()
      .prepare(
        "UPDATE release_notification_outbox SET next_attempt_at = datetime('now', '-1 minute') WHERE id = ?",
      )
      .run(queued.id);
    expect(listRetryEligibleReleaseNotificationOutbox().map((row) => row.id)).toEqual([queued.id]);
  });

  it('sends pending outbox rows through the shared email sender and marks them sent once', async () => {
    sendEmailMock.mockResolvedValue({ sent: true });
    const ticket = createSupportTicket({
      projectId: P,
      subject: 'CSV export is broken',
      body: 'Cannot export CSV.',
      reporterEmail: 'Reporter@Example.COM',
    });
    const deployment = successfulProductionDeployment();
    const cardId = insertReleaseCard({ cardId: 'card-delivery-1', supportTicketId: ticket.id });
    ensureDeploymentReleaseItem({ deploymentId: deployment.id, cardId });
    addReleaseDigestRecipient({ projectId: P, email: 'Ops@Example.COM' });
    await enqueueReleaseNotificationsForDeployment(deployment);

    const first = await deliverReleaseNotificationOutboxBatch();
    const second = await deliverReleaseNotificationOutboxBatch();

    expect(first.map((row) => row.status)).toEqual(['sent', 'sent']);
    expect(first.map((row) => row.attempts)).toEqual([1, 1]);
    expect(first.map((row) => row.last_error)).toEqual([null, null]);
    expect(second).toEqual([]);
    expect(sendEmailMock).toHaveBeenCalledTimes(2);
    expect(sendEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'reporter@example.com',
        subject: 'Update on your support ticket: CSV export is broken',
        text: expect.stringContaining('Ticket: CSV export is broken'),
      }),
    );
    expect(sendEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'ops@example.com',
        subject: 'Release digest for production abc123',
        text: expect.stringContaining('Release digest for production (abc123)'),
      }),
    );
  });

  it('labels release emails with the GitHub release version instead of the commit hash', async () => {
    sendEmailMock.mockResolvedValue({ sent: true });
    const ticket = createSupportTicket({
      projectId: P,
      subject: 'CSV export is broken',
      body: 'Cannot export CSV.',
      reporterEmail: 'Reporter@Example.COM',
    });
    const deployment = updateDeploymentStatus(
      createDeployment({
        projectId: P,
        environment: 'production',
        ref: 'refs/tags/v2.31.18',
      }).id,
      'success',
    )!;
    const cardId = insertReleaseCard({ cardId: 'card-versioned', supportTicketId: ticket.id });
    ensureDeploymentReleaseItem({ deploymentId: deployment.id, cardId });
    addReleaseDigestRecipient({ projectId: P, email: 'Ops@Example.COM' });
    await enqueueReleaseNotificationsForDeployment(deployment);

    await deliverReleaseNotificationOutboxBatch();

    expect(sendEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'ops@example.com',
        subject: 'Release digest for production v2.31.18',
        text: expect.stringContaining('Release digest for production (v2.31.18)'),
      }),
    );
    expect(sendEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'reporter@example.com',
        text: expect.stringContaining('Deployment: production (v2.31.18)'),
      }),
    );
    const digestText = sendEmailMock.mock.calls.map((call) => call[0].text).join('\n');
    expect(digestText).not.toContain('refs/tags/');
  });

  it('stores safe retryable errors when the shared email sender throws', async () => {
    sendEmailMock.mockRejectedValue(new Error('SMTP password super-secret-token leaked'));
    const deployment = successfulProductionDeployment();
    const queued = enqueueReleaseNotificationOutbox({
      projectId: P,
      deploymentId: deployment.id,
      notificationType: 'release_digest',
      idempotencyKey: 'throwing-sender-key',
      recipientEmail: 'ops@example.com',
      subject: 'Digest',
      bodyText: 'Digest body',
    });

    const first = await deliverReleaseNotificationOutboxBatch();
    const immediateRetry = await deliverReleaseNotificationOutboxBatch();

    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      id: queued.id,
      status: 'error',
      attempts: 1,
      last_error: 'send_failed',
      sent_at: null,
      next_attempt_at: expect.any(String),
    });
    expect(first[0].last_error).not.toContain('super-secret-token');
    expect(immediateRetry).toEqual([]);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
  });
});

describe('release notification per-environment routing', () => {
  function successfulDeployment(environment: string) {
    const deployment = createDeployment({ projectId: P, environment, ref: 'abc123' });
    return updateDeploymentStatus(deployment.id, 'success')!;
  }

  function seedIncludedReleaseItem(deploymentId: string, cardId: string) {
    const ticket = createSupportTicket({
      projectId: P,
      subject: 'CSV export is broken',
      body: 'Cannot export CSV.',
      reporterEmail: 'Reporter@Example.COM',
    });
    const card = insertReleaseCard({ cardId, supportTicketId: ticket.id });
    ensureDeploymentReleaseItem({ deploymentId, cardId: card });
    addReleaseDigestRecipient({ projectId: P, email: 'Ops@Example.COM' });
  }

  it('sends nothing for a non-prod deployment by default', async () => {
    const deployment = successfulDeployment('staging');
    seedIncludedReleaseItem(deployment.id, 'card-routing-staging-default');

    const queued = await enqueueReleaseNotificationsForDeployment(deployment);

    expect(queued).toEqual([]);
    expect(listReleaseNotificationOutboxByDeployment(deployment.id)).toEqual([]);
  });

  it('sends reporter + digest for a non-prod env once routing is enabled', async () => {
    const deployment = successfulDeployment('staging');
    seedIncludedReleaseItem(deployment.id, 'card-routing-staging-enabled');
    upsertNotificationRouting({
      projectId: P,
      environmentName: 'staging',
      ticketReleaseEnabled: true,
      releaseDigestEnabled: true,
    });

    const queued = await enqueueReleaseNotificationsForDeployment(deployment);

    expect(queued.map((row) => row.notification_type).sort()).toEqual([
      'release_digest',
      'ticket_release',
    ]);
  });

  it('sends nothing when an operator opts a prod env out of all notifications', async () => {
    const deployment = successfulDeployment('production');
    seedIncludedReleaseItem(deployment.id, 'card-routing-prod-off');
    upsertNotificationRouting({
      projectId: P,
      environmentName: 'production',
      ticketReleaseEnabled: false,
      releaseDigestEnabled: false,
    });

    const queued = await enqueueReleaseNotificationsForDeployment(deployment);

    expect(queued).toEqual([]);
  });

  it('sends only the reporter email when digest is routed off for prod', async () => {
    const deployment = successfulDeployment('production');
    seedIncludedReleaseItem(deployment.id, 'card-routing-prod-reporter-only');
    upsertNotificationRouting({
      projectId: P,
      environmentName: 'production',
      ticketReleaseEnabled: true,
      releaseDigestEnabled: false,
    });

    const queued = await enqueueReleaseNotificationsForDeployment(deployment);

    expect(queued.map((row) => row.notification_type)).toEqual(['ticket_release']);
  });
});
