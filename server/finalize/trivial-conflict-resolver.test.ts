import { describe, it, expect, vi } from 'vitest';
import {
  classifyFileResolution,
  isLockfilePath,
  normalizeWhitespace,
  parseConflictHunks,
  regenerateLockfile,
  resolveImportOrder,
  resolveWhitespace,
} from './trivial-conflict-resolver.js';

describe('parseConflictHunks', () => {
  it('parses a single hunk', () => {
    const text = [
      'before',
      '<<<<<<< HEAD',
      'ours line',
      '=======',
      'theirs line',
      '>>>>>>> abc123',
      'after',
    ].join('\n');
    const hunks = parseConflictHunks(text);
    expect(hunks).not.toBeNull();
    expect(hunks).toHaveLength(1);
    expect(hunks?.[0]).toMatchObject({
      start: 1,
      end: 5,
      ours: ['ours line'],
      theirs: ['theirs line'],
    });
  });

  it('parses multiple hunks in one file', () => {
    const text = [
      'a',
      '<<<<<<< HEAD',
      'o1',
      '=======',
      't1',
      '>>>>>>> x',
      'b',
      '<<<<<<< HEAD',
      'o2',
      '=======',
      't2',
      '>>>>>>> y',
      'c',
    ].join('\n');
    const hunks = parseConflictHunks(text);
    expect(hunks).toHaveLength(2);
  });

  it('returns null on unclosed conflict', () => {
    const text = ['<<<<<<< HEAD', 'ours', '======='].join('\n');
    expect(parseConflictHunks(text)).toBeNull();
  });

  it('returns null on nested conflict markers', () => {
    const text = [
      '<<<<<<< HEAD',
      'ours',
      '<<<<<<< HEAD',
      'nested',
      '=======',
      'theirs',
      '>>>>>>> x',
      '=======',
      'outer-theirs',
      '>>>>>>> y',
    ].join('\n');
    expect(parseConflictHunks(text)).toBeNull();
  });

  it('returns empty array when no conflicts present', () => {
    expect(parseConflictHunks('clean file\nno conflicts')).toEqual([]);
  });
});

describe('normalizeWhitespace', () => {
  it('trims leading and trailing whitespace', () => {
    expect(normalizeWhitespace('  hello  ')).toBe('hello');
    expect(normalizeWhitespace('\tindent')).toBe('indent');
    expect(normalizeWhitespace('trailing   ')).toBe('trailing');
  });

  it('preserves interior whitespace verbatim (including inside string literals)', () => {
    // This is the key behavioral guarantee: the previous implementation
    // collapsed interior whitespace, which silently considered
    // `"a   b"` and `"a b"` to be the same line. We do not.
    expect(normalizeWhitespace('a    b\tc')).toBe('a    b\tc');
    expect(normalizeWhitespace('const m = "a   b"')).toBe('const m = "a   b"');
  });
});

describe('resolveWhitespace', () => {
  it('resolves a tab-vs-space-only conflict, keeping ours', () => {
    const text = ['x', '<<<<<<< HEAD', '\tfoo', '=======', '    foo', '>>>>>>> z', 'y'].join('\n');
    const hunks = parseConflictHunks(text)!;
    const resolved = resolveWhitespace(text, hunks);
    expect(resolved).toBe(['x', '\tfoo', 'y'].join('\n'));
  });

  it('resolves trailing-whitespace-only conflict', () => {
    const text = [
      '<<<<<<< HEAD',
      'console.log("x")',
      '=======',
      'console.log("x")   ',
      '>>>>>>> z',
    ].join('\n');
    const hunks = parseConflictHunks(text)!;
    const resolved = resolveWhitespace(text, hunks);
    expect(resolved).toBe('console.log("x")');
  });

  it('returns null when sides differ semantically', () => {
    const text = ['<<<<<<< HEAD', 'const a = 1', '=======', 'const a = 2', '>>>>>>> z'].join('\n');
    const hunks = parseConflictHunks(text)!;
    expect(resolveWhitespace(text, hunks)).toBeNull();
  });

  it('returns null when any hunk in a multi-hunk file is non-whitespace', () => {
    const text = [
      '<<<<<<< HEAD',
      '\ttrivial',
      '=======',
      '    trivial',
      '>>>>>>> z',
      'mid',
      '<<<<<<< HEAD',
      'real diff a',
      '=======',
      'real diff b',
      '>>>>>>> z',
    ].join('\n');
    const hunks = parseConflictHunks(text)!;
    expect(resolveWhitespace(text, hunks)).toBeNull();
  });

  it('refuses string-literal interior whitespace differences (no silent merge)', () => {
    // Guards the specific behavior the reviewer flagged: a previous
    // implementation collapsed interior runs and would have resolved
    // these two sides as "equal", silently dropping "theirs".
    const text = [
      '<<<<<<< HEAD',
      'const m = "a   b"',
      '=======',
      'const m = "a b"',
      '>>>>>>> z',
    ].join('\n');
    const hunks = parseConflictHunks(text)!;
    expect(resolveWhitespace(text, hunks)).toBeNull();
  });

  it('refuses template-literal interior whitespace differences', () => {
    const text = [
      '<<<<<<< HEAD',
      'const m = `hello   world`',
      '=======',
      'const m = `hello world`',
      '>>>>>>> z',
    ].join('\n');
    const hunks = parseConflictHunks(text)!;
    expect(resolveWhitespace(text, hunks)).toBeNull();
  });
});

describe('resolveImportOrder', () => {
  it('merges and sorts both sides alphabetically', () => {
    const text = [
      '<<<<<<< HEAD',
      "import { b } from 'b'",
      "import { a } from 'a'",
      '=======',
      "import { c } from 'c'",
      "import { a } from 'a'",
      '>>>>>>> z',
    ].join('\n');
    const hunks = parseConflictHunks(text)!;
    const resolved = resolveImportOrder(text, hunks);
    expect(resolved).toBe(
      ["import { a } from 'a'", "import { b } from 'b'", "import { c } from 'c'"].join('\n'),
    );
  });

  it('handles CommonJS require lines', () => {
    const text = [
      '<<<<<<< HEAD',
      "const x = require('x');",
      '=======',
      "const y = require('y');",
      '>>>>>>> z',
    ].join('\n');
    const hunks = parseConflictHunks(text)!;
    const resolved = resolveImportOrder(text, hunks);
    expect(resolved).toContain("const x = require('x');");
    expect(resolved).toContain("const y = require('y');");
  });

  it('refuses when a side contains non-import lines', () => {
    const text = [
      '<<<<<<< HEAD',
      "import { a } from 'a'",
      'const x = 1',
      '=======',
      "import { b } from 'b'",
      '>>>>>>> z',
    ].join('\n');
    const hunks = parseConflictHunks(text)!;
    expect(resolveImportOrder(text, hunks)).toBeNull();
  });

  it('refuses when both sides are completely empty', () => {
    const text = ['<<<<<<< HEAD', '=======', '>>>>>>> z'].join('\n');
    const hunks = parseConflictHunks(text)!;
    expect(resolveImportOrder(text, hunks)).toBeNull();
  });

  it("refuses when a side contains a side-effect ES import (`import './foo'`)", () => {
    // Side-effect imports are order-sensitive (polyfill init, CSS
    // cascade). Alphabetical re-sort would silently change runtime
    // behavior, so this branch must refuse and fall through to dispatch.
    const text = [
      '<<<<<<< HEAD',
      "import './polyfill'",
      "import { a } from 'a'",
      '=======',
      "import { b } from 'b'",
      '>>>>>>> z',
    ].join('\n');
    const hunks = parseConflictHunks(text)!;
    expect(resolveImportOrder(text, hunks)).toBeNull();
  });

  it('refuses when a side contains a side-effect CSS import', () => {
    const text = [
      '<<<<<<< HEAD',
      'import "reset.css"',
      "import { a } from 'a'",
      '=======',
      "import { b } from 'b'",
      '>>>>>>> z',
    ].join('\n');
    const hunks = parseConflictHunks(text)!;
    expect(resolveImportOrder(text, hunks)).toBeNull();
  });

  it("refuses when a side contains a bare `require('x')` (side-effect)", () => {
    const text = [
      '<<<<<<< HEAD',
      "require('./register-hooks');",
      "const x = require('x');",
      '=======',
      "const y = require('y');",
      '>>>>>>> z',
    ].join('\n');
    const hunks = parseConflictHunks(text)!;
    expect(resolveImportOrder(text, hunks)).toBeNull();
  });
});

describe('isLockfilePath', () => {
  it('matches package-lock.json at any depth', () => {
    expect(isLockfilePath('package-lock.json')).toBe(true);
    expect(isLockfilePath('server/package-lock.json')).toBe(true);
    expect(isLockfilePath('a/b/c/package-lock.json')).toBe(true);
  });

  it('matches npm-shrinkwrap.json', () => {
    expect(isLockfilePath('npm-shrinkwrap.json')).toBe(true);
  });

  it('does not match unrelated files', () => {
    expect(isLockfilePath('package.json')).toBe(false);
    expect(isLockfilePath('Cargo.lock')).toBe(false);
    expect(isLockfilePath('yarn.lock')).toBe(false);
    expect(isLockfilePath('pnpm-lock.yaml')).toBe(false);
  });
});

describe('classifyFileResolution', () => {
  it('routes lockfile paths to the lockfile branch without parsing', () => {
    // Body intentionally not a parseable conflict — the lockfile branch
    // must short-circuit before parseConflictHunks runs.
    const res = classifyFileResolution('package-lock.json', '{"garbage": true}');
    expect(res.kind).toBe('lockfile');
  });

  it('routes whitespace-only conflicts to whitespace branch', () => {
    const text = ['<<<<<<< HEAD', '\tfoo', '=======', '    foo', '>>>>>>> z'].join('\n');
    const res = classifyFileResolution('server/foo.ts', text);
    expect(res.kind).toBe('whitespace');
    expect(res.resolvedText).toBeDefined();
  });

  it('routes import-order conflicts to import-order branch', () => {
    const text = [
      '<<<<<<< HEAD',
      "import { b } from 'b'",
      '=======',
      "import { a } from 'a'",
      '>>>>>>> z',
    ].join('\n');
    const res = classifyFileResolution('server/foo.ts', text);
    expect(res.kind).toBe('import-order');
    expect(res.resolvedText).toBeDefined();
  });

  it('reports non-trivial conflicts with unresolved hunks', () => {
    const text = [
      '<<<<<<< HEAD',
      'function add(a, b) { return a + b }',
      '=======',
      'function add(x, y) { return x * y }',
      '>>>>>>> z',
    ].join('\n');
    const res = classifyFileResolution('server/foo.ts', text);
    expect(res.kind).toBe('non-trivial');
    expect(res.unresolved).toHaveLength(1);
  });

  it('classifies malformed conflict markers as non-trivial', () => {
    const res = classifyFileResolution('server/foo.ts', '<<<<<<< HEAD\nno end\n');
    expect(res.kind).toBe('non-trivial');
  });
});

describe('regenerateLockfile', () => {
  it('runs npm install with --package-lock-only --ignore-scripts and reports ok', async () => {
    const runNpm = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
    const result = await regenerateLockfile('/tmp/wt', { runNpm: runNpm as never });
    expect(result.ok).toBe(true);
    // --ignore-scripts is explicit even though --package-lock-only already
    // skips lifecycle scripts — guarantees no code execution against a
    // freshly-rebased package.json.
    expect(runNpm).toHaveBeenCalledWith(
      'npm',
      ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'],
      expect.objectContaining({ cwd: '/tmp/wt' }),
    );
  });

  it('reports failure when npm exits non-zero', async () => {
    const runNpm = vi.fn().mockRejectedValue(new Error('npm exited 1: ELOCKVERIFY'));
    const result = await regenerateLockfile('/tmp/wt', { runNpm: runNpm as never });
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.detail).toContain('ELOCKVERIFY');
    }
  });
});
