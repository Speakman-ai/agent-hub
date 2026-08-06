/** Fan-out for one persisted infrastructure alert state transition. */
import { listReleaseDigestRecipients } from '../release-notification-settings.js';
import { enqueueInfraAlertEmail } from './alert-outbox.js';
import { resolveInfraAlertRouting } from './alert-routing-store.js';
import {
  DEFAULT_INFRA_ALERT_CHANNELS,
  INFRA_ALERT_CHANNELS,
  type InfraAlertChannel,
  type InfraAlertSeverity,
} from './infra-schema.js';

export interface InfraAlertTransitionNotification {
  projectId: string;
  alertId: string;
  transitionKey: string;
  severity: InfraAlertSeverity;
  resourceId: string;
  ruleName: string;
  metricName: string;
  fromState: string;
  toState: string;
  reason: string | null;
  value: number | null;
  broadcast: Record<string, unknown>;
}

export interface InfraAlertNotificationResult {
  broadcast: boolean;
  emailsQueued: number;
  /** Email recipients whose outbox enqueue failed and need recovery. */
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

function subject(input: InfraAlertTransitionNotification): string {
  return `[${input.severity}] Infrastructure alert: ${input.ruleName}`;
}

function body(input: InfraAlertTransitionNotification): string {
  return [
    `Infrastructure alert transitioned from ${input.fromState} to ${input.toState}.`,
    `Rule: ${input.ruleName}`,
    `Metric: ${input.metricName}`,
    `Resource: ${input.resourceId}`,
    `Reason: ${input.reason ?? 'state transition'}`,
    `Value: ${input.value == null ? 'unavailable' : input.value}`,
  ].join('\n');
}

/**
 * Apply the resolved channel policy. The broadcast payload is already a safe
 * projection; this function never adds account ids, credentials, or email
 * addresses to it.
 */
export function notifyInfraAlertTransition(
  input: InfraAlertTransitionNotification,
): InfraAlertNotificationResult {
  let channels: Record<InfraAlertChannel, boolean>;
  try {
    channels = resolveInfraAlertRouting(input.projectId, input.severity).channels;
  } catch {
    // A persisted transition must still reach connected clients if the
    // routing store is temporarily unavailable. Fall back to the same safe
    // severity defaults used when no override row exists.
    channels = defaultChannels(input.severity);
  }
  const inApp = channels.in_app;
  const push = channels.push;
  let broadcasted = false;

  if (inApp || push) {
    input.broadcast.suppressPush = !push;
    // This flag is consumed only by the WS transport. It allows push-only
    // routing without exposing an event to connected browser clients.
    input.broadcast.suppressWebSocket = !inApp;
    input.broadcast.broadcastChannel = 'infra_alert';
    // The caller owns the actual broadcast so persistence and delivery remain
    // decoupled from the notification policy.
    broadcasted = true;
  }

  let emailsQueued = 0;
  let emailEnqueueFailures = 0;
  if (channels.email) {
    let recipients: Array<{ email: string; enabled: boolean }> = [];
    try {
      recipients = listReleaseDigestRecipients(input.projectId);
    } catch {
      // The main DB may not be initialized in a hermetic infra worker. Email
      // delivery is best effort at enqueue time; the outbox itself is durable.
      emailEnqueueFailures += 1;
    }
    for (const recipient of recipients) {
      if (!recipient.enabled) continue;
      try {
        enqueueInfraAlertEmail({
          projectId: input.projectId,
          alertId: input.alertId,
          severity: input.severity,
          transitionKey: input.transitionKey,
          recipientEmail: recipient.email,
          subject: subject(input),
          bodyText: body(input),
        });
        emailsQueued += 1;
      } catch {
        // Email enqueueing is independent from the in-app and push fan-out.
        // A transient outbox/database failure for one recipient must not
        // suppress the other recipients or the already-resolved broadcast.
        emailEnqueueFailures += 1;
      }
    }
  }
  return { broadcast: broadcasted, emailsQueued, emailEnqueueFailures };
}

/** True when a channel is one of the supported routing keys. */
export function isInfraAlertChannel(value: string): value is InfraAlertChannel {
  return value === 'in_app' || value === 'push' || value === 'email';
}
