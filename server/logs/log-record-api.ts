/** Wire representation shared by the REST query and WebSocket live tail. */
import type { LogRecordRow } from './logs-db.js';

export function serializeLogRecord(row: LogRecordRow): Record<string, unknown> {
  return {
    id: row.id,
    projectId: row.project_id,
    sourceId: row.source_id,
    timeUnixNano: row.time_unix_nano,
    observedTimeUnixNano: row.observed_time_unix_nano,
    severityNumber: row.severity_number,
    severityText: row.severity_text,
    body: row.body,
    serviceName: row.service_name,
    environment: row.environment,
    traceId: row.trace_id,
    spanId: row.span_id,
    fingerprint: row.fingerprint,
    resourceJson: row.resource_json,
    attributesJson: row.attributes_json,
    scopeJson: row.scope_json,
    byteSize: row.byte_size,
    ingestedAt: row.ingested_at,
  };
}
