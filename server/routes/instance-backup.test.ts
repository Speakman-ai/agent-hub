/**
 * Tests for the instance-backup migration export.
 *
 * We mount the router on a stub express app with an injectable `authRole`
 * so we can exercise the requireRole gate, then assert the manifest shape
 * and that POST /bundle returns a streamed zip with the expected paths.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import supertest from 'supertest';
import path from 'path';
import os from 'os';
import { writeFileSync, mkdirSync } from 'fs';
import type { AuthenticatedRequest } from '../auth.js';
import type { RouteDeps } from '../types.js';

const dataDir = process.env.AGENT_HUB_DATA_DIR ?? path.join(os.tmpdir(), 'agent-hub-test');

// Seed a couple of files the manifest can stat. The DB is initialized at
// config-load time by db.ts, so it already exists. config.json may not —
// drop a stub so the `config` bucket has something to count.
beforeAll(() => {
  mkdirSync(dataDir, { recursive: true });
  const cfg = path.join(dataDir, 'config.json');
  try {
    writeFileSync(cfg, JSON.stringify({ port: 3051 }), { flag: 'wx' });
  } catch {
    /* already exists */
  }
});

const { default: createInstanceBackupRoutes } = await import('./instance-backup.js');
const cfg = (await import('../config.js')).default;

function buildApp(role: 'Owner' | 'Admin' | 'User' | null) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (role !== null) (req as AuthenticatedRequest).authRole = role;
    next();
  });
  // Minimal RouteDeps — only `config.dataDir` and `serverDir` are used.
  const deps = {
    config: cfg,
    serverDir: path.resolve(__dirname, '..'),
  } as unknown as RouteDeps;
  app.use(createInstanceBackupRoutes(deps));
  return app;
}

describe('GET /api/instance-backup/manifest', () => {
  it('rejects callers without Owner role', async () => {
    const res = await supertest(buildApp('Admin')).get('/api/instance-backup/manifest');
    expect(res.status).toBe(403);
    expect(res.body.requiredRole).toBe('Owner');
  });

  it('rejects unauthenticated callers', async () => {
    const res = await supertest(buildApp(null)).get('/api/instance-backup/manifest');
    expect(res.status).toBe(401);
  });

  it('returns the documented item set for Owner', async () => {
    const res = await supertest(buildApp('Owner')).get('/api/instance-backup/manifest');
    expect(res.status).toBe(200);
    const ids = (res.body.items as Array<{ id: string }>).map((i) => i.id);
    expect(ids).toEqual([
      'db.slim',
      'db.full',
      'db.orgs',
      'config',
      'workspaces',
      'designs',
      'json.kanban',
      'json.wiki',
      'json.workflows',
      'json.notes',
      'json.chat',
    ]);
    for (const item of res.body.items as Array<{
      label: string;
      description: string;
      estimatedBytes: number;
    }>) {
      expect(typeof item.label).toBe('string');
      expect(typeof item.description).toBe('string');
      expect(typeof item.estimatedBytes).toBe('number');
      expect(item.estimatedBytes).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('POST /api/instance-backup/bundle', () => {
  it('rejects empty items', async () => {
    const res = await supertest(buildApp('Owner'))
      .post('/api/instance-backup/bundle')
      .send({ items: [] });
    expect(res.status).toBe(400);
  });

  it('rejects unknown item ids', async () => {
    const res = await supertest(buildApp('Owner'))
      .post('/api/instance-backup/bundle')
      .send({ items: ['db.full', 'not-a-real-bucket'] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not-a-real-bucket/);
  });

  it('streams a zip for ["config"]', async () => {
    const res = await supertest(buildApp('Owner'))
      .post('/api/instance-backup/bundle')
      .send({ items: ['config'] })
      .buffer(true)
      .parse((response, cb) => {
        const chunks: Buffer[] = [];
        response.on('data', (c: Buffer) => chunks.push(c));
        response.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename="agent-hub-backup-.*\.zip"$/,
    );
    const body = res.body as Buffer;
    // PK\x03\x04 = local file header magic for zip.
    expect(body.length).toBeGreaterThan(4);
    expect(body[0]).toBe(0x50);
    expect(body[1]).toBe(0x4b);
    expect(body[2]).toBe(0x03);
    expect(body[3]).toBe(0x04);
  });

  it('streams a zip for ["json.kanban"] including a manifest entry', async () => {
    const res = await supertest(buildApp('Owner'))
      .post('/api/instance-backup/bundle')
      .send({ items: ['json.kanban'] })
      .buffer(true)
      .parse((response, cb) => {
        const chunks: Buffer[] = [];
        response.on('data', (c: Buffer) => chunks.push(c));
        response.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    const body = res.body as Buffer;
    // Both filenames appear inline in the zip's local file headers.
    const text = body.toString('latin1');
    expect(text).toContain('json/kanban.json');
    expect(text).toContain('BACKUP-MANIFEST.json');
  });
});
