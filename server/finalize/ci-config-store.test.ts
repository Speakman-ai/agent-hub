/**
 * Unit tests for the server-stored Finalize CI config store.
 *
 * Uses a real in-memory better-sqlite3 so the expression-index upsert
 * (ON CONFLICT(project_id, IFNULL(owner_user_id, ''))) and the NULL-scope
 * matching are exercised against the actual schema, not a fake.
 */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  FINALIZE_SERVER_CI_SCHEMA,
  getServerCiConfig,
  listServerCiConfigs,
  upsertServerCiConfig,
  deleteServerCiConfig,
} from './ci-config-store.js';

function makeStmts() {
  const db = new Database(':memory:');
  db.exec(FINALIZE_SERVER_CI_SCHEMA);
  return {
    getFinalizeServerCi: db.prepare(
      `SELECT id, project_id, owner_user_id, yaml_text, updated_by, updated_at
         FROM finalize_server_ci
        WHERE project_id = ? AND IFNULL(owner_user_id, '') = IFNULL(?, '')`,
    ),
    listFinalizeServerCiForProject: db.prepare(
      `SELECT id, project_id, owner_user_id, yaml_text, updated_by, updated_at
         FROM finalize_server_ci
        WHERE project_id = ?
        ORDER BY (owner_user_id IS NULL) DESC, updated_at DESC`,
    ),
    upsertFinalizeServerCi: db.prepare(
      `INSERT INTO finalize_server_ci
         (id, project_id, owner_user_id, yaml_text, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_id, IFNULL(owner_user_id, '')) DO UPDATE SET
         yaml_text = excluded.yaml_text,
         updated_by = excluded.updated_by,
         updated_at = excluded.updated_at`,
    ),
    deleteFinalizeServerCi: db.prepare(
      `DELETE FROM finalize_server_ci
        WHERE project_id = ? AND IFNULL(owner_user_id, '') = IFNULL(?, '')`,
    ),
  } as never;
}

describe('ci-config-store', () => {
  it('upserts and reads a project-scoped config', () => {
    const stmts = makeStmts();
    upsertServerCiConfig(stmts, { projectId: 'p1', yamlText: 'version: 1', updatedBy: 'u1' });
    const row = getServerCiConfig(stmts, 'p1', null);
    expect(row?.yaml_text).toBe('version: 1');
    expect(row?.owner_user_id).toBeNull();
    expect(row?.updated_by).toBe('u1');
  });

  it('keeps project and personal scopes isolated for the same project', () => {
    const stmts = makeStmts();
    upsertServerCiConfig(stmts, { projectId: 'p1', yamlText: 'PROJECT' });
    upsertServerCiConfig(stmts, { projectId: 'p1', ownerUserId: 'alice', yamlText: 'ALICE' });
    upsertServerCiConfig(stmts, { projectId: 'p1', ownerUserId: 'bob', yamlText: 'BOB' });

    expect(getServerCiConfig(stmts, 'p1', null)?.yaml_text).toBe('PROJECT');
    expect(getServerCiConfig(stmts, 'p1', 'alice')?.yaml_text).toBe('ALICE');
    expect(getServerCiConfig(stmts, 'p1', 'bob')?.yaml_text).toBe('BOB');
    // A user with no personal row does not read the project row via getServerCiConfig.
    expect(getServerCiConfig(stmts, 'p1', 'carol')).toBeNull();
  });

  it('upsert replaces in place (idempotent per scope, no duplicate rows)', () => {
    const stmts = makeStmts();
    upsertServerCiConfig(stmts, { projectId: 'p1', yamlText: 'v1' });
    upsertServerCiConfig(stmts, { projectId: 'p1', yamlText: 'v2' });
    expect(getServerCiConfig(stmts, 'p1', null)?.yaml_text).toBe('v2');
    expect(listServerCiConfigs(stmts, 'p1')).toHaveLength(1);
  });

  it('lists project row first, then personal rows', () => {
    const stmts = makeStmts();
    upsertServerCiConfig(stmts, { projectId: 'p1', ownerUserId: 'alice', yamlText: 'ALICE' });
    upsertServerCiConfig(stmts, { projectId: 'p1', yamlText: 'PROJECT' });
    const rows = listServerCiConfigs(stmts, 'p1');
    expect(rows).toHaveLength(2);
    expect(rows[0].owner_user_id).toBeNull();
  });

  it('deletes only the targeted scope', () => {
    const stmts = makeStmts();
    upsertServerCiConfig(stmts, { projectId: 'p1', yamlText: 'PROJECT' });
    upsertServerCiConfig(stmts, { projectId: 'p1', ownerUserId: 'alice', yamlText: 'ALICE' });

    expect(deleteServerCiConfig(stmts, 'p1', 'alice')).toBe(true);
    expect(getServerCiConfig(stmts, 'p1', 'alice')).toBeNull();
    expect(getServerCiConfig(stmts, 'p1', null)?.yaml_text).toBe('PROJECT');
    // Deleting a non-existent scope reports false.
    expect(deleteServerCiConfig(stmts, 'p1', 'ghost')).toBe(false);
  });

  it('treats a stmts object without the statements as "no config" instead of throwing', () => {
    expect(getServerCiConfig({}, 'p1', null)).toBeNull();
    expect(listServerCiConfigs({}, 'p1')).toEqual([]);
    expect(deleteServerCiConfig({}, 'p1', null)).toBe(false);
    expect(() => upsertServerCiConfig({}, { projectId: 'p1', yamlText: 'x' })).toThrow();
  });
});
