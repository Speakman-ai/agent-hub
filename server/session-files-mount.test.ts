import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express, { type Request, type Response } from 'express';
import request from 'supertest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'fs';
import path from 'path';
import os from 'os';
import { createSessionDesignFilesHandler } from './session-files-mount.js';
import { DESIGN_MODE_SUBDIR } from './design-mode-prompt.js';

/**
 * Exercises the `/session-files/:sessionId/design` mount factory in isolation:
 * the security guards (id shape, session existence, worktree requirement,
 * path-traversal containment) and the happy-path static file serve. No real
 * server / DB — a fake getSession + a temp worktree dir stand in.
 */
describe('createSessionDesignFilesHandler', () => {
  let tmp: string;
  let worktree: string;
  let designDir: string;
  const SID = 'abc123-session';

  function buildApp(sessions: Record<string, { worktree_path?: string | null }>) {
    const app = express();
    app.use(
      '/session-files/:sessionId/design',
      createSessionDesignFilesHandler({ getSession: (id) => sessions[id] }),
    );
    return app;
  }

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'sessfiles-'));
    worktree = path.join(tmp, 'worktree');
    designDir = path.join(worktree, DESIGN_MODE_SUBDIR);
    mkdirSync(designDir, { recursive: true });
    writeFileSync(path.join(designDir, 'index.html'), '<html><body>hi</body></html>');
    writeFileSync(path.join(designDir, 'style.css'), 'body{color:red}');
    // A secret living OUTSIDE the design/ root but inside the worktree — a
    // traversal attempt must not be able to reach it.
    writeFileSync(path.join(worktree, 'secret.txt'), 'TOP SECRET');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('serves index.html from the worktree design/ dir', async () => {
    const app = buildApp({ [SID]: { worktree_path: worktree } });
    const res = await request(app).get(`/session-files/${SID}/design/index.html`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('hi');
  });

  it('serves nested static assets (css)', async () => {
    const app = buildApp({ [SID]: { worktree_path: worktree } });
    const res = await request(app).get(`/session-files/${SID}/design/style.css`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('color:red');
  });

  it('sets Content-Type from the validated file extension', async () => {
    const app = buildApp({ [SID]: { worktree_path: worktree } });
    const html = await request(app).get(`/session-files/${SID}/design/index.html`);
    expect(html.headers['content-type']).toContain('text/html');
    const css = await request(app).get(`/session-files/${SID}/design/style.css`);
    expect(css.headers['content-type']).toContain('text/css');
  });

  it('falls back to application/octet-stream for an extensionless file', async () => {
    writeFileSync(path.join(designDir, 'LICENSE'), 'license text');
    const app = buildApp({ [SID]: { worktree_path: worktree } });
    const res = await request(app)
      .get(`/session-files/${SID}/design/LICENSE`)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/octet-stream');
    expect((res.body as Buffer).toString()).toContain('license text');
  });

  it('rejects an invalid session id with 400', async () => {
    const app = buildApp({});
    const res = await request(app).get('/session-files/bad_id!/design/index.html');
    expect(res.status).toBe(400);
  });

  it('404s an unknown session', async () => {
    const app = buildApp({});
    const res = await request(app).get(`/session-files/${SID}/design/index.html`);
    expect(res.status).toBe(404);
  });

  it('404s a session without a worktree', async () => {
    const app = buildApp({ [SID]: { worktree_path: null } });
    const res = await request(app).get(`/session-files/${SID}/design/index.html`);
    expect(res.status).toBe(404);
  });

  it('404s a missing file inside the design root', async () => {
    const app = buildApp({ [SID]: { worktree_path: worktree } });
    const res = await request(app).get(`/session-files/${SID}/design/missing.html`);
    expect(res.status).toBe(404);
  });

  it('does not serve a leaf symlink whose target escapes the design root (no leak)', async () => {
    // Plant a symlink INSIDE design/ that points at the worktree-level secret.
    // The lexical path (`design/leak.txt`) is contained, but the no-follow walk
    // refuses to traverse the symlink, so the secret never leaks.
    symlinkSync(path.join(worktree, 'secret.txt'), path.join(designDir, 'leak.txt'));
    const app = buildApp({ [SID]: { worktree_path: worktree } });
    const res = await request(app).get(`/session-files/${SID}/design/leak.txt`);
    expect(res.status).toBe(404);
    expect(res.text).not.toContain('TOP SECRET');
  });

  it('does not follow an intermediate directory symlink that escapes the root (no leak)', async () => {
    // The reviewer's case: `design/sub` is a symlink to a dir OUTSIDE the root,
    // and the request is `design/sub/page.html`. O_NOFOLLOW on only the leaf
    // would miss this; the descriptor-relative walk refuses the intermediate
    // symlink component too.
    const outside = path.join(tmp, 'outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(path.join(outside, 'page.html'), 'TOP SECRET PAGE');
    symlinkSync(outside, path.join(designDir, 'sub'));
    const app = buildApp({ [SID]: { worktree_path: worktree } });
    const res = await request(app).get(`/session-files/${SID}/design/sub/page.html`);
    expect(res.status).toBe(404);
    expect(res.text).not.toContain('TOP SECRET');
  });

  it('does not follow a symlinked worktree directory (no leak above design/)', async () => {
    // The reviewer's escalation: the worktree dir ITSELF is a symlink to an
    // attacker-controlled location. O_NOFOLLOW on the design root alone would
    // still follow the worktree-path parent component; the `/`-anchored walk
    // opens the worktree dir component no-follow too.
    const evil = path.join(tmp, 'evil-wt');
    mkdirSync(path.join(evil, DESIGN_MODE_SUBDIR), { recursive: true });
    writeFileSync(path.join(evil, DESIGN_MODE_SUBDIR, 'index.html'), 'EVIL SECRET');
    const wtLink = path.join(tmp, 'wt-link');
    symlinkSync(evil, wtLink);
    const app = buildApp({ [SID]: { worktree_path: wtLink } });
    const res = await request(app).get(`/session-files/${SID}/design/index.html`);
    expect(res.status).toBe(404);
    expect(res.text).not.toContain('EVIL SECRET');
  });

  it('serves through a legitimate symlink in the worktree-parent prefix', async () => {
    // A real symlink in the data-dir prefix (e.g. /tmp -> /private/tmp) must NOT
    // false-reject: the worktree PARENT is realpath'd before the no-follow walk.
    const realParent = path.join(tmp, 'real-parent');
    const wt = path.join(realParent, 'session-x');
    mkdirSync(path.join(wt, DESIGN_MODE_SUBDIR), { recursive: true });
    writeFileSync(path.join(wt, DESIGN_MODE_SUBDIR, 'index.html'), 'OK VIA SYMLINK');
    const parentLink = path.join(tmp, 'parent-link');
    symlinkSync(realParent, parentLink);
    // worktree_path traverses the legit symlink `parent-link` -> real-parent.
    const app = buildApp({ [SID]: { worktree_path: path.join(parentLink, 'session-x') } });
    const res = await request(app).get(`/session-files/${SID}/design/index.html`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('OK VIA SYMLINK');
  });

  it('refuses to follow a symlink even when its target stays inside the root', async () => {
    // No-follow is absolute: design artifacts are regular files, so the mount
    // never traverses a symlink, even a safe in-root one. (Documents the policy.)
    symlinkSync(path.join(designDir, 'index.html'), path.join(designDir, 'alias.html'));
    const app = buildApp({ [SID]: { worktree_path: worktree } });
    const res = await request(app).get(`/session-files/${SID}/design/alias.html`);
    expect(res.status).toBe(404);
  });

  it('serves a regular file in a real (non-symlink) subdirectory', async () => {
    // The legitimate nested-asset path must still work after the no-follow walk.
    mkdirSync(path.join(designDir, 'assets'), { recursive: true });
    writeFileSync(path.join(designDir, 'assets', 'app.js'), 'console.log(1)');
    const app = buildApp({ [SID]: { worktree_path: worktree } });
    const res = await request(app).get(`/session-files/${SID}/design/assets/app.js`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('console.log(1)');
  });

  it('blocks a request path that resolves outside the design root (404, no leak)', () => {
    // Drive the handler directly: superagent/express may normalize `..` in the
    // URL before the handler runs, so to prove the lexical containment guard
    // itself we hand it a req.path that escapes the per-session design/ root.
    const handler = createSessionDesignFilesHandler({
      getSession: () => ({ worktree_path: worktree }),
    });
    let status = 0;
    let body: unknown;
    const req = {
      params: { sessionId: SID },
      path: '/../secret.txt',
    } as unknown as Request;
    const res = {
      status(code: number) {
        status = code;
        return this;
      },
      json(payload: unknown) {
        body = payload;
        return this;
      },
    } as unknown as Response;
    handler(req, res);
    expect(status).toBe(404);
    expect(body).toEqual({ error: 'Not found' });
  });
});
