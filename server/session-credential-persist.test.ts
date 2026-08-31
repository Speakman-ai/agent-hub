import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { tmpdir } from 'os';

// Capture credential writes without touching orgs.db / crypto.
const upsertMock = vi.fn((opts: { keyName: string }) => ({
  id: `row-${opts.keyName}`,
  skill_id: 'survey-tracker',
  key_name: opts.keyName,
  masked_preview: '••••abcd',
  last_used_at: null,
  updated_at: 'now',
  created_at: 'now',
}));

vi.mock('./skill-credentials-store.js', () => ({
  upsertUserSkillCredential: (opts: unknown) => upsertMock(opts as { keyName: string }),
}));

import {
  normalizePersistTarget,
  persistSessionCredentialToSkill,
} from './session-credential-persist.js';
import { SessionCredentialRequestError } from './session-credential-requests.js';

function makeSkillDir(root: string, skillId: string, credentialNames: string[]): void {
  const skillDir = path.join(root, skillId);
  mkdirSync(skillDir, { recursive: true });
  const creds = credentialNames
    .map((n) => `  - name: ${n}\n    label: ${n}\n    required: false\n    type: secret`)
    .join('\n');
  writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: ${skillId}\ncredentials:\n${creds}\n---\n# ${skillId}\n`,
    'utf8',
  );
}

describe('normalizePersistTarget', () => {
  it('accepts a valid target and trims key names', () => {
    const t = normalizePersistTarget({
      skillId: 'survey-tracker',
      map: { username: ' USER ', password: 'PASS' },
    });
    expect(t).toEqual({ skillId: 'survey-tracker', map: { username: 'USER', password: 'PASS' } });
  });

  it('returns null for absent, non-object, or empty-map payloads', () => {
    expect(normalizePersistTarget(undefined)).toBeNull();
    expect(normalizePersistTarget('x')).toBeNull();
    expect(normalizePersistTarget({ skillId: 'survey-tracker', map: {} })).toBeNull();
    expect(normalizePersistTarget({ skillId: '', map: { a: 'B' } })).toBeNull();
    expect(normalizePersistTarget({ skillId: 'ok', map: { a: 5 } })).toBeNull();
  });

  it('rejects an oversized map (>6 entries)', () => {
    const map: Record<string, string> = {};
    for (let i = 0; i < 7; i++) map[`f${i}`] = `K${i}`;
    expect(normalizePersistTarget({ skillId: 'ok', map })).toBeNull();
  });

  it('rejects a map with duplicate destination credential keys', () => {
    // { password: "LOGIN", username: "LOGIN" } would upsert twice to LOGIN, the
    // later value silently overwriting the earlier and persisting the wrong
    // secret. The authoritative normalizer must reject it outright.
    expect(
      normalizePersistTarget({
        skillId: 'survey-tracker',
        map: { password: 'LOGIN', username: 'LOGIN' },
      }),
    ).toBeNull();
  });
});

describe('persistSessionCredentialToSkill', () => {
  let root: string;
  beforeEach(() => {
    upsertMock.mockClear();
    root = mkdtempSync(path.join(tmpdir(), 'session-cred-persist-'));
    makeSkillDir(root, 'survey-tracker', [
      'SURVEYTRACKER_API_DATA_USERNAME',
      'SURVEYTRACKER_API_DATA_PASSWORD',
    ]);
  });

  it('stores declared keys under the owner and reports them', () => {
    const result = persistSessionCredentialToSkill({
      ownerUserId: 'owner-1',
      actorUserId: 'owner-1',
      target: {
        skillId: 'survey-tracker',
        map: {
          username: 'SURVEYTRACKER_API_DATA_USERNAME',
          password: 'SURVEYTRACKER_API_DATA_PASSWORD',
        },
      },
      values: { username: 'ryan', password: 'hunter2' },
      projectSkillsDirs: [root],
    });

    expect(result.stored.sort()).toEqual([
      'SURVEYTRACKER_API_DATA_PASSWORD',
      'SURVEYTRACKER_API_DATA_USERNAME',
    ]);
    expect(result.skipped).toEqual([]);
    expect(upsertMock).toHaveBeenCalledTimes(2);
    expect(upsertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'owner-1',
        skillId: 'survey-tracker',
        keyName: 'SURVEYTRACKER_API_DATA_USERNAME',
        value: 'ryan',
      }),
    );
  });

  it('skips keys the skill does not declare, storing only the valid ones', () => {
    const result = persistSessionCredentialToSkill({
      ownerUserId: 'owner-1',
      actorUserId: 'owner-1',
      target: {
        skillId: 'survey-tracker',
        map: {
          username: 'SURVEYTRACKER_API_DATA_USERNAME',
          extra: 'NOT_A_DECLARED_KEY',
        },
      },
      values: { username: 'ryan', extra: 'value' },
      projectSkillsDirs: [root],
    });

    expect(result.stored).toEqual(['SURVEYTRACKER_API_DATA_USERNAME']);
    expect(result.skipped).toEqual([
      { keyName: 'NOT_A_DECLARED_KEY', reason: 'not-declared-by-skill' },
    ]);
    expect(upsertMock).toHaveBeenCalledTimes(1);
  });

  it('skips a declared key whose field has no value', () => {
    const result = persistSessionCredentialToSkill({
      ownerUserId: 'owner-1',
      actorUserId: 'owner-1',
      target: {
        skillId: 'survey-tracker',
        map: { username: 'SURVEYTRACKER_API_DATA_USERNAME' },
      },
      values: { username: '   ' },
      projectSkillsDirs: [root],
    });
    expect(result.stored).toEqual([]);
    expect(result.skipped).toEqual([
      { keyName: 'SURVEYTRACKER_API_DATA_USERNAME', reason: 'no-value-for-field' },
    ]);
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it('records a per-key store failure as skipped without discarding earlier successful writes', () => {
    // First write succeeds, second throws — the whole op must not unwind to
    // stored:[]; the successful key stays reported so the client can disclose
    // the partial save instead of claiming nothing was saved.
    upsertMock.mockImplementationOnce((opts: { keyName: string }) => ({
      id: `row-${opts.keyName}`,
      skill_id: 'survey-tracker',
      key_name: opts.keyName,
      masked_preview: '••••abcd',
      last_used_at: null,
      updated_at: 'now',
      created_at: 'now',
    }));
    upsertMock.mockImplementationOnce(() => {
      throw new Error('db write failed');
    });

    const result = persistSessionCredentialToSkill({
      ownerUserId: 'owner-1',
      actorUserId: 'owner-1',
      target: {
        skillId: 'survey-tracker',
        map: {
          username: 'SURVEYTRACKER_API_DATA_USERNAME',
          password: 'SURVEYTRACKER_API_DATA_PASSWORD',
        },
      },
      values: { username: 'ryan', password: 'hunter2' },
      projectSkillsDirs: [root],
    });

    expect(result.stored).toEqual(['SURVEYTRACKER_API_DATA_USERNAME']);
    expect(result.skipped).toEqual([
      { keyName: 'SURVEYTRACKER_API_DATA_PASSWORD', reason: 'store-failed' },
    ]);
    expect(upsertMock).toHaveBeenCalledTimes(2);
  });

  it('throws when the skill declares no credentials to persist into', () => {
    makeSkillDir(root, 'empty-skill', []);
    expect(() =>
      persistSessionCredentialToSkill({
        ownerUserId: 'owner-1',
        actorUserId: 'owner-1',
        target: { skillId: 'empty-skill', map: { username: 'FOO' } },
        values: { username: 'x' },
        projectSkillsDirs: [root],
      }),
    ).toThrow(SessionCredentialRequestError);
  });

  it('throws when the skill id is malformed', () => {
    expect(() =>
      persistSessionCredentialToSkill({
        ownerUserId: 'owner-1',
        actorUserId: 'owner-1',
        target: { skillId: 'bad id!', map: { username: 'FOO' } },
        values: { username: 'x' },
        projectSkillsDirs: [root],
      }),
    ).toThrow(/skillId is invalid/);
  });
});
