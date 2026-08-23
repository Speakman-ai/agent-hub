import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { migrateLegacyUploads } from './uploads-migration.js';

describe('migrateLegacyUploads', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function fixture(): {
    root: string;
    legacyUploadsDir: string;
    uploadsDir: string;
    markerPath: string;
  } {
    const root = mkdtempSync(path.join(os.tmpdir(), 'legacy-uploads-'));
    roots.push(root);
    const legacyUploadsDir = path.join(root, 'legacy');
    const uploadsDir = path.join(root, 'current');
    mkdirSync(path.join(legacyUploadsDir, 'nested'), { recursive: true });
    mkdirSync(uploadsDir, { recursive: true });
    return {
      root,
      legacyUploadsDir,
      uploadsDir,
      markerPath: path.join(root, 'migrations', 'legacy-uploads-v1'),
    };
  }

  it('imports legacy files recursively without overwriting newer uploads', () => {
    const dirs = fixture();
    writeFileSync(path.join(dirs.legacyUploadsDir, 'old.png'), 'legacy-image');
    writeFileSync(path.join(dirs.legacyUploadsDir, 'nested', 'replay.json'), 'legacy-replay');
    writeFileSync(path.join(dirs.legacyUploadsDir, 'conflict.txt'), 'legacy-value');
    mkdirSync(path.join(dirs.uploadsDir, 'nested'));
    writeFileSync(path.join(dirs.uploadsDir, 'nested', 'current.json'), 'current-nested');
    writeFileSync(path.join(dirs.uploadsDir, 'conflict.txt'), 'current-value');
    const log = vi.fn();

    const result = migrateLegacyUploads({ ...dirs, log });

    expect(result).toEqual({ status: 'migrated', importedEntries: 3 });
    expect(readFileSync(path.join(dirs.uploadsDir, 'old.png'), 'utf8')).toBe('legacy-image');
    expect(readFileSync(path.join(dirs.uploadsDir, 'nested', 'replay.json'), 'utf8')).toBe(
      'legacy-replay',
    );
    expect(readFileSync(path.join(dirs.uploadsDir, 'nested', 'current.json'), 'utf8')).toBe(
      'current-nested',
    );
    expect(readFileSync(path.join(dirs.uploadsDir, 'conflict.txt'), 'utf8')).toBe('current-value');
    expect(existsSync(dirs.markerPath)).toBe(true);
    expect(log).toHaveBeenCalledOnce();
  });

  it('uses the completion marker to avoid re-importing removed files', () => {
    const dirs = fixture();
    writeFileSync(path.join(dirs.legacyUploadsDir, 'old.png'), 'legacy-image');
    const log = vi.fn();
    migrateLegacyUploads({ ...dirs, log });
    rmSync(path.join(dirs.uploadsDir, 'old.png'));

    expect(migrateLegacyUploads({ ...dirs, log })).toEqual({
      status: 'already-migrated',
      importedEntries: 0,
    });
    expect(existsSync(path.join(dirs.uploadsDir, 'old.png'))).toBe(false);
  });

  it('leaves no marker when the legacy volume is unavailable', () => {
    const dirs = fixture();
    rmSync(dirs.legacyUploadsDir, { recursive: true, force: true });

    expect(migrateLegacyUploads(dirs)).toEqual({
      status: 'source-missing',
      importedEntries: 0,
    });
    expect(existsSync(dirs.markerPath)).toBe(false);
  });
});
