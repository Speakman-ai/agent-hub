import { describe, it, expect } from 'vitest';
import {
  deriveIssueGrouping,
  normalizeMessageTemplate,
  extractInAppFrames,
  type FingerprintInput,
} from './log-fingerprint.js';
import { SEVERITY_NUMBER } from './logs-schema.js';

function base(overrides: Partial<FingerprintInput> = {}): FingerprintInput {
  return {
    projectId: 'proj1',
    sourceId: 'src1',
    serviceName: 'checkout',
    environment: 'prod',
    severityNumber: SEVERITY_NUMBER.ERROR,
    body: 'boom',
    attributes: {},
    resource: {},
    ...overrides,
  };
}

describe('normalizeMessageTemplate — volatile-ID scrubbing', () => {
  it('replaces numbers, uuids, hex, ip, timestamps, urls, and emails', () => {
    expect(normalizeMessageTemplate('User 12345 not found')).toBe('User <n> not found');
    expect(normalizeMessageTemplate('order 550e8400-e29b-41d4-a716-446655440000 failed')).toBe(
      'order <uuid> failed',
    );
    expect(normalizeMessageTemplate('addr 0xDEADBEEF invalid')).toBe('addr <hex> invalid');
    expect(normalizeMessageTemplate('hash a1b2c3d4e5f6a7b8 mismatch')).toBe('hash <hex> mismatch');
    expect(normalizeMessageTemplate('connect 192.168.1.42 refused')).toBe('connect <ip> refused');
    expect(normalizeMessageTemplate('at 2026-07-14T12:34:56.789Z crashed')).toBe('at <ts> crashed');
    expect(normalizeMessageTemplate('GET https://api.example.com/x?id=5 500')).toBe(
      'GET <url> <n>',
    );
    expect(normalizeMessageTemplate('mail to a.b+c@example.co.uk bounced')).toBe(
      'mail to <email> bounced',
    );
  });

  it('leaves a pure-decimal run as <n>, not <hex>', () => {
    expect(normalizeMessageTemplate('code 12345678 seen')).toBe('code <n> seen');
  });

  it('collapses whitespace so wrapping differences do not fork groups', () => {
    expect(normalizeMessageTemplate('a\n  b\t c')).toBe('a b c');
  });

  it('is idempotent on already-templated text', () => {
    const once = normalizeMessageTemplate('id 42 x 43');
    expect(normalizeMessageTemplate(once)).toBe(once);
  });
});

describe('extractInAppFrames — stack grouping', () => {
  const stack = [
    'Error: kaboom',
    '    at handler (/app/src/checkout.js:12:5)',
    '    at process (/app/node_modules/express/lib/router.js:44:3)',
    '    at run (/app/src/server.js:99:1)',
    '    at Module._compile (node:internal/modules/cjs/loader:1105:14)',
  ].join('\n');

  it('keeps in-app frames and drops node_modules / node:internal', () => {
    const frames = extractInAppFrames(stack);
    expect(frames).toEqual(['at handler (/app/src/checkout.js)', 'at run (/app/src/server.js)']);
  });

  it('strips line:col so the same frame at a shifted line groups together', () => {
    const a = extractInAppFrames('    at f (/app/x.js:10:2)');
    const b = extractInAppFrames('    at f (/app/x.js:33:9)');
    expect(a).toEqual(b);
  });

  it('parses python-style frames', () => {
    const py = 'Traceback\n  File "/app/svc.py", line 8, in handler\n    raise ValueError';
    expect(extractInAppFrames(py)).toEqual(['File "/app/svc.py", in handler']);
  });

  it('falls back to library frames when nothing is in-app', () => {
    const libOnly = '    at x (/app/node_modules/a/i.js:1:1)';
    expect(extractInAppFrames(libOnly)).toEqual(['at x (/app/node_modules/a/i.js)']);
  });
});

describe('deriveIssueGrouping — eligibility', () => {
  it('returns null for below-ERROR records with no exception fields', () => {
    expect(deriveIssueGrouping(base({ severityNumber: SEVERITY_NUMBER.WARN }))).toBeNull();
    expect(deriveIssueGrouping(base({ severityNumber: SEVERITY_NUMBER.INFO }))).toBeNull();
  });

  it('groups a below-ERROR record that carries structured exception fields', () => {
    const g = deriveIssueGrouping(
      base({
        severityNumber: SEVERITY_NUMBER.INFO,
        attributes: { 'exception.type': 'TypeError', 'exception.message': 'x is undefined' },
      }),
    );
    expect(g).not.toBeNull();
    expect(g!.exceptionType).toBe('TypeError');
  });

  it('groups any ERROR-or-higher record even without exception fields', () => {
    expect(deriveIssueGrouping(base({ severityNumber: SEVERITY_NUMBER.ERROR }))).not.toBeNull();
    expect(deriveIssueGrouping(base({ severityNumber: SEVERITY_NUMBER.FATAL }))).not.toBeNull();
  });
});

describe('deriveIssueGrouping — collisions and separation', () => {
  it('two occurrences differing only by volatile IDs collide (same fingerprint)', () => {
    const a = deriveIssueGrouping(base({ body: 'user 111 payment 0xAB failed' }))!;
    const b = deriveIssueGrouping(base({ body: 'user 222 payment 0xCD failed' }))!;
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.messageTemplate).toBe('user <n> payment <hex> failed');
  });

  it('different exception types do not collide', () => {
    const a = deriveIssueGrouping(base({ attributes: { 'exception.type': 'TypeError' } }))!;
    const b = deriveIssueGrouping(base({ attributes: { 'exception.type': 'RangeError' } }))!;
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });

  it('different environments do not collide', () => {
    const a = deriveIssueGrouping(base({ environment: 'prod' }))!;
    const b = deriveIssueGrouping(base({ environment: 'staging' }))!;
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });

  it('same defect across releases keeps ONE fingerprint (release is a facet)', () => {
    const a = deriveIssueGrouping(base({ resource: { 'service.version': '1.0.0' } }))!;
    const b = deriveIssueGrouping(base({ resource: { 'service.version': '2.0.0' } }))!;
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.release).toBe('1.0.0');
    expect(b.release).toBe('2.0.0');
  });

  it('different in-app frames fork the group', () => {
    const a = deriveIssueGrouping(
      base({ attributes: { 'exception.stacktrace': '    at a (/app/a.js:1:1)' } }),
    )!;
    const b = deriveIssueGrouping(
      base({ attributes: { 'exception.stacktrace': '    at b (/app/b.js:1:1)' } }),
    )!;
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });
});

describe('deriveIssueGrouping — facets', () => {
  it('extracts release and commit sha from attributes/resource', () => {
    const g = deriveIssueGrouping(
      base({
        attributes: { 'exception.type': 'Error' },
        resource: { 'service.version': '3.4.5', 'vcs.repository.ref.revision': 'abc123def' },
      }),
    )!;
    expect(g.release).toBe('3.4.5');
    expect(g.commitSha).toBe('abc123def');
  });

  it('builds a stable title from type + normalized template', () => {
    const g = deriveIssueGrouping(
      base({ attributes: { 'exception.type': 'DBError', 'exception.message': 'row 7 locked' } }),
    )!;
    expect(g.title).toBe('DBError: row <n> locked');
  });
});
