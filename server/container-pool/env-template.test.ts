/**
 * `.env.preview` template renderer tests (W2).
 *
 * Covers the "missing vars fail loudly" contract from the W2 card:
 *   • All placeholders present → rendered value string with no `${…}` left.
 *   • Any placeholder missing (undefined, null, empty, whitespace) →
 *     `EnvTemplateError` listing every offending name.
 *   • Multiline values (PEM private keys) are escaped to `\n` so dotenv
 *     sees a single-line value.
 */

import { describe, it, expect } from 'vitest';
import {
  buildPrEnvFile,
  EnvTemplateError,
  PR_ENV_TEMPLATE,
  renderEnvFile,
  type PrEnvTemplateValues,
} from './env-template.js';

const VALID_VALUES: PrEnvTemplateValues = {
  repoFullName: 'acme/repo',
  prNumber: 42,
  slotId: 'pr-env-42',
  hostPort: 3125,
  dbPath: '/var/data/pr-42.db',
  githubAppId: '12345',
  githubInstallationId: '67890',
  githubPrivateKey: '-----BEGIN KEY-----\nABCDEF\n-----END KEY-----\n',
  previewUrl: 'https://preview.example.com/pr-42',
};

describe('renderEnvFile (generic)', () => {
  it('interpolates every placeholder with no residue', () => {
    const body = renderEnvFile('FOO=${a}\nBAR=${b}\n', { a: '1', b: 'two' });
    expect(body).toBe('FOO=1\nBAR=two\n');
  });

  it('throws EnvTemplateError when a placeholder is undefined', () => {
    expect(() => renderEnvFile('FOO=${a}\nBAR=${b}\n', { a: '1' })).toThrowError(EnvTemplateError);
  });

  it('throws EnvTemplateError for empty or whitespace values', () => {
    expect(() => renderEnvFile('FOO=${a}\n', { a: '' })).toThrow(/a/);
    expect(() => renderEnvFile('FOO=${a}\n', { a: '   \n\t' })).toThrow(/a/);
  });

  it('lists every missing key in the error', () => {
    try {
      renderEnvFile('A=${a}\nB=${b}\nC=${c}\n', { a: 'ok', b: '' /* c missing */ });
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(EnvTemplateError);
      expect((err as EnvTemplateError).missing.sort()).toEqual(['b', 'c']);
    }
  });

  it('escapes newlines so multiline values stay on one line', () => {
    const body = renderEnvFile('KEY=${k}\n', { k: 'line1\nline2\r\nline3' });
    // LF and CRLF both collapse to a literal `\n` escape; no raw newlines
    // remain inside the value.
    expect(body).toBe('KEY=line1\\nline2\\nline3\n');
  });
});

describe('buildPrEnvFile (PR_ENV_TEMPLATE)', () => {
  it('renders every field in the standard template', () => {
    const body = buildPrEnvFile(VALID_VALUES);
    expect(body).toContain('REPO_FULL_NAME=acme/repo');
    expect(body).toContain('PR_NUMBER=42');
    expect(body).toContain('POOL_SLOT_ID=pr-env-42');
    expect(body).toContain('HOST_PORT=3125');
    expect(body).toContain('DB_PATH=/var/data/pr-42.db');
    expect(body).toContain('GITHUB_APP_ID=12345');
    expect(body).toContain('GITHUB_INSTALLATION_ID=67890');
    expect(body).toContain('PREVIEW_URL=https://preview.example.com/pr-42');
    // Multiline private key should be escaped.
    expect(body).toContain(
      'GITHUB_PRIVATE_KEY=-----BEGIN KEY-----\\nABCDEF\\n-----END KEY-----\\n',
    );
    // No un-filled placeholders survive.
    expect(body).not.toMatch(/\$\{/);
  });

  it.each([
    ['repoFullName', { repoFullName: '' }],
    ['githubPrivateKey', { githubPrivateKey: '' }],
    ['previewUrl', { previewUrl: '   ' }],
  ] as const)('fails loudly when %s is missing', (_name, patch) => {
    const values = { ...VALID_VALUES, ...(patch as Partial<PrEnvTemplateValues>) };
    expect(() => buildPrEnvFile(values)).toThrowError(EnvTemplateError);
  });

  it('template body is self-consistent — every placeholder is covered by PrEnvTemplateValues', () => {
    // Drift guard: if someone adds `${FOO}` to PR_ENV_TEMPLATE without
    // plumbing `foo` through buildPrEnvFile, this test explodes.
    const expectedKeys = [
      'repoFullName',
      'prNumber',
      'slotId',
      'hostPort',
      'dbPath',
      'githubAppId',
      'githubInstallationId',
      'githubPrivateKey',
      'previewUrl',
    ].sort();
    const seen = Array.from(PR_ENV_TEMPLATE.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g))
      .map((m) => m[1])
      .sort();
    expect(Array.from(new Set(seen))).toEqual(expectedKeys);
  });
});
