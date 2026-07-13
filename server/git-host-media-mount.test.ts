import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
  createGitHostMediaHandler,
  imageMimeForPath,
  issueGitHostMediaToken,
  validateGitHostMediaToken,
} from './git-host-media-mount.js';

/**
 * Exercises the `/git-host-media/:projectId` mount factory in isolation with a
 * fake findProject + readBlob. No real server / git — asserts the access model
 * (image-only, hosted-only), the 4xx guards, and that a hit streams the raw
 * bytes with the right content type.
 */
describe('imageMimeForPath', () => {
  it('maps known image extensions (case-insensitive)', () => {
    expect(imageMimeForPath('docs/media/x.png')).toBe('image/png');
    expect(imageMimeForPath('a/b/PIC.JPG')).toBe('image/jpeg');
    expect(imageMimeForPath('anim.gif')).toBe('image/gif');
    expect(imageMimeForPath('shot.webp')).toBe('image/webp');
  });

  it('returns null for non-raster-image / extensionless paths', () => {
    expect(imageMimeForPath('README.md')).toBeNull();
    expect(imageMimeForPath('src/index.ts')).toBeNull();
    expect(imageMimeForPath('logo.svg')).toBeNull();
    expect(imageMimeForPath('Makefile')).toBeNull();
    expect(imageMimeForPath('.env')).toBeNull();
  });
});

describe('createGitHostMediaHandler', () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  function buildApp(over: Partial<Parameters<typeof createGitHostMediaHandler>[0]> = {}) {
    const findProject =
      over.findProject ?? ((id: string) => (id === 'proj' ? { id, gitHost: 'agenthub' } : null));
    const validateToken =
      over.validateToken ??
      ((projectId: string, branch: string, token: unknown) => token === 'tok');
    const readBlob = over.readBlob ?? (async () => ({ buffer: PNG }));
    const app = express();
    app.use(
      '/git-host-media/:projectId',
      createGitHostMediaHandler({ findProject, validateToken, readBlob }),
    );
    return app;
  }

  it('streams the raw blob with the image content type + hardening headers', async () => {
    const readBlob = vi.fn(async () => ({ buffer: PNG }));
    const app = buildApp({ readBlob });
    const res = await request(app)
      .get('/git-host-media/proj')
      .query({ path: 'docs/media/x.png', branch: 'main', token: 'tok' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(Buffer.from(res.body)).toEqual(PNG);
    expect(readBlob).toHaveBeenCalledWith('proj', 'docs/media/x.png', 'main');
  });

  it('defaults the branch to undefined when omitted', async () => {
    const readBlob = vi.fn(async () => ({ buffer: PNG }));
    const app = buildApp({ readBlob });
    await request(app).get('/git-host-media/proj').query({ path: 'a.png', token: 'tok' });
    expect(readBlob).toHaveBeenCalledWith('proj', 'a.png', undefined);
  });

  it('404s a non-image extension without touching the repo', async () => {
    const readBlob = vi.fn(async () => ({ buffer: PNG }));
    const app = buildApp({ readBlob });
    const res = await request(app)
      .get('/git-host-media/proj')
      .query({ path: 'server/secrets.ts', token: 'tok' });
    expect(res.status).toBe(404);
    expect(readBlob).not.toHaveBeenCalled();
  });

  it('404s SVG without touching the repo', async () => {
    const readBlob = vi.fn(async () => ({ buffer: Buffer.from('<svg></svg>') }));
    const app = buildApp({ readBlob });
    const res = await request(app)
      .get('/git-host-media/proj')
      .query({ path: 'docs/logo.svg', token: 'tok' });
    expect(res.status).toBe(404);
    expect(readBlob).not.toHaveBeenCalled();
  });

  it('400s an invalid project id', async () => {
    const res = await request(buildApp())
      .get('/git-host-media/bad%2Fslug')
      .query({ path: 'a.png', token: 'tok' });
    expect(res.status).toBe(400);
  });

  it('400s a missing path', async () => {
    const res = await request(buildApp()).get('/git-host-media/proj');
    expect(res.status).toBe(400);
  });

  it('404s a project that is not Hub-hosted', async () => {
    const app = buildApp({ findProject: (id: string) => ({ id, gitHost: 'github' }) });
    const res = await request(app)
      .get('/git-host-media/proj')
      .query({ path: 'a.png', token: 'tok' });
    expect(res.status).toBe(404);
  });

  it('404s an unknown project', async () => {
    const app = buildApp({ findProject: () => null });
    const res = await request(app)
      .get('/git-host-media/proj')
      .query({ path: 'a.png', token: 'tok' });
    expect(res.status).toBe(404);
  });

  it('404s an invalid media token before reading the repo blob', async () => {
    const validateToken = vi.fn(() => false);
    const readBlob = vi.fn(async () => ({ buffer: PNG }));
    const app = buildApp({ validateToken, readBlob });

    const res = await request(app)
      .get('/git-host-media/proj')
      .query({ path: 'a.png', token: 'bad' });

    expect(res.status).toBe(404);
    expect(validateToken).toHaveBeenCalledWith('proj', '', 'bad');
    expect(readBlob).not.toHaveBeenCalled();
  });

  it('404s when the blob is absent (e.g. unsafe path rejected by readBlob)', async () => {
    const app = buildApp({ readBlob: async () => null });
    const res = await request(app)
      .get('/git-host-media/proj')
      .query({ path: 'a.png', token: 'tok' });
    expect(res.status).toBe(404);
  });

  it('404s a truncated blob rather than serving corrupt partial bytes', async () => {
    const app = buildApp({ readBlob: async () => ({ buffer: PNG, truncated: true }) });
    const res = await request(app)
      .get('/git-host-media/proj')
      .query({ path: 'a.png', token: 'tok' });
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toContain('application/json');
  });

  it('404s when readBlob throws', async () => {
    const app = buildApp({
      readBlob: async () => {
        throw new Error('git blew up');
      },
    });
    const res = await request(app)
      .get('/git-host-media/proj')
      .query({ path: 'a.png', token: 'tok' });
    expect(res.status).toBe(404);
  });
});

describe('git-host media tokens', () => {
  it('validates only the matching project and branch before expiry', () => {
    const token = issueGitHostMediaToken('proj', 'main', 1_000);

    expect(validateGitHostMediaToken('proj', 'main', token, 1_001)).toBe(true);
    expect(validateGitHostMediaToken('proj', 'dev', token, 1_001)).toBe(false);
    expect(validateGitHostMediaToken('other', 'main', token, 1_001)).toBe(false);
  });

  it('rejects expired tokens', () => {
    const token = issueGitHostMediaToken('proj', 'main', 1_000);

    expect(validateGitHostMediaToken('proj', 'main', token, 1_000 + 10 * 60 * 1_000 + 1)).toBe(
      false,
    );
  });
});
