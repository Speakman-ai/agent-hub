import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import path from 'path';
import os from 'os';

// We need to mock child_process.spawn before importing memory.js
vi.mock('child_process', () => {
  const mockSpawn = vi.fn();
  return { spawn: mockSpawn };
});

const { spawn } = await import('child_process');
const { reconcileMemoryAfterSession, reconcileMemoryFromWiki } = await import('./memory.js');

// Helper: create a fake spawn that resolves with given output and exit code
function setupSpawnMock(output, exitCode = 0) {
  spawn.mockImplementation(() => {
    const proc = {
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn(),
      kill: vi.fn(),
    };
    // Simulate async events
    setTimeout(() => {
      if (output != null) {
        const stdoutCb = proc.stdout.on.mock.calls.find((c) => c[0] === 'data')?.[1];
        if (stdoutCb) stdoutCb(Buffer.from(output));
      }
      const closeCb = proc.on.mock.calls.find((c) => c[0] === 'close')?.[1];
      if (closeCb) closeCb(exitCode);
    }, 5);
    return proc;
  });
}

function setupSpawnError(errorMsg, exitCode = 1) {
  spawn.mockImplementation(() => {
    const proc = {
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn(),
      kill: vi.fn(),
    };
    setTimeout(() => {
      const stderrCb = proc.stderr.on.mock.calls.find((c) => c[0] === 'data')?.[1];
      if (stderrCb) stderrCb(Buffer.from(errorMsg));
      const closeCb = proc.on.mock.calls.find((c) => c[0] === 'close')?.[1];
      if (closeCb) closeCb(exitCode);
    }, 5);
    return proc;
  });
}

const DEFAULT_OPTS = {
  claudeBin: '/usr/local/bin/claude',
  spawnEnv: {},
  cwd: '/tmp',
};

let tmpDir;

beforeEach(() => {
  tmpDir = path.join(
    os.tmpdir(),
    `memory-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(tmpDir, { recursive: true });
  spawn.mockReset();
});

afterEach(() => {
  if (tmpDir && existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ─── reconcileMemoryAfterSession ─────────────────────────────────

describe('reconcileMemoryAfterSession', () => {
  describe('early returns', () => {
    it('returns immediately if workspace is falsy', async () => {
      await reconcileMemoryAfterSession(null, 'some summary', DEFAULT_OPTS);
      expect(spawn).not.toHaveBeenCalled();
    });

    it('returns immediately if sessionSummary is falsy', async () => {
      await reconcileMemoryAfterSession(tmpDir, '', DEFAULT_OPTS);
      expect(spawn).not.toHaveBeenCalled();
    });

    it('returns immediately if MEMORY.md does not exist', async () => {
      await reconcileMemoryAfterSession(tmpDir, 'some summary', DEFAULT_OPTS);
      expect(spawn).not.toHaveBeenCalled();
    });

    it('returns immediately if MEMORY.md is empty', async () => {
      writeFileSync(path.join(tmpDir, 'MEMORY.md'), '   \n  ', 'utf-8');
      await reconcileMemoryAfterSession(tmpDir, 'some summary', DEFAULT_OPTS);
      expect(spawn).not.toHaveBeenCalled();
    });
  });

  describe('NO_CHANGES_NEEDED detection', () => {
    it('does not overwrite MEMORY.md when Claude responds NO_CHANGES_NEEDED', async () => {
      const original = '# Memory\n\nSome existing content here that is long enough.';
      writeFileSync(path.join(tmpDir, 'MEMORY.md'), original, 'utf-8');
      setupSpawnMock('NO_CHANGES_NEEDED');

      await reconcileMemoryAfterSession(tmpDir, 'session summary', DEFAULT_OPTS);

      const after = readFileSync(path.join(tmpDir, 'MEMORY.md'), 'utf-8');
      expect(after).toBe(original);
    });

    it('does not overwrite when response contains NO_CHANGES_NEEDED among other text', async () => {
      const original = '# Memory\n\nSome existing content here that is long enough.';
      writeFileSync(path.join(tmpDir, 'MEMORY.md'), original, 'utf-8');
      setupSpawnMock('After review: NO_CHANGES_NEEDED for this file.');

      await reconcileMemoryAfterSession(tmpDir, 'session summary', DEFAULT_OPTS);

      const after = readFileSync(path.join(tmpDir, 'MEMORY.md'), 'utf-8');
      expect(after).toBe(original);
    });
  });

  describe('size guard logic', () => {
    it('rejects result that is too short (< 50 chars)', async () => {
      const original = '# Memory\n\nSome content that is reasonable length for a memory file.';
      writeFileSync(path.join(tmpDir, 'MEMORY.md'), original, 'utf-8');
      setupSpawnMock('Too short');

      await reconcileMemoryAfterSession(tmpDir, 'session summary', DEFAULT_OPTS);

      const after = readFileSync(path.join(tmpDir, 'MEMORY.md'), 'utf-8');
      expect(after).toBe(original);
    });

    it('rejects result that is too long (> 3x current size)', async () => {
      const original = '# Memory\n\n' + 'x'.repeat(500); // 512 chars
      writeFileSync(path.join(tmpDir, 'MEMORY.md'), original, 'utf-8');
      // Result is > 512 * 3 = 1536 chars
      const hugeResult = '# Memory\n\n' + 'y'.repeat(2000);
      setupSpawnMock(hugeResult);

      await reconcileMemoryAfterSession(tmpDir, 'session summary', DEFAULT_OPTS);

      const after = readFileSync(path.join(tmpDir, 'MEMORY.md'), 'utf-8');
      expect(after).toBe(original);
    });

    it('uses floor of 1000 when MEMORY.md is very small', async () => {
      // Small MEMORY.md: 80 chars. 80 * 3 = 240, but floor is 1000.
      // A 500-char result should be accepted (< 1000 floor).
      const original = '# Memory\n\n' + 'x'.repeat(69); // 80 chars
      writeFileSync(path.join(tmpDir, 'MEMORY.md'), original, 'utf-8');
      const validResult = '# Memory\n\n' + 'Updated content. '.repeat(30); // ~520 chars
      setupSpawnMock(validResult);

      await reconcileMemoryAfterSession(tmpDir, 'session summary', DEFAULT_OPTS);

      const after = readFileSync(path.join(tmpDir, 'MEMORY.md'), 'utf-8');
      expect(after).toBe(validResult.trim());
    });
  });

  describe('successful update', () => {
    it('writes updated content and creates .bak backup', async () => {
      const original = '# Memory\n\nOld content that is long enough for the size check to pass.';
      writeFileSync(path.join(tmpDir, 'MEMORY.md'), original, 'utf-8');
      const updated = '# Memory\n\nUpdated content that is long enough for the size check to pass.';
      setupSpawnMock(updated);

      await reconcileMemoryAfterSession(tmpDir, 'session summary', DEFAULT_OPTS);

      const after = readFileSync(path.join(tmpDir, 'MEMORY.md'), 'utf-8');
      expect(after).toBe(updated);
      const backup = readFileSync(path.join(tmpDir, 'MEMORY.md.bak'), 'utf-8');
      expect(backup).toBe(original);
    });
  });

  describe('error handling', () => {
    it('does not overwrite MEMORY.md when Claude exits non-zero', async () => {
      const original = '# Memory\n\nSome existing content that should not be changed.';
      writeFileSync(path.join(tmpDir, 'MEMORY.md'), original, 'utf-8');
      setupSpawnError('Something went wrong', 1);

      // Should not throw — errors are caught internally
      await reconcileMemoryAfterSession(tmpDir, 'session summary', DEFAULT_OPTS);

      const after = readFileSync(path.join(tmpDir, 'MEMORY.md'), 'utf-8');
      expect(after).toBe(original);
    });
  });
});

// ─── reconcileMemoryFromWiki ─────────────────────────────────────

describe('reconcileMemoryFromWiki', () => {
  const sampleWikiPages = [
    { title: 'Architecture', content: 'Service mesh with gRPC', category: 'Technical' },
  ];

  describe('early returns', () => {
    it('returns immediately if workspace is falsy', async () => {
      await reconcileMemoryFromWiki(null, sampleWikiPages, DEFAULT_OPTS);
      expect(spawn).not.toHaveBeenCalled();
    });

    it('returns immediately if wikiPages is empty', async () => {
      await reconcileMemoryFromWiki(tmpDir, [], DEFAULT_OPTS);
      expect(spawn).not.toHaveBeenCalled();
    });

    it('returns immediately if MEMORY.md does not exist', async () => {
      await reconcileMemoryFromWiki(tmpDir, sampleWikiPages, DEFAULT_OPTS);
      expect(spawn).not.toHaveBeenCalled();
    });

    it('returns immediately if MEMORY.md is empty', async () => {
      writeFileSync(path.join(tmpDir, 'MEMORY.md'), '  \n', 'utf-8');
      await reconcileMemoryFromWiki(tmpDir, sampleWikiPages, DEFAULT_OPTS);
      expect(spawn).not.toHaveBeenCalled();
    });
  });

  describe('NO_CHANGES_NEEDED', () => {
    it('does not overwrite when Claude says no changes needed', async () => {
      const original = '# Memory\n\nExisting wiki-derived content, long enough to pass checks.';
      writeFileSync(path.join(tmpDir, 'MEMORY.md'), original, 'utf-8');
      setupSpawnMock('NO_CHANGES_NEEDED');

      await reconcileMemoryFromWiki(tmpDir, sampleWikiPages, DEFAULT_OPTS);

      const after = readFileSync(path.join(tmpDir, 'MEMORY.md'), 'utf-8');
      expect(after).toBe(original);
    });
  });

  describe('size guard', () => {
    it('rejects too-short result', async () => {
      const original = '# Memory\n\nContent with enough length to be meaningful for the test.';
      writeFileSync(path.join(tmpDir, 'MEMORY.md'), original, 'utf-8');
      setupSpawnMock('Short');

      await reconcileMemoryFromWiki(tmpDir, sampleWikiPages, DEFAULT_OPTS);

      const after = readFileSync(path.join(tmpDir, 'MEMORY.md'), 'utf-8');
      expect(after).toBe(original);
    });
  });

  describe('successful update', () => {
    it('writes updated content and creates backup', async () => {
      const original = '# Memory\n\nOld wiki-derived content that is long enough to pass checks.';
      writeFileSync(path.join(tmpDir, 'MEMORY.md'), original, 'utf-8');
      const updated = '# Memory\n\nNew wiki-derived content that is long enough to pass checks.';
      setupSpawnMock(updated);

      await reconcileMemoryFromWiki(tmpDir, sampleWikiPages, DEFAULT_OPTS);

      const after = readFileSync(path.join(tmpDir, 'MEMORY.md'), 'utf-8');
      expect(after).toBe(updated);
      const backup = readFileSync(path.join(tmpDir, 'MEMORY.md.bak'), 'utf-8');
      expect(backup).toBe(original);
    });
  });
});

// ─── Mutex serialization ────────────────────────────────────────

describe('mutex serialization', () => {
  it('serializes concurrent reconciliations (second waits for first)', async () => {
    const original = '# Memory\n\nOriginal content long enough for both reconciliation passes.';
    writeFileSync(path.join(tmpDir, 'MEMORY.md'), original, 'utf-8');

    let callCount = 0;
    spawn.mockImplementation(() => {
      callCount++;
      const currentCall = callCount;
      const proc = {
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn(),
        kill: vi.fn(),
      };
      // First call takes longer, second is fast
      const delay = currentCall === 1 ? 30 : 5;
      setTimeout(() => {
        const stdoutCb = proc.stdout.on.mock.calls.find((c) => c[0] === 'data')?.[1];
        if (stdoutCb) {
          stdoutCb(
            Buffer.from(`# Memory\n\nUpdate from call ${currentCall} with enough length to pass.`),
          );
        }
        const closeCb = proc.on.mock.calls.find((c) => c[0] === 'close')?.[1];
        if (closeCb) closeCb(0);
      }, delay);
      return proc;
    });

    // Fire both concurrently
    const p1 = reconcileMemoryAfterSession(tmpDir, 'summary 1', DEFAULT_OPTS);
    const p2 = reconcileMemoryAfterSession(tmpDir, 'summary 2', DEFAULT_OPTS);

    await Promise.all([p1, p2]);

    // Both should have run (spawn called twice)
    expect(spawn).toHaveBeenCalledTimes(2);
    // The final content should be from the second call (serialized, so it ran last)
    const after = readFileSync(path.join(tmpDir, 'MEMORY.md'), 'utf-8');
    expect(after).toContain('Update from call 2');
  });
});
