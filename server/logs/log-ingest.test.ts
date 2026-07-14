import { describe, it, expect } from 'vitest';
import { buildRedactionConfig, REDACTION_PLACEHOLDER } from './log-redaction.js';
import {
  anyValueToJs,
  normalizeAhBatch,
  normalizeOtlpLogsData,
  severityNumberToText,
  severityTextToNumber,
  type IngestContext,
} from './log-ingest.js';
import { MAX_BATCH_RECORDS, SEVERITY_NUMBER } from './logs-schema.js';
import type { JsonAnyValue, JsonLogsData } from './otlp-protobuf.js';

const NOW = 1_700_000_000_000; // ms

function ctx(overrides: Partial<IngestContext> = {}): IngestContext {
  return {
    projectId: 'proj1',
    sourceId: 'src1',
    defaultServiceName: 'default-svc',
    defaultEnvironment: 'default-env',
    redaction: buildRedactionConfig(),
    nowMs: NOW,
    ...overrides,
  };
}

describe('severity mapping', () => {
  it('maps numbers to base labels', () => {
    expect(severityNumberToText(SEVERITY_NUMBER.ERROR)).toBe('ERROR');
    expect(severityNumberToText(18)).toBe('ERROR');
    expect(severityNumberToText(SEVERITY_NUMBER.INFO)).toBe('INFO');
    expect(severityNumberToText(0)).toBeNull();
  });
  it('maps free-text levels to numbers', () => {
    expect(severityTextToNumber('warning')).toBe(SEVERITY_NUMBER.WARN);
    expect(severityTextToNumber('CRITICAL')).toBe(SEVERITY_NUMBER.FATAL);
    expect(severityTextToNumber('nonsense')).toBe(SEVERITY_NUMBER.UNSPECIFIED);
  });
});

describe('anyValueToJs', () => {
  it('projects each AnyValue variant', () => {
    expect(anyValueToJs({ stringValue: 'x' })).toBe('x');
    expect(anyValueToJs({ boolValue: true })).toBe(true);
    expect(anyValueToJs({ intValue: '42' })).toBe(42);
    expect(anyValueToJs({ doubleValue: 1.5 })).toBe(1.5);
    expect(anyValueToJs({ arrayValue: { values: [{ stringValue: 'a' }] } })).toEqual(['a']);
    expect(
      anyValueToJs({ kvlistValue: { values: [{ key: 'k', value: { intValue: '1' } }] } }),
    ).toEqual({
      k: 1,
    });
    expect(anyValueToJs({})).toBeNull();
  });

  it('bounds deeply nested JSON AnyValues instead of overflowing the stack', () => {
    let value: JsonAnyValue = { stringValue: 'leaf' };
    for (let i = 0; i < 100; i++) {
      value = { arrayValue: { values: [value] } };
    }
    expect(() => anyValueToJs(value)).not.toThrow();
  });
});

describe('normalizeOtlpLogsData', () => {
  const base: JsonLogsData = {
    resourceLogs: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'checkout' } }] },
        scopeLogs: [
          {
            scope: { name: 'lib', version: '2.0', attributes: [] },
            logRecords: [
              {
                timeUnixNano: 1700000000000000000,
                severityNumber: 17,
                body: { stringValue: 'kaboom' },
                attributes: [
                  { key: 'http.method', value: { stringValue: 'GET' } },
                  { key: 'deployment.environment', value: { stringValue: 'prod' } },
                ],
                traceId: 'abcd',
                spanId: 'ef01',
              },
            ],
          },
        ],
      },
    ],
  };

  it('preserves severity, body, trace/span, facets, resource + scope', () => {
    const { records } = normalizeOtlpLogsData(base, ctx());
    expect(records).toHaveLength(1);
    const r = records[0]!;
    expect(r.severityNumber).toBe(17);
    expect(r.severityText).toBe('ERROR'); // derived from number
    expect(r.body).toBe('kaboom');
    expect(r.traceId).toBe('abcd');
    expect(r.spanId).toBe('ef01');
    expect(r.serviceName).toBe('checkout'); // from resource attr, not source default
    expect(r.environment).toBe('prod'); // from record attr
    expect(JSON.parse(r.attributesJson!)['http.method']).toBe('GET');
    expect(JSON.parse(r.resourceJson!)['service.name']).toBe('checkout');
    expect(JSON.parse(r.scopeJson!)).toEqual({ name: 'lib', version: '2.0' });
  });

  it('falls back to source-configured facets and ingest time when unset', () => {
    const data: JsonLogsData = {
      resourceLogs: [{ scopeLogs: [{ logRecords: [{ body: { stringValue: 'hi' } }] }] }],
    };
    const { records } = normalizeOtlpLogsData(data, ctx());
    const r = records[0]!;
    expect(r.serviceName).toBe('default-svc');
    expect(r.environment).toBe('default-env');
    expect(r.timeUnixNano).toBe(NOW * 1_000_000); // ingest time in ns
    expect(r.severityText).toBeNull();
    expect(r.severityNumber).toBe(0);
  });

  it('redacts secrets in body and attributes before persistence', () => {
    const data: JsonLogsData = {
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                {
                  body: { stringValue: 'auth Bearer abcdef0123456789ABCDEF failed' },
                  attributes: [{ key: 'password', value: { stringValue: 'hunter2' } }],
                },
              ],
            },
          ],
        },
      ],
    };
    const { records, redactions } = normalizeOtlpLogsData(data, ctx());
    expect(records[0]!.body).toContain(REDACTION_PLACEHOLDER);
    expect(JSON.parse(records[0]!.attributesJson!).password).toBe(REDACTION_PLACEHOLDER);
    expect(redactions).toBeGreaterThanOrEqual(2);
  });

  it('redacts sensitive keys inside an OTLP structured body before serialization', () => {
    const data: JsonLogsData = {
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                {
                  body: {
                    kvlistValue: {
                      values: [
                        { key: 'event', value: { stringValue: 'login' } },
                        { key: 'password', value: { stringValue: 'hunter2' } },
                      ],
                    },
                  },
                },
              ],
            },
          ],
        },
      ],
    };
    const { records, redactions } = normalizeOtlpLogsData(data, ctx());
    expect(JSON.parse(records[0]!.body!)).toEqual({
      event: 'login',
      password: REDACTION_PLACEHOLDER,
    });
    expect(redactions).toBe(1);
  });

  it('caps the batch and counts the overflow as rejected', () => {
    const logRecords = Array.from({ length: MAX_BATCH_RECORDS + 5 }, () => ({
      body: { stringValue: 'x' },
    }));
    const data: JsonLogsData = { resourceLogs: [{ scopeLogs: [{ logRecords }] }] };
    const { records, rejected } = normalizeOtlpLogsData(data, ctx());
    expect(records).toHaveLength(MAX_BATCH_RECORDS);
    expect(rejected).toBe(5);
  });
});

describe('normalizeAhBatch', () => {
  it('maps a simple batch with text severity, message alias, and millis time', () => {
    const { records } = normalizeAhBatch(
      {
        resource: { 'service.name': 'api' },
        records: [
          {
            timeUnixMillis: 1700000000000,
            severity: 'warning',
            message: 'disk almost full',
            attributes: { region: 'us-east-1' },
            environment: 'staging',
          },
        ],
      },
      ctx(),
    );
    const r = records[0]!;
    expect(r.severityNumber).toBe(SEVERITY_NUMBER.WARN);
    expect(r.severityText).toBe('warning');
    expect(r.body).toBe('disk almost full');
    expect(r.timeUnixNano).toBe(1700000000000 * 1_000_000);
    expect(r.serviceName).toBe('api'); // batch resource
    expect(r.environment).toBe('staging'); // convenience field
    expect(JSON.parse(r.attributesJson!).region).toBe('us-east-1');
  });

  it('serializes a structured body to JSON text', () => {
    const { records } = normalizeAhBatch(
      { records: [{ body: { event: 'signup', plan: 'pro' } }] },
      ctx(),
    );
    expect(JSON.parse(records[0]!.body!)).toEqual({ event: 'signup', plan: 'pro' });
  });

  it('redacts sensitive keys inside an Agent Hub structured body', () => {
    const { records, redactions } = normalizeAhBatch(
      { records: [{ body: { event: 'signup', password: 'hunter2' } }] },
      ctx(),
    );
    expect(JSON.parse(records[0]!.body!)).toEqual({
      event: 'signup',
      password: REDACTION_PLACEHOLDER,
    });
    expect(redactions).toBe(1);
  });

  it('redacts configured extra keys via project overrides', () => {
    const custom = ctx({ redaction: buildRedactionConfig({ redactKeys: ['internal_ref'] }) });
    const { records } = normalizeAhBatch(
      { records: [{ body: 'ok', attributes: { internal_ref: 'sensitive' } }] },
      custom,
    );
    expect(JSON.parse(records[0]!.attributesJson!).internal_ref).toBe(REDACTION_PLACEHOLDER);
  });
});
