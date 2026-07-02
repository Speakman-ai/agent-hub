import { randomUUID } from 'crypto';
import { getStmts } from './db.js';
import { sendEmailResult } from './email-sender.js';
import { listDeploymentReleaseItemsWithContext } from './deploy/deployment-store.js';
import { deploymentReleaseLabel } from './deploy/release-label.js';
import { generateDeploymentReleaseDigest, type ReleaseDigestRunner } from './release-digest.js';
import { listReleaseDigestRecipients } from './release-notification-settings.js';
import { resolveNotificationRouting } from './deploy/deployment-notification-routing-store.js';
import type {
  AppConfig,
  BroadcastFn,
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

export interface ReleaseNotificationHistoryItem {
  id: string;
  deployment_id: string;
  release_item_id: string | null;
  support_ticket_id: string | null;
  notification_type: ReleaseNotificationType;
  recipient_type: 'reporter' | 'release_digest';
  subject: string;
  status: ReleaseNotificationOutboxRow['status'];
  attempts: number;
  sent_at: string | null;
  next_attempt_at: string | null;
  error_summary: string | null;
  can_retry: boolean;
  created_at: string;
  updated_at: string;
}

export interface ReleaseNotificationRecipientItem {
  id: string;
  deployment_id: string;
  release_item_id: string | null;
  support_ticket_id: string | null;
  notification_type: ReleaseNotificationType;
  recipient_type: 'reporter' | 'release_digest';
  recipient_email: string;
  subject: string;
  status: ReleaseNotificationOutboxRow['status'];
  attempts: number;
  sent_at: string | null;
  next_attempt_at: string | null;
  error_summary: string | null;
  created_at: string;
  updated_at: string;
}

export interface EnqueueReleaseNotificationsOptions {
  cfg?: AppConfig;
  releaseDigestRunner?: ReleaseDigestRunner;
  /**
   * Best-effort WS fan-out. When provided, a `release_notification_update`
   * event is broadcast after rows are queued so the Deployments UI shows the
   * newly-pending notifications live (the deployment_update event carries only
   * the row + steps, not the notification history).
   */
  broadcast?: BroadcastFn;
}

/** WS event that mirrors the safe (PII-free) notification history for a deployment. */
export interface ReleaseNotificationUpdateEvent {
  type: 'release_notification_update';
  projectId: string;
  deploymentId: string;
  releaseNotifications: ReleaseNotificationHistoryItem[];
}

/**
 * Build the safe `release_notification_update` payload for a deployment. Uses
 * {@link releaseNotificationHistoryItem} (no recipient address, sanitized error)
 * because WS events fan out to every connected client of the project — unlike
 * the Admin-gated recipients endpoint, they must never carry reporter PII.
 */
export function releaseNotificationUpdateEvent(
  projectId: string,
  deploymentId: string,
): ReleaseNotificationUpdateEvent {
  return {
    type: 'release_notification_update',
    projectId,
    deploymentId,
    releaseNotifications: listReleaseNotificationOutboxByDeployment(deploymentId).map(
      releaseNotificationHistoryItem,
    ),
  };
}

/**
 * Broadcast a `release_notification_update` for a deployment. BEST-EFFORT by
 * contract, mirroring the deploy orchestrator's `emitDeploymentUpdate`: live
 * progress is a notification, never authoritative, so a WS/fanout failure must
 * not reject the delivery/enqueue path. Swallows and logs any failure.
 */
export function broadcastReleaseNotificationUpdate(
  broadcast: BroadcastFn | undefined,
  projectId: string,
  deploymentId: string,
): void {
  if (!broadcast) return;
  try {
    broadcast(
      releaseNotificationUpdateEvent(projectId, deploymentId) as unknown as Record<string, unknown>,
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(
      `[release-notification-outbox] release_notification_update broadcast failed ` +
        `(best-effort) deployment=${deploymentId} project=${projectId}: ${detail}`,
    );
  }
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

function ticketSubject(item: DeploymentReleaseItemDetailRow): string {
  const subject = item.support_ticket_subject?.trim() || item.card_title.trim();
  return `Update on your support ticket: ${subject}`;
}

function renderTicketReleaseBody(
  deployment: Pick<DeploymentRow, 'environment' | 'ref' | 'meta' | 'completed_at'>,
  item: DeploymentReleaseItemDetailRow,
): string {
  const lines = [
    'The fix linked to your support ticket has shipped to production.',
    '',
    `Ticket: ${item.support_ticket_subject?.trim() || item.support_ticket_id || 'Support ticket'}`,
    `Released item: ${item.card_title}`,
    `Deployment: ${deployment.environment} (${deploymentReleaseLabel(deployment).label})`,
  ];
  if (deployment.completed_at) lines.push(`Completed at: ${deployment.completed_at}`);
  return lines.join('\n');
}

function renderReleaseDigestBody(
  deployment: Pick<DeploymentRow, 'environment' | 'ref' | 'meta' | 'completed_at'>,
  items: DeploymentReleaseItemDetailRow[],
): string {
  const lines = [
    `Release digest for ${deployment.environment} (${deploymentReleaseLabel(deployment).label})`,
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

function releaseDigestIdempotencyKey(deploymentId: string, recipientEmail: string): string {
  return `deployment:${deploymentId}:release-digest:${normalizeRecipientEmail(recipientEmail)}`;
}

async function renderReleaseDigestBodyForOutbox(
  deployment: Pick<
    DeploymentRow,
    'id' | 'project_id' | 'environment' | 'ref' | 'meta' | 'status' | 'completed_at'
  >,
  items: DeploymentReleaseItemDetailRow[],
  options: EnqueueReleaseNotificationsOptions,
): Promise<string> {
  const canGenerateDigest =
    options.cfg &&
    (options.releaseDigestRunner || typeof options.cfg.openaiApiKey === 'string') &&
    (options.releaseDigestRunner || options.cfg.openaiApiKey?.trim());
  if (canGenerateDigest && options.cfg) {
    try {
      const digest = await generateDeploymentReleaseDigest({
        projectId: deployment.project_id,
        deploymentId: deployment.id,
        cfg: options.cfg,
        runner: options.releaseDigestRunner,
      });
      return digest.digestMarkdown;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error(
        `[release-notification-outbox] release digest generation failed ` +
          `deployment=${deployment.id} project=${deployment.project_id}: ${detail}`,
      );
    }
  }
  return renderReleaseDigestBody(deployment, items);
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

export function listReleaseNotificationOutboxBySupportTicket(
  supportTicketId: string,
): ReleaseNotificationOutboxRow[] {
  return getStmts().listReleaseNotificationOutboxBySupportTicket.all(
    supportTicketId,
  ) as ReleaseNotificationOutboxRow[];
}

export function safeReleaseNotificationErrorSummary(error: string | null): string | null {
  if (!error) return null;
  const normalized = error.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === 'smtp_not_configured') return 'SMTP is not configured.';
  if (normalized === 'send_failed') return 'Email send failed.';
  if (normalized === 'recipient_missing') return 'Recipient address is missing.';
  if (normalized === 'invalid_recipient') return 'Recipient address is invalid.';
  return 'Email delivery failed.';
}

export function releaseNotificationHistoryItem(
  row: ReleaseNotificationOutboxRow,
): ReleaseNotificationHistoryItem {
  return {
    id: row.id,
    deployment_id: row.deployment_id,
    release_item_id: row.release_item_id,
    support_ticket_id: row.support_ticket_id,
    notification_type: row.notification_type,
    recipient_type: row.notification_type === 'ticket_release' ? 'reporter' : 'release_digest',
    subject: row.subject,
    status: row.status,
    attempts: row.attempts,
    sent_at: row.sent_at,
    next_attempt_at: row.next_attempt_at,
    error_summary: safeReleaseNotificationErrorSummary(row.last_error),
    can_retry: row.status === 'error' && row.sent_at === null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * Admin-only projection of an outbox row. Unlike {@link releaseNotificationHistoryItem}
 * (the safe operator-facing history that hides addresses), this exposes the actual
 * `recipient_email` so an Admin can audit exactly who a deployment notified. It still
 * withholds the raw `last_error` and `body_text` — only the sanitized `error_summary`
 * is surfaced, matching the redaction rules elsewhere in this module.
 */
export function releaseNotificationRecipientItem(
  row: ReleaseNotificationOutboxRow,
): ReleaseNotificationRecipientItem {
  return {
    id: row.id,
    deployment_id: row.deployment_id,
    release_item_id: row.release_item_id,
    support_ticket_id: row.support_ticket_id,
    notification_type: row.notification_type,
    recipient_type: row.notification_type === 'ticket_release' ? 'reporter' : 'release_digest',
    recipient_email: row.recipient_email,
    subject: row.subject,
    status: row.status,
    attempts: row.attempts,
    sent_at: row.sent_at,
    next_attempt_at: row.next_attempt_at,
    error_summary: safeReleaseNotificationErrorSummary(row.last_error),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * Admin-only recipient audit list for a deployment: every outbox row projected with
 * its recipient address, ordered as the store returns them (chronological insert order).
 */
export function listReleaseNotificationRecipientsByDeployment(
  deploymentId: string,
): ReleaseNotificationRecipientItem[] {
  return listReleaseNotificationOutboxByDeployment(deploymentId).map(
    releaseNotificationRecipientItem,
  );
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

export function retryReleaseNotificationOutbox(id: string): ReleaseNotificationOutboxRow | null {
  const result = getStmts().retryReleaseNotificationOutbox.run(
    RELEASE_NOTIFICATION_OUTBOX_MAX_ATTEMPTS,
    RELEASE_NOTIFICATION_OUTBOX_MAX_ATTEMPTS - 1,
    id,
  );
  if (result.changes === 0) return null;
  return (
    (getStmts().getReleaseNotificationOutboxById.get(id) as
      | ReleaseNotificationOutboxRow
      | undefined) ?? null
  );
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

export async function enqueueReleaseNotificationsForDeployment(
  deployment: Pick<
    DeploymentRow,
    'id' | 'project_id' | 'environment' | 'ref' | 'meta' | 'status' | 'completed_at'
  >,
  options: EnqueueReleaseNotificationsOptions = {},
): Promise<ReleaseNotificationOutboxRow[]> {
  if (deployment.status !== 'success') return [];
  // Per-(project, environment) routing decides which notification types fire.
  // The default (no config row) is prod → reporter + digest, non-prod → nothing,
  // so pre-routing behaviour is preserved until an operator opts an env in/out.
  const routing = resolveNotificationRouting(deployment.project_id, deployment.environment);
  if (!routing.ticketReleaseEnabled && !routing.releaseDigestEnabled) return [];
  const items = listDeploymentReleaseItemsWithContext(deployment.id).filter(
    (item) => item.inclusion_status === 'included',
  );
  if (!items.length) return [];

  const queued: ReleaseNotificationOutboxRow[] = [];
  if (routing.ticketReleaseEnabled) {
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
  }

  const recipients = routing.releaseDigestEnabled
    ? listReleaseDigestRecipients(deployment.project_id).filter((recipient) => recipient.enabled)
    : [];
  if (recipients.length > 0) {
    const digestRecipients = recipients.map((recipient) => {
      const idempotencyKey = releaseDigestIdempotencyKey(deployment.id, recipient.email);
      return {
        recipient,
        idempotencyKey,
        existing: getStmts().getReleaseNotificationOutboxByKey.get(
          idempotencyKey,
        ) as ReleaseNotificationOutboxRow | null,
      };
    });
    const missingDigestRecipients = digestRecipients.filter((entry) => !entry.existing);
    const subject = `Release digest for ${deployment.environment} ${
      deploymentReleaseLabel(deployment).label
    }`;
    const bodyText =
      missingDigestRecipients.length > 0
        ? await renderReleaseDigestBodyForOutbox(deployment, items, options)
        : null;
    for (const { recipient, idempotencyKey, existing } of digestRecipients) {
      if (existing) {
        queued.push(existing);
        continue;
      }
      queued.push(
        enqueueReleaseNotificationOutbox({
          projectId: deployment.project_id,
          deploymentId: deployment.id,
          releaseItemId: null,
          supportTicketId: null,
          notificationType: 'release_digest',
          idempotencyKey,
          recipientEmail: recipient.email,
          subject,
          bodyText: bodyText ?? renderReleaseDigestBody(deployment, items),
        }),
      );
    }
  }

  if (queued.length > 0) {
    broadcastReleaseNotificationUpdate(options.broadcast, deployment.project_id, deployment.id);
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

export interface DeliverReleaseNotificationOutboxOptions {
  /**
   * Best-effort WS fan-out. When provided, a single `release_notification_update`
   * event is broadcast per affected deployment after the batch settles so the
   * Deployments UI reflects sent/failed transitions without a manual refresh.
   */
  broadcast?: BroadcastFn;
}

export async function deliverReleaseNotificationOutboxBatch(
  limit = DEFAULT_DELIVERY_LIMIT,
  options: DeliverReleaseNotificationOutboxOptions = {},
): Promise<ReleaseNotificationOutboxRow[]> {
  const deliveredOrFailed: ReleaseNotificationOutboxRow[] = [];
  for (const candidate of listRetryEligibleReleaseNotificationOutbox(limit)) {
    const claimed = claimReleaseNotificationOutboxForDelivery(candidate);
    if (!claimed) continue;
    try {
      const result = await sendEmailResult({
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
    } catch {
      getStmts().markReleaseNotificationOutboxDeliveryError.run(
        nextReleaseNotificationAttemptAt(claimed.attempts),
        'send_failed',
        claimed.id,
        claimed.attempts,
      );
    }
    deliveredOrFailed.push(
      getStmts().getReleaseNotificationOutboxById.get(claimed.id) as ReleaseNotificationOutboxRow,
    );
  }
  // One broadcast per affected deployment (rows for the same deployment share a
  // history projection, so per-row events would be redundant fan-out).
  if (options.broadcast && deliveredOrFailed.length > 0) {
    const affected = new Map<string, string>();
    for (const row of deliveredOrFailed) affected.set(row.deployment_id, row.project_id);
    for (const [deploymentId, projectId] of affected) {
      broadcastReleaseNotificationUpdate(options.broadcast, projectId, deploymentId);
    }
  }
  return deliveredOrFailed;
}
