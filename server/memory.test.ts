import { vi, type Mock } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import path from 'path';
import os from 'os';
import type { ChildProcess } from 'child_process';

vi.mock('child_process', () => {
  const mockSpawn = vi.fn();
  return { spawn: mockSpawn };
});

const { spawn } = await import('child_process');
const { reconcileMemoryAfterSession, reconcileMemoryFromWiki, localDateStr } =
  await import('./memory.js');

const spawnMock = spawn as Mock;

interface MockProc {
  stdout: { on: Mock };
  stderr: { on: Mock };
  on: Mock;
  kill: Mock;
}

function setupSpawnMock(output: string | null, exitCode = 0): void {
  spawnMock.mockImplementation((): MockProc => {
    const proc: MockProc = {
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn(),
      kill: vi.fn(),
    };
    setTimeout(() => {
      if (output != null) {
        const stdoutCb = proc.stdout.on.mock.calls.find((c: unknown[]) => c[0] === 'data')?.[1] as
          | ((buf: Buffer) => void)
          | undefined;
        if (stdoutCb) stdoutCb(Buffer.from(output));
      }
      const closeCb = proc.on.mock.calls.find((c: unknown[]) => c[0] === 'close')?.[1] as
        | ((code: number) => void)
        | undefined;
      if (closeCb) closeCb(exitCode);
    }, 5);
    return proc;
  });
}

function setupSpawnError(errorMsg: string, exitCode = 1): void {
  spawnMock.mockImplementation((): MockProc => {
    const proc: MockProc = {
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn(),
      kill: vi.fn(),
    };
    setTimeout(() => {
      const stderrCb = proc.stderr.on.mock.calls.find((c: unknown[]) => c[0] === 'data')?.[1] as
        | ((buf: Buffer) => void)
        | undefined;
      if (stderrCb) stderrCb(Buffer.from(errorMsg));
      const closeCb = proc.on.mock.calls.find((c: unknown[]) => c[0] === 'close')?.[1] as
        | ((code: number) => void)
        | undefined;
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

let tmpDir: string;

beforeEach(() => {
  tmpDir = path.join(
    os.tmpdir(),
    `memory-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(tmpDir, { recursive: true });
  spawnMock.mockReset();
});

afterEach(() => {
  if (tmpDir && existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

describe('localDateStr', () => {
  it('formats a date as YYYY-MM-DD using local timezone', () => {
    const d = new Date(2025, 5, 15, 12, 0, 0);
    expect(localDateStr(d)).toBe('2025-06-15');
  });

  it('zero-pads single-digit months and days', () => {
    const d = new Date(2025, 0, 5, 12, 0, 0);
    expect(localDateStr(d)).toBe('2025-01-05');
  });

  it('uses local date, not UTC date', () => {
    const d = new Date(2025, 0, 1, 0, 30, 0);
    const result = localDateStr(d);
    expect(result).toBe('2025-01-01');
  });

  it('defaults to current date when called with no arguments', () => {
    const result = localDateStr();
    const now = new Date();
    const expected = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    expect(result).toBe(expected);
  });
});

describe('reconcileMemoryAfterSession', () => {
  describe('early returns', () => {
    it('returns immediately if workspace is falsy', async () => {
      await reconcileMemoryAfterSession(undefined, 'some summary', DEFAULT_OPTS);
      expect(spawnMock).not.toHaveBeenCalled();
    });

    it('returns immediately if sessionSummary is falsy', async () => {
      await reconcileMemoryAfterSession(tmpDir, '', DEFAULT_OPTS);
      expect(spawnMock).not.toHaveBeenCalled();
    });

    it('returns immediately if MEMORY.md does not exist', async () => {
      await reconcileMemoryAfterSession(tmpDir, 'some summary', DEFAULT_OPTS);
      expect(spawnMock).not.toHaveBeenCalled();
    });

    it('returns immediately if MEMORY.md is empty', async () => {
      writeFileSync(path.join(tmpDir, 'MEMORY.md'), '   \n  ', 'utf-8');
      await reconcileMemoryAfterSession(tmpDir, 'some summary', DEFAULT_OPTS);
      expect(spawnMock).not.toHaveBeenCalled();
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
      const original = '# Memory\n\n' + 'x'.repeat(500);
      writeFileSync(path.join(tmpDir, 'MEMORY.md'), original, 'utf-8');
      const hugeResult = '# Memory\n\n' + 'y'.repeat(2000);
      setupSpawnMock(hugeResult);

      await reconcileMemoryAfterSession(tmpDir, 'session summary', DEFAULT_OPTS);

      const after = readFileSync(path.join(tmpDir, 'MEMORY.md'), 'utf-8');
      expect(after).toBe(original);
    });

    it('uses floor of 1000 when MEMORY.md is very small', async () => {
      const original = '# Memory\n\n' + 'x'.repeat(69);
      writeFileSync(path.join(tmpDir, 'MEMORY.md'), original, 'utf-8');
      const validResult = '# Memory\n\n' + 'Updated content. '.repeat(30);
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

      await reconcileMemoryAfterSession(tmpDir, 'session summary', DEFAULT_OPTS);

      const after = readFileSync(path.join(tmpDir, 'MEMORY.md'), 'utf-8');
      expect(after).toBe(original);
    });
  });
});

describe('reconcileMemoryFromWiki', () => {
  const sampleWikiPages = [
    { title: 'Architecture', content: 'Service mesh with gRPC', category: 'Technical' },
  ];

  describe('early returns', () => {
    it('returns immediately if workspace is falsy', async () => {
      await reconcileMemoryFromWiki(undefined, sampleWikiPages, DEFAULT_OPTS);
      expect(spawnMock).not.toHaveBeenCalled();
    });

    it('returns immediately if wikiPages is empty', async () => {
      await reconcileMemoryFromWiki(tmpDir, [], DEFAULT_OPTS);
      expect(spawnMock).not.toHaveBeenCalled();
    });

    it('returns immediately if MEMORY.md does not exist', async () => {
      await reconcileMemoryFromWiki(tmpDir, sampleWikiPages, DEFAULT_OPTS);
      expect(spawnMock).not.toHaveBeenCalled();
    });

    it('returns immediately if MEMORY.md is empty', async () => {
      writeFileSync(path.join(tmpDir, 'MEMORY.md'), '  \n', 'utf-8');
      await reconcileMemoryFromWiki(tmpDir, sampleWikiPages, DEFAULT_OPTS);
      expect(spawnMock).not.toHaveBeenCalled();
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

describe('mutex serialization', () => {
  it('serializes concurrent reconciliations (second waits for first)', async () => {
    const original = '# Memory\n\nOriginal content long enough for both reconciliation passes.';
    writeFileSync(path.join(tmpDir, 'MEMORY.md'), original, 'utf-8');

    let callCount = 0;
    spawnMock.mockImplementation((): MockProc => {
      callCount++;
      const currentCall = callCount;
      const proc: MockProc = {
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn(),
        kill: vi.fn(),
      };
      const delay = currentCall === 1 ? 30 : 5;
      setTimeout(() => {
        const stdoutCb = proc.stdout.on.mock.calls.find((c: unknown[]) => c[0] === 'data')?.[1] as
          | ((buf: Buffer) => void)
          | undefined;
        if (stdoutCb) {
          stdoutCb(
            Buffer.from(`# Memory\n\nUpdate from call ${currentCall} with enough length to pass.`),
          );
        }
        const closeCb = proc.on.mock.calls.find((c: unknown[]) => c[0] === 'close')?.[1] as
          | ((code: number) => void)
          | undefined;
        if (closeCb) closeCb(0);
      }, delay);
      return proc;
    });

    const p1 = reconcileMemoryAfterSession(tmpDir, 'summary 1', DEFAULT_OPTS);
    const p2 = reconcileMemoryAfterSession(tmpDir, 'summary 2', DEFAULT_OPTS);

    await Promise.all([p1, p2]);

    expect(spawnMock).toHaveBeenCalledTimes(2);
    const after = readFileSync(path.join(tmpDir, 'MEMORY.md'), 'utf-8');
    expect(after).toContain('Update from call 2');
  });
});
