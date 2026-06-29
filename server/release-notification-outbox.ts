import { randomUUID } from 'crypto';
import { getStmts } from './db.js';
import { sendEmail } from './email-sender.js';
import { listDeploymentReleaseItemsWithContext } from './deploy/deployment-store.js';
import { listReleaseDigestRecipients } from './release-notification-settings.js';
import type {
  DeploymentReleaseItemDetailRow,
  DeploymentRow,
  ReleaseNotificationOutboxRow,
  ReleaseNotificationType,
} from './types.js';

const DEFAULT_DELIVERY_LIMIT = 25;
export const RELEASE_NOTIFICATION_OUTBOX_MAX_ATTEMPTS = 5;

const RETRY_BACKOFF_MINUTES_BY_ATTEMPT = new Map<number, number>([
  [1, 5],
  [2, 15],
  [3, 60],
  [4, 240],
]);

export interface EnqueueReleaseNotificationInput {
  projectId: string;
  deploymentId: string;
  releaseItemId?: string | null;
  supportTicketId?: string | null;
  notificationType: ReleaseNotificationType;
  idempotencyKey: string;
  recipientEmail: string;
  subject: string;
  bodyText: string;
}

function normalizeRecipientEmail(email: string): string {
  return email.trim().toLowerCase();
}

function sqliteDateTimeAfterMinutes(minutes: number, now = new Date()): string {
  return new Date(now.getTime() + minutes * 60_000).toISOString().replace('T', ' ').slice(0, 19);
}

export function nextReleaseNotificationAttemptAt(
  attempts: number,
  now = new Date(),
): string | null {
  if (attempts >= RELEASE_NOTIFICATION_OUTBOX_MAX_ATTEMPTS) return null;
  const attemptForBackoff = Math.max(1, Math.floor(attempts));
  const minutes = RETRY_BACKOFF_MINUTES_BY_ATTEMPT.get(attemptForBackoff) ?? 240;
  return sqliteDateTimeAfterMinutes(minutes, now);
}

function isProductionEnvironment(environment: string): boolean {
  const normalized = environment.trim().toLowerCase();
  return normalized === 'prod' || normalized === 'production';
}

function ticketSubject(item: DeploymentReleaseItemDetailRow): string {
  const subject = item.support_ticket_subject?.trim() || item.card_title.trim();
  return `Update on your support ticket: ${subject}`;
}

function renderTicketReleaseBody(
  deployment: Pick<DeploymentRow, 'environment' | 'ref' | 'completed_at'>,
  item: DeploymentReleaseItemDetailRow,
): string {
  const lines = [
    'The fix linked to your support ticket has shipped to production.',
    '',
    `Ticket: ${item.support_ticket_subject?.trim() || item.support_ticket_id || 'Support ticket'}`,
    `Released item: ${item.card_title}`,
    `Deployment: ${deployment.environment} (${deployment.ref})`,
  ];
  if (deployment.completed_at) lines.push(`Completed at: ${deployment.completed_at}`);
  return lines.join('\n');
}

function renderReleaseDigestBody(
  deployment: Pick<DeploymentRow, 'environment' | 'ref' | 'completed_at'>,
  items: DeploymentReleaseItemDetailRow[],
): string {
  const lines = [
    `Release digest for ${deployment.environment} (${deployment.ref})`,
    '',
    ...items.map((item, index) => {
      const ticket = item.support_ticket_subject ? `, ticket: ${item.support_ticket_subject}` : '';
      return `${index + 1}. ${item.card_title}${ticket}`;
    }),
  ];
  if (deployment.completed_at) {
    lines.push('', `Completed at: ${deployment.completed_at}`);
  }
  return lines.join('\n');
}

export function enqueueReleaseNotificationOutbox(
  input: EnqueueReleaseNotificationInput,
): ReleaseNotificationOutboxRow {
  const recipientEmail = normalizeRecipientEmail(input.recipientEmail);
  getStmts().insertReleaseNotificationOutbox.run({
    id: randomUUID(),
    project_id: input.projectId,
    deployment_id: input.deploymentId,
    release_item_id: input.releaseItemId ?? null,
    support_ticket_id: input.supportTicketId ?? null,
    notification_type: input.notificationType,
    idempotency_key: input.idempotencyKey,
    recipient_email: recipientEmail,
    subject: input.subject.trim(),
    body_text: input.bodyText.trim(),
  });
  return getStmts().getReleaseNotificationOutboxByKey.get(
    input.idempotencyKey,
  ) as ReleaseNotificationOutboxRow;
}

export function listReleaseNotificationOutboxByDeployment(
  deploymentId: string,
): ReleaseNotificationOutboxRow[] {
  return getStmts().listReleaseNotificationOutboxByDeployment.all(
    deploymentId,
  ) as ReleaseNotificationOutboxRow[];
}

export function listRetryEligibleReleaseNotificationOutbox(
  limit = DEFAULT_DELIVERY_LIMIT,
): ReleaseNotificationOutboxRow[] {
  const boundedLimit = Number.isFinite(limit)
    ? Math.max(1, Math.min(200, Math.floor(limit)))
    : DEFAULT_DELIVERY_LIMIT;
  return getStmts().listRetryEligibleReleaseNotificationOutbox.all(
    RELEASE_NOTIFICATION_OUTBOX_MAX_ATTEMPTS,
    boundedLimit,
  ) as ReleaseNotificationOutboxRow[];
}

export function markReleaseNotificationOutboxError(
  id: string,
  error: string,
): ReleaseNotificationOutboxRow | null {
  getStmts().markReleaseNotificationOutboxError.run(
    nextReleaseNotificationAttemptAt(0),
    error.slice(0, 2000),
    id,
  );
  return (
    (getStmts().getReleaseNotificationOutboxById.get(id) as
      | ReleaseNotificationOutboxRow
      | undefined) ?? null
  );
}

export function enqueueReleaseNotificationsForDeployment(
  deployment: Pick<
    DeploymentRow,
    'id' | 'project_id' | 'environment' | 'ref' | 'status' | 'completed_at'
  >,
): ReleaseNotificationOutboxRow[] {
  if (deployment.status !== 'success' || !isProductionEnvironment(deployment.environment)) {
    return [];
  }
  const items = listDeploymentReleaseItemsWithContext(deployment.id).filter(
    (item) => item.inclusion_status === 'included',
  );
  if (!items.length) return [];

  const queued: ReleaseNotificationOutboxRow[] = [];
  for (const item of items) {
    const recipientEmail = item.support_ticket_reporter_email;
    if (!item.support_ticket_id || !recipientEmail) continue;
    queued.push(
      enqueueReleaseNotificationOutbox({
        projectId: deployment.project_id,
        deploymentId: deployment.id,
        releaseItemId: item.id,
        supportTicketId: item.support_ticket_id,
        notificationType: 'ticket_release',
        idempotencyKey: `deployment:${deployment.id}:support-ticket:${item.support_ticket_id}:ticket_release`,
        recipientEmail,
        subject: ticketSubject(item),
        bodyText: renderTicketReleaseBody(deployment, item),
      }),
    );
  }

  const recipients = listReleaseDigestRecipients(deployment.project_id).filter(
    (recipient) => recipient.enabled,
  );
  if (recipients.length > 0) {
    const subject = `Release digest for ${deployment.environment} ${deployment.ref}`;
    const bodyText = renderReleaseDigestBody(deployment, items);
    for (const recipient of recipients) {
      const normalized = normalizeRecipientEmail(recipient.email);
      queued.push(
        enqueueReleaseNotificationOutbox({
          projectId: deployment.project_id,
          deploymentId: deployment.id,
          releaseItemId: null,
          supportTicketId: null,
          notificationType: 'release_digest',
          idempotencyKey: `deployment:${deployment.id}:release-digest:${normalized}`,
          recipientEmail: recipient.email,
          subject,
          bodyText,
        }),
      );
    }
  }

  return queued;
}

function claimReleaseNotificationOutboxForDelivery(
  row: ReleaseNotificationOutboxRow,
): ReleaseNotificationOutboxRow | null {
  const result = getStmts().markReleaseNotificationOutboxSending.run(row.id);
  if (result.changes === 0) return null;
  return getStmts().getReleaseNotificationOutboxById.get(row.id) as ReleaseNotificationOutboxRow;
}

export async function deliverReleaseNotificationOutboxBatch(
  limit = DEFAULT_DELIVERY_LIMIT,
): Promise<ReleaseNotificationOutboxRow[]> {
  const deliveredOrFailed: ReleaseNotificationOutboxRow[] = [];
  for (const candidate of listRetryEligibleReleaseNotificationOutbox(limit)) {
    const claimed = claimReleaseNotificationOutboxForDelivery(candidate);
    if (!claimed) continue;
    try {
      const result = await sendEmail({
        to: claimed.recipient_email,
        subject: claimed.subject,
        text: claimed.body_text,
      });
      if (result.sent) {
        getStmts().markReleaseNotificationOutboxSent.run(claimed.id, claimed.attempts);
      } else {
        getStmts().markReleaseNotificationOutboxDeliveryError.run(
          nextReleaseNotificationAttemptAt(claimed.attempts),
          result.reason ?? 'send_failed',
          claimed.id,
          claimed.attempts,
        );
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      getStmts().markReleaseNotificationOutboxDeliveryError.run(
        nextReleaseNotificationAttemptAt(claimed.attempts),
        detail.slice(0, 2000),
        claimed.id,
        claimed.attempts,
      );
    }
    deliveredOrFailed.push(
      getStmts().getReleaseNotificationOutboxById.get(claimed.id) as ReleaseNotificationOutboxRow,
    );
  }
  return deliveredOrFailed;
}
