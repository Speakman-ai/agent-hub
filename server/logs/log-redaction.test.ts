import { describe, it, expect } from 'vitest';
import {
  buildRedactionConfig,
  normalizeLogText,
  redactText,
  redactStructured,
  REDACTION_PLACEHOLDER,
} from './log-redaction.js';

const cfg = buildRedactionConfig();

describe('normalizeLogText', () => {
  it('collapses CRLF/CR to LF and keeps TAB/LF', () => {
    expect(normalizeLogText('a\r\nb\rc\td')).toBe('a\nb\nc\td');
  });

  it('strips ANSI escape sequences', () => {
    expect(normalizeLogText('\x1b[31mred\x1b[0m')).toBe('red');
  });

  it('strips C0/C1 control chars (log-injection guard) but not printable text', () => {
    expect(normalizeLogText('ok\x00\x07\x1fmore')).toBe('okmore');
    expect(normalizeLogText('plain text 123')).toBe('plain text 123');
    // A forged extra "log line" via CR is collapsed to a normal newline.
    expect(normalizeLogText('line1\r\nFAKE 500 error')).toBe('line1\nFAKE 500 error');
  });
});

describe('redactText — built-in secret value patterns', () => {
  const cases: Array<[string, string]> = [
    ['auth Bearer', 'Authorization: Bearer abcdef0123456789ABCDEF'],
    ['jwt', 'token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcDEF123_-'],
    ['aws key', 'key AKIAIOSFODNN7EXAMPLE here'],
    ['github pat', 'ghp_0123456789abcdef0123456789abcdefABCD'],
    ['stripe', 'sk_live_0123456789abcdefABCDEFG'],
    ['ahlog token', 'ahlog_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'],
    ['kv password', 'db connect password=hunter2secret host=x'],
    ['url userinfo', 'postgres://admin:s3cr3tpass@db.internal:5432/app'],
  ];
  for (const [name, input] of cases) {
    it(`masks ${name}`, () => {
      const { value, redactions } = redactText(input, cfg);
      expect(redactions).toBeGreaterThan(0);
      expect(value).toContain(REDACTION_PLACEHOLDER);
    });
  }

  it('masks a PEM private key block', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIabc123==\n-----END RSA PRIVATE KEY-----';
    const { value, redactions } = redactText(pem, cfg);
    expect(redactions).toBe(1);
    expect(value).toBe(REDACTION_PLACEHOLDER);
  });

  it('leaves ordinary text untouched', () => {
    const { value, redactions } = redactText('user 42 completed checkout in 231ms', cfg);
    expect(redactions).toBe(0);
    expect(value).toBe('user 42 completed checkout in 231ms');
  });
});

describe('redactStructured — key-based redaction', () => {
  it('drops the entire value of a sensitively-named key, any shape', () => {
    const { value } = redactStructured(
      {
        password: { nested: 'secret' },
        Authorization: 'Bearer xyz',
        'x-api-key': 'abc123',
        userId: 42,
        note: 'fine',
      },
      cfg,
    );
    const v = value as Record<string, unknown>;
    expect(v.password).toBe(REDACTION_PLACEHOLDER);
    expect(v.Authorization).toBe(REDACTION_PLACEHOLDER);
    expect(v['x-api-key']).toBe(REDACTION_PLACEHOLDER);
    expect(v.userId).toBe(42);
    expect(v.note).toBe('fine');
  });

  it('recurses into arrays and nested objects redacting string leaves', () => {
    const { value, redactions } = redactStructured(
      { items: [{ msg: 'ghp_0123456789abcdef0123456789abcdefABCD' }] },
      cfg,
    );
    const v = value as { items: Array<{ msg: string }> };
    expect(v.items[0]!.msg).toBe(REDACTION_PLACEHOLDER);
    expect(redactions).toBe(1);
  });
});

describe('buildRedactionConfig — operator overrides', () => {
  it('adds extra keys and value patterns; skips an invalid regex', () => {
    const custom = buildRedactionConfig({
      redactKeys: ['internal_ref'],
      redactPatterns: ['CUSTOMSECRET-\\d+', '((('], // last is invalid → skipped
    });
    const { value } = redactStructured(
      { internal_ref: 'abc', note: 'leaked CUSTOMSECRET-99 here' },
      custom,
    );
    const v = value as Record<string, unknown>;
    expect(v.internal_ref).toBe(REDACTION_PLACEHOLDER);
    expect(v.note).toContain(REDACTION_PLACEHOLDER);
  });
});
