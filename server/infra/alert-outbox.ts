/** Durable email delivery for infrastructure alert transitions. */
import { randomUUID } from 'node:crypto';
import { getInfraDb } from './infra-db.js';
import { sendEmailResult } from '../email-sender.js';
import type { InfraAlertSeverity } from './infra-schema.js';

export const INFRA_ALERT_OUTBOX_MAX_ATTEMPTS = 5;
export const INFRA_ALERT_OUTBOX_RETRY_BACKOFF_MINUTES = [5, 15, 60, 240] as const;
const DEFAULT_DELIVERY_LIMIT = 25;

export type InfraAlertOutboxStatus = 'pending' | 'sending' | 'sent' | 'error';

export interface InfraAlertOutboxRow {
  id: string;
  project_id: string;
  alert_id: string;
  severity: InfraAlertSeverity;
  transition_key: string;
  recipient_email: string;
  subject: string;
  body_text: string;
  status: InfraAlertOutboxStatus;
  attempts: number;
  sent_at: string | null;
  next_attempt_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface EnqueueInfraAlertEmailInput {
  projectId: string;
  alertId: string;
  severity: InfraAlertSeverity;
  transitionKey: string;
  recipientEmail: string;
  subject: string;
  bodyText: string;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function sqliteDateTimeAfterMinutes(minutes: number, now = new Date()): string {
  return new Date(now.getTime() + minutes * 60_000).toISOString().replace('T', ' ').slice(0, 19);
}

export function nextInfraAlertAttemptAt(attempts: number, now = new Date()): string | null {
  if (attempts >= INFRA_ALERT_OUTBOX_MAX_ATTEMPTS) return null;
  const index = Math.max(1, Math.floor(attempts)) - 1;
  const minutes = INFRA_ALERT_OUTBOX_RETRY_BACKOFF_MINUTES[index] ?? 240;
  return sqliteDateTimeAfterMinutes(minutes, now);
}

export function enqueueInfraAlertEmail(input: EnqueueInfraAlertEmailInput): InfraAlertOutboxRow {
  const recipientEmail = normalizeEmail(input.recipientEmail);
  getInfraDb()
    .prepare(
      `INSERT INTO infra_alert_outbox
         (id, project_id, alert_id, severity, transition_key, recipient_email,
          subject, body_text)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(transition_key, recipient_email) DO NOTHING`,
    )
    .run(
      randomUUID(),
      input.projectId,
      input.alertId,
      input.severity,
      input.transitionKey,
      recipientEmail,
      input.subject.trim(),
      input.bodyText.trim(),
    );
  return getInfraDb()
    .prepare(
      `SELECT * FROM infra_alert_outbox
       WHERE transition_key = ? AND recipient_email = ?`,
    )
    .get(input.transitionKey, recipientEmail) as InfraAlertOutboxRow;
}

export function listRetryEligibleInfraAlertOutbox(
  limit = DEFAULT_DELIVERY_LIMIT,
): InfraAlertOutboxRow[] {
  const boundedLimit = Number.isFinite(limit)
    ? Math.max(1, Math.min(200, Math.floor(limit)))
    : DEFAULT_DELIVERY_LIMIT;
  return getInfraDb()
    .prepare(
      `SELECT * FROM infra_alert_outbox
       WHERE sent_at IS NULL
         AND (
           (status = 'pending' AND attempts < ?)
           OR (status = 'error' AND attempts < ?
             AND (next_attempt_at IS NULL OR next_attempt_at <= datetime('now')))
           OR (status = 'sending' AND attempts <= ?
             AND updated_at <= datetime('now', '-15 minutes'))
         )
       ORDER BY created_at ASC, rowid ASC
       LIMIT ?`,
    )
    .all(
      INFRA_ALERT_OUTBOX_MAX_ATTEMPTS,
      INFRA_ALERT_OUTBOX_MAX_ATTEMPTS,
      INFRA_ALERT_OUTBOX_MAX_ATTEMPTS,
      boundedLimit,
    ) as InfraAlertOutboxRow[];
}

function claim(row: InfraAlertOutboxRow): InfraAlertOutboxRow | null {
  const result = getInfraDb()
    .prepare(
      `UPDATE infra_alert_outbox
       SET status = 'sending',
           attempts = CASE WHEN attempts < ? THEN attempts + 1 ELSE attempts END,
           next_attempt_at = NULL, updated_at = datetime('now')
       WHERE id = ? AND sent_at IS NULL
         AND (status IN ('pending', 'error')
           OR (status = 'sending' AND updated_at <= datetime('now', '-15 minutes')))`,
    )
    .run(INFRA_ALERT_OUTBOX_MAX_ATTEMPTS, row.id);
  if (result.changes === 0) return null;
  return getInfraDb()
    .prepare('SELECT * FROM infra_alert_outbox WHERE id = ?')
    .get(row.id) as InfraAlertOutboxRow;
}

function setSent(row: InfraAlertOutboxRow): void {
  getInfraDb()
    .prepare(
      `UPDATE infra_alert_outbox
       SET status = 'sent', sent_at = datetime('now'), next_attempt_at = NULL,
           last_error = NULL, updated_at = datetime('now')
       WHERE id = ? AND status = 'sending' AND attempts = ?`,
    )
    .run(row.id, row.attempts);
}

function setError(row: InfraAlertOutboxRow, reason: string): void {
  getInfraDb()
    .prepare(
      `UPDATE infra_alert_outbox
       SET status = 'error', next_attempt_at = ?, last_error = ?, updated_at = datetime('now')
       WHERE id = ? AND status = 'sending' AND attempts = ?`,
    )
    .run(nextInfraAlertAttemptAt(row.attempts), reason.slice(0, 2000), row.id, row.attempts);
}

export function safeInfraAlertErrorSummary(error: string | null): string | null {
  if (!error) return null;
  if (error === 'smtp_not_configured') return 'SMTP is not configured.';
  if (error === 'invalid_recipient') return 'Recipient address is invalid.';
  return 'Alert email delivery failed.';
}

export async function deliverInfraAlertOutboxBatch(
  limit = DEFAULT_DELIVERY_LIMIT,
): Promise<InfraAlertOutboxRow[]> {
  const settled: InfraAlertOutboxRow[] = [];
  for (const candidate of listRetryEligibleInfraAlertOutbox(limit)) {
    const row = claim(candidate);
    if (!row) continue;
    try {
      const result = await sendEmailResult({
        to: row.recipient_email,
        subject: row.subject,
        text: row.body_text,
      });
      if (result.sent) setSent(row);
      else setError(row, result.reason ?? 'send_failed');
    } catch {
      setError(row, 'send_failed');
    }
    settled.push(
      getInfraDb()
        .prepare('SELECT * FROM infra_alert_outbox WHERE id = ?')
        .get(row.id) as InfraAlertOutboxRow,
    );
  }
  return settled;
}
