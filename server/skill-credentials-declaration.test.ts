import { describe, expect, it } from 'vitest';
import { parseCredentialsDeclaration } from './skill-credentials-declaration.js';

describe('parseCredentialsDeclaration', () => {
  it('accepts missing / null credentials as empty schema', () => {
    expect(parseCredentialsDeclaration(undefined)).toEqual({
      credentials: [],
      error: null,
    });
    expect(parseCredentialsDeclaration(null)).toEqual({ credentials: [], error: null });
  });

  it('rejects non-array credentials', () => {
    const r = parseCredentialsDeclaration({});
    expect(r.error).toMatch(/must be an array/);
    expect(r.credentials).toHaveLength(0);
  });

  it('parses valid declaration', () => {
    const r = parseCredentialsDeclaration([
      {
        name: 'LINEAR_API_KEY',
        label: 'Linear API key',
        description: 'from settings',
        required: true,
        type: 'secret',
        docs_url: 'https://linear.app/settings/api',
      },
      { name: 'LINEAR_TEAM', type: 'string', required: false },
    ]);
    expect(r.error).toBeNull();
    expect(r.credentials).toHaveLength(2);
    expect(r.credentials[1]!.label).toBe('LINEAR_TEAM');
    expect(r.credentials[1]!.type).toBe('string');
    expect(r.credentials[1]!.required).toBe(false);
  });

  it('rejects invalid env-style names', () => {
    const r = parseCredentialsDeclaration([{ name: 'bad-key', type: 'secret' }]);
    expect(r.error).toMatch(/POSIX/);
    expect(r.credentials).toHaveLength(0);
  });

  it('rejects duplicate names', () => {
    const r = parseCredentialsDeclaration([
      { name: 'FOO', type: 'secret' },
      { name: 'FOO', type: 'secret' },
    ]);
    expect(r.error).toMatch(/duplicate/i);
  });

  it('defaults type to secret and required true', () => {
    const r = parseCredentialsDeclaration([{ name: 'BAR' }]);
    expect(r.error).toBeNull();
    expect(r.credentials[0]!.type).toBe('secret');
    expect(r.credentials[0]!.required).toBe(true);
  });

  it('omits docs_url when scheme is not http(s)', () => {
    const r = parseCredentialsDeclaration([
      { name: 'X', type: 'secret', docs_url: 'javascript:alert(1)' },
      { name: 'Y', type: 'secret', docs_url: 'data:text/html,hi' },
      { name: 'Z', type: 'secret', docs_url: 'file:///etc/passwd' },
    ]);
    expect(r.error).toBeNull();
    expect(r.credentials[0]!.docs_url).toBeUndefined();
    expect(r.credentials[1]!.docs_url).toBeUndefined();
    expect(r.credentials[2]!.docs_url).toBeUndefined();
  });

  it('normalizes http(s) docs_url to href string', () => {
    const r = parseCredentialsDeclaration([
      { name: 'A', type: 'string', docs_url: 'https://example.com/path' },
    ]);
    expect(r.error).toBeNull();
    expect(r.credentials[0]!.docs_url).toBe('https://example.com/path');
  });

  it('omits docs_url for invalid URL strings', () => {
    const r = parseCredentialsDeclaration([{ name: 'W', type: 'secret', docs_url: 'not a url' }]);
    expect(r.error).toBeNull();
    expect(r.credentials[0]!.docs_url).toBeUndefined();
  });
});
