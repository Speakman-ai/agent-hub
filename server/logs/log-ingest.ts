/**
 * Canonical log-ingest normalizer (decision LOG-INGEST). Both wire formats we
 * accept — OTLP/HTTP (`{ resourceLogs: [...] }`, from JSON or the protobuf
 * decoder) and the simple Agent Hub JSON batch — funnel through here into the
 * store's `LogRecordInput` shape. One place owns:
 *
 *   - projecting OTLP `AnyValue` attributes / body into plain JS,
 *   - severity number ↔ text mapping,
 *   - timestamp resolution (fall back observed → now when unset),
 *   - service / environment facet resolution (record → resource attrs → the
 *     source's configured defaults),
 *   - LOG-TRUST redaction of body + resource/scope/attribute blobs BEFORE the
 *     record is ever persisted,
 *   - and the batch cap (overflow is rejected, not silently dropped — the count
 *     surfaces in the OTLP partial-success reply).
 *
 * Pure and IO-free (identity + redaction config are passed in), so it unit-tests
 * without a DB or the network. The route calls `insertLogRecords` with the
 * returned records and adds the store's oversize rejections to `rejected`.
 */

import type { LogRecordInput } from './logs-db.js';
import { MAX_BATCH_RECORDS, SEVERITY_NUMBER } from './logs-schema.js';
import { redactStructured, type RedactionConfig } from './log-redaction.js';
import type {
  JsonAnyValue,
  JsonLogsData,
  JsonLogRecord,
  JsonResourceLogs,
} from './otlp-protobuf.js';

/** Identity + policy an ingest request resolves to (never from the body). */
export interface IngestContext {
  projectId: string;
  sourceId: string;
  /** Source's configured service_name facet default. */
  defaultServiceName?: string | null;
  /** Source's configured environment facet default. */
  defaultEnvironment?: string | null;
  redaction: RedactionConfig;
  /** Ingest wall-clock (ms). Injected for deterministic tests. */
  nowMs: number;
}

export interface NormalizeResult {
  records: LogRecordInput[];
  /** Records rejected pre-store (batch overflow). */
  rejected: number;
  /** Total secret substrings / keys masked across the batch (metric). */
  redactions: number;
}

// ─── AnyValue projection ────────────────────────────────────────────

// Match `redactStructured`'s recursion ceiling: JSON.parse can construct a
// deeply nested AnyValue tree that is still well below the request byte cap.
const MAX_ANY_VALUE_DEPTH = 32;

/** Project an OTLP/JSON AnyValue into a plain JS value (null when empty/deep). */
export function anyValueToJs(av: JsonAnyValue | undefined | null, depth = 0): unknown {
  if (depth > MAX_ANY_VALUE_DEPTH) return null;
  if (av == null || typeof av !== 'object' || Array.isArray(av)) return null;
  const o = av as Record<string, unknown>;
  if ('stringValue' in o) return o.stringValue;
  if ('boolValue' in o) return o.boolValue;
  if ('intValue' in o) {
    // OTLP/JSON encodes int64 as a string; tolerate a raw number too. This
    // canonical model and logs.db currently store numeric attributes as JS
    // numbers, so values outside Number's safe-integer range lose precision.
    // Keep this narrowing explicit until the store adopts bigint/string ints.
    const n = Number(o.intValue);
    return Number.isFinite(n) ? n : o.intValue;
  }
  if ('doubleValue' in o) return o.doubleValue;
  if ('bytesValue' in o) return o.bytesValue;
  if ('arrayValue' in o) {
    const candidate = (o.arrayValue as { values?: unknown })?.values;
    const values = Array.isArray(candidate) ? candidate : [];
    return values.map((v) => anyValueToJs(v, depth + 1));
  }
  if ('kvlistValue' in o) {
    const candidate = (o.kvlistValue as { values?: unknown })?.values;
    const values = Array.isArray(candidate) ? candidate : [];
    return kvListToObject(values, depth + 1);
  }
  return null;
}

/** Reduce an OTLP KeyValue list into a plain object. */
export function kvListToObject(kvs: unknown, valueDepth = 0): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!Array.isArray(kvs)) return out;
  for (const kv of kvs) {
    if (kv && typeof kv === 'object' && typeof (kv as { key?: unknown }).key === 'string') {
      const entry = kv as { key: string; value?: JsonAnyValue };
      out[entry.key] = anyValueToJs(entry.value, valueDepth);
    }
  }
  return out;
}

// ─── Severity mapping ───────────────────────────────────────────────

/** Base OTel severity label for a number (nearest tier floor). */
export function severityNumberToText(n: number): string | null {
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n >= SEVERITY_NUMBER.FATAL) return 'FATAL';
  if (n >= SEVERITY_NUMBER.ERROR) return 'ERROR';
  if (n >= SEVERITY_NUMBER.WARN) return 'WARN';
  if (n >= SEVERITY_NUMBER.INFO) return 'INFO';
  if (n >= SEVERITY_NUMBER.DEBUG) return 'DEBUG';
  return 'TRACE';
}

const SEVERITY_BY_TEXT: Record<string, number> = {
  TRACE: SEVERITY_NUMBER.TRACE,
  DEBUG: SEVERITY_NUMBER.DEBUG,
  INFO: SEVERITY_NUMBER.INFO,
  INFORMATION: SEVERITY_NUMBER.INFO,
  NOTICE: SEVERITY_NUMBER.INFO,
  WARN: SEVERITY_NUMBER.WARN,
  WARNING: SEVERITY_NUMBER.WARN,
  ERROR: SEVERITY_NUMBER.ERROR,
  ERR: SEVERITY_NUMBER.ERROR,
  SEVERE: SEVERITY_NUMBER.ERROR,
  FATAL: SEVERITY_NUMBER.FATAL,
  CRITICAL: SEVERITY_NUMBER.FATAL,
  CRIT: SEVERITY_NUMBER.FATAL,
  ALERT: SEVERITY_NUMBER.FATAL,
  EMERGENCY: SEVERITY_NUMBER.FATAL,
};

/** Map a free-text severity label to an OTel severity number (0 if unknown). */
export function severityTextToNumber(text: string): number {
  return SEVERITY_BY_TEXT[text.trim().toUpperCase()] ?? SEVERITY_NUMBER.UNSPECIFIED;
}

// ─── Shared helpers ─────────────────────────────────────────────────

function firstString(...vals: Array<unknown>): string | null {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
  }
  return null;
}

/** Coerce a nanosecond timestamp that may arrive as number or numeric string. */
function toNano(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

/** Stringify a body value: a string passes through; anything else is JSON. */
function bodyToString(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

interface BuiltRecord {
  timeUnixNano: number;
  observedTimeUnixNano: number | null;
  severityNumber: number;
  severityText: string | null;
  bodyValue: unknown;
  attributes: Record<string, unknown>;
  resource: Record<string, unknown>;
  scope: Record<string, unknown> | null;
  traceId: string | null;
  spanId: string | null;
}

/**
 * Redact + serialize a built record into a store `LogRecordInput`, resolving
 * facets and accumulating the redaction count. Shared by both protocols.
 */
function finalizeRecord(
  built: BuiltRecord,
  ctx: IngestContext,
  counter: { redactions: number },
): LogRecordInput {
  // Bodies can be structured AnyValues, not only strings. Redact recursively
  // BEFORE JSON serialization so sensitive keys such as `{ password: ... }`
  // are masked; a text-only pass over the serialized JSON misses quoted keys.
  const bodyR = redactStructured(built.bodyValue, ctx.redaction);
  counter.redactions += bodyR.redactions;
  const body = bodyToString(bodyR.value);

  const attrsR = redactStructured(built.attributes, ctx.redaction);
  counter.redactions += attrsR.redactions;
  const resourceR = redactStructured(built.resource, ctx.redaction);
  counter.redactions += resourceR.redactions;
  const scopeR = built.scope ? redactStructured(built.scope, ctx.redaction) : null;
  if (scopeR) counter.redactions += scopeR.redactions;

  const attributes = attrsR.value as Record<string, unknown>;
  const resource = resourceR.value as Record<string, unknown>;

  const serviceName = firstString(
    (attributes as Record<string, unknown>)['service.name'],
    (resource as Record<string, unknown>)['service.name'],
    ctx.defaultServiceName,
  );
  const environment = firstString(
    (attributes as Record<string, unknown>)['deployment.environment.name'],
    (attributes as Record<string, unknown>)['deployment.environment'],
    (resource as Record<string, unknown>)['deployment.environment.name'],
    (resource as Record<string, unknown>)['deployment.environment'],
    ctx.defaultEnvironment,
  );

  return {
    projectId: ctx.projectId,
    sourceId: ctx.sourceId,
    timeUnixNano: built.timeUnixNano,
    observedTimeUnixNano: built.observedTimeUnixNano,
    severityNumber: built.severityNumber,
    severityText: built.severityText,
    body,
    serviceName,
    environment,
    traceId: built.traceId,
    spanId: built.spanId,
    fingerprint: null,
    resourceJson: Object.keys(resource).length ? JSON.stringify(resource) : null,
    attributesJson: Object.keys(attributes).length ? JSON.stringify(attributes) : null,
    scopeJson:
      scopeR && Object.keys(scopeR.value as object).length ? JSON.stringify(scopeR.value) : null,
  };
}

/** Cap the built records to the batch limit, counting the overflow as rejected. */
function capBatch(built: BuiltRecord[]): { kept: BuiltRecord[]; rejected: number } {
  if (built.length <= MAX_BATCH_RECORDS) return { kept: built, rejected: 0 };
  return { kept: built.slice(0, MAX_BATCH_RECORDS), rejected: built.length - MAX_BATCH_RECORDS };
}

// ─── OTLP normalization ─────────────────────────────────────────────

function resolveSeverity(
  severityNumber: unknown,
  severityText: unknown,
): { number: number; text: string | null } {
  const text = typeof severityText === 'string' && severityText.trim() ? severityText.trim() : null;
  let number =
    typeof severityNumber === 'number' && Number.isFinite(severityNumber) ? severityNumber : 0;
  if (number <= 0 && text) number = severityTextToNumber(text);
  return { number, text: text ?? severityNumberToText(number) };
}

function buildOtlpRecord(
  rec: JsonLogRecord,
  resourceAttrs: Record<string, unknown>,
  scope: Record<string, unknown> | null,
  ctx: IngestContext,
): BuiltRecord {
  // Number cannot retain exact sub-microsecond bits at Unix-nanosecond scale;
  // retention/query cutoffs remain millisecond-derived (see u64ToNumber).
  const nowNano = ctx.nowMs * 1_000_000;
  const time = toNano(rec.timeUnixNano) ?? toNano(rec.observedTimeUnixNano) ?? nowNano;
  const observed = toNano(rec.observedTimeUnixNano) ?? nowNano;
  const sev = resolveSeverity(rec.severityNumber, rec.severityText);
  return {
    timeUnixNano: time,
    observedTimeUnixNano: observed,
    severityNumber: sev.number,
    severityText: sev.text,
    bodyValue: anyValueToJs(rec.body),
    attributes: kvListToObject(rec.attributes),
    resource: resourceAttrs,
    scope,
    traceId: firstString(rec.traceId),
    spanId: firstString(rec.spanId),
  };
}

/**
 * Normalize an OTLP LogsData tree (from JSON or the protobuf decoder) into
 * store records. Malformed sub-trees are skipped defensively rather than
 * failing the whole request.
 */
export function normalizeOtlpLogsData(data: JsonLogsData, ctx: IngestContext): NormalizeResult {
  const built: BuiltRecord[] = [];
  const resourceLogs = Array.isArray(data?.resourceLogs) ? data.resourceLogs : [];
  for (const candidateRl of resourceLogs) {
    if (!candidateRl || typeof candidateRl !== 'object' || Array.isArray(candidateRl)) continue;
    const rl = candidateRl as JsonResourceLogs;
    const resourceAttrs = kvListToObject(rl.resource?.attributes);
    const scopeLogs = Array.isArray(rl.scopeLogs) ? rl.scopeLogs : [];
    for (const candidateSl of scopeLogs) {
      if (!candidateSl || typeof candidateSl !== 'object' || Array.isArray(candidateSl)) continue;
      const sl = candidateSl;
      const scope =
        sl.scope &&
        typeof sl.scope === 'object' &&
        (sl.scope.name || sl.scope.version || sl.scope.attributes?.length)
          ? {
              ...(sl.scope.name ? { name: sl.scope.name } : {}),
              ...(sl.scope.version ? { version: sl.scope.version } : {}),
              ...(sl.scope.attributes?.length
                ? { attributes: kvListToObject(sl.scope.attributes) }
                : {}),
            }
          : null;
      const logRecords = Array.isArray(sl.logRecords) ? sl.logRecords : [];
      for (const candidateRec of logRecords) {
        if (!candidateRec || typeof candidateRec !== 'object' || Array.isArray(candidateRec)) {
          continue;
        }
        built.push(buildOtlpRecord(candidateRec as JsonLogRecord, resourceAttrs, scope, ctx));
      }
    }
  }
  const { kept, rejected } = capBatch(built);
  const counter = { redactions: 0 };
  const records = kept.map((b) => finalizeRecord(b, ctx, counter));
  return { records, rejected, redactions: counter.redactions };
}

// ─── Agent Hub JSON batch normalization ─────────────────────────────

export interface AhLogRecordInput {
  timeUnixNano?: number | string;
  timeUnixMillis?: number;
  observedTimeUnixNano?: number | string;
  severityNumber?: number;
  severityText?: string;
  severity?: string;
  body?: unknown;
  message?: unknown;
  attributes?: Record<string, unknown>;
  resource?: Record<string, unknown>;
  scope?: Record<string, unknown>;
  traceId?: string;
  spanId?: string;
  service?: string;
  environment?: string;
}

export interface AhLogBatch {
  /** Batch-level resource attributes merged under each record's own. */
  resource?: Record<string, unknown>;
  records: AhLogRecordInput[];
}

function buildAhRecord(
  rec: AhLogRecordInput,
  batchResource: Record<string, unknown>,
  ctx: IngestContext,
): BuiltRecord {
  // Number cannot retain exact sub-microsecond bits at Unix-nanosecond scale;
  // retention/query cutoffs remain millisecond-derived (see u64ToNumber).
  const nowNano = ctx.nowMs * 1_000_000;
  const time =
    toNano(rec.timeUnixNano) ??
    (typeof rec.timeUnixMillis === 'number' && rec.timeUnixMillis > 0
      ? rec.timeUnixMillis * 1_000_000
      : null) ??
    toNano(rec.observedTimeUnixNano) ??
    nowNano;
  const observed = toNano(rec.observedTimeUnixNano) ?? nowNano;
  const sev = resolveSeverity(rec.severityNumber, rec.severityText ?? rec.severity);

  const attributes: Record<string, unknown> = {
    ...(rec.attributes && typeof rec.attributes === 'object' ? rec.attributes : {}),
  };
  if (rec.service && !('service.name' in attributes)) attributes['service.name'] = rec.service;
  if (rec.environment && !('deployment.environment' in attributes)) {
    attributes['deployment.environment'] = rec.environment;
  }

  const resource: Record<string, unknown> = {
    ...(batchResource || {}),
    ...(rec.resource && typeof rec.resource === 'object' ? rec.resource : {}),
  };

  return {
    timeUnixNano: time,
    observedTimeUnixNano: observed,
    severityNumber: sev.number,
    severityText: sev.text,
    bodyValue: rec.body ?? rec.message ?? null,
    attributes,
    resource,
    scope: rec.scope && typeof rec.scope === 'object' ? rec.scope : null,
    traceId: firstString(rec.traceId),
    spanId: firstString(rec.spanId),
  };
}

/**
 * Normalize an Agent Hub JSON batch (`{ resource?, records: [...] }`) into store
 * records, applying the same canonical model, facet resolution, and redaction
 * as the OTLP path.
 */
export function normalizeAhBatch(batch: AhLogBatch, ctx: IngestContext): NormalizeResult {
  const batchResource = batch.resource && typeof batch.resource === 'object' ? batch.resource : {};
  const built = (batch.records ?? []).map((r) => buildAhRecord(r, batchResource, ctx));
  const { kept, rejected } = capBatch(built);
  const counter = { redactions: 0 };
  const records = kept.map((b) => finalizeRecord(b, ctx, counter));
  return { records, rejected, redactions: counter.redactions };
}
