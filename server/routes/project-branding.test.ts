import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import createProjectBrandingRoutes from './project-branding.js';
import type { Project, RouteDeps } from '../types.js';

const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const PNG_DATA_URL = `data:image/png;base64,${PNG_1X1}`;

let rootDir: string;
let project: Project;
let saveProjects: ReturnType<typeof vi.fn>;

function brandingFiles(): string[] {
  const dir = path.join(rootDir, 'proj1', 'branding');
  return existsSync(dir) ? readdirSync(dir) : [];
}

function buildApp(role = 'Admin') {
  saveProjects = vi.fn();
  const deps = {
    findProject: (id: string) => (id === project.id ? project : null),
    saveProjects,
    getProjectDataDir: (id: string) => path.join(rootDir, id),
  } as unknown as RouteDeps;

  const app = express();
  app.use(express.json({ limit: '20mb' }));
  app.use((req, _res, next) => {
    const header = req.headers['x-test-role'];
    (req as unknown as { authRole?: string }).authRole = typeof header === 'string' ? header : role;
    next();
  });
  app.use(createProjectBrandingRoutes(deps));
  return app;
}

beforeEach(() => {
  rootDir = mkdtempSync(path.join(tmpdir(), 'proj-branding-route-'));
  project = { id: 'proj1', name: 'Proj 1', cwd: '/tmp/p1', ahw: '/tmp/p1', agents: [] };
});

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true });
});

describe('project email logo routes', () => {
  it('uploads a logo, persists metadata + file, and reports it back', async () => {
    const app = buildApp();
    const put = await request(app)
      .put('/api/projects/proj1/email-logo')
      .send({ dataUrl: PNG_DATA_URL });
    expect(put.status).toBe(200);
    expect(put.body.emailLogo.filename).toMatch(/^email-logo-.+\.png$/);
    expect(put.body.emailLogo.contentType).toBe('image/png');
    expect(project.emailLogo?.filename).toBe(put.body.emailLogo.filename);
    expect(saveProjects).toHaveBeenCalledTimes(1);
    expect(existsSync(path.join(rootDir, 'proj1', 'branding', put.body.emailLogo.filename))).toBe(
      true,
    );

    const meta = await request(app).get('/api/projects/proj1/email-logo');
    expect(meta.status).toBe(200);
    expect(meta.body.emailLogo.filename).toBe(put.body.emailLogo.filename);

    const raw = await request(app).get('/api/projects/proj1/email-logo/raw');
    expect(raw.status).toBe(200);
    expect(raw.headers['content-type']).toContain('image/png');
  });

  it('replacing a logo removes the superseded file, leaving exactly one', async () => {
    const app = buildApp();
    const first = await request(app)
      .put('/api/projects/proj1/email-logo')
      .send({ dataUrl: PNG_DATA_URL });
    const second = await request(app)
      .put('/api/projects/proj1/email-logo')
      .send({ dataUrl: `data:image/gif;base64,R0lGODlhAQABAAAAACw=` });
    expect(second.status).toBe(200);
    expect(second.body.emailLogo.filename).not.toBe(first.body.emailLogo.filename);
    expect(brandingFiles()).toEqual([second.body.emailLogo.filename]);
  });

  it('rolls back on a persistence failure, leaving the prior override intact', async () => {
    const app = buildApp();
    // First upload succeeds.
    const first = await request(app)
      .put('/api/projects/proj1/email-logo')
      .send({ dataUrl: PNG_DATA_URL });
    const firstLogo = first.body.emailLogo;

    // Second upload: persistence throws — the request must fail without
    // destroying the first logo (file + metadata).
    saveProjects.mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    const second = await request(app)
      .put('/api/projects/proj1/email-logo')
      .send({ dataUrl: `data:image/gif;base64,R0lGODlhAQABAAAAACw=` });
    expect(second.status).toBe(500);
    // Metadata still points at the first logo, whose file still exists...
    expect(project.emailLogo?.filename).toBe(firstLogo.filename);
    expect(existsSync(path.join(rootDir, 'proj1', 'branding', firstLogo.filename))).toBe(true);
    // ...and the orphaned second file was cleaned up (only the first remains).
    expect(brandingFiles()).toEqual([firstLogo.filename]);
  });

  it('removes the logo on DELETE', async () => {
    const app = buildApp();
    const put = await request(app)
      .put('/api/projects/proj1/email-logo')
      .send({ dataUrl: PNG_DATA_URL });
    const del = await request(app).delete('/api/projects/proj1/email-logo');
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ ok: true, emailLogo: null });
    expect(project.emailLogo).toBeUndefined();
    expect(existsSync(path.join(rootDir, 'proj1', 'branding', put.body.emailLogo.filename))).toBe(
      false,
    );
  });

  it('DELETE rollback keeps the file + metadata when persistence fails', async () => {
    const app = buildApp();
    const put = await request(app)
      .put('/api/projects/proj1/email-logo')
      .send({ dataUrl: PNG_DATA_URL });
    const logo = put.body.emailLogo;

    saveProjects.mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    const del = await request(app).delete('/api/projects/proj1/email-logo');
    expect(del.status).toBe(500);
    // Metadata restored and the bytes are NOT deleted.
    expect(project.emailLogo?.filename).toBe(logo.filename);
    expect(existsSync(path.join(rootDir, 'proj1', 'branding', logo.filename))).toBe(true);
  });

  it('serves 404 for raw bytes when no logo is set', async () => {
    const app = buildApp();
    const raw = await request(app).get('/api/projects/proj1/email-logo/raw');
    expect(raw.status).toBe(404);
  });

  it('rejects a non-admin uploader with 403 and does not mutate the project', async () => {
    const app = buildApp('User');
    const put = await request(app)
      .put('/api/projects/proj1/email-logo')
      .send({ dataUrl: PNG_DATA_URL });
    expect(put.status).toBe(403);
    expect(project.emailLogo).toBeUndefined();
    expect(saveProjects).not.toHaveBeenCalled();
  });

  it('rejects a disallowed image type with 400', async () => {
    const app = buildApp();
    const put = await request(app)
      .put('/api/projects/proj1/email-logo')
      .send({ dataUrl: 'data:text/plain;base64,aGVsbG8=' });
    expect(put.status).toBe(400);
    expect(project.emailLogo).toBeUndefined();
  });

  it('rejects a malformed data URL with 400', async () => {
    const app = buildApp();
    const put = await request(app)
      .put('/api/projects/proj1/email-logo')
      .send({ dataUrl: 'not-a-data-url' });
    expect(put.status).toBe(400);
  });

  it('404s for an unknown project', async () => {
    const app = buildApp();
    const put = await request(app)
      .put('/api/projects/nope/email-logo')
      .send({ dataUrl: PNG_DATA_URL });
    expect(put.status).toBe(404);
  });
});
