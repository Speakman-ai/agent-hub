/**
 * Regression: `initOrgsDb` must drop the retired `mcp_servers` registry.
 *
 * The registry table was created with `CREATE TABLE IF NOT EXISTS`, so
 * deleting the schema module alone leaves the table (and its two indexes,
 * and the AES key that decrypts its secret columns) sitting on every
 * install that ever booted a version with the feature. These tests seed a
 * pre-removal orgs.db and assert the boot-time migration cleans it up.
 */
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs';
import os from 'os';
import path from 'path';
import { initOrgsDb, getOrgsDb, setOrgsDbPathForTests } from '../orgs.js';

const LEGACY_MCP_SCHEMA = `
  CREATE TABLE IF NOT EXISTS mcp_servers (
    id                     TEXT PRIMARY KEY,
    user_id                TEXT NOT NULL,
    name                   TEXT NOT NULL,
    transport              TEXT NOT NULL CHECK(transport IN ('stdio','http')),
    command                TEXT NOT NULL DEFAULT '',
    args_json              TEXT NOT NULL DEFAULT '[]',
    url                    TEXT NOT NULL DEFAULT '',
    env_encrypted_json     TEXT NOT NULL DEFAULT '',
    headers_encrypted_json TEXT NOT NULL DEFAULT '',
    enabled                INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_mcp_servers_user_id ON mcp_servers(user_id);
  CREATE INDEX IF NOT EXISTS idx_mcp_servers_user_enabled ON mcp_servers(user_id, enabled);
`;

let tmpDir: string;
let dbPath: string;

function tableExists(name: string): boolean {
  const row = getOrgsDb()
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name);
  return !!row;
}

function indexNames(): string[] {
  return getOrgsDb()
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`)
    .all()
    .map((r) => (r as { name: string }).name);
}

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'orgs-mcp-drop-'));
  dbPath = path.join(tmpDir, 'orgs.db');
});

afterEach(() => {
  setOrgsDbPathForTests(null);
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('initOrgsDb — mcp_servers removal migration', () => {
  it('drops a pre-existing mcp_servers table and its indexes', () => {
    const seed = new Database(dbPath);
    seed.exec(LEGACY_MCP_SCHEMA);
    seed.close();

    setOrgsDbPathForTests(dbPath);
    initOrgsDb();

    expect(tableExists('mcp_servers')).toBe(false);
    const indexes = indexNames();
    expect(indexes).not.toContain('idx_mcp_servers_user_id');
    expect(indexes).not.toContain('idx_mcp_servers_user_enabled');
  });

  it('never re-creates mcp_servers on a fresh install', () => {
    setOrgsDbPathForTests(dbPath);
    initOrgsDb();

    expect(tableExists('mcp_servers')).toBe(false);
    // Second boot must stay a no-op rather than throwing on the DROP.
    expect(() => initOrgsDb()).not.toThrow();
    expect(tableExists('mcp_servers')).toBe(false);
  });

  it('deletes the orphaned mcp-servers-secret.key next to orgs.db', () => {
    const keyPath = path.join(tmpDir, 'mcp-servers-secret.key');
    writeFileSync(keyPath, 'a'.repeat(64), { mode: 0o600 });

    setOrgsDbPathForTests(dbPath);
    initOrgsDb();

    expect(existsSync(keyPath)).toBe(false);
  });
});
