import './test/setup.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import {
  createApiKey,
  verifyApiKey,
  isAutopilotWorkerKeyName,
  revokeAutopilotWorkerKeys,
} from './api-keys-store.js';
import { getOrgsDb, initOrgsDb, setOrgsDbPathForTests } from './orgs.js';
import { createUser } from './users-store.js';

describe('api-keys-store — retired Autopilot worker keys', () => {
  let orgsDir: string;
  let userId: string;

  beforeEach(() => {
    orgsDir = mkdtempSync(path.join(os.tmpdir(), 'api-keys-store-orgs-'));
    setOrgsDbPathForTests(path.join(orgsDir, 'orgs.db'));
    initOrgsDb();
    userId = createUser({
      username: `ak-user-${Date.now()}-${Math.random()}`,
      passwordHash: 'h',
    }).id;
  });

  afterEach(() => {
    rmSync(orgsDir, { recursive: true, force: true });
  });

  it('recognizes the autopilot: worker key namespace', () => {
    expect(isAutopilotWorkerKeyName('autopilot:agent-hub:run-123')).toBe(true);
    expect(isAutopilotWorkerKeyName('autopilot:agent-hub:run-123:eval')).toBe(true);
    expect(isAutopilotWorkerKeyName('spawn:sess-1')).toBe(false);
    expect(isAutopilotWorkerKeyName('My key')).toBe(false);
  });

  it('refuses to authenticate an unexpired worker key (would otherwise grant the owner role)', () => {
    // Simulate a worker credential minted before the issuer/guard were removed:
    // a normal (unexpired, unrevoked) api_keys row named autopilot:<proj>:<run>.
    const created = createApiKey(userId, 'autopilot:agent-hub:run-abc', 7);
    expect(created.token).toBeTruthy();
    // A regular per-user key with the same owner would authenticate fine — but
    // the autopilot namespace must be rejected at auth even while still valid.
    expect(verifyApiKey(created.token)).toBeNull();
  });

  it('still authenticates an ordinary per-user key', () => {
    const created = createApiKey(userId, 'My laptop', 7);
    expect(verifyApiKey(created.token)).toMatchObject({ userId, name: 'My laptop' });
  });

  it('revokeAutopilotWorkerKeys revokes only the worker namespace and is idempotent', () => {
    const worker = createApiKey(userId, 'autopilot:agent-hub:run-1', 7);
    const evalKey = createApiKey(userId, 'autopilot:agent-hub:run-1:eval', 7);
    const normal = createApiKey(userId, 'Keep me', 7);

    const revoked = revokeAutopilotWorkerKeys();
    expect(revoked).toBe(2);

    const db = getOrgsDb();
    const rows = db
      .prepare('SELECT name, revoked_at FROM api_keys WHERE user_id = ? ORDER BY name')
      .all(userId) as Array<{ name: string; revoked_at: string | null }>;
    const byName = Object.fromEntries(rows.map((r) => [r.name, r.revoked_at]));
    expect(byName['autopilot:agent-hub:run-1']).not.toBeNull();
    expect(byName['autopilot:agent-hub:run-1:eval']).not.toBeNull();
    expect(byName['Keep me']).toBeNull();

    // Second run touches nothing (only matches revoked_at IS NULL).
    expect(revokeAutopilotWorkerKeys()).toBe(0);

    // Tokens are unusable either way.
    expect(verifyApiKey(worker.token)).toBeNull();
    expect(verifyApiKey(evalKey.token)).toBeNull();
    expect(verifyApiKey(normal.token)).toMatchObject({ userId });
  });

  it('startup migration (initOrgsDb) revokes a worker key persisted by an earlier version', () => {
    // Simulate an upgrade: a worker row exists in the DB before the current
    // server boots. Re-running initOrgsDb() against the same path is what a
    // restart does; it must revoke the surviving worker credential.
    createApiKey(userId, 'autopilot:agent-hub:legacy-run', 7);
    const db = getOrgsDb();
    const before = db
      .prepare("SELECT revoked_at FROM api_keys WHERE name = 'autopilot:agent-hub:legacy-run'")
      .get() as { revoked_at: string | null };
    expect(before.revoked_at).toBeNull();

    initOrgsDb();

    const after = getOrgsDb()
      .prepare("SELECT revoked_at FROM api_keys WHERE name = 'autopilot:agent-hub:legacy-run'")
      .get() as { revoked_at: string | null };
    expect(after.revoked_at).not.toBeNull();
  });
});
