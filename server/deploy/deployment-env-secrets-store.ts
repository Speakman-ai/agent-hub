/**
 * Encrypted secrets scoped to one deploy environment. DDL and the reasoning for
 * a dedicated table live in `deployment-env-secrets-schema.ts`.
 *
 * Validation, encryption, and masking match project secrets
 * (`preview/preview-secrets-store.ts`) so the REST and UI contract is the same:
 * `secret`-kind values come back as MASK, and PUTting MASK keeps the stored
 * value. Values are decrypted only by {@link loadEnvironmentSecretsForDeploy}.
 */
import { v4 as uuidv4 } from 'uuid';
import { encryptSecret, decryptSecret, MASK } from '../secret-crypto.js';
import { getDb } from '../db.js';
import { isFullyRedactable, MIN_REDACT_LENGTH } from './secret-redaction.js';
import {
  PreviewSecretValidationError,
  splitIvTag,
  validateKeyOrThrow,
  validateKindOrThrow,
  validateValueOrThrow,
  type PreviewSecretInput,
  type SecretKind,
} from '../preview/preview-secrets-store.js';

export interface EnvironmentSecretRow {
  id: string;
  project_id: string;
  environment_name: string;
  key: string;
  kind: SecretKind;
  /** Plaintext for `plain` rows, MASK for `secret` rows. */
  value: string;
  created_at: string;
  updated_at: string;
}

interface RawRow {
  id: string;
  project_id: string;
  environment_name: string;
  key: string;
  value_ciphertext: string;
  value_iv: string;
  value_tag: string;
  kind: SecretKind;
  created_at: string;
  updated_at: string;
}

/** Decrypted env for one deployment, plus the values its logs must not show. */
export interface EnvironmentSecretsForDeploy {
  env: Record<string, string>;
  /** Decrypted values of `secret`-kind rows, for step-output redaction. */
  redactValues: string[];
}

const MAX_ENV_NAME = 255;

/** One or more environment secrets failed to decrypt. Names keys, never values. */
export class EnvironmentSecretDecryptError extends Error {
  constructor(readonly keys: readonly string[]) {
    super(
      `Deploy environment secret(s) could not be decrypted: ${keys.join(', ')}. ` +
        `Re-save them in the environment's Secrets settings.`,
    );
    this.name = 'EnvironmentSecretDecryptError';
  }
}

function normalizeEnvironmentName(name: string): string {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (!trimmed) throw new PreviewSecretValidationError('environment name is required');
  if (trimmed.length > MAX_ENV_NAME) {
    throw new PreviewSecretValidationError(`environment name exceeds ${MAX_ENV_NAME} chars`);
  }
  return trimmed;
}

function rowToPublic(row: RawRow): EnvironmentSecretRow {
  let value = MASK;
  if (row.kind === 'plain') {
    try {
      value = decryptSecret(row.value_ciphertext);
    } catch {
      // Corrupt row: show the mask rather than failing the whole list.
    }
  }
  return {
    id: row.id,
    project_id: row.project_id,
    environment_name: row.environment_name,
    key: row.key,
    kind: row.kind,
    value,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function rawRows(projectId: string, environmentName: string): RawRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM deployment_env_secrets
        WHERE project_id = ? AND environment_name = ?
        ORDER BY key ASC`,
    )
    .all(projectId, environmentName) as RawRow[];
}

function appendAudit(opts: {
  projectId: string;
  environmentName: string;
  keys: readonly string[];
  action: 'upsert' | 'delete' | 'read';
  actorUserId?: string | null;
  deploymentId?: string | null;
}): void {
  if (opts.keys.length === 0) return;
  getDb()
    .prepare(
      `INSERT INTO deployment_env_secret_audit
         (id, project_id, environment_name, keys, action, actor_user_id, deployment_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      uuidv4(),
      opts.projectId,
      opts.environmentName,
      opts.keys.join('|'),
      opts.action,
      opts.actorUserId ?? null,
      opts.deploymentId ?? null,
    );
}

export function listEnvironmentSecrets(
  projectId: string,
  environmentName: string,
): EnvironmentSecretRow[] {
  return rawRows(projectId, normalizeEnvironmentName(environmentName)).map(rowToPublic);
}

/** Environment name → number of stored secrets, for settings summaries. */
export function countEnvironmentSecrets(projectId: string): Record<string, number> {
  const rows = getDb()
    .prepare(
      `SELECT environment_name, COUNT(*) AS n FROM deployment_env_secrets
        WHERE project_id = ? GROUP BY environment_name`,
    )
    .all(projectId) as Array<{ environment_name: string; n: number }>;
  return Object.fromEntries(rows.map((r) => [r.environment_name, r.n]));
}

/**
 * Replace the environment's full secret set. Keys missing from `inputs` are
 * deleted; a `secret` row sent with the MASK value keeps its stored ciphertext.
 * Read, validation, write, and audit run as one transaction.
 */
export function replaceEnvironmentSecrets(
  projectId: string,
  environmentNameRaw: string,
  inputs: readonly PreviewSecretInput[],
  actorUserId?: string | null,
): EnvironmentSecretRow[] {
  const environmentName = normalizeEnvironmentName(environmentNameRaw);
  const db = getDb();
  // One transaction from the read of existing rows through the audit inserts:
  // the MASK check and the diff see the same snapshot as the write, and a
  // failed audit insert rolls the whole change back.
  db.transaction(() => {
    const existingByKey = new Map(rawRows(projectId, environmentName).map((r) => [r.key, r]));

    const writes: Array<{ key: string; kind: SecretKind; value: string | null }> = [];
    const seen = new Set<string>();
    for (const raw of inputs) {
      validateKeyOrThrow(raw.key);
      const kind = validateKindOrThrow(raw.kind, raw.key);
      if (seen.has(raw.key)) {
        throw new PreviewSecretValidationError(`duplicate key "${raw.key}" in batch`);
      }
      seen.add(raw.key);
      // MASK means "keep the stored value" only for an existing secret row: a
      // plain row lists its real plaintext, so it never round-trips as MASK.
      if (kind === 'secret' && raw.value === MASK) {
        if (existingByKey.get(raw.key)?.kind !== 'secret') {
          throw new PreviewSecretValidationError(`value for "${raw.key}" is required`);
        }
        writes.push({ key: raw.key, kind, value: null });
        continue;
      }
      validateValueOrThrow(raw.value, raw.key);
      // Deploy output masks secret values; a value too short to mask safely would
      // be printed in the clear, so refuse it rather than store it.
      if (kind === 'secret' && !isFullyRedactable(raw.value)) {
        throw new PreviewSecretValidationError(
          `secret value for "${raw.key}" must be at least ${MIN_REDACT_LENGTH} characters on every line so it can be masked in deploy logs; store short non-sensitive values as plain`,
        );
      }
      writes.push({ key: raw.key, kind, value: raw.value });
    }

    const del = db.prepare(
      `DELETE FROM deployment_env_secrets
          WHERE project_id = ? AND environment_name = ? AND key = ?`,
    );
    for (const key of existingByKey.keys()) {
      if (!seen.has(key)) del.run(projectId, environmentName, key);
    }
    const insert = db.prepare(
      `INSERT INTO deployment_env_secrets
           (id, project_id, environment_name, key, value_ciphertext, value_iv, value_tag, kind)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const update = db.prepare(
      `UPDATE deployment_env_secrets
            SET value_ciphertext = ?, value_iv = ?, value_tag = ?, kind = ?,
                updated_at = datetime('now')
          WHERE project_id = ? AND environment_name = ? AND key = ?`,
    );
    for (const w of writes) {
      if (w.value === null) continue;
      const ciphertext = encryptSecret(w.value);
      const { iv, tag } = splitIvTag(ciphertext);
      if (existingByKey.has(w.key)) {
        update.run(ciphertext, iv, tag, w.kind, projectId, environmentName, w.key);
      } else {
        insert.run(uuidv4(), projectId, environmentName, w.key, ciphertext, iv, tag, w.kind);
      }
    }
    const removed = [...existingByKey.keys()].filter((k) => !seen.has(k));
    appendAudit({
      projectId,
      environmentName,
      keys: writes.map((w) => w.key),
      action: 'upsert',
      actorUserId,
    });
    appendAudit({ projectId, environmentName, keys: removed, action: 'delete', actorUserId });
  })();

  return listEnvironmentSecrets(projectId, environmentName);
}

/** Delete one key. Returns false when it did not exist. */
export function deleteEnvironmentSecret(
  projectId: string,
  environmentNameRaw: string,
  key: string,
  actorUserId?: string | null,
): boolean {
  const environmentName = normalizeEnvironmentName(environmentNameRaw);
  validateKeyOrThrow(key);
  const db = getDb();
  return db.transaction(() => {
    const result = db
      .prepare(
        `DELETE FROM deployment_env_secrets
          WHERE project_id = ? AND environment_name = ? AND key = ?`,
      )
      .run(projectId, environmentName, key);
    if (result.changes === 0) return false;
    appendAudit({ projectId, environmentName, keys: [key], action: 'delete', actorUserId });
    return true;
  })();
}

/** Remove every environment secret and audit row for a project (project delete). */
export function deleteAllEnvironmentSecretsForProject(projectId: string): void {
  const db = getDb();
  db.transaction(() => {
    db.prepare(`DELETE FROM deployment_env_secrets WHERE project_id = ?`).run(projectId);
    db.prepare(`DELETE FROM deployment_env_secret_audit WHERE project_id = ?`).run(projectId);
  })();
}

/**
 * Decrypt an environment's secrets for one deployment. The only decrypting
 * reader of this table. Throws {@link EnvironmentSecretDecryptError} when any
 * row fails to decrypt. The audit row records which keys were read and by
 * which deployment, never the values.
 */
export function loadEnvironmentSecretsForDeploy(
  projectId: string,
  environmentNameRaw: string,
  context: { deploymentId?: string | null } = {},
): EnvironmentSecretsForDeploy {
  const environmentName = normalizeEnvironmentName(environmentNameRaw);
  const env: Record<string, string> = Object.create(null) as Record<string, string>;
  const redactValues: string[] = [];
  const keysRead: string[] = [];
  const failedKeys: string[] = [];
  for (const row of rawRows(projectId, environmentName)) {
    try {
      const value = decryptSecret(row.value_ciphertext);
      env[row.key] = value;
      keysRead.push(row.key);
      if (row.kind === 'secret') redactValues.push(value);
    } catch {
      failedKeys.push(row.key);
    }
  }
  appendAudit({
    projectId,
    environmentName,
    keys: keysRead,
    action: 'read',
    deploymentId: context.deploymentId ?? null,
  });
  // Fail closed: project secrets are already in the job env, so skipping a
  // corrupt override would deploy with the project-wide credential instead.
  if (failedKeys.length > 0) throw new EnvironmentSecretDecryptError(failedKeys);
  return { env, redactValues };
}

export function listEnvironmentSecretAudit(
  projectId: string,
  environmentName: string,
  limit = 50,
): Array<{
  keys: string;
  action: 'upsert' | 'delete' | 'read';
  actor_user_id: string | null;
  deployment_id: string | null;
  created_at: string;
}> {
  return getDb()
    .prepare(
      `SELECT keys, action, actor_user_id, deployment_id, created_at
         FROM deployment_env_secret_audit
        WHERE project_id = ? AND environment_name = ?
        ORDER BY created_at DESC, rowid DESC
        LIMIT ?`,
    )
    .all(projectId, environmentName.trim(), limit) as Array<{
    keys: string;
    action: 'upsert' | 'delete' | 'read';
    actor_user_id: string | null;
    deployment_id: string | null;
    created_at: string;
  }>;
}
