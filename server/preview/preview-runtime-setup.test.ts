/**
 * Tests for the production wiring helpers in `preview-runtime-setup.ts`.
 *
 * Covers:
 *   - The pure `buildComposeOverrideYaml` body emitted to disk.
 *   - `buildDiskOverrideFileWriter` writes 0600-perm YAML to
 *     `<composeOverrideDir>/<groupId>.yml` and returns the absolute path.
 *   - `buildDiskOverrideFileWriter` rejects hostile groupIds that
 *     sanitise to empty.
 *   - `buildDiskOverrideFileDeleter` removes a file inside the scope
 *     dir and refuses paths outside it (path-traversal defense in
 *     depth).
 *   - `createPreviewRuntimes` constructs both singletons against a
 *     shared DB + dataDir, mkdir-ps the layout, and exposes the
 *     compose override dir.
 *
 * No real spawn / fetch is exercised here — those paths are covered by
 * `preview-compose-runtime.test.ts` and `preview-runtime.test.ts`.
 */

import Database from 'better-sqlite3';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { describe, it, expect } from 'vitest';
import { buildComposeOverrideYaml } from './preview-compose-runtime.js';
import {
  buildDiskOverrideFileDeleter,
  buildDiskOverrideFileWriter,
  createPreviewRuntimes,
} from './preview-runtime-setup.js';

function freshTmpDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'preview-setup-'));
}

describe('buildComposeOverrideYaml', () => {
  it('emits a minimal compose YAML mapping the host port to the entry service', () => {
    const body = buildComposeOverrideYaml({
      entryService: 'web',
      hostPort: 4101,
      entryPort: 8000,
    });
    expect(body).toContain('services:');
    expect(body).toContain('  web:');
    // `!override` is required so the runtime mapping REPLACES the base
    // compose file's `ports:` list rather than appending — without it,
    // a base file with `ports: ["8000:8000"]` would bind both the
    // static and the allocated port, and a second concurrent session
    // would EADDRINUSE on 8000. See `buildComposeOverrideYaml` docstring.
    expect(body).toContain('    ports: !override');
    expect(body).toContain('      - "4101:8000"');
    expect(body.endsWith('\n')).toBe(true);
  });

  it('omits the volumes block when entryWorkdir is not set (back-compat)', () => {
    // Existing projects that have not opted into live-edit previews
    // must keep getting the image-baked source — no bind mount, no
    // volumes block at all.
    const body = buildComposeOverrideYaml({
      entryService: 'web',
      hostPort: 4101,
      entryPort: 8000,
    });
    expect(body).not.toContain('volumes:');
    expect(body).not.toContain('.:');
  });

  it('emits a bind-mount + anonymous-volume shadows when entryWorkdir is set', () => {
    // The bind source is `.` because compose resolves it against
    // `--project-directory`, which the runtime sets to the host-
    // translated worktree path. The shadow entries are anonymous
    // volumes that prevent the host bind from clobbering image-
    // baked artifacts like node_modules — without them, `vite dev`
    // / `ng serve` fail on the first import resolution.
    const body = buildComposeOverrideYaml({
      entryService: 'frontend',
      hostPort: 4123,
      entryPort: 4200,
      entryWorkdir: '/workspace',
      shadowDirs: ['node_modules', 'dist'],
    });
    expect(body).toContain('    volumes: !override');
    expect(body).toContain('      - ".:/workspace"');
    expect(body).toContain('      - "/workspace/node_modules"');
    expect(body).toContain('      - "/workspace/dist"');
  });

  it('strips leading/trailing slashes from shadowDirs entries before emit', () => {
    // Defensive normalisation — operators sometimes write
    // ["/node_modules"] or ["node_modules/"], which would otherwise
    // produce "//node_modules" or "/workspace/node_modules/" in the
    // override and surprise the docker volume parser.
    const body = buildComposeOverrideYaml({
      entryService: 'frontend',
      hostPort: 4123,
      entryPort: 4200,
      entryWorkdir: '/workspace',
      shadowDirs: ['/node_modules/', 'dist/'],
    });
    expect(body).toContain('      - "/workspace/node_modules"');
    expect(body).toContain('      - "/workspace/dist"');
    expect(body).not.toContain('//');
  });

  it('handles entryWorkdir with trailing slash without doubling it', () => {
    const body = buildComposeOverrideYaml({
      entryService: 'frontend',
      hostPort: 4123,
      entryPort: 4200,
      entryWorkdir: '/workspace/',
      shadowDirs: ['node_modules'],
    });
    expect(body).toContain('      - "/workspace/node_modules"');
    expect(body).not.toContain('//');
  });

  it('emits the bind mount even when shadowDirs is empty (caller opted in explicitly)', () => {
    // Empty shadowDirs is "I really mean: no shadows, the bind
    // covers everything." Usually wrong (the image's node_modules
    // gets clobbered) but the validator allowed it, so the writer
    // honours it.
    const body = buildComposeOverrideYaml({
      entryService: 'frontend',
      hostPort: 4123,
      entryPort: 4200,
      entryWorkdir: '/workspace',
      shadowDirs: [],
    });
    expect(body).toContain('      - ".:/workspace"');
    // Only the bind itself — no anonymous volumes.
    const volLines = body.split('\n').filter((l) => l.trim().startsWith('- "'));
    expect(volLines.length).toBe(2); // ports line + one volume bind
  });

  it('injects AGENT_HUB_PREVIEW_BASE_PATH into the entry service environment', () => {
    // The path-prefix proxy mounts every preview under
    // /api/sessions/<sid>/preview/proxy/. Dev servers that default to
    // base "/" emit asset URLs (JS modules, HMR WebSocket, manifest)
    // that resolve at the Hub root, producing the "white screen with
    // manifest syntax error" failure mode. Apps that map this env var
    // to their framework's base-URL knob (Angular's --serve-path,
    // Vite's `base`, Next's basePath, CRA's PUBLIC_URL) get correct
    // paths; apps that ignore it are unaffected.
    const body = buildComposeOverrideYaml({
      entryService: 'frontend',
      hostPort: 4123,
      entryPort: 4200,
      previewBasePath: '/api/sessions/sess-abc/preview/proxy/',
    });
    expect(body).toContain('    environment:');
    expect(body).toContain(
      '      AGENT_HUB_PREVIEW_BASE_PATH: "/api/sessions/sess-abc/preview/proxy/"',
    );
  });

  it('omits the environment block when previewBasePath is not set (back-compat)', () => {
    const body = buildComposeOverrideYaml({
      entryService: 'web',
      hostPort: 4101,
      entryPort: 8000,
    });
    expect(body).not.toContain('environment:');
    expect(body).not.toContain('AGENT_HUB_PREVIEW_BASE_PATH');
  });

  it('combines bind-mount + env injection cleanly when both are set', () => {
    const body = buildComposeOverrideYaml({
      entryService: 'frontend',
      hostPort: 4123,
      entryPort: 4200,
      entryWorkdir: '/workspace',
      shadowDirs: ['node_modules'],
      previewBasePath: '/api/sessions/sess-xyz/preview/proxy/',
    });
    expect(body).toContain('    volumes: !override');
    expect(body).toContain('      - ".:/workspace"');
    expect(body).toContain('      - "/workspace/node_modules"');
    expect(body).toContain('    environment:');
    expect(body).toContain('AGENT_HUB_PREVIEW_BASE_PATH');
  });
});

describe('buildDiskOverrideFileWriter', () => {
  it('writes 0600-perm YAML to <dir>/<groupId>.yml and returns the path', () => {
    const dir = freshTmpDir();
    const writer = buildDiskOverrideFileWriter(dir);
    const groupId = '550e8400-e29b-41d4-a716-446655440000';
    const out = writer({
      groupId,
      entryService: 'frontend',
      hostPort: 4123,
      entryPort: 5173,
    });
    expect(out).toBe(path.join(dir, `${groupId}.yml`));
    expect(existsSync(out)).toBe(true);

    const mode = statSync(out).mode & 0o777;
    expect(mode).toBe(0o600);

    const body = readFileSync(out, 'utf-8');
    expect(body).toContain('  frontend:');
    expect(body).toContain('"4123:5173"');
  });

  it('strips groupId chars and lands the file under the scope dir', () => {
    // Hand-built ids with separators would otherwise let a caller drop
    // a file two levels up. The writer keeps only `[A-Za-z0-9_-]`.
    const dir = freshTmpDir();
    const writer = buildDiskOverrideFileWriter(dir);
    const out = writer({
      groupId: 'sess/escape/../etc',
      entryService: 'web',
      hostPort: 4101,
      entryPort: 8000,
    });
    expect(out.startsWith(dir + path.sep)).toBe(true);
    // Sanitiser keeps `[A-Za-z0-9_-]` only — dots, slashes, and other
    // path-separator chars all drop out, leaving a flat filename.
    expect(out).toBe(path.join(dir, 'sessescapeetc.yml'));
  });

  it('throws when sanitisation leaves an empty groupId', () => {
    const dir = freshTmpDir();
    const writer = buildDiskOverrideFileWriter(dir);
    expect(() =>
      writer({
        groupId: '////',
        entryService: 'web',
        hostPort: 4101,
        entryPort: 8000,
      }),
    ).toThrow(/empty\/sanitised groupId/);
  });
});

describe('buildDiskOverrideFileDeleter', () => {
  it('removes the file when it lives inside the scope dir', () => {
    const dir = freshTmpDir();
    const target = path.join(dir, 'abc.yml');
    writeFileSync(target, 'services: {}\n', { mode: 0o600 });
    expect(existsSync(target)).toBe(true);

    const deleter = buildDiskOverrideFileDeleter(dir);
    deleter(target);
    expect(existsSync(target)).toBe(false);
  });

  it('is a no-op on a missing file (best-effort cleanup)', () => {
    const dir = freshTmpDir();
    const deleter = buildDiskOverrideFileDeleter(dir);
    expect(() => deleter(path.join(dir, 'missing.yml'))).not.toThrow();
  });

  it('returns silently for paths outside the scope dir and leaves siblings intact', () => {
    const dir = freshTmpDir();
    const deleter = buildDiskOverrideFileDeleter(dir);
    // Hostile path — must NOT touch /etc/passwd. Inside the test we
    // assert two observable signals: (a) a sibling file in the scope
    // dir survives (proves the deleter didn't somehow widen its
    // target), and (b) a console.warn fires naming the rejected path
    // so an operator can see the attempt in production logs.
    const sibling = path.join(dir, 'keep.yml');
    writeFileSync(sibling, 'keep me\n');
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => {
      warns.push(args.map((a) => String(a)).join(' '));
    };
    try {
      expect(() => deleter('/etc/passwd')).not.toThrow();
    } finally {
      console.warn = orig;
    }
    expect(existsSync(sibling)).toBe(true);
    expect(warns.some((w) => w.includes('refusing path outside'))).toBe(true);
  });
});

describe('createPreviewRuntimes', () => {
  it('mkdir-ps the previews + preview-compose dirs and returns all runtimes', () => {
    const dataDir = freshTmpDir();
    const db = new Database(':memory:');
    const { previewRuntime, previewComposeRuntime, devServerRuntime, composeOverrideDir } =
      createPreviewRuntimes({
        db,
        dataDir,
        reconcileOrphanComposeOnBoot: false,
      });

    expect(previewRuntime).toBeDefined();
    expect(previewComposeRuntime).toBeDefined();
    expect(devServerRuntime).toBeDefined();
    expect(composeOverrideDir).toBe(path.join(dataDir, 'preview-compose'));
    expect(existsSync(path.join(dataDir, 'previews'))).toBe(true);
    expect(existsSync(composeOverrideDir)).toBe(true);

    // The compose runtime's schema migration ran — the
    // override_file_path column should be present.
    const cols = db.prepare(`PRAGMA table_info(worktree_preview_groups)`).all() as Array<{
      name: string;
    }>;
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain('compose_project_name');
    expect(colNames).toContain('override_file_path');
    expect(colNames).toContain('runtime');
  });

  it('wires loadProjectEnv on PreviewRuntime so per-project secrets reach the spawn', () => {
    // Regression for PR #1055 review (the "CRITICAL — secrets never
    // injected at spawn time" claim). The factory MUST hand the
    // PreviewRuntime a loadProjectEnv callback or the entire
    // per-project secrets feature is silently disabled in production.
    // We peek at the runtime's private field via a typed cast — the
    // alternative (end-to-end spawn) needs a CLI and a worktree fixture
    // and would balloon this test by two orders of magnitude.
    const dataDir = freshTmpDir();
    const db = new Database(':memory:');
    const { previewRuntime } = createPreviewRuntimes({
      db,
      dataDir,
      reconcileOrphanComposeOnBoot: false,
    });
    const wired = (previewRuntime as unknown as { loadProjectEnv: unknown }).loadProjectEnv;
    // Must be a function (not the `null` fallback used when the dep is omitted).
    expect(typeof wired).toBe('function');
  });
});
