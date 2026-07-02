// Pure helpers for the deployment notification-recipients audit surface.
// Framework-free so they can be unit-tested. Mirror of
// client/src/utils/deployRecipients.ts. Backend contract lives in the
// Admin-gated read endpoint
// GET /api/projects/:projectId/deployments/:deploymentId/notification-recipients
// (server/release-notification-outbox.ts → releaseNotificationRecipientItem).

export interface ReleaseNotificationRecipient {
  id: string;
  deployment_id: string;
  release_item_id: string | null;
  support_ticket_id: string | null;
  notification_type: 'ticket_release' | 'release_digest' | string;
  recipient_type: 'reporter' | 'release_digest' | string;
  recipient_email: string;
  subject: string | null;
  status: 'pending' | 'sending' | 'sent' | 'error' | string;
  attempts: number;
  sent_at: string | null;
  next_attempt_at: string | null;
  error_summary: string | null;
}

/** Human label for who a recipient row addresses. */
export function recipientTypeLabel(recipient: {
  recipient_type?: string;
  notification_type?: string;
}): string {
  if (recipient?.recipient_type === 'reporter') return 'Reporter';
  if (recipient?.recipient_type === 'release_digest') return 'Release digest';
  return String(recipient?.recipient_type || recipient?.notification_type || 'Recipient');
}

/** Delivery status, humanized (`next_attempt` → `next attempt`). */
export function recipientStatusLabel(recipient: { status?: string }): string {
  return String(recipient?.status || 'pending').replaceAll('_', ' ');
}

export interface RecipientCounts {
  total: number;
  sent: number;
  pending: number;
  error: number;
}

/** Tally recipient rows by delivery status for the audit header. */
export function summarizeRecipients(
  recipients: Array<{ status?: string }> | null | undefined,
): RecipientCounts {
  const counts: RecipientCounts = { total: 0, sent: 0, pending: 0, error: 0 };
  for (const r of recipients || []) {
    counts.total += 1;
    if (r?.status === 'sent') counts.sent += 1;
    else if (r?.status === 'error') counts.error += 1;
    else counts.pending += 1;
  }
  return counts;
}

/** One-line summary sentence for the recipients audit header. */
export function summarizeRecipientCounts(
  recipients: Array<{ status?: string }> | null | undefined,
): string {
  const { total, sent, pending, error } = summarizeRecipients(recipients);
  if (total === 0) return 'No recipients recorded';
  const parts: string[] = [];
  if (sent) parts.push(`${sent} sent`);
  if (pending) parts.push(`${pending} pending`);
  if (error) parts.push(`${error} failed`);
  const noun = total === 1 ? 'recipient' : 'recipients';
  return `${total} ${noun} (${parts.join(', ')})`;
}
