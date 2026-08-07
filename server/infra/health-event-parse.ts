/**
 * Pure normalizer for AWS Health events delivered over Amazon EventBridge.
 *
 * WHY EVENTBRIDGE AND NOT `DescribeEvents`
 * ----------------------------------------
 * The AWS Health API is gated on a Business Support+ / Enterprise / Unified
 * Operations plan and returns `SubscriptionRequiredException` to any account
 * without one. EventBridge delivery of the same events is documented as
 * available to *all* AWS customers at no additional cost. So the ingest path
 * is the broadly-usable one, and it is the only one a Basic- or Developer-tier
 * account can use at all.
 *
 * The load-bearing consequence: an account on a lesser support plan cannot
 * call `DescribeEvents` to backfill or re-fetch an event by ARN. **The
 * EventBridge payload must be self-sufficient** — this module never assumes a
 * follow-up lookup is possible. `DescribeEvents` remains available as a later,
 * optional enrichment for Business Support+ accounts behind capability
 * detection; nothing here depends on it.
 *
 * The rule lives in the OPERATOR's account (see
 * `docs/guides/aws-health-eventbridge.md`). The Hub creates nothing in the
 * monitored account, which keeps INFRA-CRED's read-only posture intact.
 *
 * DEFENSIVE PARSING IS NOT OPTIONAL HERE
 * --------------------------------------
 * The AWS docs disagree with themselves in ways this module has to absorb:
 *   - `lastUpdatedTime` is marked "Required: Yes" but is absent from several of
 *     AWS's own published examples.
 *   - The affected-entity timestamp is `lastUpdatedtime` (lowercase t) in the
 *     schema table and `lastUpdatedTime` in every example.
 *   - `personas` is documented as `OPERATIONAL` in the schema table and
 *     `OPERATIONS` everywhere else.
 *   - Timestamps inside `detail` are RFC-1123 strings ("Thu, 27 Aug 2026
 *     13:19:03 GMT"), NOT ISO-8601. Only the envelope `time` is ISO-8601.
 *   - `page`, `totalPages` and `backupEvent` arrive as STRINGS ("1", "false").
 *
 * A field this module cannot understand degrades to null. It rejects only when
 * the payload is not identifiably a Health event or lacks the identity needed
 * to dedupe it, because a dropped event is invisible to the operator while a
 * partially-parsed one still shows up on the timeline.
 */
import {
  INFRA_HEALTH_ABUSE_DETAIL_TYPE,
  INFRA_HEALTH_CATEGORY_SEVERITY,
  INFRA_HEALTH_DETAIL_TYPE,
  MAX_INFRA_HEALTH_AFFECTED_ENTITIES,
  MAX_INFRA_HEALTH_DESCRIPTION_CHARS,
  type InfraAlertSeverity,
} from './infra-schema.js';

/** Envelope `source` that identifies a Health event. */
export const AWS_HEALTH_EVENT_SOURCE = 'aws.health';

/**
 * Largest batch accepted in one ingest request.
 *
 * An EventBridge API destination delivers one event per invocation, so the
 * normal batch size is 1. The array form exists for operators who front the
 * endpoint with a Lambda or Firehose that coalesces; the cap keeps a
 * misconfigured fan-in from turning one request into an unbounded write.
 */
export const MAX_HEALTH_EVENT_BATCH = 100;

/** One affected entity, projected down to the fields the timeline renders. */
export interface HealthAffectedEntity {
  entityValue: string;
  status: string | null;
  lastUpdatedMs: number | null;
}

/** A Health communication, normalized and ready to persist. */
export interface ParsedHealthEvent {
  eventArn: string;
  communicationId: string;
  affectedAccount: string;
  accountId: string;
  deliveryRegion: string;
  eventRegion: string | null;
  detailType: string;
  service: string | null;
  eventTypeCode: string;
  eventTypeCategory: string;
  eventScopeCode: string | null;
  statusCode: string | null;
  severity: InfraAlertSeverity;
  startTimeMs: number | null;
  endTimeMs: number | null;
  lastUpdatedMs: number | null;
  description: string | null;
  affectedEntities: HealthAffectedEntity[];
  affectedEntityCount: number;
  backupEvent: boolean;
  page: number;
  totalPages: number;
  eventTimeMs: number | null;
}

export type HealthEventRejectionReason =
  | 'not-an-object'
  | 'wrong-source'
  | 'wrong-detail-type'
  | 'missing-detail'
  | 'missing-event-arn'
  | 'missing-communication-id'
  | 'missing-account'
  | 'missing-event-type-code';

export type ParseHealthEventResult =
  | { ok: true; event: ParsedHealthEvent }
  | { ok: false; reason: HealthEventRejectionReason };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Parse a timestamp AWS may express in either format.
 *
 * `Date.parse` handles RFC-1123 and ISO-8601 alike, so the work here is
 * rejecting what it accepts too liberally: a bare number would be read as a
 * year, and `Date.parse` returns NaN rather than throwing on garbage.
 */
function timeMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Health never sends epoch numbers, but a transformer in front of the
    // endpoint might. Treat it as ms epoch rather than discarding it.
    return Math.trunc(value);
  }
  const raw = str(value);
  if (!raw) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * AWS delivers `page`, `totalPages` and similar as strings. A value that is
 * absent or unparseable falls back rather than failing the event, since
 * pagination only applies to events large enough to exceed 256 KB.
 */
function positiveInt(value: unknown, fallback: number): number {
  const raw = typeof value === 'number' ? value : Number(str(value) ?? NaN);
  if (!Number.isFinite(raw)) return fallback;
  const truncated = Math.trunc(raw);
  return truncated >= 1 ? truncated : fallback;
}

/** `backupEvent` is the string "true"/"false", not a boolean. */
function looseBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  const raw = str(value);
  return raw != null && raw.toLowerCase() === 'true';
}

/**
 * Severity used for INFRA-NOTIFY routing.
 *
 * An event AWS has already closed is a timeline entry, not a page — it is
 * downgraded to `info` whatever its category, so an outage that resolved
 * overnight does not wake anyone at the moment it is confirmed fixed. An
 * unrecognized category is `warning`: quiet enough not to page on something we
 * do not understand, loud enough not to be silently swallowed.
 */
export function healthEventSeverity(
  category: string,
  statusCode: string | null,
  detailType: string,
): InfraAlertSeverity {
  // Abuse notices are account-security events. They outrank the status
  // downgrade: a closed abuse notice still needs a human to have seen it.
  if (detailType === INFRA_HEALTH_ABUSE_DETAIL_TYPE) return 'critical';
  if (statusCode === 'closed') return 'info';
  const mapped = (INFRA_HEALTH_CATEGORY_SEVERITY as Record<string, InfraAlertSeverity | undefined>)[
    category
  ];
  return mapped ?? 'warning';
}

/** The en_US description, or the first one offered if AWS sends no en_US. */
function pickDescription(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const entries = value.filter(isRecord);
  const preferred =
    entries.find((entry) => str(entry.language)?.toLowerCase().startsWith('en')) ?? entries[0];
  const text = preferred ? str(preferred.latestDescription) : null;
  if (!text) return null;
  return text.length > MAX_INFRA_HEALTH_DESCRIPTION_CHARS
    ? `${text.slice(0, MAX_INFRA_HEALTH_DESCRIPTION_CHARS - 1)}…`
    : text;
}

function parseEntities(value: unknown): { entities: HealthAffectedEntity[]; total: number } {
  if (!Array.isArray(value)) return { entities: [], total: 0 };
  const usable = value.filter(isRecord);
  const entities: HealthAffectedEntity[] = [];
  for (const entry of usable) {
    if (entities.length >= MAX_INFRA_HEALTH_AFFECTED_ENTITIES) break;
    const entityValue = str(entry.entityValue);
    if (!entityValue) continue;
    entities.push({
      entityValue,
      status: str(entry.status),
      // Schema table says `lastUpdatedtime`, every example says
      // `lastUpdatedTime`. Accept both rather than betting on which is current.
      lastUpdatedMs: timeMs(entry.lastUpdatedTime ?? entry.lastUpdatedtime),
    });
  }
  return { entities, total: usable.length };
}

/**
 * Normalize one EventBridge envelope.
 *
 * Rejects anything whose `source` is not exactly `aws.health`. That check is
 * the code-side mirror of the rule the operator writes: AWS documents in an
 * explicit callout that a rule must use `"source": ["aws.health"]` and that
 * wildcards such as `"source": ["aws.health*"]` will never match. A rule that
 * silently matches nothing is the most likely setup failure, so the ingest
 * endpoint reports a wrong-source payload rather than absorbing it.
 *
 * It also rejects `detail-type: "AWS API Call via CloudTrail"`, which shares
 * the `aws.health` source but describes someone CALLING the Health API rather
 * than a health event — a broad source-only rule in the operator's account
 * will catch those, and they are not timeline entries.
 */
export function parseHealthEvent(input: unknown): ParseHealthEventResult {
  if (!isRecord(input)) return { ok: false, reason: 'not-an-object' };

  if (str(input.source) !== AWS_HEALTH_EVENT_SOURCE) {
    return { ok: false, reason: 'wrong-source' };
  }

  const detailType = str(input['detail-type']);
  if (detailType !== INFRA_HEALTH_DETAIL_TYPE && detailType !== INFRA_HEALTH_ABUSE_DETAIL_TYPE) {
    return { ok: false, reason: 'wrong-detail-type' };
  }

  const detail = input.detail;
  if (!isRecord(detail)) return { ok: false, reason: 'missing-detail' };

  const eventArn = str(detail.eventArn);
  if (!eventArn) return { ok: false, reason: 'missing-event-arn' };

  // Without a communicationId there is no dedupe key, and at-least-once
  // delivery would make every redelivery a new timeline row.
  const communicationId = str(detail.communicationId);
  if (!communicationId) return { ok: false, reason: 'missing-communication-id' };

  const accountId = str(input.account);
  if (!accountId) return { ok: false, reason: 'missing-account' };

  const eventTypeCode = str(detail.eventTypeCode);
  if (!eventTypeCode) return { ok: false, reason: 'missing-event-type-code' };

  const statusCode = str(detail.statusCode);
  // An absent category resolves to the same `warning` severity as an
  // unrecognized one rather than defaulting to the quietest category. Guessing
  // `accountNotification` here would silently downgrade an event we simply
  // failed to classify, which is the one direction this mapping must not err in.
  const eventTypeCategory = str(detail.eventTypeCategory) ?? 'unknown';
  const { entities, total } = parseEntities(detail.affectedEntities);

  return {
    ok: true,
    event: {
      eventArn,
      communicationId,
      // Defaulted, never null: SQLite treats NULLs as distinct in a UNIQUE
      // constraint, so a null here would silently defeat the dedupe.
      affectedAccount: str(detail.affectedAccount) ?? accountId,
      accountId,
      deliveryRegion: str(input.region) ?? 'unknown',
      eventRegion: str(detail.eventRegion),
      detailType,
      service: str(detail.service),
      eventTypeCode,
      eventTypeCategory,
      eventScopeCode: str(detail.eventScopeCode),
      statusCode,
      severity: healthEventSeverity(eventTypeCategory, statusCode, detailType),
      startTimeMs: timeMs(detail.startTime),
      endTimeMs: timeMs(detail.endTime),
      lastUpdatedMs: timeMs(detail.lastUpdatedTime),
      description: pickDescription(detail.eventDescription),
      affectedEntities: entities,
      affectedEntityCount: total,
      backupEvent: looseBoolean(detail.backupEvent),
      page: positiveInt(detail.page, 1),
      totalPages: positiveInt(detail.totalPages, 1),
      eventTimeMs: timeMs(input.time),
    },
  };
}

export interface ParsedHealthBatch {
  events: ParsedHealthEvent[];
  /** Payloads that were not usable Health events, with why. */
  rejected: { index: number; reason: HealthEventRejectionReason }[];
  /** Entries dropped because the batch exceeded {@link MAX_HEALTH_EVENT_BATCH}. */
  overflow: number;
}

/**
 * Normalize a request body, which is either a single EventBridge envelope (the
 * API-destination default) or an array of them.
 */
export function parseHealthEventBatch(body: unknown): ParsedHealthBatch {
  const raw = Array.isArray(body) ? body : [body];
  const accepted = raw.slice(0, MAX_HEALTH_EVENT_BATCH);
  const events: ParsedHealthEvent[] = [];
  const rejected: { index: number; reason: HealthEventRejectionReason }[] = [];

  accepted.forEach((entry, index) => {
    const result = parseHealthEvent(entry);
    if (result.ok) events.push(result.event);
    else rejected.push({ index, reason: result.reason });
  });

  return { events, rejected, overflow: Math.max(0, raw.length - accepted.length) };
}
