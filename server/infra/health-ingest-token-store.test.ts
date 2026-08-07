import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { initInfraDb, getInfraDb, closeInfraDb } from './infra-db.js';
import {
  createInfraHealthIngestToken,
  getInfraHealthIngestToken,
  resolveInfraHealthIngestToken,
  revokeInfraHealthIngestToken,
  hashInfraHealthToken,
  INFRA_HEALTH_TOKEN_REGEX,
} from './health-ingest-token-store.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'infra-health-token-'));
  initInfraDb(dir);
});

afterEach(() => {
  closeInfraDb();
  rmSync(dir, { recursive: true, force: true });
});

describe('createInfraHealthIngestToken', () => {
  it('mints an ahhealth_ token matching the wire guard', () => {
    const { token } = createInfraHealthIngestToken('p1', 1000);
    expect(token.startsWith('ahhealth_')).toBe(true);
    expect(INFRA_HEALTH_TOKEN_REGEX.test(token)).toBe(true);
  });

  it('never persists the plaintext', () => {
    const { token } = createInfraHealthIngestToken('p1', 1000);
    const row = getInfraDb()
      .prepare('SELECT * FROM infra_health_ingest_tokens WHERE project_id = ?')
      .get('p1') as Record<string, unknown>;
    expect(JSON.stringify(row)).not.toContain(token.slice(20));
    expect(row.token_hash).toBe(hashInfraHealthToken(token));
  });

  it('mints a distinct token each time', () => {
    const first = createInfraHealthIngestToken('p1', 1000).token;
    const second = createInfraHealthIngestToken('p1', 2000).token;
    expect(first).not.toBe(second);
  });

  it('keeps createdAt across a rotation and stamps rotatedAt', () => {
    createInfraHealthIngestToken('p1', 1000);
    const { info } = createInfraHealthIngestToken('p1', 5000);
    expect(info.createdAt).toBe(1000);
    expect(info.rotatedAt).toBe(5000);
  });

  it('invalidates the previous token immediately on rotation', () => {
    // No grace window by design: two live credentials would be a liability.
    const first = createInfraHealthIngestToken('p1', 1000).token;
    const second = createInfraHealthIngestToken('p1', 2000).token;
    expect(resolveInfraHealthIngestToken(first)).toBeNull();
    expect(resolveInfraHealthIngestToken(second)).toEqual({ projectId: 'p1' });
  });
});

describe('resolveInfraHealthIngestToken', () => {
  it('resolves a valid token to its project', () => {
    const { token } = createInfraHealthIngestToken('my-project', 1000);
    expect(resolveInfraHealthIngestToken(token, 2000)).toEqual({ projectId: 'my-project' });
  });

  it('stamps lastUsedAt on a successful resolve', () => {
    const { token } = createInfraHealthIngestToken('p1', 1000);
    expect(getInfraHealthIngestToken('p1')!.lastUsedAt).toBeNull();
    resolveInfraHealthIngestToken(token, 4242);
    expect(getInfraHealthIngestToken('p1')!.lastUsedAt).toBe(4242);
  });

  it('rejects a malformed token without a database lookup', () => {
    for (const bad of ['', 'nope', 'ahhealth_short', 'ahlog_' + 'a'.repeat(40), 'Bearer x']) {
      expect(resolveInfraHealthIngestToken(bad)).toBeNull();
    }
  });

  it('rejects a well-formed token that was never minted', () => {
    createInfraHealthIngestToken('p1', 1000);
    expect(resolveInfraHealthIngestToken(`ahhealth_${'z'.repeat(43)}`)).toBeNull();
  });

  it('does not resolve one project token against another project', () => {
    const a = createInfraHealthIngestToken('p1', 1000).token;
    createInfraHealthIngestToken('p2', 1000);
    expect(resolveInfraHealthIngestToken(a)).toEqual({ projectId: 'p1' });
  });
});

describe('revokeInfraHealthIngestToken', () => {
  it('stops resolving the token but keeps the row', () => {
    const { token } = createInfraHealthIngestToken('p1', 1000);
    expect(revokeInfraHealthIngestToken('p1', 3000)).toBe(true);
    expect(resolveInfraHealthIngestToken(token)).toBeNull();
    expect(getInfraHealthIngestToken('p1')!.revokedAt).toBe(3000);
  });

  it('is idempotent and false when nothing was revoked', () => {
    createInfraHealthIngestToken('p1', 1000);
    expect(revokeInfraHealthIngestToken('p1', 3000)).toBe(true);
    expect(revokeInfraHealthIngestToken('p1', 4000)).toBe(false);
    expect(revokeInfraHealthIngestToken('never-existed', 4000)).toBe(false);
  });

  it('re-minting clears the revocation, so rotate doubles as re-enable', () => {
    createInfraHealthIngestToken('p1', 1000);
    revokeInfraHealthIngestToken('p1', 2000);
    const { token, info } = createInfraHealthIngestToken('p1', 3000);
    expect(info.revokedAt).toBeNull();
    expect(resolveInfraHealthIngestToken(token)).toEqual({ projectId: 'p1' });
  });
});

describe('getInfraHealthIngestToken', () => {
  it('returns null for a project with no token', () => {
    expect(getInfraHealthIngestToken('nope')).toBeNull();
  });

  it('returns only non-secret metadata', () => {
    const { token } = createInfraHealthIngestToken('p1', 1000);
    const info = getInfraHealthIngestToken('p1')!;
    expect(info).not.toHaveProperty('tokenHash');
    expect(JSON.stringify(info)).not.toContain(token.slice(20));
    expect(info.tokenPrefix).toBe(token.slice(0, 'ahhealth_'.length + 8));
  });
});
