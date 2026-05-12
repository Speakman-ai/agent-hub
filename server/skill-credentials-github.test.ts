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
const { upsertUserSkillCredential } = await import('./skill-credentials-store.js');
const { getGithubPatForUser, gitAuthArgsForGithubPat } =
  await import('./skill-credentials-github.js');
const { getOrgsDb } = await import('./orgs.js');

function freshDb() {
  TMP_DIR = mkdtempSync(path.join(tmpdir(), 'gh-pat-test-'));
  setOrgsDbPathForTests(path.join(TMP_DIR, 'orgs.db'));
  initOrgsDb();
}

describe('gitAuthArgsForGithubPat', () => {
  it('returns the canonical -c extraheader argv for github.com when a token is given', () => {
    const args = gitAuthArgsForGithubPat('ghp_secret_value');
    expect(args).toHaveLength(2);
    expect(args[0]).toBe('-c');
    // Header must be scoped to github.com (the trailing slash matters as a URL
    // match prefix in git's http.<url>.* config namespace).
    expect(args[1]).toMatch(/^http\.https:\/\/github\.com\/\.extraheader=/);
    expect(args[1]).toMatch(/^http\.https:\/\/github\.com\/\.extraheader=Authorization: basic /);
    // The base64 payload must encode `x-access-token:<TOKEN>`.
    const b64 = args[1].split('Authorization: basic ')[1];
    expect(Buffer.from(b64, 'base64').toString('utf8')).toBe('x-access-token:ghp_secret_value');
  });

  it('returns an empty argv when token is null / undefined / empty', () => {
    expect(gitAuthArgsForGithubPat(null)).toEqual([]);
    expect(gitAuthArgsForGithubPat(undefined)).toEqual([]);
    expect(gitAuthArgsForGithubPat('')).toEqual([]);
  });

  it('survives tokens that contain shell-special characters (no escape mangling)', () => {
    // Fine-grained PATs can contain `_` and `+`; we encode via base64 so any
    // byte makes it through unmangled.
    const weird = 'github_pat_$weird+!@#%^&*()_value';
    const args = gitAuthArgsForGithubPat(weird);
    const b64 = args[1].split('Authorization: basic ')[1];
    expect(Buffer.from(b64, 'base64').toString('utf8')).toBe(`x-access-token:${weird}`);
  });
});

describe('getGithubPatForUser', () => {
  let userId: string;

  beforeEach(() => {
    freshDb();
    userId = createUser({ username: `u-${Date.now()}`, passwordHash: 'h' }).id;
  });

  it('returns null when no credential row exists for the user', () => {
    expect(getGithubPatForUser(userId)).toBeNull();
  });

  it('returns null for missing / falsy userIds (defensive — never throws)', () => {
    expect(getGithubPatForUser(null)).toBeNull();
    expect(getGithubPatForUser(undefined)).toBeNull();
    expect(getGithubPatForUser('')).toBeNull();
  });

  it('returns the decrypted GH_TOKEN when one is stored under skill_id=github', () => {
    upsertUserSkillCredential({
      userId,
      skillId: 'github',
      keyName: 'GH_TOKEN',
      value: 'ghp_real_token_value_42',
      actorUserId: userId,
    });
    expect(getGithubPatForUser(userId)).toBe('ghp_real_token_value_42');
  });

  it('does NOT return a row stored under a different skill_id (scope is exact)', () => {
    // Belt-and-braces: if a future skill ever uses the same `GH_TOKEN` key
    // name (e.g. a custom "gitlab-mirror" skill), it must not be served back
    // to the github clone path.
    upsertUserSkillCredential({
      userId,
      skillId: 'some-other-skill',
      keyName: 'GH_TOKEN',
      value: 'wrong-skill-token',
      actorUserId: userId,
    });
    expect(getGithubPatForUser(userId)).toBeNull();
  });

  it('does NOT return a row stored under a different key_name (scope is exact)', () => {
    upsertUserSkillCredential({
      userId,
      skillId: 'github',
      keyName: 'GITHUB_PAT', // misspelled / non-canonical key
      value: 'wrong-key-token',
      actorUserId: userId,
    });
    expect(getGithubPatForUser(userId)).toBeNull();
  });

  it('returns null when another user owns the only stored row (no cross-user leak)', () => {
    const otherUserId = createUser({ username: `other-${Date.now()}`, passwordHash: 'h' }).id;
    upsertUserSkillCredential({
      userId: otherUserId,
      skillId: 'github',
      keyName: 'GH_TOKEN',
      value: 'other-users-token',
      actorUserId: otherUserId,
    });
    expect(getGithubPatForUser(userId)).toBeNull();
    expect(getGithubPatForUser(otherUserId)).toBe('other-users-token');
  });

  it('returns null when the stored ciphertext is unreadable (defensive — never throws)', () => {
    // Manually insert a row with malformed ciphertext. The helper must swallow
    // the decrypt failure rather than tearing down the calling clone path.
    getOrgsDb()
      .prepare(
        `INSERT INTO user_skill_credentials (id, user_id, skill_id, key_name, value_enc, masked_preview)
         VALUES (?, ?, 'github', 'GH_TOKEN', ?, NULL)`,
      )
      .run(`row-${Date.now()}`, userId, 'NOT_REAL_CIPHERTEXT_$$$$');
    expect(getGithubPatForUser(userId)).toBeNull();
  });
});
