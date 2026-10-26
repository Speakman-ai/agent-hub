import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDb } from '../db.js';
import { wipeTables } from '../test/destructive-db.js';
import { MASK } from '../secret-crypto.js';
import { loadProjectEnvForSpawn, replacePreviewSecrets } from '../preview/preview-secrets-store.js';
import {
  countEnvironmentSecrets,
  EnvironmentSecretDecryptError,
  deleteAllEnvironmentSecretsForProject,
  deleteEnvironmentSecret,
  listEnvironmentSecretAudit,
  listEnvironmentSecrets,
  loadEnvironmentSecretsForDeploy,
  replaceEnvironmentSecrets,
} from './deployment-env-secrets-store.js';

const P = 'proj-env-secrets-test';

beforeEach(() => {
  wipeTables(getDb(), [
    'deployment_env_secrets',
    'deployment_env_secret_audit',
    'worktree_preview_secrets',
    'worktree_preview_secret_audit',
  ]);
});

describe('deployment environment secrets store', () => {
  it('masks secret values on list and shows plain values', () => {
    const rows = replaceEnvironmentSecrets(P, 'prod', [
      { key: 'AWS_SECRET_ACCESS_KEY', value: 'shh-secret' },
      { key: 'AWS_REGION', value: 'us-east-1', kind: 'plain' },
    ]);
    expect(rows.map((r) => [r.key, r.kind, r.value])).toEqual([
      ['AWS_REGION', 'plain', 'us-east-1'],
      ['AWS_SECRET_ACCESS_KEY', 'secret', MASK],
    ]);
  });

  it('scopes rows to one environment', () => {
    replaceEnvironmentSecrets(P, 'prod', [{ key: 'A', value: 'prod-a' }]);
    replaceEnvironmentSecrets(P, 'dev', [{ key: 'A', value: 'dev-a' }]);
    expect(loadEnvironmentSecretsForDeploy(P, 'prod').env.A).toBe('prod-a');
    expect(loadEnvironmentSecretsForDeploy(P, 'dev').env.A).toBe('dev-a');
    expect(loadEnvironmentSecretsForDeploy(P, 'staging').env).toEqual({});
    expect(countEnvironmentSecrets(P)).toEqual({ prod: 1, dev: 1 });
  });

  it('never leaks into the project spawn env used by chat and CI', () => {
    replacePreviewSecrets(P, [{ key: 'PROJECT_KEY', value: 'p' }]);
    replaceEnvironmentSecrets(P, 'prod', [{ key: 'PROD_KEY', value: 'secret-prod' }]);
    expect(loadProjectEnvForSpawn(P)).toEqual({ PROJECT_KEY: 'p' });
  });

  it('keeps a stored secret when MASK is sent back, and deletes omitted keys', () => {
    replaceEnvironmentSecrets(P, 'prod', [
      { key: 'KEEP', value: 'original' },
      { key: 'DROP', value: 'gone' },
    ]);
    replaceEnvironmentSecrets(P, 'prod', [{ key: 'KEEP', value: MASK }]);
    const loaded = loadEnvironmentSecretsForDeploy(P, 'prod');
    expect(loaded.env).toEqual({ KEEP: 'original' });
  });

  it('rejects MASK for a key with no stored secret', () => {
    expect(() => replaceEnvironmentSecrets(P, 'prod', [{ key: 'NEW', value: MASK }])).toThrow(
      /required/,
    );
    replaceEnvironmentSecrets(P, 'prod', [{ key: 'PLAIN', value: 'x', kind: 'plain' }]);
    expect(() => replaceEnvironmentSecrets(P, 'prod', [{ key: 'PLAIN', value: MASK }])).toThrow(
      /required/,
    );
  });

  it('rejects reserved and malformed keys without writing anything', () => {
    expect(() =>
      replaceEnvironmentSecrets(P, 'prod', [
        { key: 'OK', value: 'value-1' },
        { key: 'AGENT_HUB_API_KEY', value: 'value-1' },
      ]),
    ).toThrow(/reserved/);
    expect(() =>
      replaceEnvironmentSecrets(P, 'prod', [{ key: '1BAD', value: 'value-1' }]),
    ).toThrow();
    expect(listEnvironmentSecrets(P, 'prod')).toEqual([]);
  });

  it('rejects secret values too short to mask in deploy logs, but allows plain ones', () => {
    expect(() => replaceEnvironmentSecrets(P, 'prod', [{ key: 'PIN', value: 'abc' }])).toThrow(
      /at least 4 characters/,
    );
    expect(() =>
      replaceEnvironmentSecrets(P, 'prod', [{ key: 'PW', value: 'long-secret\n密码' }]),
    ).toThrow(/at least 4 characters/);
    expect(listEnvironmentSecrets(P, 'prod')).toEqual([]);
    replaceEnvironmentSecrets(P, 'prod', [{ key: 'PIN', value: 'abc', kind: 'plain' }]);
    expect(loadEnvironmentSecretsForDeploy(P, 'prod').env.PIN).toBe('abc');
  });

  it('throws naming the key, not the value, when a row cannot be decrypted', () => {
    replaceEnvironmentSecrets(P, 'prod', [
      { key: 'GOOD', value: 'good-value' },
      { key: 'BAD', value: 'bad-value' },
    ]);
    getDb()
      .prepare(`UPDATE deployment_env_secrets SET value_ciphertext = 'x:y:z' WHERE key = 'BAD'`)
      .run();
    let thrown: unknown;
    try {
      loadEnvironmentSecretsForDeploy(P, 'prod');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(EnvironmentSecretDecryptError);
    expect((thrown as Error).message).toContain('BAD');
    expect((thrown as Error).message).not.toContain('good-value');
  });

  it('returns only secret-kind values for redaction', () => {
    replaceEnvironmentSecrets(P, 'prod', [
      { key: 'TOKEN', value: 'tok-value' },
      { key: 'REGION', value: 'us-east-1', kind: 'plain' },
    ]);
    expect(loadEnvironmentSecretsForDeploy(P, 'prod').redactValues).toEqual(['tok-value']);
  });

  it('audits reads with the deployment id and never the values', () => {
    replaceEnvironmentSecrets(P, 'prod', [{ key: 'TOKEN', value: 'tok-value' }], 'user-1');
    loadEnvironmentSecretsForDeploy(P, 'prod', { deploymentId: 'dep-1' });
    const audit = listEnvironmentSecretAudit(P, 'prod');
    expect(audit[0]).toMatchObject({ action: 'read', keys: 'TOKEN', deployment_id: 'dep-1' });
    expect(audit[1]).toMatchObject({ action: 'upsert', actor_user_id: 'user-1' });
    expect(JSON.stringify(audit)).not.toContain('tok-value');
  });

  it('deletes one key and everything on project delete', () => {
    replaceEnvironmentSecrets(P, 'prod', [
      { key: 'A', value: 'value-a' },
      { key: 'B', value: 'value-b' },
    ]);
    expect(deleteEnvironmentSecret(P, 'prod', 'A')).toBe(true);
    expect(deleteEnvironmentSecret(P, 'prod', 'A')).toBe(false);
    deleteAllEnvironmentSecretsForProject(P);
    expect(listEnvironmentSecrets(P, 'prod')).toEqual([]);
    expect(listEnvironmentSecretAudit(P, 'prod')).toEqual([]);
  });
});

describe('deployment environment secrets audit atomicity', () => {
  const failAudit = (action: string) =>
    getDb().exec(
      `CREATE TRIGGER fail_env_secret_audit BEFORE INSERT ON deployment_env_secret_audit
         WHEN NEW.action = '${action}'
         BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END`,
    );
  afterEach(() => {
    getDb().exec('DROP TRIGGER IF EXISTS fail_env_secret_audit');
  });

  it('rolls back a replace when the upsert audit insert fails', () => {
    replaceEnvironmentSecrets(P, 'prod', [{ key: 'KEEP', value: 'original' }]);
    failAudit('upsert');
    expect(() =>
      replaceEnvironmentSecrets(P, 'prod', [{ key: 'KEEP', value: 'changed-value' }]),
    ).toThrow(/audit unavailable/);
    expect(loadEnvironmentSecretsForDeploy(P, 'prod').env).toEqual({ KEEP: 'original' });
  });

  it('rolls back keys removed by a replace when the delete audit insert fails', () => {
    replaceEnvironmentSecrets(P, 'prod', [
      { key: 'KEEP', value: 'original' },
      { key: 'DROP', value: 'dropped' },
    ]);
    failAudit('delete');
    expect(() => replaceEnvironmentSecrets(P, 'prod', [{ key: 'KEEP', value: MASK }])).toThrow(
      /audit unavailable/,
    );
    expect(Object.keys(loadEnvironmentSecretsForDeploy(P, 'prod').env).sort()).toEqual([
      'DROP',
      'KEEP',
    ]);
  });

  it('rolls back a single-key delete when its audit insert fails, so a retry still works', () => {
    replaceEnvironmentSecrets(P, 'prod', [{ key: 'A', value: 'value-a' }]);
    failAudit('delete');
    expect(() => deleteEnvironmentSecret(P, 'prod', 'A')).toThrow(/audit unavailable/);
    expect(listEnvironmentSecrets(P, 'prod').map((r) => r.key)).toEqual(['A']);
    getDb().exec('DROP TRIGGER fail_env_secret_audit');
    expect(deleteEnvironmentSecret(P, 'prod', 'A')).toBe(true);
    expect(listEnvironmentSecretAudit(P, 'prod')[0]).toMatchObject({ action: 'delete', keys: 'A' });
  });

  it('refuses to hand secrets to a deploy when the read audit insert fails', () => {
    replaceEnvironmentSecrets(P, 'prod', [{ key: 'A', value: 'value-a' }]);
    failAudit('read');
    expect(() => loadEnvironmentSecretsForDeploy(P, 'prod', { deploymentId: 'd1' })).toThrow(
      /audit unavailable/,
    );
  });
});
