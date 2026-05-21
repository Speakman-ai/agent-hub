import './test/setup.js';
import { describe, it, expect, beforeEach } from 'vitest';
import { mergeProjectSecretsSpawnEnv } from './project-secrets-spawn.js';
import { replacePreviewSecrets } from './preview/preview-secrets-store.js';
import { getDb } from './db.js';

const PROJECT_ID = 'proj-spawn-secrets';

beforeEach(() => {
  const db = getDb();
  db.prepare(`DELETE FROM worktree_preview_secrets WHERE project_id = ?`).run(PROJECT_ID);
  db.prepare(`DELETE FROM worktree_preview_secret_audit WHERE project_id = ?`).run(PROJECT_ID);
});

describe('mergeProjectSecretsSpawnEnv', () => {
  it('injects decrypted secret-kind values without overwriting existing env keys', () => {
    replacePreviewSecrets(PROJECT_ID, [
      { key: 'MY_API_KEY', value: 'sk-test', kind: 'secret' },
      { key: 'FEATURE_FLAG', value: 'on', kind: 'plain' },
    ]);

    const base: NodeJS.ProcessEnv = { MY_API_KEY: 'hub-wins', PATH: '/usr/bin' };
    mergeProjectSecretsSpawnEnv(base, { projectId: PROJECT_ID, sessionId: 'sess-1' });

    expect(base.MY_API_KEY).toBe('hub-wins');
    expect(base.FEATURE_FLAG).toBe('on');
    expect(base.PATH).toBe('/usr/bin');
  });

  it('is a no-op when the project has no secrets', () => {
    const base: NodeJS.ProcessEnv = { EXISTING: '1' };
    mergeProjectSecretsSpawnEnv(base, { projectId: PROJECT_ID, sessionId: null });
    expect(base).toEqual({ EXISTING: '1' });
  });

  it('overwrites stale host env when overwriteExisting is true (compose spawn)', () => {
    replacePreviewSecrets(PROJECT_ID, [
      { key: 'AWS_ACCESS_KEY_ID', value: 'AKIANEW', kind: 'secret' },
      { key: 'AWS_SECRET_ACCESS_KEY', value: 'secret-new', kind: 'secret' },
    ]);
    const base: NodeJS.ProcessEnv = {
      AWS_ACCESS_KEY_ID: 'AKIAOLD',
      AWS_SECRET_ACCESS_KEY: 'secret-old',
    };
    mergeProjectSecretsSpawnEnv(base, {
      projectId: PROJECT_ID,
      sessionId: 'sess-compose',
      overwriteExisting: true,
    });
    expect(base.AWS_ACCESS_KEY_ID).toBe('AKIANEW');
    expect(base.AWS_SECRET_ACCESS_KEY).toBe('secret-new');
  });
});
