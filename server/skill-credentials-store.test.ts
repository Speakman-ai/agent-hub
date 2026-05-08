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
});
