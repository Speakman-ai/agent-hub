import { describe, it, expect, beforeEach, vi } from 'vitest';
import { tmpdir } from 'os';
import { mkdtempSync } from 'fs';
import path from 'path';

let TMP_DIR = '';
vi.mock('./config.js', () => ({
  default: {
    apiKey: null,
    get dataDir() {
      return TMP_DIR;
    },
  },
}));

const { initOrgsDb, setOrgsDbPathForTests } = await import('./orgs.js');
const { createUser } = await import('./users-store.js');
const { upsertUserSkillCredential, mergeDecryptedSkillCredentialsIntoEnv } =
  await import('./skill-credentials-store.js');

function freshDb() {
  TMP_DIR = mkdtempSync(path.join(tmpdir(), 'skill-cred-store-test-'));
  setOrgsDbPathForTests(path.join(TMP_DIR, 'orgs.db'));
  initOrgsDb();
}

describe('mergeDecryptedSkillCredentialsIntoEnv', () => {
  let userId: string;
  beforeEach(() => {
    freshDb();
    userId = createUser({ username: `u-${Date.now()}`, passwordHash: 'h' }).id;
  });

  it('applies duplicate env keys in deterministic skill_id order (SQLite row order is not)', () => {
    // Insert reverse lexicographic order — without ORDER BY the first merged
    // value could flip between runs.
    upsertUserSkillCredential({
      userId,
      skillId: 'zeta-skill',
      keyName: 'SHARED_KEY',
      value: 'from-zeta',
      actorUserId: userId,
    });
    upsertUserSkillCredential({
      userId,
      skillId: 'alpha-skill',
      keyName: 'SHARED_KEY',
      value: 'from-alpha',
      actorUserId: userId,
    });

    const env: NodeJS.ProcessEnv = {};
    mergeDecryptedSkillCredentialsIntoEnv(userId, ['zeta-skill', 'alpha-skill'], env);

    expect(env.SHARED_KEY).toBe('from-alpha');
  });

  it('honours the per-skill schema allowlist — keys outside the allowlist do NOT merge', () => {
    // Simulate the cross-project leak the reviewer flagged in PR #825 [7/10]:
    // the row was accepted via project B's forked SKILL.md (extra env key),
    // but project A's spawn resolves a stricter schema. The extra key must
    // not appear in project A's spawn env even though it sits in storage.
    upsertUserSkillCredential({
      userId,
      skillId: 'github',
      keyName: 'GH_TOKEN',
      value: 'declared',
      actorUserId: userId,
    });
    upsertUserSkillCredential({
      userId,
      skillId: 'github',
      keyName: 'PROJECT_B_ONLY_KEY',
      value: 'leaked-if-broken',
      actorUserId: userId,
    });

    const allow = new Map<string, ReadonlySet<string>>([['github', new Set(['GH_TOKEN'])]]);
    const env: NodeJS.ProcessEnv = {};
    mergeDecryptedSkillCredentialsIntoEnv(userId, ['github'], env, allow);

    expect(env.GH_TOKEN).toBe('declared');
    expect(env.PROJECT_B_ONLY_KEY).toBeUndefined();
  });

  it('skill-id missing from the allowlist Map is treated as an empty allowlist (no merges)', () => {
    upsertUserSkillCredential({
      userId,
      skillId: 'github',
      keyName: 'GH_TOKEN',
      value: 'declared',
      actorUserId: userId,
    });
    // Empty allowlist — caller resolved the schema and got `error` or
    // `[]`. Either way the spawn should leak nothing.
    const env: NodeJS.ProcessEnv = {};
    mergeDecryptedSkillCredentialsIntoEnv(userId, ['github'], env, new Map());
    expect(env.GH_TOKEN).toBeUndefined();
  });

  it('omitting the allowlist preserves historical no-filter behavior', () => {
    upsertUserSkillCredential({
      userId,
      skillId: 'github',
      keyName: 'GH_TOKEN',
      value: 'plain',
      actorUserId: userId,
    });
    const env: NodeJS.ProcessEnv = {};
    mergeDecryptedSkillCredentialsIntoEnv(userId, ['github'], env);
    expect(env.GH_TOKEN).toBe('plain');
  });
});
