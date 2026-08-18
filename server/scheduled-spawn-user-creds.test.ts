import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Per-user CLI cred override used by scheduled cron spawns (and any other
 * one-shot that builds env via `buildSpawnEnv` + `userOverride`).
 */

const mockUserAuth = vi.hoisted(() => ({
  claude: {} as Record<
    string,
    { anthropicApiKey: string | null; claudeCodeOAuthToken: string | null }
  >,
}));

vi.mock('./users-store.js', () => ({
  getUserClaudeAuth: vi.fn((userId: string) => mockUserAuth.claude[userId] ?? null),
  getUserCursorAuth: vi.fn(() => null),
  getUserGeminiAuth: vi.fn(() => null),
  getUserCodexAuth: vi.fn(() => null),
  getUserGrokAuth: vi.fn(() => null),
}));

const { resolveUserCliCredOverride } = await import('./per-user-cli-spawn.js');

describe('resolveUserCliCredOverride', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUserAuth.claude = {};
  });

  it('returns null for a missing/empty user', () => {
    expect(resolveUserCliCredOverride(null)).toBeNull();
    expect(resolveUserCliCredOverride('   ')).toBeNull();
  });

  it('returns null when the user has no stored keys', () => {
    mockUserAuth.claude['user-empty'] = { anthropicApiKey: null, claudeCodeOAuthToken: null };
    expect(resolveUserCliCredOverride('user-empty')).toBeNull();
  });

  it('builds an override from the user stored Claude api key', () => {
    mockUserAuth.claude['user-a'] = {
      anthropicApiKey: 'sk-ant-user-a',
      claudeCodeOAuthToken: null,
    };
    expect(resolveUserCliCredOverride('user-a')).toMatchObject({
      anthropicApiKey: 'sk-ant-user-a',
      claudeCodeOAuthToken: null,
    });
  });
});
