import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { initLogsDb, closeLogsDb, getLogsDb, insertLogRecords } from './logs-db.js';
import {
  createLogSource,
  listLogSources,
  getLogSource,
  updateLogSource,
  rotateLogSourceToken,
  revokeLogSourceToken,
  deleteLogSource,
  resolveLogSourceByToken,
  listLogSourceAudit,
  hashLogSourceToken,
  LOG_SOURCE_TOKEN_REGEX,
  LogSourceError,
} from './log-sources-store.js';

const NOW = 1_800_000_000_000;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'log-sources-test-'));
  initLogsDb(dir);
});

afterEach(() => {
  closeLogsDb();
  rmSync(dir, { recursive: true, force: true });
});

describe('createLogSource', () => {
  it('mints an ahlog_ token, reveals it once, and stores only the hash', () => {
    const created = createLogSource(
      {
        projectId: 'proj-a',
        name: 'api',
        serviceName: 'checkout',
        environment: 'prod',
        actorUserId: 'u1',
      },
      NOW,
    );

    expect(created.token).toMatch(LOG_SOURCE_TOKEN_REGEX);
    expect(created.token.startsWith('ahlog_')).toBe(true);
    expect(created.status).toBe('active');
    expect(created.tokenPrefix).toBe(created.token.slice(0, 'ahlog_'.length + 8));
    expect(created.serviceName).toBe('checkout');
    expect(created.environment).toBe('prod');

    // The DB must hold the hash, never the plaintext.
    const row = getLogsDb()
      .prepare('SELECT token_hash, token_prefix FROM log_sources WHERE id = ?')
      .get(created.id) as { token_hash: string; token_prefix: string };
    expect(row.token_hash).toBe(hashLogSourceToken(created.token));
    expect(row.token_hash).not.toContain(created.token);
    expect(row.token_prefix).toBe(created.tokenPrefix);

    // Public read shapes never carry the token.
    const listed = listLogSources('proj-a')[0] as unknown as Record<string, unknown>;
    expect(listed).not.toHaveProperty('token');
    expect(listed).not.toHaveProperty('tokenHash');
  });

  it('gives two sources distinct tokens', () => {
    const a = createLogSource({ projectId: 'p', name: 'a' }, NOW);
    const b = createLogSource({ projectId: 'p', name: 'b' }, NOW);
    expect(a.token).not.toBe(b.token);
    expect(a.tokenPrefix).not.toBe(b.tokenPrefix);
  });

  it('rejects a duplicate (project, name) with a 409 LogSourceError', () => {
    createLogSource({ projectId: 'p', name: 'dupe' }, NOW);
    try {
      createLogSource({ projectId: 'p', name: 'dupe' }, NOW);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(LogSourceError);
      expect((err as LogSourceError).status).toBe(409);
    }
    // Same name in a different project is fine.
    expect(() => createLogSource({ projectId: 'other', name: 'dupe' }, NOW)).not.toThrow();
  });

  it('rejects an empty / oversized name', () => {
    expect(() => createLogSource({ projectId: 'p', name: '  ' }, NOW)).toThrow(LogSourceError);
    expect(() => createLogSource({ projectId: 'p', name: 'x'.repeat(101) }, NOW)).toThrow(
      LogSourceError,
    );
  });

  it('writes a create audit entry attributed to the actor', () => {
    const created = createLogSource({ projectId: 'p', name: 'a', actorUserId: 'alice' }, NOW);
    const audit = listLogSourceAudit('p', created.id);
    expect(audit).toHaveLength(1);
    expect(audit[0].action).toBe('create');
    expect(audit[0].actorUserId).toBe('alice');
  });
});

describe('resolveLogSourceByToken — ingest identity derivation', () => {
  it('resolves a live token to its (project, source) identity', () => {
    const created = createLogSource(
      { projectId: 'proj-a', name: 'web', serviceName: 'frontend', environment: 'staging' },
      NOW,
    );
    const resolved = resolveLogSourceByToken(created.token);
    expect(resolved).toEqual({
      projectId: 'proj-a',
      sourceId: created.id,
      name: 'web',
      serviceName: 'frontend',
      environment: 'staging',
    });
  });

  it('identity comes only from the token — body-declared ids are irrelevant', () => {
    // The resolver takes ONLY the token. A caller cannot smuggle a different
    // project/source: whatever they put in a request body is never consulted.
    const created = createLogSource({ projectId: 'real-project', name: 'src' }, NOW);
    const resolved = resolveLogSourceByToken(created.token);
    expect(resolved?.projectId).toBe('real-project');
    expect(resolved?.sourceId).toBe(created.id);
  });

  it('returns null for malformed, unknown, or non-ahlog tokens', () => {
    expect(resolveLogSourceByToken('not-a-token')).toBeNull();
    expect(resolveLogSourceByToken('ahub_' + 'a'.repeat(43))).toBeNull();
    expect(resolveLogSourceByToken('ahlog_' + 'a'.repeat(43))).toBeNull();
    expect(resolveLogSourceByToken('')).toBeNull();
  });
});

describe('rotateLogSourceToken', () => {
  it('invalidates the old token and activates the new one', () => {
    const created = createLogSource({ projectId: 'p', name: 'a' }, NOW);
    const oldToken = created.token;

    const rotated = rotateLogSourceToken('p', created.id, 'u1', NOW + 1000);
    expect(rotated).not.toBeNull();
    expect(rotated!.token).not.toBe(oldToken);
    expect(rotated!.rotatedAt).toBe(NOW + 1000);

    expect(resolveLogSourceByToken(oldToken)).toBeNull();
    expect(resolveLogSourceByToken(rotated!.token)?.sourceId).toBe(created.id);

    const audit = listLogSourceAudit('p', created.id);
    expect(audit[0].action).toBe('rotate');
  });

  it('re-activates a revoked source', () => {
    const created = createLogSource({ projectId: 'p', name: 'a' }, NOW);
    revokeLogSourceToken('p', created.id, 'u1', NOW);
    expect(getLogSource('p', created.id)!.status).toBe('revoked');

    const rotated = rotateLogSourceToken('p', created.id, 'u1', NOW + 1);
    expect(rotated!.status).toBe('active');
    expect(resolveLogSourceByToken(rotated!.token)?.sourceId).toBe(created.id);
  });

  it('returns null for a source in another project', () => {
    const created = createLogSource({ projectId: 'p', name: 'a' }, NOW);
    expect(rotateLogSourceToken('other', created.id, 'u1', NOW)).toBeNull();
  });
});

describe('revokeLogSourceToken', () => {
  it('write-disables the token but keeps the row for audit', () => {
    const created = createLogSource({ projectId: 'p', name: 'a' }, NOW);
    const token = created.token;

    const revoked = revokeLogSourceToken('p', created.id, 'u1', NOW + 5);
    expect(revoked!.status).toBe('revoked');
    expect(revoked!.revokedAt).toBe(NOW + 5);
    expect(resolveLogSourceByToken(token)).toBeNull();

    // Row still present + audit recorded.
    expect(getLogSource('p', created.id)).not.toBeNull();
    expect(listLogSourceAudit('p', created.id).some((a) => a.action === 'revoke')).toBe(true);
  });

  it('is idempotent', () => {
    const created = createLogSource({ projectId: 'p', name: 'a' }, NOW);
    revokeLogSourceToken('p', created.id, 'u1', NOW);
    const again = revokeLogSourceToken('p', created.id, 'u1', NOW + 1);
    expect(again!.status).toBe('revoked');
    // Only one revoke audit row (second call is a no-op).
    expect(listLogSourceAudit('p', created.id).filter((a) => a.action === 'revoke')).toHaveLength(
      1,
    );
  });
});

describe('updateLogSource', () => {
  it('updates metadata without touching the token', () => {
    const created = createLogSource({ projectId: 'p', name: 'a', serviceName: 'old' }, NOW);
    const updated = updateLogSource('p', created.id, { name: 'b', serviceName: 'new' }, 'u1', NOW);
    expect(updated!.name).toBe('b');
    expect(updated!.serviceName).toBe('new');
    expect(updated!.tokenPrefix).toBe(created.tokenPrefix);
    expect(resolveLogSourceByToken(created.token)?.name).toBe('b');
    expect(listLogSourceAudit('p', created.id).some((a) => a.action === 'update')).toBe(true);
  });

  it('clears a facet when passed null', () => {
    const created = createLogSource({ projectId: 'p', name: 'a', environment: 'prod' }, NOW);
    const updated = updateLogSource('p', created.id, { environment: null }, 'u1', NOW);
    expect(updated!.environment).toBeNull();
  });

  it('409s on a name collision with a sibling source', () => {
    createLogSource({ projectId: 'p', name: 'taken' }, NOW);
    const b = createLogSource({ projectId: 'p', name: 'free' }, NOW);
    expect(() => updateLogSource('p', b.id, { name: 'taken' }, 'u1', NOW)).toThrow(LogSourceError);
  });

  it('returns null for an unknown source', () => {
    expect(updateLogSource('p', 'ghost', { name: 'x' }, 'u1', NOW)).toBeNull();
  });
});

describe('deleteLogSource', () => {
  it('removes the row and its token', () => {
    const created = createLogSource({ projectId: 'p', name: 'a' }, NOW);
    expect(deleteLogSource('p', created.id, 'u1', NOW)).toBe(true);
    expect(getLogSource('p', created.id)).toBeNull();
    expect(resolveLogSourceByToken(created.token)).toBeNull();
    // Audit row persists after the source is gone.
    expect(listLogSourceAudit('p', created.id).some((a) => a.action === 'delete')).toBe(true);
  });

  it('returns false for an unknown source', () => {
    expect(deleteLogSource('p', 'ghost', 'u1', NOW)).toBe(false);
  });
});

describe('lastIngestAt overlay', () => {
  it('is null for a source with no records and reflects the newest ingest once records land', () => {
    const a = createLogSource({ projectId: 'p', name: 'a' }, NOW);
    const b = createLogSource({ projectId: 'p', name: 'b' }, NOW);

    // No records yet — both null in list and get.
    expect(listLogSources('p').every((s) => s.lastIngestAt === null)).toBe(true);
    expect(getLogSource('p', a.id)?.lastIngestAt).toBeNull();

    insertLogRecords(
      [
        { projectId: 'p', sourceId: a.id, timeUnixNano: NOW * 1_000_000, body: 'first' },
        { projectId: 'p', sourceId: a.id, timeUnixNano: NOW * 1_000_000, body: 'second' },
      ],
      NOW + 1000,
    );
    insertLogRecords(
      [{ projectId: 'p', sourceId: a.id, timeUnixNano: NOW * 1_000_000, body: 'third' }],
      NOW + 5000,
    );

    // Source a reflects the newest ingested_at; source b stays null.
    expect(getLogSource('p', a.id)?.lastIngestAt).toBe(NOW + 5000);
    expect(getLogSource('p', b.id)?.lastIngestAt).toBeNull();
    const listed = listLogSources('p');
    expect(listed.find((s) => s.id === a.id)?.lastIngestAt).toBe(NOW + 5000);
    expect(listed.find((s) => s.id === b.id)?.lastIngestAt).toBeNull();
  });
});
