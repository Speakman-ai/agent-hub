import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, statSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { ensureSpawnCwd } from './spawn-cwd.js';

describe('ensureSpawnCwd', () => {
  const created: string[] = [];

  afterEach(() => {
    while (created.length) {
      const p = created.pop();
      if (!p) continue;
      try {
        rmSync(p, { recursive: true, force: true });
      } catch {}
    }
  });

  it('returns "exists" when the cwd is already a directory', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ensure-cwd-'));
    created.push(dir);
    expect(ensureSpawnCwd(dir).status).toBe('exists');
  });

  it('auto-creates a missing nested cwd and reports auto-created', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'ensure-cwd-'));
    created.push(root);
    const target = path.join(root, 'projects', 'survey-tracker', 'workspace');

    const result = ensureSpawnCwd(target);
    expect(result.status).toBe('auto-created');
    expect(existsSync(target)).toBe(true);
    expect(statSync(target).isDirectory()).toBe(true);
  });

  it('returns "failed" with a reason when mkdir cannot create the cwd', () => {
    // Use an unwritable path (root-owned + no write perm). On most CI
    // sandboxes /sys is read-only, which makes mkdirSync throw EROFS/EACCES.
    const target = '/sys/agent-hub-cwd-test-must-fail';
    const result = ensureSpawnCwd(target);
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(typeof result.reason).toBe('string');
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });
});
