/**
 * Minimal OTLP/HTTP binary-Protobuf codec for the logs export message
 * (decision LOG-INGEST). We accept `application/x-protobuf` bodies at
 * `/api/otel/v1/logs`, so we need to decode `ExportLogsServiceRequest`
 * (== `opentelemetry.proto.collector.logs.v1`) and encode the matching
 * `ExportLogsServiceResponse` for the partial-success reply.
 *
 * Rather than pull in `protobufjs` + the OTEL `.proto` bundle, this hand-rolls
 * the tiny slice of the wire format the logs message uses. The decoder walks
 * the generic wire format (varint / fixed64 / length-delimited / fixed32) and
 * projects it into the SAME object shape as OTLP/JSON — `{ resourceLogs: [...] }`
 * with `AnyValue` objects (`{ stringValue }`, `{ intValue }`, …) and hex-encoded
 * `traceId` / `spanId` — so a single normalizer downstream handles both wire
 * formats. Pure and IO-free; fully unit-tested against fixtures.
 *
 * OTLP logs proto field numbers (stable):
 *   ExportLogsServiceRequest { resource_logs = 1 }
 *   ResourceLogs { resource = 1, scope_logs = 2, schema_url = 3 }
 *   Resource { attributes = 1, dropped_attributes_count = 2 }
 *   ScopeLogs { scope = 1, log_records = 2, schema_url = 3 }
 *   InstrumentationScope { name = 1, version = 2, attributes = 3 }
 *   LogRecord { time_unix_nano = 1 (fixed64), severity_number = 2, severity_text = 3,
 *               body = 5, attributes = 6, dropped_attributes_count = 7, flags = 8 (fixed32),
 *               trace_id = 9, span_id = 10, observed_time_unix_nano = 11 (fixed64) }
 *   KeyValue { key = 1, value = 2 }
 *   AnyValue { string=1, bool=2, int=3, double=4, array=5, kvlist=6, bytes=7 }
 *   ArrayValue { values = 1 }  KeyValueList { values = 1 }
 */

const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_LEN = 2;
const WIRE_FIXED32 = 5;

interface WireField {
  wireType: number;
  varint?: bigint;
  bytes?: Buffer;
  fixed64?: Buffer;
  fixed32?: Buffer;
}

/** Thrown for a malformed protobuf body — the route maps it to 400. */
export class OtlpProtobufError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OtlpProtobufError';
  }
}

/**
 * Decode a length-delimited protobuf message into a map of field number →
 * occurrences. Repeated fields collect every occurrence in order. Bounded by
 * the buffer length, so a truncated body throws rather than looping.
 */
function decodeFields(buf: Buffer): Map<number, WireField[]> {
  const out = new Map<number, WireField[]>();
  let i = 0;
  const push = (field: number, v: WireField): void => {
    const arr = out.get(field);
    if (arr) arr.push(v);
    else out.set(field, [v]);
  };
  while (i < buf.length) {
    const [tag, next] = readVarint(buf, i);
    i = next;
    const fieldNumber = Number(tag >> 3n);
    const wireType = Number(tag & 7n);
    if (fieldNumber <= 0) throw new OtlpProtobufError('invalid field number');
    switch (wireType) {
      case WIRE_VARINT: {
        const [v, n] = readVarint(buf, i);
        i = n;
        push(fieldNumber, { wireType, varint: v });
        break;
      }
      case WIRE_FIXED64: {
        if (i + 8 > buf.length) throw new OtlpProtobufError('truncated fixed64');
        push(fieldNumber, { wireType, fixed64: buf.subarray(i, i + 8) });
        i += 8;
        break;
      }
      case WIRE_LEN: {
        const [len, n] = readVarint(buf, i);
        i = n;
        const end = i + Number(len);
        if (end > buf.length) throw new OtlpProtobufError('truncated length-delimited field');
        push(fieldNumber, { wireType, bytes: buf.subarray(i, end) });
        i = end;
        break;
      }
      case WIRE_FIXED32: {
        if (i + 4 > buf.length) throw new OtlpProtobufError('truncated fixed32');
        push(fieldNumber, { wireType, fixed32: buf.subarray(i, i + 4) });
        i += 4;
        break;
      }
      default:
        throw new OtlpProtobufError(`unsupported wire type ${wireType}`);
    }
  }
  return out;
}

/** Read a base-128 varint at `offset`, returning [value, nextOffset]. */
function readVarint(buf: Buffer, offset: number): [bigint, number] {
  let result = 0n;
  let shift = 0n;
  let i = offset;
  while (i < buf.length) {
    const byte = buf[i]!;
    result |= BigInt(byte & 0x7f) << shift;
    i++;
    if ((byte & 0x80) === 0) return [result, i];
    shift += 7n;
    if (shift > 63n) throw new OtlpProtobufError('varint too long');
  }
  throw new OtlpProtobufError('truncated varint');
}

function first(fields: Map<number, WireField[]>, n: number): WireField | undefined {
  return fields.get(n)?.[0];
}
function all(fields: Map<number, WireField[]>, n: number): WireField[] {
  return fields.get(n) ?? [];
}
function bytesOf(f: WireField | undefined): Buffer | undefined {
  return f?.bytes;
}
function stringOf(f: WireField | undefined): string | undefined {
  return f?.bytes ? f.bytes.toString('utf8') : undefined;
}
/**
 * Little-endian unsigned 64-bit → Number. Real Unix-nanosecond timestamps are
 * above Number.MAX_SAFE_INTEGER, so sub-microsecond bits may round. Retention
 * cutoffs are millisecond-derived, but exact nanosecond ordering is unavailable
 * across the current number-typed store/query path; preserving that would need
 * an end-to-end bigint/string representation (SQLite itself can hold int64).
 */
function u64ToNumber(f: WireField | undefined): number | undefined {
  if (!f?.fixed64) return undefined;
  return Number(f.fixed64.readBigUInt64LE(0));
}

// ─── AnyValue (JSON-equivalent projection) ──────────────────────────

/** OTLP/JSON-shaped AnyValue. Only the populated `*Value` key is present. */
export type JsonAnyValue =
  | { stringValue: string }
  | { boolValue: boolean }
  | { intValue: string }
  | { doubleValue: number }
  | { arrayValue: { values: JsonAnyValue[] } }
  | { kvlistValue: { values: Array<{ key: string; value: JsonAnyValue }> } }
  | { bytesValue: string }
  | Record<string, never>;

// The 1 MiB request cap still permits hundreds of thousands of tiny nested
// wrappers. Match the JSON/redaction path's ceiling so hostile nesting cannot
// overflow the JS stack or escape the route as an untyped RangeError/HTML 500.
const MAX_ANY_VALUE_DEPTH = 32;

function decodeAnyValue(buf: Buffer, depth = 0): JsonAnyValue {
  if (depth > MAX_ANY_VALUE_DEPTH) {
    throw new OtlpProtobufError(`AnyValue nesting exceeds ${MAX_ANY_VALUE_DEPTH} levels`);
  }
  const f = decodeFields(buf);
  const s = first(f, 1);
  if (s) return { stringValue: stringOf(s) ?? '' };
  const b = first(f, 2);
  if (b) return { boolValue: b.varint === 1n };
  const iv = first(f, 3);
  if (iv?.varint != null) return { intValue: asSignedInt64(iv.varint).toString() };
  const dv = first(f, 4);
  if (dv?.fixed64) return { doubleValue: dv.fixed64.readDoubleLE(0) };
  const av = first(f, 5);
  if (av?.bytes) {
    const inner = decodeFields(av.bytes);
    return {
      arrayValue: {
        values: all(inner, 1).map((e) => decodeAnyValue(e.bytes ?? Buffer.alloc(0), depth + 1)),
      },
    };
  }
  const kv = first(f, 6);
  if (kv?.bytes) {
    const inner = decodeFields(kv.bytes);
    return {
      kvlistValue: {
        values: all(inner, 1).map((e) => decodeKeyValue(e.bytes ?? Buffer.alloc(0), depth + 1)),
      },
    };
  }
  const byv = first(f, 7);
  if (byv?.bytes) return { bytesValue: byv.bytes.toString('base64') };
  return {};
}

/** Interpret an unsigned varint as a two's-complement signed int64. */
function asSignedInt64(v: bigint): bigint {
  return BigInt.asIntN(64, v);
}

function decodeKeyValue(buf: Buffer, valueDepth = 0): { key: string; value: JsonAnyValue } {
  const f = decodeFields(buf);
  const key = stringOf(first(f, 1)) ?? '';
  const valField = first(f, 2);
  const value = valField?.bytes ? decodeAnyValue(valField.bytes, valueDepth) : {};
  return { key, value };
}

function decodeAttributes(
  fields: Map<number, WireField[]>,
  fieldNum: number,
): Array<{ key: string; value: JsonAnyValue }> {
  return all(fields, fieldNum).map((e) => decodeKeyValue(e.bytes ?? Buffer.alloc(0)));
}

// ─── LogRecord / ResourceLogs projection ────────────────────────────

export interface JsonLogRecord {
  timeUnixNano?: number;
  observedTimeUnixNano?: number;
  severityNumber?: number;
  severityText?: string;
  body?: JsonAnyValue;
  attributes?: Array<{ key: string; value: JsonAnyValue }>;
  traceId?: string;
  spanId?: string;
}

export interface JsonScopeLogs {
  scope?: {
    name?: string;
    version?: string;
    attributes?: Array<{ key: string; value: JsonAnyValue }>;
  };
  logRecords?: JsonLogRecord[];
}

export interface JsonResourceLogs {
  resource?: { attributes?: Array<{ key: string; value: JsonAnyValue }> };
  scopeLogs?: JsonScopeLogs[];
}

export interface JsonLogsData {
  resourceLogs?: JsonResourceLogs[];
}

function decodeLogRecord(buf: Buffer): JsonLogRecord {
  const f = decodeFields(buf);
  const rec: JsonLogRecord = {};
  const t = u64ToNumber(first(f, 1));
  if (t != null) rec.timeUnixNano = t;
  const sev = first(f, 2)?.varint;
  if (sev != null) rec.severityNumber = Number(sev);
  const sevText = stringOf(first(f, 3));
  if (sevText != null) rec.severityText = sevText;
  const body = bytesOf(first(f, 5));
  if (body) rec.body = decodeAnyValue(body);
  const attrs = decodeAttributes(f, 6);
  if (attrs.length) rec.attributes = attrs;
  const traceId = bytesOf(first(f, 9));
  if (traceId && traceId.length) rec.traceId = traceId.toString('hex');
  const spanId = bytesOf(first(f, 10));
  if (spanId && spanId.length) rec.spanId = spanId.toString('hex');
  const obs = u64ToNumber(first(f, 11));
  if (obs != null) rec.observedTimeUnixNano = obs;
  return rec;
}

function decodeScopeLogs(buf: Buffer): JsonScopeLogs {
  const f = decodeFields(buf);
  const out: JsonScopeLogs = {};
  const scopeField = bytesOf(first(f, 1));
  if (scopeField) {
    const sf = decodeFields(scopeField);
    out.scope = {
      name: stringOf(first(sf, 1)),
      version: stringOf(first(sf, 2)),
      attributes: decodeAttributes(sf, 3),
    };
  }
  const records = all(f, 2).map((e) => decodeLogRecord(e.bytes ?? Buffer.alloc(0)));
  if (records.length) out.logRecords = records;
  return out;
}

function decodeResourceLogs(buf: Buffer): JsonResourceLogs {
  const f = decodeFields(buf);
  const out: JsonResourceLogs = {};
  const resField = bytesOf(first(f, 1));
  if (resField) {
    const rf = decodeFields(resField);
    out.resource = { attributes: decodeAttributes(rf, 1) };
  }
  const scopes = all(f, 2).map((e) => decodeScopeLogs(e.bytes ?? Buffer.alloc(0)));
  if (scopes.length) out.scopeLogs = scopes;
  return out;
}

/**
 * Decode an `ExportLogsServiceRequest` protobuf body into the OTLP/JSON-shaped
 * `{ resourceLogs: [...] }` object. Throws {@link OtlpProtobufError} on a
 * malformed / truncated body.
 */
export function decodeExportLogsServiceRequest(buf: Buffer): JsonLogsData {
  const f = decodeFields(buf);
  const resourceLogs = all(f, 1).map((e) => decodeResourceLogs(e.bytes ?? Buffer.alloc(0)));
  return { resourceLogs };
}

// ─── Response encoder ───────────────────────────────────────────────

function writeVarint(value: number): Buffer {
  const bytes: number[] = [];
  let v = BigInt(value);
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) byte |= 0x80;
    bytes.push(byte);
  } while (v > 0n);
  return Buffer.from(bytes);
}

function tag(fieldNumber: number, wireType: number): Buffer {
  return writeVarint((fieldNumber << 3) | wireType);
}

function lenDelimited(fieldNumber: number, payload: Buffer): Buffer {
  return Buffer.concat([tag(fieldNumber, WIRE_LEN), writeVarint(payload.length), payload]);
}

/**
 * Encode an `ExportLogsServiceResponse`. When `rejected > 0` (or an error
 * message is set) a `partial_success` submessage is emitted with the rejected
 * count and message; a fully-accepted request encodes as an empty message
 * (`Buffer` of length 0), the canonical OTLP success reply.
 *
 *   ExportLogsServiceResponse { partial_success = 1 }
 *   ExportLogsPartialSuccess  { rejected_log_records = 1 (int64), error_message = 2 }
 */
export function encodeExportLogsServiceResponse(opts: {
  rejected: number;
  errorMessage?: string;
}): Buffer {
  if (opts.rejected <= 0 && !opts.errorMessage) return Buffer.alloc(0);
  const parts: Buffer[] = [];
  if (opts.rejected > 0) {
    parts.push(tag(1, WIRE_VARINT), writeVarint(opts.rejected));
  }
  if (opts.errorMessage) {
    parts.push(lenDelimited(2, Buffer.from(opts.errorMessage, 'utf8')));
  }
  const partialSuccess = Buffer.concat(parts);
  return lenDelimited(1, partialSuccess);
}

/**
 * Encode `google.rpc.Status` for an OTLP/HTTP non-200 protobuf response.
 * OTLP requires this envelope for protocol errors rather than an
 * `ExportLogsServiceResponse` partial-success message.
 *
 *   google.rpc.Status { code = 1 (int32), message = 2 (string) }
 */
export function encodeGoogleRpcStatus(code: number, message: string): Buffer {
  const parts: Buffer[] = [tag(1, WIRE_VARINT), writeVarint(Math.max(0, Math.floor(code)))];
  if (message) parts.push(lenDelimited(2, Buffer.from(message, 'utf8')));
  return Buffer.concat(parts);
}
