/**
 * INFRA-NOTIFY fan-out for an ingested AWS Health event.
 *
 * Deliberately reuses the alert routing table, the alert email outbox, and the
 * existing `infra_alert` push type rather than introducing a parallel set:
 *
 *   - Routing: `infra_alert_routing` is keyed (project, severity, channel), and
 *     a Health event resolves to a severity like any other infra signal. An
 *     operator who muted `info` on push meant it for both.
 *   - Email: `infra_alert_outbox` is a generic (project, severity, key,
 *     recipient, subject, body) queue — `alert_id` carries no foreign key and
 *     the worker never joins back to `infra_alerts`. Reusing it inherits the
 *     idempotency-key dedupe and the 5/15/60/240-minute retry backoff for free.
 *   - Push: reusing the `infra_alert` push event type means per-token opt-in
 *     works with no mobile settings change, exactly as INFRA-NOTIFY intends.
 *
 * The idempotency key is `health:<eventArn>:<communicationId>`, which makes the
 * outbox's existing `UNIQUE (transition_key, recipient_email)` a second line of
 * defence against at-least-once delivery — even if a duplicate somehow reached
 * this function, it could not enqueue a second email.
 */
import { listReleaseDigestRecipients } from '../release-notification-settings.js';
import { enqueueInfraAlertEmail } from './alert-outbox.js';
import { resolveInfraAlertRouting } from './alert-routing-store.js';
import type { InfraHealthEventRow } from './health-event-store.js';
import {
  DEFAULT_INFRA_ALERT_CHANNELS,
  INFRA_ALERT_CHANNELS,
  type InfraAlertChannel,
  type InfraAlertSeverity,
} from './infra-schema.js';

export interface InfraHealthNotificationResult {
  broadcast: boolean;
  emailsQueued: number;
  emailEnqueueFailures: number;
}

function defaultChannels(severity: InfraAlertSeverity): Record<InfraAlertChannel, boolean> {
  return Object.fromEntries(
    INFRA_ALERT_CHANNELS.map((channel) => [
      channel,
      DEFAULT_INFRA_ALERT_CHANNELS[severity].includes(channel),
    ]),
  ) as Record<InfraAlertChannel, boolean>;
}

/** Stable per-communication key; see the module docblock. */
export function healthNotificationKey(row: InfraHealthEventRow): string {
  return `health:${row.event_arn}:${row.communication_id}`;
}

/** Human-facing one-liner shared by the push body and the email subject. */
export function healthEventHeadline(row: InfraHealthEventRow): string {
  const service = row.service ?? 'AWS';
  const region = row.event_region ?? row.delivery_region;
  return `${service} ${row.event_type_code} (${region})`;
}

/**
 * Safe projection broadcast to every connected client of the project.
 *
 * INFRA-NOTIFY's hard constraint: WS events fan out project-wide, so this
 * carries resource identifiers only. The AWS account id — both the delivering
 * account and `affectedAccount` — is deliberately absent.
 */
export function buildHealthEventBroadcast(row: InfraHealthEventRow): Record<string, unknown> {
  return {
    type: 'infra_health_event',
    projectId: row.project_id,
    healthEventId: row.id,
    eventArn: row.event_arn,
    severity: row.severity,
    service: row.service,
    region: row.event_region ?? row.delivery_region,
    eventTypeCode: row.event_type_code,
    eventTypeCategory: row.event_type_category,
    eventScopeCode: row.event_scope_code,
    statusCode: row.status_code,
    headline: healthEventHeadline(row),
    startTime: row.start_time_ms,
    endTime: row.end_time_ms,
    affectedEntityCount: row.affected_entity_count,
    receivedAt: row.received_at_ms,
  };
}

function subject(row: InfraHealthEventRow): string {
  return `[${row.severity}] AWS Health: ${healthEventHeadline(row)}`;
}

function body(row: InfraHealthEventRow): string {
  const lines = [
    `AWS Health reported a ${row.event_type_category} event.`,
    `Event: ${row.event_type_code}`,
    `Service: ${row.service ?? 'unknown'}`,
    `Region: ${row.event_region ?? row.delivery_region}`,
    `Status: ${row.status_code ?? 'unknown'}`,
    `Scope: ${row.event_scope_code ?? 'unknown'}`,
  ];
  if (row.affected_entity_count > 0) {
    lines.push(`Affected entities: ${row.affected_entity_count}`);
  }
  if (row.description) lines.push('', row.description);
  return lines.join('\n');
}

/**
 * Apply the resolved channel policy to one newly-ingested Health event.
 *
 * Like `notifyInfraAlertTransition`, this does not send the broadcast itself —
 * it stamps the routing flags the WS and push transports read and hands the
 * payload back, so persistence stays decoupled from delivery.
 */
export function notifyInfraHealthEvent(
  row: InfraHealthEventRow,
  broadcastPayload: Record<string, unknown>,
): InfraHealthNotificationResult {
  let channels: Record<InfraAlertChannel, boolean>;
  try {
    channels = resolveInfraAlertRouting(row.project_id, row.severity).channels;
  } catch {
    // An ingested event must still reach connected clients if the routing
    // store is briefly unavailable; fall back to the severity defaults.
    channels = defaultChannels(row.severity);
  }

  let broadcasted = false;
  if (channels.in_app || channels.push) {
    broadcastPayload.suppressPush = !channels.push;
    broadcastPayload.suppressWebSocket = !channels.in_app;
    broadcastPayload.broadcastChannel = 'infra_alert';
    broadcasted = true;
  }

  let emailsQueued = 0;
  let emailEnqueueFailures = 0;
  if (channels.email) {
    let recipients: Array<{ email: string; enabled: boolean }> = [];
    try {
      recipients = listReleaseDigestRecipients(row.project_id);
    } catch {
      // The main DB may not be initialized in a hermetic infra worker.
      emailEnqueueFailures += 1;
    }
    for (const recipient of recipients) {
      if (!recipient.enabled) continue;
      try {
        enqueueInfraAlertEmail({
          projectId: row.project_id,
          // No FK: this column is an opaque correlation id, and pointing it at
          // the health event row keeps the outbox entry traceable.
          alertId: row.id,
          severity: row.severity,
          transitionKey: healthNotificationKey(row),
          recipientEmail: recipient.email,
          subject: subject(row),
          bodyText: body(row),
        });
        emailsQueued += 1;
      } catch {
        // One bad recipient must not suppress the others or the broadcast.
        emailEnqueueFailures += 1;
      }
    }
  }

  return { broadcast: broadcasted, emailsQueued, emailEnqueueFailures };
}
