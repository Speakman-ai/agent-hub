import { execFileSync } from 'child_process';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
  renameSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HostWorktreeIo } from '../session-env/worktree-io.js';
import {
  isShellTool,
  notePreviewWatchToolResult,
  notePreviewWatchToolUse,
  nudgeRecentlyChangedFiles,
  buildRecentChangeFindCommand,
  buildStatCommand,
  buildTouchCommand,
  parseFingerprintPairs,
  LIST_SOURCE_FILES_GIT_ARGS,
  ledgerPathsForTest,
  resetPreviewWatchNudgeState,
  shellQuote,
  type PreviewWatchNudgeDeps,
} from './preview-watch-nudge.js';

function runtimeWith(status: string | null): PreviewWatchNudgeDeps['getDevServerRuntime'] {
  return () =>
    ({
      getActiveBySessionId: () => (status ? { id: 'ds-1', status } : null),
    }) as unknown as ReturnType<NonNullable<PreviewWatchNudgeDeps['getDevServerRuntime']>>;
}

describe('isShellTool', () => {
  it('matches shell tools across engines, not editor tools', () => {
    for (const t of ['Bash', 'Shell', 'run_terminal_cmd']) expect(isShellTool(t)).toBe(true);
    expect(isShellTool('Edit')).toBe(false);
    expect(isShellTool('Write')).toBe(false);
  });
});

describe('buildRecentChangeFindCommand', () => {
  it('filters on inode change time, prunes .git / node_modules, NUL-delimits', () => {
    const cmd = buildRecentChangeFindCommand(1700000000.9);
    expect(cmd).toContain('-newerct @1700000000');
    expect(cmd).toContain('-name .git -o -name node_modules');
    expect(cmd).toContain("-printf '%C@:%i:%s\\0%p\\0'");
  });

  it('lists source files through git with NUL output and standard excludes', () => {
    expect(LIST_SOURCE_FILES_GIT_ARGS).toEqual(['ls-files', '-z', '-co', '--exclude-standard']);
  });
});

describe('parseFingerprintPairs', () => {
  it('maps verbatim paths to fingerprints', () => {
    const out =
      '1790775389.1834814980:12:3\0./ok.ts\0' + '1790775390.0000000001:13:4\0./nl\nq"\\x.ts\0';
    expect([...parseFingerprintPairs(out)]).toEqual([
      ['ok.ts', '1790775389.1834814980:12:3'],
      ['nl\nq"\\x.ts', '1790775390.0000000001:13:4'],
    ]);
  });
});

describe('touch / stat commands', () => {
  it('never creates files and stats with the scan fingerprint format', () => {
    expect(buildTouchCommand(['-odd.ts'])).toBe("touch -c -- './-odd.ts'");
    expect(buildStatCommand(['-odd.ts'])).toContain(
      "find './-odd.ts' -maxdepth 0 -printf '%C@:%i:%s\\0%p\\0'",
    );
  });
});

describe('shellQuote', () => {
  it('escapes single quotes', () => {
    expect(shellQuote("it's.ts")).toBe(`'it'\\''s.ts'`);
  });
});

// Each case waits past a whole-second ctime boundary and shells out to git;
// the default 5s budget is too tight on a loaded runner.
describe('nudgeRecentlyChangedFiles', { timeout: 20_000 }, () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nudge-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir });
    git('init', '-q');
    git('config', 'user.email', 't@t');
    git('config', 'user.name', 't');
    writeFileSync(join(dir, 'app.ts'), 'a\n');
    writeFileSync(join(dir, 'old.ts'), 'old\n');
    git('add', '.');
    git('commit', '-qm', 'init');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    resetPreviewWatchNudgeState();
  });

  function deps(status: string | null): PreviewWatchNudgeDeps {
    return {
      broadcast: () => {},
      worktreePath: dir,
      getDevServerRuntime: runtimeWith(status),
      resolveIo: async () => new HostWorktreeIo(dir),
    };
  }

  const ancient = new Date(Date.now() - 60 * 60_000);
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const mtime = (rel: string) => statSync(join(dir, rel)).mtimeMs;

  /**
   * Age every setup file, then wait past the second boundary so the
   * command window (find -newerct has whole-second granularity here)
   * starts strictly after setup.
   */
  async function startCommandWindow(): Promise<number> {
    for (const f of ['app.ts', 'old.ts']) utimesSync(join(dir, f), ancient, ancient);
    await sleep(1100);
    return Date.now();
  }

  function windowDeps(): PreviewWatchNudgeDeps {
    // Kernel ctime comes from a coarse clock that can trail Date.now() by a
    // tick; a little slack keeps a just-written file inside the window.
    return { ...deps('ready'), changeSlackMs: 50 };
  }

  it('touches a file replaced by rename (sed -i style) and leaves untouched files alone', async () => {
    writeFileSync(join(dir, 'old.ts'), 'older\n');
    const since = await startCommandWindow();
    // Simulate `sed -i`: write a temp file, rename over the original, with an old mtime.
    writeFileSync(join(dir, 'app.ts.tmp'), 'b\n');
    utimesSync(join(dir, 'app.ts.tmp'), ancient, ancient);
    renameSync(join(dir, 'app.ts.tmp'), join(dir, 'app.ts'));

    const touched = await nudgeRecentlyChangedFiles('s1', since, windowDeps());

    expect(touched).toEqual(['app.ts']);
    expect(mtime('app.ts')).toBeGreaterThan(ancient.getTime() + 1000);
    // Dirty but outside the command window.
    expect(mtime('old.ts')).toBeCloseTo(ancient.getTime(), -1);
  });

  it('touches a file a rewrite made git-clean again', async () => {
    writeFileSync(join(dir, 'app.ts'), 'dirty\n');
    const since = await startCommandWindow();
    // `sed -i` restores the committed contents: git status is clean afterwards.
    writeFileSync(join(dir, 'app.ts.tmp'), 'a\n');
    renameSync(join(dir, 'app.ts.tmp'), join(dir, 'app.ts'));
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: dir }).toString()).toBe('');

    expect(await nudgeRecentlyChangedFiles('s1', since, windowDeps())).toEqual(['app.ts']);
  });

  it('touches a mv destination whose preserved mtime predates the command', async () => {
    const since = await startCommandWindow();
    renameSync(join(dir, 'old.ts'), join(dir, 'moved.ts'));
    expect(mtime('moved.ts')).toBeCloseTo(ancient.getTime(), -1);

    const touched = await nudgeRecentlyChangedFiles('s1', since, windowDeps());

    expect(touched).toEqual(['moved.ts']);
    expect(mtime('moved.ts')).toBeGreaterThan(ancient.getTime() + 1000);
  });

  it('skips git-ignored files', async () => {
    writeFileSync(join(dir, '.gitignore'), 'dist/\n');
    execFileSync('git', ['add', '.gitignore'], { cwd: dir });
    execFileSync('git', ['commit', '-qm', 'ignore'], { cwd: dir });
    utimesSync(join(dir, '.gitignore'), ancient, ancient);
    const since = await startCommandWindow();
    mkdirSync(join(dir, 'dist'));
    writeFileSync(join(dir, 'dist', 'main.js'), 'x');
    // Names git quotes/escapes in its line output even with core.quotePath=false.
    for (const name of ['a"b.js', 'back\\slash.js', 'new\nline.js']) {
      writeFileSync(join(dir, 'dist', name), 'x');
    }

    expect(await nudgeRecentlyChangedFiles('s1', since, windowDeps())).toEqual([]);
  });

  it('touches untracked files re-included by a negated ignore pattern', async () => {
    writeFileSync(join(dir, '.gitignore'), 'src/*\n!src/app.ts\n');
    mkdirSync(join(dir, 'lib'));
    writeFileSync(join(dir, 'lib', '.gitignore'), '*.gen.ts\n!keep.gen.ts\n');
    for (const f of ['.gitignore', 'lib/.gitignore']) utimesSync(join(dir, f), ancient, ancient);
    const since = await startCommandWindow();
    mkdirSync(join(dir, 'src'));
    for (const f of ['src/app.ts', 'src/other.ts', 'lib/keep.gen.ts', 'lib/drop.gen.ts']) {
      writeFileSync(join(dir, f), 'x');
    }

    const touched = await nudgeRecentlyChangedFiles('s1', since, windowDeps());

    expect([...touched].sort()).toEqual(['lib/keep.gen.ts', 'src/app.ts']);
  });

  it('touches non-ignored files with quote, backslash and newline in the name', async () => {
    const since = await startCommandWindow();
    const names = ['q"uote.ts', 'back\\slash.ts', 'new\nline.ts', "it's.ts"];
    for (const name of names) {
      writeFileSync(join(dir, name), 'x');
      utimesSync(join(dir, name), ancient, ancient);
    }

    const touched = await nudgeRecentlyChangedFiles('s1', since, windowDeps());

    expect([...touched].sort()).toEqual([...names].sort());
    for (const name of names) expect(mtime(name)).toBeGreaterThan(ancient.getTime() + 1000);
  });

  it('does not re-nudge its own touch on later read-only commands (production slack)', async () => {
    const prod = deps('ready'); // no changeSlackMs override: the real 5s window
    const rewrite = (content: string) => {
      writeFileSync(join(dir, 'app.ts.tmp'), content);
      renameSync(join(dir, 'app.ts.tmp'), join(dir, 'app.ts'));
    };
    // Setup wrote files inside the 5s window; the first scan nudges them once.
    await nudgeRecentlyChangedFiles('s1', Date.now(), prod);

    rewrite('b\n');
    expect(await nudgeRecentlyChangedFiles('s1', Date.now(), prod)).toEqual(['app.ts']);
    const afterNudge = mtime('app.ts');

    // `git status`, `ls`, … inside the slack window: nothing new happened.
    for (let i = 0; i < 3; i++) {
      expect(await nudgeRecentlyChangedFiles('s1', Date.now(), prod)).toEqual([]);
    }
    expect(mtime('app.ts')).toBe(afterNudge);

    // A real edit after the nudge is still detected, even within the same window.
    rewrite('c\n');
    expect(await nudgeRecentlyChangedFiles('s1', Date.now(), prod)).toEqual(['app.ts']);
    expect(await nudgeRecentlyChangedFiles('s1', Date.now(), prod)).toEqual([]);
  });

  it('does not re-nudge when an older command window finishes after newer ones', async () => {
    const d = windowDeps();
    const rewrite = (name: string, content: string) => {
      writeFileSync(join(dir, `${name}.tmp`), content);
      renameSync(join(dir, `${name}.tmp`), join(dir, name));
    };
    const since0 = await startCommandWindow();
    // Long read-only command L starts and stays outstanding.
    notePreviewWatchToolUse('s1', 'long', 'Bash', { command: 'npm test' }, since0);

    rewrite('app.ts', 'A\n');
    expect(await nudgeRecentlyChangedFiles('s1', since0, d)).toEqual(['app.ts']);

    // A later short command edits old.ts; its window starts after app.ts's touch.
    // Far enough that since1's whole-second floor is past the earlier touch.
    await sleep(2100);
    const since1 = Date.now();
    rewrite('old.ts', 'B\n');
    expect(await nudgeRecentlyChangedFiles('s1', since1, d)).toEqual(['old.ts']);
    // app.ts is outside this window but L's window still covers it.
    expect(ledgerPathsForTest('s1')).toEqual(['app.ts', 'old.ts']);

    // L finishes last and scans from its own, older start.
    expect(await nudgeRecentlyChangedFiles('s1', since0, d)).toEqual([]);
  });

  it('keeps fingerprints for an older scan queued behind an in-flight newer scan', async () => {
    const d = windowDeps();
    const rewrite = (name: string, content: string) => {
      writeFileSync(join(dir, `${name}.tmp`), content);
      renameSync(join(dir, `${name}.tmp`), join(dir, name));
    };
    const since0 = await startCommandWindow();
    notePreviewWatchToolUse('s1', 'long', 'Bash', { command: 'npm test' }, since0);
    rewrite('app.ts', 'A\n');
    expect(await nudgeRecentlyChangedFiles('s1', since0, d)).toEqual(['app.ts']);
    const appAfterNudge = mtime('app.ts');

    // Far enough that since1's whole-second floor is past app.ts's touch.
    await sleep(2100);
    const since1 = Date.now();
    rewrite('old.ts', 'B\n');
    // Newer scan N starts and stalls on I/O.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const newer = nudgeRecentlyChangedFiles('s1', since1, {
      ...d,
      resolveIo: async () => {
        await gate;
        return new HostWorktreeIo(dir);
      },
    });

    // The long read-only command finishes; its debounced scan fires and
    // queues behind N.
    const fired: Array<() => void> = [];
    notePreviewWatchToolResult('s1', 'long', { ...d, schedule: (fn) => fired.push(fn) });
    expect(fired).toHaveLength(1);
    fired[0]();

    release();
    expect(await newer).toEqual(['old.ts']);
    expect(ledgerPathsForTest('s1')).toEqual(['app.ts', 'old.ts']);
    // Queued after the older scan, so resolving it means that one finished.
    await nudgeRecentlyChangedFiles('s1', Date.now(), d);
    expect(mtime('app.ts')).toBe(appAfterNudge);
  });

  it('prunes fingerprints once no outstanding window can include them', async () => {
    const d = windowDeps();
    const since0 = await startCommandWindow();
    writeFileSync(join(dir, 'app.ts.tmp'), 'A\n');
    renameSync(join(dir, 'app.ts.tmp'), join(dir, 'app.ts'));
    expect(await nudgeRecentlyChangedFiles('s1', since0, d)).toEqual(['app.ts']);

    // Far enough that since1's whole-second floor is past the earlier touch.
    await sleep(2100);
    const since1 = Date.now();
    writeFileSync(join(dir, 'old.ts.tmp'), 'B\n');
    renameSync(join(dir, 'old.ts.tmp'), join(dir, 'old.ts'));
    expect(await nudgeRecentlyChangedFiles('s1', since1, d)).toEqual(['old.ts']);
    expect(ledgerPathsForTest('s1')).toEqual(['old.ts']);
  });

  /** Host IO whose exec runs `hook` after each touch command completes. */
  function ioWithTouchHook(
    hook: (attempt: number) => void,
    failTouches = 0,
  ): PreviewWatchNudgeDeps['resolveIo'] {
    return async () => {
      const io = new HostWorktreeIo(dir);
      let touches = 0;
      const exec = io.exec.bind(io);
      io.exec = async (command, opts) => {
        if (!command.startsWith('touch ')) return exec(command, opts);
        touches++;
        if (touches <= failTouches) return { stdout: '', stderr: 'boom', exitCode: 1 };
        const res = await exec(command, opts);
        hook(touches);
        return res;
      };
      return io;
    };
  }

  it('re-touches a file replaced between our touch and its stat', async () => {
    const prod = deps('ready');
    await nudgeRecentlyChangedFiles('s1', Date.now(), prod);
    writeFileSync(join(dir, 'app.ts.tmp'), 'A\n');
    renameSync(join(dir, 'app.ts.tmp'), join(dir, 'app.ts'));

    // Another command's `sed -i` lands right after our first touch: an old-mtime replacement.
    const touched = await nudgeRecentlyChangedFiles('s1', Date.now(), {
      ...prod,
      resolveIo: ioWithTouchHook((attempt) => {
        if (attempt !== 1) return;
        writeFileSync(join(dir, 'app.ts.tmp'), 'B\n');
        utimesSync(join(dir, 'app.ts.tmp'), ancient, ancient);
        renameSync(join(dir, 'app.ts.tmp'), join(dir, 'app.ts'));
      }),
    });

    expect(touched).toEqual(['app.ts']);
    // The replacement itself was touched, not just ledgered.
    expect(mtime('app.ts')).toBeGreaterThan(ancient.getTime() + 1000);
    const afterRetry = mtime('app.ts');
    expect(await nudgeRecentlyChangedFiles('s1', Date.now(), prod)).toEqual([]);
    expect(mtime('app.ts')).toBe(afterRetry);
  });

  it('leaves a file whose touch failed for the next scan instead of ledgering it', async () => {
    const prod = deps('ready');
    await nudgeRecentlyChangedFiles('s1', Date.now(), prod);
    writeFileSync(join(dir, 'app.ts.tmp'), 'A\n');
    renameSync(join(dir, 'app.ts.tmp'), join(dir, 'app.ts'));

    const failing = { ...prod, resolveIo: ioWithTouchHook(() => {}, 99) };
    expect(await nudgeRecentlyChangedFiles('s1', Date.now(), failing)).toEqual([]);
    expect(await nudgeRecentlyChangedFiles('s1', Date.now(), prod)).toEqual(['app.ts']);
  });

  it('serializes concurrent nudges so one does not re-touch the other', async () => {
    const prod = deps('ready');
    await nudgeRecentlyChangedFiles('s1', Date.now(), prod);
    writeFileSync(join(dir, 'app.ts.tmp'), 'z\n');
    renameSync(join(dir, 'app.ts.tmp'), join(dir, 'app.ts'));
    const results = await Promise.all([
      nudgeRecentlyChangedFiles('s1', Date.now(), prod),
      nudgeRecentlyChangedFiles('s1', Date.now(), prod),
    ]);
    expect(results).toEqual([['app.ts'], []]);
  });

  it('does nothing without an active preview', async () => {
    writeFileSync(join(dir, 'app.ts'), 'c\n');
    expect(await nudgeRecentlyChangedFiles('s1', Date.now() - 2000, deps(null))).toEqual([]);
    expect(await nudgeRecentlyChangedFiles('s1', Date.now() - 2000, deps('stopped'))).toEqual([]);
  });

  it('schedules one debounced nudge per burst of shell results', async () => {
    const scheduled: Array<() => void> = [];
    const d: PreviewWatchNudgeDeps = { ...deps('ready'), schedule: (fn) => scheduled.push(fn) };
    notePreviewWatchToolUse('s1', 'tu-1', 'Bash', { command: "sed -i 's/a/b/' app.ts" });
    notePreviewWatchToolUse('s1', 'tu-2', 'Bash', { command: 'mv x y' });
    notePreviewWatchToolUse('s1', 'tu-3', 'Bash', { command: 'git status' });
    notePreviewWatchToolResult('s1', 'tu-1', d);
    notePreviewWatchToolResult('s1', 'tu-2', d);
    notePreviewWatchToolResult('s1', 'tu-3', d);
    expect(scheduled).toHaveLength(1);
  });

  it('checks shell commands the old write-heuristic missed, but not editor tools', () => {
    const scheduled: Array<() => void> = [];
    const d: PreviewWatchNudgeDeps = { ...deps('ready'), schedule: (fn) => scheduled.push(fn) };
    notePreviewWatchToolUse('s1', 'tu-e', 'Edit', { file_path: 'app.ts' });
    notePreviewWatchToolResult('s1', 'tu-e', d);
    expect(scheduled).toHaveLength(0);
    notePreviewWatchToolUse('s1', 'tu-p', 'Bash', { command: "perl -pi -e 's/a/b/' app.ts" });
    notePreviewWatchToolResult('s1', 'tu-p', d);
    expect(scheduled).toHaveLength(1);
  });

  it('does not schedule when no preview is running', () => {
    const scheduled: Array<() => void> = [];
    const d: PreviewWatchNudgeDeps = { ...deps(null), schedule: (fn) => scheduled.push(fn) };
    notePreviewWatchToolUse('s1', 'tu-1', 'Bash', { command: "sed -i 's/a/b/' app.ts" });
    notePreviewWatchToolResult('s1', 'tu-1', d);
    expect(scheduled).toHaveLength(0);
  });
});
