/**
 * One log record row (shared by the Live tail and Issue sample lists).
 *
 * SECURITY (LOG-TRUST): every field here originates from an untrusted ingested
 * record. It is rendered exclusively as text nodes / `whitespace-pre-wrap`
 * content — never via `dangerouslySetInnerHTML` — so embedded markup can never
 * execute. Body and stack traces keep their newlines/indentation.
 */
import { useState } from 'react';
import { ChevronRight, ChevronDown } from 'lucide-react';
import { formatDateTime } from '../../utils/time';
import {
  severityLabel,
  severityTone,
  nanoToMillis,
  parseAttributes,
  extractStackTrace,
  type LogRecord,
} from '../../utils/logStream';

interface LogRecordRowProps {
  record: LogRecord;
}

export default function LogRecordRow({ record }: LogRecordRowProps): React.ReactElement {
  const [expanded, setExpanded] = useState(false);
  const attributes = expanded ? parseAttributes(record.attributesJson) : [];
  const resource = expanded ? parseAttributes(record.resourceJson) : [];
  const stack = expanded ? extractStackTrace(record.attributesJson) : null;
  const label = severityLabel(record.severityNumber, record.severityText);
  const hasDetail =
    Boolean(record.attributesJson) ||
    Boolean(record.resourceJson) ||
    Boolean(record.traceId) ||
    Boolean(record.spanId);

  return (
    <div className="border-b border-gray-800 text-xs font-mono">
      <button
        type="button"
        onClick={() => hasDetail && setExpanded((v) => !v)}
        className={`flex w-full items-start gap-2 px-2 py-1.5 text-left ${
          hasDetail ? 'hover:bg-gray-800/40 cursor-pointer' : 'cursor-default'
        }`}
        aria-expanded={hasDetail ? expanded : undefined}
      >
        <span className="mt-0.5 w-3 shrink-0 text-gray-500">
          {hasDetail ? expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} /> : null}
        </span>
        <time
          className="shrink-0 text-gray-500 tabular-nums"
          dateTime={String(record.timeUnixNano)}
        >
          {formatDateTime(nanoToMillis(record.timeUnixNano))}
        </time>
        <span
          className={`shrink-0 rounded border px-1 text-[10px] font-semibold uppercase ${severityTone(
            record.severityNumber,
          )}`}
        >
          {label}
        </span>
        {record.serviceName ? (
          <span className="shrink-0 text-sky-300/80" title="service">
            {record.serviceName}
          </span>
        ) : null}
        {record.environment ? (
          <span className="shrink-0 rounded bg-gray-700/50 px-1 text-[10px] text-gray-300">
            {record.environment}
          </span>
        ) : null}
        <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-gray-200">
          {record.body ?? ''}
        </span>
      </button>

      {expanded ? (
        <div className="space-y-3 bg-gray-900/60 px-7 py-2 text-[11px]">
          {record.traceId || record.spanId ? (
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-gray-400">
              {record.traceId ? (
                <span>
                  trace_id: <span className="text-gray-200">{record.traceId}</span>
                </span>
              ) : null}
              {record.spanId ? (
                <span>
                  span_id: <span className="text-gray-200">{record.spanId}</span>
                </span>
              ) : null}
              <span>
                source: <span className="text-gray-200">{record.sourceId}</span>
              </span>
            </div>
          ) : null}

          {stack ? (
            <div>
              <div className="mb-1 font-semibold text-gray-400">Stack trace</div>
              <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded bg-black/40 p-2 text-gray-200">
                {stack}
              </pre>
            </div>
          ) : null}

          {attributes.length > 0 ? (
            <div>
              <div className="mb-1 font-semibold text-gray-400">Attributes</div>
              <dl className="grid grid-cols-[minmax(0,12rem)_1fr] gap-x-3 gap-y-0.5">
                {attributes.map((a) => (
                  <div key={a.key} className="contents">
                    <dt className="truncate text-gray-500">{a.key}</dt>
                    <dd className="whitespace-pre-wrap break-words text-gray-200">{a.value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ) : null}

          {resource.length > 0 ? (
            <div>
              <div className="mb-1 font-semibold text-gray-400">Resource</div>
              <dl className="grid grid-cols-[minmax(0,12rem)_1fr] gap-x-3 gap-y-0.5">
                {resource.map((a) => (
                  <div key={a.key} className="contents">
                    <dt className="truncate text-gray-500">{a.key}</dt>
                    <dd className="whitespace-pre-wrap break-words text-gray-200">{a.value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
