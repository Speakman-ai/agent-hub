/**
 * Unit tests for mcp-servers-store.ts — schema, CRUD, AES-256-GCM round-trip,
 * and the MASK preservation contract.
 */
import './setup.js';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import path from 'path';
import os from 'os';
import { mkdirSync } from 'fs';

import {
  MASK,
  createMcpServer,
  deleteMcpServer,
  ensureMcpServersSchema,
  listEnabledMcpServersForUser,
  listMcpServersForUser,
  listMcpServersMaskedForUser,
  readMcpServerRow,
  updateMcpServer,
  __resetMcpServersStoreForTests,
  __setMcpServersKeyFilePathForTests,
} from '../mcp-servers-store.js';
import { getOrgsDb, getActiveOrgId, initOrgsDb } from '../orgs.js';
import { createUser } from '../users-store.js';
import { createMembership } from '../memberships-store.js';

let userId: string;

beforeAll(() => {
  // Pin the encryption key file under the per-test data dir so each run
  // gets a fresh key rather than reusing whatever happens to be on disk.
  const keyDir = path.join(os.tmpdir(), `mcp-store-test-${process.pid}`);
  mkdirSync(keyDir, { recursive: true });
  __setMcpServersKeyFilePathForTests(path.join(keyDir, 'mcp-test.key'));

  initOrgsDb();
  ensureMcpServersSchema();

  const orgId = getActiveOrgId();
  const u = createUser({
    username: `mcp-test-${Date.now()}`,
    passwordHash: 'h',
    createdAt: '2026-01-01T00:00:00Z',
  });
  createMembership(u.id, orgId, 'Admin');
  userId = u.id;
});

beforeEach(() => {
  // Wipe rows between tests so list assertions are deterministic.
  getOrgsDb().prepare('DELETE FROM mcp_servers WHERE user_id = ?').run(userId);
});

describe('schema', () => {
  it('mcp_servers table is present with the expected columns', () => {
    const cols = getOrgsDb().prepare("PRAGMA table_info('mcp_servers')").all() as Array<{
      name: string;
    }>;
    const names = cols.map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'id',
        'user_id',
        'name',
        'catalog_id',
        'transport',
        'command',
        'args_json',
        'url',
        'env_encrypted_json',
        'headers_encrypted_json',
        'enabled',
        'created_at',
        'updated_at',
      ]),
    );
  });

  it('ensureMcpServersSchema is idempotent', () => {
    expect(() => ensureMcpServersSchema()).not.toThrow();
    expect(() => ensureMcpServersSchema()).not.toThrow();
  });
});

describe('createMcpServer', () => {
  it('rejects empty name', () => {
    expect(() =>
      createMcpServer({
        userId,
        name: '   ',
        transport: 'stdio',
        command: 'npx',
      }),
    ).toThrow(/name is required/);
  });

  it('rejects stdio transport without a command', () => {
    expect(() => createMcpServer({ userId, name: 'bad', transport: 'stdio', command: '' })).toThrow(
      /stdio transport requires/,
    );
  });

  it('rejects http transport without a url', () => {
    expect(() => createMcpServer({ userId, name: 'bad', transport: 'http', url: '' })).toThrow(
      /http transport requires/,
    );
  });

  it('inserts a stdio row, returns it masked, and stores env encrypted at rest', () => {
    const masked = createMcpServer({
      userId,
      name: 'notion',
      catalogId: 'notion',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@notionhq/notion-mcp-server'],
      env: { OPENAPI_MCP_HEADERS: 'secret-token' },
    });

    expect(masked.name).toBe('notion');
    expect(masked.transport).toBe('stdio');
    expect(masked.env).toEqual({ OPENAPI_MCP_HEADERS: MASK });

    // Raw row decrypts back to the plaintext.
    const raw = readMcpServerRow(masked.id);
    expect(raw?.env).toEqual({ OPENAPI_MCP_HEADERS: 'secret-token' });

    // The stored ciphertext is NOT plaintext.
    const dbRow = getOrgsDb()
      .prepare('SELECT env_encrypted_json FROM mcp_servers WHERE id = ?')
      .get(masked.id) as { env_encrypted_json: string };
    expect(dbRow.env_encrypted_json).not.toContain('secret-token');
    expect(dbRow.env_encrypted_json).toMatch(/^[^:]+:[^:]+:[^:]+$/); // iv:tag:ciphertext
  });

  it('inserts an http row with encrypted headers', () => {
    const masked = createMcpServer({
      userId,
      name: 'linear',
      catalogId: 'linear',
      transport: 'http',
      url: 'https://mcp.linear.app/sse',
      headers: { Authorization: 'Bearer lin_api_xxx' },
    });
    expect(masked.headers).toEqual({ Authorization: MASK });
    expect(readMcpServerRow(masked.id)?.headers).toEqual({
      Authorization: 'Bearer lin_api_xxx',
    });
  });
});

describe('updateMcpServer', () => {
  it('preserves existing secrets when env value is sent back as MASK', () => {
    const created = createMcpServer({
      userId,
      name: 'linear',
      transport: 'http',
      url: 'https://mcp.linear.app/sse',
      headers: { Authorization: 'Bearer original' },
    });

    const updated = updateMcpServer(created.id, {
      headers: { Authorization: MASK },
      enabled: false,
    });
    expect(updated).not.toBeNull();
    expect(updated!.enabled).toBe(false);

    // Plaintext is unchanged.
    expect(readMcpServerRow(created.id)?.headers).toEqual({ Authorization: 'Bearer original' });
  });

  it('replaces a secret when the value is a real string', () => {
    const created = createMcpServer({
      userId,
      name: 'linear',
      transport: 'http',
      url: 'https://mcp.linear.app/sse',
      headers: { Authorization: 'Bearer original' },
    });

    updateMcpServer(created.id, { headers: { Authorization: 'Bearer rotated' } });
    expect(readMcpServerRow(created.id)?.headers).toEqual({ Authorization: 'Bearer rotated' });
  });

  it('drops keys that are absent from the incoming map (full-replacement semantics)', () => {
    const created = createMcpServer({
      userId,
      name: 'notion',
      transport: 'stdio',
      command: 'npx',
      env: { OPENAPI_MCP_HEADERS: 'a', EXTRA: 'b' },
    });

    updateMcpServer(created.id, { env: { OPENAPI_MCP_HEADERS: MASK } });
    const after = readMcpServerRow(created.id);
    expect(after?.env).toEqual({ OPENAPI_MCP_HEADERS: 'a' }); // EXTRA dropped
  });

  it('returns null for an unknown id', () => {
    expect(updateMcpServer('mcp_does_not_exist', { name: 'x' })).toBeNull();
  });
});

describe('listing', () => {
  it('listMcpServersForUser returns rows sorted by created_at', async () => {
    const a = createMcpServer({ userId, name: 'a', transport: 'http', url: 'https://a/' });
    // small delay so created_at is deterministic
    await new Promise((r) => setTimeout(r, 1100));
    const b = createMcpServer({ userId, name: 'b', transport: 'http', url: 'https://b/' });

    const list = listMcpServersForUser(userId);
    expect(list.map((r) => r.id)).toEqual([a.id, b.id]);
  });

  it('listMcpServersMaskedForUser masks env/headers values', () => {
    createMcpServer({
      userId,
      name: 'linear',
      transport: 'http',
      url: 'https://mcp.linear.app/sse',
      headers: { Authorization: 'Bearer xyz' },
    });
    const list = listMcpServersMaskedForUser(userId);
    expect(list[0].headers).toEqual({ Authorization: MASK });
  });

  it('listEnabledMcpServersForUser excludes disabled rows', () => {
    const a = createMcpServer({
      userId,
      name: 'a',
      transport: 'http',
      url: 'https://a/',
      enabled: true,
    });
    createMcpServer({
      userId,
      name: 'b',
      transport: 'http',
      url: 'https://b/',
      enabled: false,
    });
    const list = listEnabledMcpServersForUser(userId);
    expect(list.map((r) => r.id)).toEqual([a.id]);
  });
});

describe('deleteMcpServer', () => {
  it('removes the row and returns true', () => {
    const created = createMcpServer({
      userId,
      name: 'doomed',
      transport: 'http',
      url: 'https://x/',
    });
    expect(deleteMcpServer(created.id)).toBe(true);
    expect(readMcpServerRow(created.id)).toBeNull();
  });

  it('returns false for an unknown id', () => {
    expect(deleteMcpServer('mcp_nope')).toBe(false);
  });
});

describe('encryption', () => {
  it('round-trips an empty env without error and stores empty blob', () => {
    const created = createMcpServer({
      userId,
      name: 'noenv',
      transport: 'stdio',
      command: 'echo',
      env: {},
    });
    const dbRow = getOrgsDb()
      .prepare('SELECT env_encrypted_json FROM mcp_servers WHERE id = ?')
      .get(created.id) as { env_encrypted_json: string };
    expect(dbRow.env_encrypted_json).toBe('');
    expect(readMcpServerRow(created.id)?.env).toEqual({});
  });

  it('uses a fresh IV per write — same plaintext yields different ciphertext', () => {
    __resetMcpServersStoreForTests();
    // Re-pin (resetting wiped both key and path).
    const keyDir = path.join(os.tmpdir(), `mcp-store-test-${process.pid}`);
    __setMcpServersKeyFilePathForTests(path.join(keyDir, 'mcp-test.key'));

    const a = createMcpServer({
      userId,
      name: 'a',
      transport: 'http',
      url: 'https://a/',
      headers: { Authorization: 'Bearer same' },
    });
    const b = createMcpServer({
      userId,
      name: 'b',
      transport: 'http',
      url: 'https://b/',
      headers: { Authorization: 'Bearer same' },
    });

    const rows = getOrgsDb()
      .prepare('SELECT id, headers_encrypted_json FROM mcp_servers WHERE id IN (?, ?) ORDER BY id')
      .all(a.id, b.id) as Array<{ id: string; headers_encrypted_json: string }>;
    expect(rows[0].headers_encrypted_json).not.toBe(rows[1].headers_encrypted_json);
  });
});
