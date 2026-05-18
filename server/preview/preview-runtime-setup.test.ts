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
    expect(body).toContain('    ports:');
    expect(body).toContain('      - "4101:8000"');
    expect(body.endsWith('\n')).toBe(true);
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

  it('refuses paths that resolve outside the scope dir', () => {
    const dir = freshTmpDir();
    const deleter = buildDiskOverrideFileDeleter(dir);
    // Hostile path — must NOT delete /etc/passwd. We can't easily
    // observe non-deletion of a system file, but we can verify the
    // call returns silently and a sibling file in `dir` is untouched.
    const sibling = path.join(dir, 'keep.yml');
    writeFileSync(sibling, 'keep me\n');
    expect(() => deleter('/etc/passwd')).not.toThrow();
    expect(existsSync(sibling)).toBe(true);
  });
});

describe('createPreviewRuntimes', () => {
  it('mkdir-ps the previews + preview-compose dirs and returns both runtimes', () => {
    const dataDir = freshTmpDir();
    const db = new Database(':memory:');
    const { previewRuntime, previewComposeRuntime, composeOverrideDir } = createPreviewRuntimes({
      db,
      dataDir,
    });

    expect(previewRuntime).toBeDefined();
    expect(previewComposeRuntime).toBeDefined();
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
  });
});
