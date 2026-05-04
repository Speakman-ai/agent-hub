import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the two store modules the resolver depends on so we don't need
// a live orgs.db for these unit tests.
vi.mock('./integration-provider-runtime.js', () => ({
  getIntegrationProviderConfig: vi.fn(),
}));
vi.mock('./user-integrations-store.js', () => ({
  listForUser: vi.fn(),
}));

import { resolveNangoSpawnOverride } from './spawn-nango-env.js';
import { getIntegrationProviderConfig } from './integration-provider-runtime.js';
import { listForUser } from './user-integrations-store.js';

const mockedGetConfig = vi.mocked(getIntegrationProviderConfig);
const mockedListForUser = vi.mocked(listForUser);

function okConfig(overrides: Partial<{ secretKey: string; baseUrl: string }> = {}) {
  return {
    ok: true as const,
    mode: 'shared' as const,
    provider: 'nango-cloud' as const,
    secretKey: overrides.secretKey ?? 'nango_secret_abc',
    baseUrl: overrides.baseUrl ?? 'https://api.nango.dev',
    webhookSecret: '',
    enabled: true,
    source: 'env' as const,
  };
}

describe('resolveNangoSpawnOverride', () => {
  beforeEach(() => {
    mockedGetConfig.mockReset();
    mockedListForUser.mockReset();
  });

  it('returns null for an anonymous spawn (null ownerUserId)', () => {
    expect(resolveNangoSpawnOverride(null)).toBeNull();
    // Lookup must not even be attempted when there's no owner.
    expect(mockedGetConfig).not.toHaveBeenCalled();
    expect(mockedListForUser).not.toHaveBeenCalled();
  });

  it('returns null for an empty-string ownerUserId', () => {
    expect(resolveNangoSpawnOverride('')).toBeNull();
    expect(mockedGetConfig).not.toHaveBeenCalled();
  });

  it('returns null when the IntegrationProvider is not configured', () => {
    mockedGetConfig.mockReturnValue({
      ok: false,
      reason: 'shared-mode-missing-env',
      mode: 'shared',
      provider: 'nango-cloud',
      baseUrl: 'https://api.nango.dev',
    });
    expect(resolveNangoSpawnOverride('alice')).toBeNull();
    // No need to query user_integrations when there's no secret to use.
    expect(mockedListForUser).not.toHaveBeenCalled();
  });

  it('returns null when the IntegrationProvider is disabled', () => {
    mockedGetConfig.mockReturnValue({
      ok: false,
      reason: 'disabled',
      mode: 'byo',
      provider: 'nango-cloud',
      baseUrl: 'https://api.nango.dev',
    });
    expect(resolveNangoSpawnOverride('alice')).toBeNull();
  });

  it('returns an override with the resolved secret + baseUrl + connections', () => {
    mockedGetConfig.mockReturnValue(
      okConfig({ secretKey: 'nango_secret_abc', baseUrl: 'https://api.nango.dev' }),
    );
    mockedListForUser.mockReturnValue([
      {
        userId: 'alice',
        app: 'slack',
        connectionId: 'conn_abc',
        status: 'CONNECTED',
        metadata: null,
        createdAt: '2026-05-04T00:00:00Z',
        updatedAt: '2026-05-04T00:00:00Z',
      },
      {
        userId: 'alice',
        app: 'google-mail',
        connectionId: 'conn_def',
        status: 'CONNECTED',
        metadata: null,
        createdAt: '2026-05-04T00:00:00Z',
        updatedAt: '2026-05-04T00:00:00Z',
      },
    ]);
    const out = resolveNangoSpawnOverride('alice');
    expect(out).toEqual({
      secretKey: 'nango_secret_abc',
      providerBaseUrl: 'https://api.nango.dev',
      connections: { slack: 'conn_abc', 'google-mail': 'conn_def' },
    });
    expect(mockedListForUser).toHaveBeenCalledWith('alice');
  });

  it('only includes CONNECTED rows in the connections map', () => {
    mockedGetConfig.mockReturnValue(okConfig());
    mockedListForUser.mockReturnValue([
      {
        userId: 'alice',
        app: 'slack',
        connectionId: 'conn_connected',
        status: 'CONNECTED',
        metadata: null,
        createdAt: '',
        updatedAt: '',
      },
      {
        userId: 'alice',
        app: 'google-mail',
        connectionId: 'conn_pending',
        status: 'PENDING',
        metadata: null,
        createdAt: '',
        updatedAt: '',
      },
      {
        userId: 'alice',
        app: 'github',
        connectionId: 'conn_revoked',
        status: 'REVOKED',
        metadata: null,
        createdAt: '',
        updatedAt: '',
      },
      {
        userId: 'alice',
        app: 'notion',
        connectionId: 'conn_error',
        status: 'ERROR',
        metadata: null,
        createdAt: '',
        updatedAt: '',
      },
    ]);
    const out = resolveNangoSpawnOverride('alice');
    expect(out?.connections).toEqual({ slack: 'conn_connected' });
  });

  it('returns an override with empty connections when the user has none', () => {
    mockedGetConfig.mockReturnValue(okConfig());
    mockedListForUser.mockReturnValue([]);
    const out = resolveNangoSpawnOverride('alice');
    expect(out).toEqual({
      secretKey: 'nango_secret_abc',
      providerBaseUrl: 'https://api.nango.dev',
      connections: {},
    });
  });

  it('only ever queries the requested ownerUserId (cross-user isolation)', () => {
    mockedGetConfig.mockReturnValue(okConfig());
    mockedListForUser.mockImplementation((uid: string) => {
      if (uid !== 'alice') {
        throw new Error(`store leaked across users: queried ${uid}`);
      }
      return [
        {
          userId: 'alice',
          app: 'slack',
          connectionId: 'conn_alice_slack',
          status: 'CONNECTED',
          metadata: null,
          createdAt: '',
          updatedAt: '',
        },
      ];
    });
    const out = resolveNangoSpawnOverride('alice');
    expect(out?.connections).toEqual({ slack: 'conn_alice_slack' });
    // The store was hit exactly once, with alice — bob's rows can't
    // appear no matter what the underlying table looks like.
    expect(mockedListForUser).toHaveBeenCalledTimes(1);
    expect(mockedListForUser).toHaveBeenCalledWith('alice');
  });
});
