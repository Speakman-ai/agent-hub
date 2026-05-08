import { describe, it, expect } from 'vitest';
import {
  redactOpRefs,
  redactOpValues,
  redactOpOutput,
  OP_REF_PLACEHOLDER,
  SECRET_PLACEHOLDER,
  TOKEN_PLACEHOLDER,
} from './op-redact.js';

describe('redactOpRefs', () => {
  it('masks a bare op:// URI', () => {
    const input = 'op://Personal/AWSAccount/access_key_id';
    expect(redactOpRefs(input)).toBe(OP_REF_PLACEHOLDER);
  });

  it('masks an op:// URI embedded in a larger string', () => {
    const input = 'key is op://Shared/ProdDB/password and nothing else';
    expect(redactOpRefs(input)).toBe(`key is ${OP_REF_PLACEHOLDER} and nothing else`);
  });

  it('masks multiple op:// URIs in the same string', () => {
    const input = 'a=op://V1/I1/F1 b=op://V2/I2/F2';
    const result = redactOpRefs(input);
    expect(result).toBe(`a=${OP_REF_PLACEHOLDER} b=${OP_REF_PLACEHOLDER}`);
  });

  it('does not alter strings with no op:// references', () => {
    const input = 'no secrets here, just normal text';
    expect(redactOpRefs(input)).toBe(input);
  });

  it('handles an empty string', () => {
    expect(redactOpRefs('')).toBe('');
  });

  it('masks op:// URIs inside JSON-like error output', () => {
    // Item names with spaces require UUID or quoting; this uses a UUID form
    const input = '{"ref":"op://vault/4aSHcMhNmNtyEGAyc53vwD/field","error":"not found"}';
    const result = redactOpRefs(input);
    expect(result).toContain(OP_REF_PLACEHOLDER);
    // The placeholder itself must not re-introduce op:// into the output
    expect(result).not.toContain('op://');
  });

  it('masks op:// URI with four-part path (vault/item/section/field)', () => {
    const input = 'ref=op://Shared/MyServer/SSH/private_key';
    const result = redactOpRefs(input);
    expect(result).toBe(`ref=${OP_REF_PLACEHOLDER}`);
    expect(result).not.toContain('op://');
  });

  it('stops masking at a space (unquoted refs cannot contain spaces)', () => {
    // In real shell use, "Prod DB" in an unquoted ref would split on the space.
    // The regex stops at the first space, masking only the URI prefix.
    const input = 'op://Shared/Prod DB/password is not a valid unquoted ref';
    const result = redactOpRefs(input);
    // The op://Shared/Prod part before the space should be masked
    expect(result).toContain(OP_REF_PLACEHOLDER);
    // The trailing text after the space is unchanged
    expect(result).toContain('DB/password is not a valid unquoted ref');
  });
});

describe('redactOpValues', () => {
  it('replaces a known secret value with [redacted]', () => {
    const secret = 'AKIAIOSFODNN7EXAMPLE';
    const input = `The key is ${secret} and it works`;
    expect(redactOpValues(input, [secret])).toBe(`The key is ${SECRET_PLACEHOLDER} and it works`);
  });

  it('replaces all occurrences of a known secret', () => {
    const secret = 'mysecret123xyz';
    const input = `${secret} is used twice: ${secret}`;
    const result = redactOpValues(input, [secret]);
    expect(result).toBe(`${SECRET_PLACEHOLDER} is used twice: ${SECRET_PLACEHOLDER}`);
  });

  it('skips values shorter than 4 chars to avoid over-redaction', () => {
    const input = 'the value is yes and no';
    // "yes" and "no" should not be redacted even if passed as known values
    const result = redactOpValues(input, ['yes', 'no', 'ok']);
    expect(result).toBe(input);
  });

  it('skips empty-string values', () => {
    const input = 'some text here';
    expect(redactOpValues(input, [''])).toBe(input);
  });

  it('handles multiple distinct known values', () => {
    const input = 'key=abc123xyz789qrs user=john';
    const result = redactOpValues(input, ['abc123xyz789qrs', 'john']);
    expect(result).toBe(`key=${SECRET_PLACEHOLDER} user=${SECRET_PLACEHOLDER}`);
  });

  it('does not treat known values as regexes (special chars are literal)', () => {
    const secret = 'abc.+?$def';
    const input = `secret is ${secret} here`;
    const result = redactOpValues(input, [secret]);
    expect(result).toBe(`secret is ${SECRET_PLACEHOLDER} here`);
    // Make sure the original literal string (with regex chars) was matched
    expect(result).not.toContain(secret);
  });

  it('handles an empty input string', () => {
    expect(redactOpValues('', ['mysecret'])).toBe('');
  });
});

describe('redactOpOutput (full pipeline)', () => {
  it('masks op:// refs, known values, and long tokens together', () => {
    const resolvedSecret = 'AKIAIOSFODNN7EXAMPLElongkeyvalue123';
    const input = [
      'ref=op://Personal/AWSAccount/access_key_id',
      `resolved=${resolvedSecret}`,
      'token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
    ].join('\n');

    const result = redactOpOutput(input, [resolvedSecret]);

    // op:// ref should be gone and placeholder must NOT re-introduce op://
    expect(result).not.toContain('op://');
    // Known resolved value should be gone
    expect(result).not.toContain(resolvedSecret);
    // Long JWT-like token should be gone (≥32 contiguous chars)
    expect(result).not.toMatch(/[A-Za-z0-9]{32,}/);

    // Placeholders should be present
    expect(result).toContain(OP_REF_PLACEHOLDER);
    expect(result).toContain(SECRET_PLACEHOLDER);
  });

  it('leaves short non-secret strings intact', () => {
    const input = 'vault=Personal item=AWS status=ok';
    const result = redactOpOutput(input);
    // Short strings should not be redacted
    expect(result).toContain('Personal');
    expect(result).toContain('AWS');
    expect(result).toContain('status=ok');
  });

  it('handles output with no secrets at all', () => {
    const input = 'Title: My Login\nVault: Personal\nCategory: Login\n';
    expect(redactOpOutput(input)).toBe(input);
  });

  it('returns empty string unchanged', () => {
    expect(redactOpOutput('')).toBe('');
  });

  it('masks long service account token format (ops_...)', () => {
    // Service Account tokens start with "ops_" and are long
    const saToken = 'ops_eyJzaWduSW5BZGRyZXNzIjoiaHR0cHM6Ly9teS4xcGFzc3dvcmQuY29tIn0';
    const input = `token=${saToken}`;
    const result = redactOpOutput(input);
    expect(result).not.toContain(saToken);
    expect(result).toContain(TOKEN_PLACEHOLDER);
  });

  it('does not mask short identifiers that are not secrets', () => {
    // Short alphanumeric strings (under 32 chars) should not be masked
    const input = 'id=abc12345 vault=Personal type=Login';
    expect(redactOpOutput(input)).toBe(input);
  });

  it('does not redact known values provided as empty array', () => {
    const input = 'Hello world, no secrets here';
    expect(redactOpOutput(input, [])).toBe(input);
  });

  it('never leaks a resolved secret through the full pipeline', () => {
    // Simulate what op item get might return after resolution
    const secretValue = 'sk-ant-api03-SUPERSECRETAPIKEY1234567890ABCDEFGHIJKLMNOP';
    const rawOutput = `item=MyAPIKey field=credential value=${secretValue}`;
    const result = redactOpOutput(rawOutput, [secretValue]);
    expect(result).not.toContain(secretValue);
    // Both the explicit redaction AND the heuristic kick in
    expect(result).toContain(SECRET_PLACEHOLDER);
  });
});
