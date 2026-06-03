import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./preview/preview-secrets-store.js', () => ({
  parseDotEnv: vi.fn((blob: string) =>
    blob
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const eq = line.indexOf('=');
        return { key: line.slice(0, eq), value: line.slice(eq + 1), kind: undefined };
      }),
  ),
  listRawPreviewSecretRows: vi.fn(() => []),
  replacePreviewSecretsMixed: vi.fn(),
  replacePreviewSecrets: vi.fn(),
  PreviewSecretValidationError: class PreviewSecretValidationError extends Error {
    statusCode = 400;
  },
}));

import {
  listRawPreviewSecretRows,
  replacePreviewSecretsMixed,
  replacePreviewSecrets,
} from './preview/preview-secrets-store.js';
import { applyWizardSecrets } from './wizard-secrets-apply.js';

describe('applyWizardSecrets', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns zero when secrets payload is omitted', () => {
    expect(applyWizardSecrets('proj-1', undefined, 'user-1')).toEqual({
      ok: true,
      secretsImported: 0,
    });
  });

  it('merge-imports dotenv lines', () => {
    const result = applyWizardSecrets(
      'proj-1',
      { env: 'AWS_ACCESS_KEY_ID=abc\nPOSTGRES_DB_PASSWORD=secret\n', mode: 'merge' },
      'user-1',
    );
    expect(result).toEqual({ ok: true, secretsImported: 2 });
    expect(listRawPreviewSecretRows).toHaveBeenCalledWith('proj-1');
    expect(replacePreviewSecretsMixed).toHaveBeenCalled();
    expect(replacePreviewSecrets).not.toHaveBeenCalled();
  });

  it('replace mode calls replacePreviewSecrets', () => {
    applyWizardSecrets('proj-1', { env: 'FOO=bar\n', mode: 'replace' }, null);
    expect(replacePreviewSecrets).toHaveBeenCalledWith('proj-1', expect.any(Array), null);
  });

  it('400s on invalid mode', () => {
    const result = applyWizardSecrets(
      'proj-1',
      { env: 'X=1\n', mode: 'overwrite' as 'merge' },
      null,
    );
    expect(result).toEqual({
      ok: false,
      statusCode: 400,
      error: 'secrets.mode must be "merge" or "replace"',
    });
  });
});
