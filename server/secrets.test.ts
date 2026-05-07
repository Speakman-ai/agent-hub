/**
 * Unit tests for server/secrets.ts
 *
 * The AWS SDK client is replaced with a hand-rolled fake via the test-only
 * escape hatch so no real AWS credentials or network calls are needed.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

// ─── Module under test (dynamic import after mocks are in place) ───────────

const {
  cardNeedsDevHubKey,
  getDevHubApiKey,
  __setSecretsClientForTests,
  __clearSecretsCacheForTests,
} = await import('./secrets.js');

// ─── Fake Secrets Manager client ──────────────────────────────────────────

function makeFakeClient(
  response: { SecretString?: string } | 'AccessDenied' | 'ResourceNotFound',
): SecretsManagerClient {
  return {
    send: vi.fn(async () => {
      if (response === 'AccessDenied') {
        throw new Error('AccessDeniedException: User is not authorized');
      }
      if (response === 'ResourceNotFound') {
        throw new Error(
          "ResourceNotFoundException: Secrets Manager can't find the specified secret",
        );
      }
      return response;
    }),
  } as unknown as SecretsManagerClient;
}

// ─── cardNeedsDevHubKey ────────────────────────────────────────────────────

describe('cardNeedsDevHubKey', () => {
  it('returns false for null labels', () => {
    expect(cardNeedsDevHubKey(null)).toBe(false);
  });

  it('returns false for undefined labels', () => {
    expect(cardNeedsDevHubKey(undefined)).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(cardNeedsDevHubKey('')).toBe(false);
  });

  it('returns false for unrelated labels', () => {
    expect(cardNeedsDevHubKey('infra,backend,ci')).toBe(false);
  });

  it('matches cross-hub:dev label', () => {
    expect(cardNeedsDevHubKey('cross-hub:dev')).toBe(true);
  });

  it('matches survey-tracker label', () => {
    expect(cardNeedsDevHubKey('survey-tracker')).toBe(true);
  });

  it('matches cross-hub:dev within a multi-label string', () => {
    expect(cardNeedsDevHubKey('infra,cross-hub:dev,secrets-manager')).toBe(true);
  });

  it('matches survey-tracker within a multi-label string', () => {
    expect(cardNeedsDevHubKey('frontend,survey-tracker,bug')).toBe(true);
  });

  it('is case-insensitive for cross-hub:dev', () => {
    expect(cardNeedsDevHubKey('Cross-Hub:Dev')).toBe(true);
  });

  it('is case-insensitive for survey-tracker', () => {
    expect(cardNeedsDevHubKey('Survey-Tracker')).toBe(true);
  });

  it('trims whitespace around labels', () => {
    expect(cardNeedsDevHubKey(' cross-hub:dev , infra ')).toBe(true);
  });

  it('does not partially match (cross-hub:dev-extra is not cross-hub:dev)', () => {
    expect(cardNeedsDevHubKey('cross-hub:dev-extra')).toBe(false);
  });
});

// ─── getDevHubApiKey ──────────────────────────────────────────────────────

describe('getDevHubApiKey — happy path', () => {
  beforeEach(() => {
    __clearSecretsCacheForTests();
  });

  it('returns the SecretString from AWS', async () => {
    __setSecretsClientForTests(makeFakeClient({ SecretString: 'ahub_testkey123' }));
    const key = await getDevHubApiKey();
    expect(key).toBe('ahub_testkey123');
  });

  it('trims whitespace from the returned value', async () => {
    __setSecretsClientForTests(makeFakeClient({ SecretString: '  ahub_whitespace  ' }));
    const key = await getDevHubApiKey();
    expect(key).toBe('ahub_whitespace');
  });

  it('caches the value and does not call AWS again within TTL', async () => {
    const fakeSend = vi.fn(async () => ({ SecretString: 'ahub_cached' }));
    __setSecretsClientForTests({ send: fakeSend } as unknown as SecretsManagerClient);

    const key1 = await getDevHubApiKey();
    const key2 = await getDevHubApiKey();

    expect(key1).toBe('ahub_cached');
    expect(key2).toBe('ahub_cached');
    // AWS should only have been called once (second call hit the cache).
    expect(fakeSend).toHaveBeenCalledTimes(1);
  });
});

describe('getDevHubApiKey — error handling', () => {
  beforeEach(() => {
    __clearSecretsCacheForTests();
  });

  it('returns null when AWS throws AccessDenied (does not rethrow)', async () => {
    __setSecretsClientForTests(makeFakeClient('AccessDenied'));
    const key = await getDevHubApiKey();
    expect(key).toBeNull();
  });

  it('returns null when AWS throws ResourceNotFound (does not rethrow)', async () => {
    __setSecretsClientForTests(makeFakeClient('ResourceNotFound'));
    const key = await getDevHubApiKey();
    expect(key).toBeNull();
  });

  it('returns null when SecretString is absent', async () => {
    __setSecretsClientForTests(makeFakeClient({}));
    const key = await getDevHubApiKey();
    expect(key).toBeNull();
  });

  it('returns null when SecretString is empty', async () => {
    __setSecretsClientForTests(makeFakeClient({ SecretString: '' }));
    const key = await getDevHubApiKey();
    expect(key).toBeNull();
  });

  it('negative-caches AWS errors — does not call AWS again within NEG_CACHE_TTL_MS', async () => {
    const fakeSend = vi.fn(async () => {
      throw new Error('AccessDeniedException: User is not authorized');
    });
    __setSecretsClientForTests({ send: fakeSend } as unknown as SecretsManagerClient);

    const key1 = await getDevHubApiKey();
    const key2 = await getDevHubApiKey();
    const key3 = await getDevHubApiKey();

    expect(key1).toBeNull();
    expect(key2).toBeNull();
    expect(key3).toBeNull();
    // AWS should only have been called once; subsequent calls are served from negative cache.
    expect(fakeSend).toHaveBeenCalledTimes(1);
  });

  it('negative-caches empty SecretString — does not call AWS again within NEG_CACHE_TTL_MS', async () => {
    const fakeSend = vi.fn(async () => ({ SecretString: '' }));
    __setSecretsClientForTests({ send: fakeSend } as unknown as SecretsManagerClient);

    const key1 = await getDevHubApiKey();
    const key2 = await getDevHubApiKey();

    expect(key1).toBeNull();
    expect(key2).toBeNull();
    expect(fakeSend).toHaveBeenCalledTimes(1);
  });
});
