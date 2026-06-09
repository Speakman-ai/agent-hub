// Tests for the memory reconciliation flows. These intentionally don't
// exercise engine selection — that's covered in `engine-resolver.test.ts`
// and `engine-availability.test.ts`. Here we mock both the resolver and
// the one-shot spawn so the tests can focus on prompt assembly, the
// NO_CHANGES_NEEDED short-circuit, the size-guard, the .bak backup, and
// the reconciliation mutex.

import { vi, type Mock } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import path from 'path';
import os from 'os';

vi.mock('./engine-resolver.js', async () => {
  const actual =
    await vi.importActual<typeof import('./engine-resolver.js')>('./engine-resolver.js');
  return {
    ...actual,
    // Default — succeed with claude-code. Individual tests can override
    // via `(resolveOneShotEngine as Mock).mockImplementationOnce(...)`.
    resolveOneShotEngine: vi.fn(async () => ({
      engine: 'claude-code' as const,
      model: 'claude-sonnet-4-5',
      fallbackUsed: false,
      availability: {} as never,
    })),
  };
});

vi.mock('./one-shot-spawn.js', () => ({
  runOneShotPrompt: vi.fn(),
}));

const { resolveOneShotEngine, NoEnginesAvailableError } = await import('./engine-resolver.js');
const { runOneShotPrompt } = await import('./one-shot-spawn.js');
const { reconcileMemoryAfterSession, reconcileMemoryFromWiki, localDateStr } =
  await import('./memory.js');

const runOneShotMock = runOneShotPrompt as Mock;
const resolveMock = resolveOneShotEngine as Mock;

function setupRunReturn(output: string): void {
  // `runOneShotPrompt` trims its return value in production — mirror
  // that here so tests model the real return shape.
  runOneShotMock.mockImplementation(async () => output.trim());
}

function setupRunReject(message: string): void {
  runOneShotMock.mockImplementation(async () => {
    throw new Error(message);
  });
}

const DEFAULT_OPTS = {
  // The resolver is mocked, so we only need an object that satisfies the
  // type — none of these fields are read in the test path.
  cfg: {} as never,
  spawnEnv: {} as NodeJS.ProcessEnv,
  cwd: '/tmp',
};

let tmpDir: string;

beforeEach(() => {
  tmpDir = path.join(
    os.tmpdir(),
    `memory-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(tmpDir, { recursive: true });
  runOneShotMock.mockReset();
  resolveMock.mockReset();
  // Default resolver behaviour: claude-code, no fallback.
  resolveMock.mockImplementation(async () => ({
    engine: 'claude-code' as const,
    model: 'claude-sonnet-4-5',
    fallbackUsed: false,
    availability: {} as never,
  }));
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
      expect(runOneShotMock).not.toHaveBeenCalled();
    });

    it('returns immediately if sessionSummary is falsy', async () => {
      await reconcileMemoryAfterSession(tmpDir, '', DEFAULT_OPTS);
      expect(runOneShotMock).not.toHaveBeenCalled();
    });

    it('returns immediately if MEMORY.md does not exist', async () => {
      await reconcileMemoryAfterSession(tmpDir, 'some summary', DEFAULT_OPTS);
      expect(runOneShotMock).not.toHaveBeenCalled();
    });

    it('returns immediately if MEMORY.md is empty', async () => {
      writeFileSync(path.join(tmpDir, 'MEMORY.md'), '   \n  ', 'utf-8');
      await reconcileMemoryAfterSession(tmpDir, 'some summary', DEFAULT_OPTS);
      expect(runOneShotMock).not.toHaveBeenCalled();
    });
  });

  describe('NO_CHANGES_NEEDED detection', () => {
    it('does not overwrite MEMORY.md when the model responds NO_CHANGES_NEEDED', async () => {
      const original = '# Memory\n\nSome existing content here that is long enough.';
      writeFileSync(path.join(tmpDir, 'MEMORY.md'), original, 'utf-8');
      setupRunReturn('NO_CHANGES_NEEDED');

      await reconcileMemoryAfterSession(tmpDir, 'session summary', DEFAULT_OPTS);

      const after = readFileSync(path.join(tmpDir, 'MEMORY.md'), 'utf-8');
      expect(after).toBe(original);
    });

    it('does not overwrite when response contains NO_CHANGES_NEEDED among other text', async () => {
      const original = '# Memory\n\nSome existing content here that is long enough.';
      writeFileSync(path.join(tmpDir, 'MEMORY.md'), original, 'utf-8');
      setupRunReturn('After review: NO_CHANGES_NEEDED for this file.');

      await reconcileMemoryAfterSession(tmpDir, 'session summary', DEFAULT_OPTS);

      const after = readFileSync(path.join(tmpDir, 'MEMORY.md'), 'utf-8');
      expect(after).toBe(original);
    });
  });

  describe('size guard logic', () => {
    it('rejects result that is too short (< 50 chars)', async () => {
      const original = '# Memory\n\nSome content that is reasonable length for a memory file.';
      writeFileSync(path.join(tmpDir, 'MEMORY.md'), original, 'utf-8');
      setupRunReturn('Too short');

      await reconcileMemoryAfterSession(tmpDir, 'session summary', DEFAULT_OPTS);

      const after = readFileSync(path.join(tmpDir, 'MEMORY.md'), 'utf-8');
      expect(after).toBe(original);
    });

    it('rejects result that is too long (> 3x current size)', async () => {
      const original = '# Memory\n\n' + 'x'.repeat(500);
      writeFileSync(path.join(tmpDir, 'MEMORY.md'), original, 'utf-8');
      const hugeResult = '# Memory\n\n' + 'y'.repeat(2000);
      setupRunReturn(hugeResult);

      await reconcileMemoryAfterSession(tmpDir, 'session summary', DEFAULT_OPTS);

      const after = readFileSync(path.join(tmpDir, 'MEMORY.md'), 'utf-8');
      expect(after).toBe(original);
    });

    it('uses floor of 1000 when MEMORY.md is very small', async () => {
      const original = '# Memory\n\n' + 'x'.repeat(69);
      writeFileSync(path.join(tmpDir, 'MEMORY.md'), original, 'utf-8');
      const validResult = '# Memory\n\n' + 'Updated content. '.repeat(30);
      setupRunReturn(validResult);

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
      setupRunReturn(updated);

      await reconcileMemoryAfterSession(tmpDir, 'session summary', DEFAULT_OPTS);

      const after = readFileSync(path.join(tmpDir, 'MEMORY.md'), 'utf-8');
      expect(after).toBe(updated);
      const backup = readFileSync(path.join(tmpDir, 'MEMORY.md.bak'), 'utf-8');
      expect(backup).toBe(original);
    });
  });

  describe('error handling', () => {
    it('does not overwrite MEMORY.md when the runner rejects', async () => {
      const original = '# Memory\n\nSome existing content that should not be changed.';
      writeFileSync(path.join(tmpDir, 'MEMORY.md'), original, 'utf-8');
      setupRunReject('Something went wrong');

      await reconcileMemoryAfterSession(tmpDir, 'session summary', DEFAULT_OPTS);

      const after = readFileSync(path.join(tmpDir, 'MEMORY.md'), 'utf-8');
      expect(after).toBe(original);
    });

    it('handles NoEnginesAvailableError without overwriting MEMORY.md', async () => {
      const original = '# Memory\n\nExisting content that must remain when no engines are set up.';
      writeFileSync(path.join(tmpDir, 'MEMORY.md'), original, 'utf-8');
      // The resolver throws NoEnginesAvailableError when nothing is authed.
      resolveMock.mockImplementationOnce(async () => {
        throw new NoEnginesAvailableError({} as never);
      });
      const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await reconcileMemoryAfterSession(tmpDir, 'session summary', DEFAULT_OPTS);

      const after = readFileSync(path.join(tmpDir, 'MEMORY.md'), 'utf-8');
      expect(after).toBe(original);
      // The catch block tags the no-engines case distinctly so ops can
      // tell it apart from a generic spawn failure.
      expect(consoleErrSpy).toHaveBeenCalledWith(
        expect.stringContaining('No AI engine credentials available'),
        expect.any(String),
      );
      consoleErrSpy.mockRestore();
    });

    it('logs a transient quota 429 at warn level with a concise one-liner (not error)', async () => {
      const original = '# Memory\n\nUntouched on a transient quota failure.';
      writeFileSync(path.join(tmpDir, 'MEMORY.md'), original, 'utf-8');
      // Mimic the real gemini-cli rejection: raw multi-line stderr + an
      // `engine` tag (set by one-shot-spawn on the rejection Error).
      runOneShotMock.mockImplementation(async () => {
        throw Object.assign(
          new Error(
            'Warning: 256-color support not detected.\nTerminalQuotaError: You have exhausted your daily quota on this model.\n    at classifyGoogleError (chunk.js:1:1)\nAn unexpected critical error occurred:[object Object]',
          ),
          { engine: 'gemini-cli' },
        );
      });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await reconcileMemoryAfterSession(tmpDir, 'session summary', DEFAULT_OPTS);

      expect(readFileSync(path.join(tmpDir, 'MEMORY.md'), 'utf-8')).toBe(original);
      // Best-effort task: a transient quota error is a warn, never an error.
      expect(errSpy).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const line = (warnSpy.mock.calls[0] as string[]).join(' ');
      expect(line).toContain('[Memory Reconciliation]');
      expect(line).toContain('429');
      // The noisy stderr never reaches the log line.
      expect(line).not.toContain('[object Object]');
      expect(line).not.toContain('256-color');
      expect(line).not.toMatch(/\bat classifyGoogleError/);
      warnSpy.mockRestore();
      errSpy.mockRestore();
    });

    it('logs a generic spawn failure at error level with a concise summary', async () => {
      writeFileSync(path.join(tmpDir, 'MEMORY.md'), '# Memory\n\nContent.', 'utf-8');
      setupRunReject('Boom: the model returned a 500\n    at frame (x.js:1:1)');
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await reconcileMemoryAfterSession(tmpDir, 'session summary', DEFAULT_OPTS);

      expect(warnSpy).not.toHaveBeenCalled();
      expect(errSpy).toHaveBeenCalledTimes(1);
      const line = (errSpy.mock.calls[0] as string[]).join(' ');
      expect(line).toContain('[Memory Reconciliation] Failed:');
      expect(line).toContain('Boom: the model returned a 500');
      expect(line).not.toMatch(/\bat frame/);
      warnSpy.mockRestore();
      errSpy.mockRestore();
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
      expect(runOneShotMock).not.toHaveBeenCalled();
    });

    it('returns immediately if wikiPages is empty', async () => {
      await reconcileMemoryFromWiki(tmpDir, [], DEFAULT_OPTS);
      expect(runOneShotMock).not.toHaveBeenCalled();
    });

    it('returns immediately if MEMORY.md does not exist', async () => {
      await reconcileMemoryFromWiki(tmpDir, sampleWikiPages, DEFAULT_OPTS);
      expect(runOneShotMock).not.toHaveBeenCalled();
    });

    it('returns immediately if MEMORY.md is empty', async () => {
      writeFileSync(path.join(tmpDir, 'MEMORY.md'), '  \n', 'utf-8');
      await reconcileMemoryFromWiki(tmpDir, sampleWikiPages, DEFAULT_OPTS);
      expect(runOneShotMock).not.toHaveBeenCalled();
    });
  });

  describe('NO_CHANGES_NEEDED', () => {
    it('does not overwrite when the model says no changes needed', async () => {
      const original = '# Memory\n\nExisting wiki-derived content, long enough to pass checks.';
      writeFileSync(path.join(tmpDir, 'MEMORY.md'), original, 'utf-8');
      setupRunReturn('NO_CHANGES_NEEDED');

      await reconcileMemoryFromWiki(tmpDir, sampleWikiPages, DEFAULT_OPTS);

      const after = readFileSync(path.join(tmpDir, 'MEMORY.md'), 'utf-8');
      expect(after).toBe(original);
    });
  });

  describe('size guard', () => {
    it('rejects too-short result', async () => {
      const original = '# Memory\n\nContent with enough length to be meaningful for the test.';
      writeFileSync(path.join(tmpDir, 'MEMORY.md'), original, 'utf-8');
      setupRunReturn('Short');

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
      setupRunReturn(updated);

      await reconcileMemoryFromWiki(tmpDir, sampleWikiPages, DEFAULT_OPTS);

      const after = readFileSync(path.join(tmpDir, 'MEMORY.md'), 'utf-8');
      expect(after).toBe(updated);
      const backup = readFileSync(path.join(tmpDir, 'MEMORY.md.bak'), 'utf-8');
      expect(backup).toBe(original);
    });

    it('falls back to a non-Claude engine without disturbing the result', async () => {
      // Resolver reports a fallback was needed (Claude unavailable). The
      // memory function should still apply the result — the engine choice
      // is opaque to the caller.
      resolveMock.mockImplementationOnce(async () => ({
        engine: 'cursor-agent' as const,
        model: 'auto',
        fallbackUsed: true,
        fallbackFromReason: 'claude-code:no-credentials',
        availability: {} as never,
      }));
      const original = '# Memory\n\nOld wiki-derived content that is long enough to pass checks.';
      writeFileSync(path.join(tmpDir, 'MEMORY.md'), original, 'utf-8');
      const updated = '# Memory\n\nFallback-engine update content that is also sufficiently long.';
      setupRunReturn(updated);

      await reconcileMemoryFromWiki(tmpDir, sampleWikiPages, DEFAULT_OPTS);

      const after = readFileSync(path.join(tmpDir, 'MEMORY.md'), 'utf-8');
      expect(after).toBe(updated);
    });

    it('skips the sync (no overwrite) when the resolver throws NoEnginesAvailableError', async () => {
      const original = '# Memory\n\nExisting content that must remain when no engines are set up.';
      writeFileSync(path.join(tmpDir, 'MEMORY.md'), original, 'utf-8');
      resolveMock.mockImplementationOnce(async () => {
        throw new NoEnginesAvailableError({} as never);
      });
      const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await reconcileMemoryFromWiki(tmpDir, sampleWikiPages, DEFAULT_OPTS);

      const after = readFileSync(path.join(tmpDir, 'MEMORY.md'), 'utf-8');
      expect(after).toBe(original);
      expect(consoleErrSpy).toHaveBeenCalledWith(
        expect.stringContaining('No AI engine credentials available'),
        expect.any(String),
      );
      consoleErrSpy.mockRestore();
    });
  });
});

describe('mutex serialization', () => {
  it('serializes concurrent reconciliations (second waits for first)', async () => {
    const original = '# Memory\n\nOriginal content long enough for both reconciliation passes.';
    writeFileSync(path.join(tmpDir, 'MEMORY.md'), original, 'utf-8');

    let callCount = 0;
    runOneShotMock.mockImplementation(async () => {
      callCount += 1;
      const me = callCount;
      const delay = me === 1 ? 30 : 5;
      await new Promise((resolve) => setTimeout(resolve, delay));
      return `# Memory\n\nUpdate from call ${me} with enough length to pass.`;
    });

    const p1 = reconcileMemoryAfterSession(tmpDir, 'summary 1', DEFAULT_OPTS);
    const p2 = reconcileMemoryAfterSession(tmpDir, 'summary 2', DEFAULT_OPTS);

    await Promise.all([p1, p2]);

    expect(runOneShotMock).toHaveBeenCalledTimes(2);
    const after = readFileSync(path.join(tmpDir, 'MEMORY.md'), 'utf-8');
    expect(after).toContain('Update from call 2');
  });
});
