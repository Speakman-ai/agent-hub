/**
 * skill-credentials-github-resolve.test.ts
 *
 * Tests for `resolveUserGithubToken` — the unified per-user GitHub token
 * resolver used by the pre-spawn worktree-clone path.
 *
 * Precedence under test:
 *   1. OAuth user-to-server token via `getActiveAccessToken`
 *   2. Skill-credentials PAT via `getGithubPatForUser`
 *   3. null
 *
 * Strategy: stand up a fresh orgs DB (so the real PAT lookup can hit a
 * row when we want it to) but mock the OAuth-store module so we drive
 * the `getActiveAccessToken` branch directly without exercising the real
 * OAuth refresh code path.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
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

// Drive the OAuth branch independently of the real refresh code path.
let mockOauthImpl: (userId: string, creds: unknown) => Promise<string | null> = async () => null;
vi.mock('./github-connections-store.js', () => ({
  getActiveAccessToken: (userId: string, creds: unknown) => mockOauthImpl(userId, creds),
}));

const { initOrgsDb, setOrgsDbPathForTests } = await import('./orgs.js');
const { createUser } = await import('./users-store.js');
const { upsertUserSkillCredential } = await import('./skill-credentials-store.js');
const { resolveUserGithubToken } = await import('./skill-credentials-github.js');

function freshDb() {
  TMP_DIR = mkdtempSync(path.join(tmpdir(), 'gh-resolve-test-'));
  setOrgsDbPathForTests(path.join(TMP_DIR, 'orgs.db'));
  initOrgsDb();
}

describe('resolveUserGithubToken', () => {
  let userId: string;

  beforeEach(() => {
    freshDb();
    userId = createUser({ username: `u-${Date.now()}`, passwordHash: 'h' }).id;
    mockOauthImpl = async () => null;
  });

  it('returns null for falsy userId without consulting either source', async () => {
    let oauthHits = 0;
    mockOauthImpl = async () => {
      oauthHits++;
      return 'should-not-be-read';
    };
    // Also seed a PAT — if the userId guard fails we'd return this.
    upsertUserSkillCredential({
      userId,
      skillId: 'github',
      keyName: 'GH_TOKEN',
      value: 'pat-that-must-not-be-served-without-a-userId',
      actorUserId: userId,
    });

    expect(await resolveUserGithubToken(null, { oauthCredentials: null })).toBeNull();
    expect(await resolveUserGithubToken(undefined, { oauthCredentials: null })).toBeNull();
    expect(await resolveUserGithubToken('', { oauthCredentials: null })).toBeNull();

    expect(oauthHits).toBe(0);
  });

  it('prefers the OAuth token when both are available (canonical, refreshable identity wins)', async () => {
    const OAUTH = 'gho_oauth_user_to_server_xxxxxxxxxxxxxxxx';
    const PAT = 'ghp_skill_credential_pat_yyyyyyyyyyyyyy';
    mockOauthImpl = async () => OAUTH;
    upsertUserSkillCredential({
      userId,
      skillId: 'github',
      keyName: 'GH_TOKEN',
      value: PAT,
      actorUserId: userId,
    });

    const token = await resolveUserGithubToken(userId, {
      oauthCredentials: { clientId: 'a', clientSecret: 'b' },
    });

    expect(token).toBe(OAUTH);
  });

  it('falls back to the skill-credentials PAT when OAuth returns null', async () => {
    const PAT = 'ghp_only_path_zzzzzzzzzzzzzzzzzzzz';
    mockOauthImpl = async () => null;
    upsertUserSkillCredential({
      userId,
      skillId: 'github',
      keyName: 'GH_TOKEN',
      value: PAT,
      actorUserId: userId,
    });

    const token = await resolveUserGithubToken(userId, { oauthCredentials: null });

    expect(token).toBe(PAT);
  });

  it('returns null when neither path yields a token (downstream falls back to unauth clone)', async () => {
    mockOauthImpl = async () => null;
    // No PAT row inserted.

    const token = await resolveUserGithubToken(userId, { oauthCredentials: null });

    expect(token).toBeNull();
  });

  it('swallows OAuth-path errors and falls through to the PAT — store outage must not break clones', async () => {
    const PAT = 'ghp_recovered_after_oauth_outage';
    mockOauthImpl = async () => {
      throw new Error('orgs DB outage simulating mid-flight failure');
    };
    upsertUserSkillCredential({
      userId,
      skillId: 'github',
      keyName: 'GH_TOKEN',
      value: PAT,
      actorUserId: userId,
    });

    // Suppress the console.warn the helper emits on OAuth failure so test
    // output stays clean; the warn itself is documented behaviour.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const token = await resolveUserGithubToken(userId, { oauthCredentials: null });

    expect(token).toBe(PAT);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('forwards the OAuth credentials object verbatim to getActiveAccessToken', async () => {
    const creds = { clientId: 'cid', clientSecret: 'csecret' };
    const captured: Array<{ userId: string; creds: unknown }> = [];
    mockOauthImpl = async (uid, c) => {
      captured.push({ userId: uid, creds: c });
      return 'irrelevant';
    };

    await resolveUserGithubToken(userId, { oauthCredentials: creds });

    expect(captured).toHaveLength(1);
    expect(captured[0].userId).toBe(userId);
    expect(captured[0].creds).toBe(creds); // identity match, not a clone
  });
});
