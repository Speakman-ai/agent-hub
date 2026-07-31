// Regression tests for the concurrent-clone failure that produced
//
//   BUG: refs/files-backend.c:3040: initial ref transaction called with existing refs
//
// Root cause: `ensureSessionWorkspace` had no concurrency control, and its
// "clone already exists, just refresh it" branch gated on `existsSync(<dir>/.git)`.
// `git clone` creates `.git` ~5ms into a clone that takes hundreds of ms (warm)
// to tens of seconds (cold, large repo), so a second concurrent call for the
// same session took the reuse branch and ran `git fetch origin --quiet` into the
// clone that was still being built. The fetch wrote `refs/remotes/origin/*`; the
// live clone then reached `write_remote_refs` -> `initial_ref_transaction_commit`,
// found refs it was about to create, and aborted.
//
// Because git's `BUG()` path aborts via SIGABRT it skips git's own junk-dir
// cleanup, so a half-built `.git` survived. `removeZombieCloneDir` bailed the
// moment `.git` existed, and the reuse gate then adopted the carcass forever —
// turning one race into an unbounded stream of identical failures.
//
// Three guards are covered here: the per-session lock, the completeness probe
// that replaced the bare `.git` check, and transient-classification so the
// clone retries and wipes the partial directory.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execSync, execFileSync } from 'child_process';
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import path from 'path';
import os from 'os';
import { homedir } from 'os';
import type { SessionRow } from './types.js';

vi.mock('./config.js', () => ({
  default: { defaultCwd: '/tmp' },
}));

const { ensureSessionWorkspace, removeWorkspace, __test } = await import('./worktree.js');
const { classifyWorktreeFailure } = await import('./worktree-failure-cause.js');

const BUG_MESSAGE =
  'Command failed: git clone --quiet /data/git/surveytracker.git /home/node/.agent-hub/workspaces/surveytracker/session-9b1990ab\n' +
  'BUG: refs/files-backend.c:3040: initial ref transaction called with existing refs\n';

// ─── withKeyedLock ───────────────────────────────────────────────────────────

describe('withKeyedLock', () => {
  it('serialises overlapping calls that share a key', async () => {
    const events: string[] = [];
    const task = (name: string, ms: number) => async () => {
      events.push(`${name}:enter`);
      await new Promise((r) => setTimeout(r, ms));
      events.push(`${name}:exit`);
      return name;
    };

    const [a, b] = await Promise.all([
      __test.withKeyedLock('same', task('a', 30)),
      __test.withKeyedLock('same', task('b', 1)),
    ]);

    expect(a).toBe('a');
    expect(b).toBe('b');
    // The critical property: no interleaving. Without the lock this reads
    // a:enter, b:enter, b:exit, a:exit — which is exactly the window where
    // one call fetches into the clone another is still creating.
    expect(events).toEqual(['a:enter', 'a:exit', 'b:enter', 'b:exit']);
  });

  it('allows different keys to run concurrently', async () => {
    const events: string[] = [];
    const task = (name: string, ms: number) => async () => {
      events.push(`${name}:enter`);
      await new Promise((r) => setTimeout(r, ms));
      events.push(`${name}:exit`);
    };

    await Promise.all([
      __test.withKeyedLock('key-a', task('a', 30)),
      __test.withKeyedLock('key-b', task('b', 1)),
    ]);

    // Distinct sessions must not block each other.
    expect(events).toEqual(['a:enter', 'b:enter', 'b:exit', 'a:exit']);
  });

  it('does not poison the chain when a predecessor rejects', async () => {
    const failing = __test.withKeyedLock('shared', async () => {
      throw new Error('boom');
    });
    const following = __test.withKeyedLock('shared', async () => 'ok');

    await expect(failing).rejects.toThrow('boom');
    await expect(following).resolves.toBe('ok');
  });

  it('releases the key once the chain drains (no unbounded map growth)', async () => {
    await __test.withKeyedLock('transient', async () => 'done');
    // Re-acquiring must work and must not observe a stale predecessor.
    await expect(__test.withKeyedLock('transient', async () => 'again')).resolves.toBe('again');
  });
});

// ─── cloneLooksComplete / removeZombieCloneDir ───────────────────────────────

describe('cloneLooksComplete', () => {
  let root: string;

  beforeEach(() => {
    root = path.join(
      os.tmpdir(),
      `clone-complete-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(root, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** Build the exact shape a clone killed in `write_remote_refs` leaves behind. */
  function makeHalfBuiltClone(dir: string): string {
    const gitDir = path.join(dir, '.git');
    mkdirSync(path.join(gitDir, 'objects', 'pack'), { recursive: true });
    mkdirSync(path.join(gitDir, 'refs', 'heads'), { recursive: true });
    // The racing fetch wrote remote-tracking refs; the clone never got to
    // write a local branch or check out an index.
    mkdirSync(path.join(gitDir, 'refs', 'remotes', 'origin'), { recursive: true });
    writeFileSync(path.join(gitDir, 'refs', 'remotes', 'origin', 'master'), `${'0'.repeat(40)}\n`);
    writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/master\n');
    writeFileSync(path.join(gitDir, 'config'), '[core]\n\trepositoryformatversion = 0\n');
    return dir;
  }

  it('rejects a directory with no .git at all', () => {
    const dir = path.join(root, 'no-git');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'leftover.txt'), 'junk\n');
    expect(__test.cloneLooksComplete(dir)).toBe(false);
  });

  it('rejects a .git directory with no HEAD (clone died during init)', () => {
    const dir = path.join(root, 'no-head');
    mkdirSync(path.join(dir, '.git', 'objects'), { recursive: true });
    expect(__test.cloneLooksComplete(dir)).toBe(false);
  });

  it('rejects a clone aborted during write_remote_refs (remote refs only, no index, no local branch)', () => {
    const dir = makeHalfBuiltClone(path.join(root, 'half-built'));
    // The old gate was `existsSync(<dir>/.git)`, which is true here — that is
    // precisely why the poisoned directory was never swept.
    expect(existsSync(path.join(dir, '.git'))).toBe(true);
    expect(__test.cloneLooksComplete(dir)).toBe(false);
  });

  it('does not treat a bare .git/index as proof of a finished clone', () => {
    // An index is necessary evidence that checkout ran, but never sufficient
    // on its own: this shape has remote-tracking refs and no branch, so the
    // clone died before `update_head` whatever the index file contains.
    const dir = makeHalfBuiltClone(path.join(root, 'with-index'));
    writeFileSync(path.join(dir, '.git', 'index'), 'DIRC anything at all');
    expect(__test.cloneLooksComplete(dir)).toBe(false);
  });

  it('rejects a branch-bearing clone that never reached checkout', () => {
    // `update_head` writes refs/heads/<branch> before `checkout` writes the
    // index and working tree. A clone killed in that window has a perfectly
    // good branch and no files at all — reusing it hands an agent an empty
    // directory.
    const dir = makeHalfBuiltClone(path.join(root, 'branch-no-checkout'));
    writeFileSync(path.join(dir, '.git', 'refs', 'heads', 'master'), `${'a'.repeat(40)}\n`);
    expect(__test.hasLocalBranch(path.join(dir, '.git'))).toBe(true);
    expect(__test.checkoutLooksDone(path.join(dir, '.git'))).toBe(false);
    expect(__test.cloneLooksComplete(dir)).toBe(false);
  });

  it('accepts a clone with both a local branch and an index', () => {
    const dir = makeHalfBuiltClone(path.join(root, 'branch-and-index'));
    writeFileSync(path.join(dir, '.git', 'refs', 'heads', 'master'), `${'a'.repeat(40)}\n`);
    writeFileSync(path.join(dir, '.git', 'index'), 'DIRC');
    expect(__test.cloneLooksComplete(dir)).toBe(true);
  });

  it('finds a nested session branch (refs/heads/agent-hub/<agent>/session-<id>)', () => {
    const dir = makeHalfBuiltClone(path.join(root, 'nested-branch'));
    const nested = path.join(dir, '.git', 'refs', 'heads', 'agent-hub', 'dev');
    mkdirSync(nested, { recursive: true });
    writeFileSync(path.join(nested, 'session-abc123'), `${'a'.repeat(40)}\n`);
    expect(__test.hasLocalBranch(path.join(dir, '.git'))).toBe(true);
    writeFileSync(path.join(dir, '.git', 'index'), 'DIRC');
    expect(__test.cloneLooksComplete(dir)).toBe(true);
  });

  it('does not accept an empty nested ref directory as a branch', () => {
    const dir = makeHalfBuiltClone(path.join(root, 'empty-nested'));
    // Counting entries under refs/heads (the first implementation) would have
    // called this complete — `agent-hub/` is a directory with no ref in it.
    mkdirSync(path.join(dir, '.git', 'refs', 'heads', 'agent-hub', 'dev'), { recursive: true });
    expect(__test.hasLocalBranch(path.join(dir, '.git'))).toBe(false);
    expect(__test.cloneLooksComplete(dir)).toBe(false);
  });

  it('does not accept a ref file whose contents are not a ref', () => {
    const dir = makeHalfBuiltClone(path.join(root, 'garbage-ref'));
    writeFileSync(path.join(dir, '.git', 'refs', 'heads', 'master'), 'not-a-sha\n');
    expect(__test.hasLocalBranch(path.join(dir, '.git'))).toBe(false);
    expect(__test.cloneLooksComplete(dir)).toBe(false);
  });

  it('accepts a symref ref file', () => {
    expect(__test.isValidRefContent('ref: refs/heads/main\n')).toBe(true);
    expect(__test.isValidRefContent('ref: nonsense\n')).toBe(false);
    expect(__test.isValidRefContent(`${'f'.repeat(64)}\n`)).toBe(true); // sha256
    expect(__test.isValidRefContent('')).toBe(false);
  });

  it('rejects a truncated symref that names only a namespace', () => {
    // `startsWith('refs/')` alone accepted all of these, which let a truncated
    // HEAD or ref file stand in for a real branch.
    for (const body of ['ref: refs/', 'ref: refs/heads/', 'ref: refs/heads', 'ref: refs']) {
      expect(__test.isValidRefContent(body)).toBe(false);
    }
  });

  it('rejects a loose ref whose contents are a truncated symref', () => {
    const dir = makeHalfBuiltClone(path.join(root, 'truncated-symref'));
    writeFileSync(path.join(dir, '.git', 'refs', 'heads', 'main'), 'ref: refs/\n');
    expect(__test.hasLocalBranch(path.join(dir, '.git'))).toBe(false);
    expect(__test.cloneLooksComplete(dir)).toBe(false);
  });

  it('ignores a .lock file sitting next to a ref', () => {
    const dir = makeHalfBuiltClone(path.join(root, 'lockfile'));
    writeFileSync(path.join(dir, '.git', 'refs', 'heads', 'main.lock'), `${'a'.repeat(40)}\n`);
    expect(__test.hasLocalBranch(path.join(dir, '.git'))).toBe(false);
    expect(__test.cloneLooksComplete(dir)).toBe(false);
  });

  it('rejects a packed-refs line naming only the bare namespace', () => {
    const dir = makeHalfBuiltClone(path.join(root, 'packed-bare-ns'));
    writeFileSync(
      path.join(dir, '.git', 'packed-refs'),
      `# pack-refs with: peeled fully-peeled sorted \n${'b'.repeat(40)} refs/heads/\n`,
    );
    expect(__test.hasLocalBranch(path.join(dir, '.git'))).toBe(false);
    expect(__test.cloneLooksComplete(dir)).toBe(false);
  });

  it('isConcreteRefPath requires a name beneath the namespace', () => {
    expect(__test.isConcreteRefPath('refs/heads/main')).toBe(true);
    expect(__test.isConcreteRefPath('refs/remotes/origin/HEAD')).toBe(true);
    // git itself accepts `refs/heads` as a refname, but as a branch it names
    // the namespace, not a branch.
    expect(__test.isValidRefName('refs/heads')).toBe(true);
    expect(__test.isConcreteRefPath('refs/heads')).toBe(false);
    expect(__test.isConcreteRefPath('refs/heads/')).toBe(false);
    expect(__test.isConcreteRefPath('refs/')).toBe(false);
  });

  it('matches git check-ref-format', () => {
    // Pins the hand-rolled rules to git's own implementation so they cannot
    // drift apart silently.
    const names = [
      'refs/heads/main',
      'refs/heads/agent-hub/dev/session-abc123',
      'refs/remotes/origin/HEAD',
      'refs/tags/v1.0.0',
      'refs/heads/feature/x-y_z',
      'refs/heads',
      'refs/heads/@',
      'refs/heads/a@b',
      'refs/',
      'refs/heads/',
      '',
      '@',
      'refs/heads/.hidden',
      'refs/heads/foo.lock',
      'refs/heads/a..b',
      'refs/heads/a b',
      'refs/heads/a~b',
      'refs/heads/a^b',
      'refs/heads/a:b',
      'refs/heads/a?b',
      'refs/heads/a*b',
      'refs/heads/a[b',
      'refs/heads/a\\b',
      'refs/heads//b',
      'refs/heads/b/',
      'refs/heads/b.',
      'refs/heads/a@{b',
      '/refs/heads/a',
      'refs/heads/sub/.dot',
      'refs/heads/sub/x.lock',
    ];
    for (const name of names) {
      let gitAccepts: boolean;
      try {
        execFileSync('git', ['check-ref-format', name], { stdio: 'pipe' });
        gitAccepts = true;
      } catch {
        gitAccepts = false;
      }
      expect({ name, valid: __test.isValidRefName(name) }).toEqual({ name, valid: gitAccepts });
    }
  });

  it('accepts a clone whose branches live in packed-refs (empty refs/heads)', () => {
    const dir = makeHalfBuiltClone(path.join(root, 'packed-branch'));
    writeFileSync(
      path.join(dir, '.git', 'packed-refs'),
      `# pack-refs with: peeled fully-peeled sorted \n${'b'.repeat(40)} refs/heads/main\n`,
    );
    expect(__test.hasLocalBranch(path.join(dir, '.git'))).toBe(true);
    writeFileSync(path.join(dir, '.git', 'index'), 'DIRC');
    expect(__test.cloneLooksComplete(dir)).toBe(true);
  });

  it('does not mistake a packed remote-tracking ref for a local branch', () => {
    const dir = makeHalfBuiltClone(path.join(root, 'packed-remote-only'));
    writeFileSync(
      path.join(dir, '.git', 'packed-refs'),
      `# pack-refs with: peeled fully-peeled sorted \n${'c'.repeat(40)} refs/remotes/origin/main\n`,
    );
    expect(__test.cloneLooksComplete(dir)).toBe(false);
  });

  it('ignores peeled-tag continuation lines in packed-refs', () => {
    const dir = makeHalfBuiltClone(path.join(root, 'peeled'));
    writeFileSync(
      path.join(dir, '.git', 'packed-refs'),
      `# pack-refs with: peeled fully-peeled sorted \n` +
        `${'c'.repeat(40)} refs/tags/v1\n^${'d'.repeat(40)}\n`,
    );
    expect(__test.hasLocalBranch(path.join(dir, '.git'))).toBe(false);
  });

  describe('linked worktrees (.git as a pointer file)', () => {
    /** A linked worktree gitdir plus the shared repo its commondir points at. */
    function makeLinkedWorktree(name: string): { dir: string; gitDir: string } {
      const dir = path.join(root, name);
      const hostGit = path.join(root, `${name}-host`, '.git');
      const gitDir = path.join(hostGit, 'worktrees', name);
      mkdirSync(dir, { recursive: true });
      mkdirSync(gitDir, { recursive: true });
      mkdirSync(path.join(hostGit, 'objects'), { recursive: true });
      writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/wt\n');
      writeFileSync(path.join(gitDir, 'index'), 'DIRC');
      writeFileSync(path.join(gitDir, 'commondir'), '../..\n');
      return { dir, gitDir };
    }

    it('accepts a pointer whose gitdir target exists', () => {
      const { dir, gitDir } = makeLinkedWorktree('linked-ok');
      writeFileSync(path.join(dir, '.git'), `gitdir: ${gitDir}\n`);

      expect(__test.resolveGitDir(dir)).toBe(gitDir);
      expect(__test.cloneLooksComplete(dir)).toBe(true);
    });

    it('follows commondir for objects and refs (per-worktree gitdir has neither)', () => {
      const { dir, gitDir } = makeLinkedWorktree('linked-common');
      writeFileSync(path.join(dir, '.git'), `gitdir: ${gitDir}\n`);

      // The real shape: no objects/ under the per-worktree gitdir.
      expect(existsSync(path.join(gitDir, 'objects'))).toBe(false);
      expect(__test.resolveCommonDir(gitDir)).toBe(path.resolve(gitDir, '../..'));
      expect(__test.cloneLooksComplete(dir)).toBe(true);
    });

    it('accepts a linked worktree created by real git', () => {
      // Guards against hand-built fixtures drifting from git's actual layout:
      // a real per-worktree gitdir has no objects/ or refs/ of its own.
      const host = path.join(root, 'real-host');
      mkdirSync(host, { recursive: true });
      const git = (cmd: string, cwd = host) => execSync(`git ${cmd}`, { cwd, stdio: 'pipe' });
      git('init --quiet --initial-branch=main');
      git('config user.email t@example.com');
      git('config user.name Test');
      writeFileSync(path.join(host, 'a.txt'), 'hi\n');
      git('add a.txt');
      git('commit -qm init');
      const linked = path.join(root, 'real-linked');
      git(`worktree add -q "${linked}" -b wt`);

      expect(__test.cloneLooksComplete(linked)).toBe(true);
      expect(__test.removeZombieCloneDir(linked)).toBe(false);
      expect(existsSync(linked)).toBe(true);
    });

    it('rejects a pointer to a gitdir that does not exist', () => {
      const dir = path.join(root, 'linked-dangling');
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, '.git'), 'gitdir: /nowhere/.git/worktrees/gone\n');
      expect(__test.resolveGitDir(dir)).toBeNull();
      expect(__test.cloneLooksComplete(dir)).toBe(false);
    });

    it('rejects a truncated or malformed pointer file', () => {
      const dir = path.join(root, 'linked-garbage');
      mkdirSync(dir, { recursive: true });
      for (const body of ['', 'gitdir:\n', 'total garbage\n']) {
        writeFileSync(path.join(dir, '.git'), body);
        expect(__test.resolveGitDir(dir)).toBeNull();
        expect(__test.cloneLooksComplete(dir)).toBe(false);
      }
    });

    it('resolves a relative gitdir pointer against the worktree', () => {
      const { dir, gitDir } = makeLinkedWorktree('linked-rel');
      writeFileSync(path.join(dir, '.git'), `gitdir: ${path.relative(dir, gitDir)}\n`);

      expect(__test.resolveGitDir(dir)).toBe(gitDir);
      expect(__test.cloneLooksComplete(dir)).toBe(true);
    });
  });

  it('rejects a git dir with no objects/ directory', () => {
    // `init_db` writes HEAD and objects/ together, so HEAD without objects/ is
    // not a usable repository.
    const dir = path.join(root, 'no-objects');
    mkdirSync(path.join(dir, '.git'), { recursive: true });
    writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    expect(__test.cloneLooksComplete(dir)).toBe(false);
  });

  describe('no refs at all — resolved on the object store', () => {
    /** HEAD written, objects/ present, nothing else. */
    function makeRefless(name: string): string {
      const dir = path.join(root, name);
      mkdirSync(path.join(dir, '.git', 'objects', 'pack'), { recursive: true });
      mkdirSync(path.join(dir, '.git', 'objects', 'info'), { recursive: true });
      mkdirSync(path.join(dir, '.git', 'refs', 'heads'), { recursive: true });
      writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
      return dir;
    }

    it('accepts a finished clone of an empty repository (empty object store)', () => {
      // Verified against real git: a clone of an empty bare repo has no index,
      // no refs, an unborn HEAD, and an empty objects/. Sweeping that shape
      // would delete a legitimate workspace on every single session start.
      const dir = makeRefless('empty-upstream');
      expect(__test.objectStoreIsEmpty(path.join(dir, '.git'))).toBe(true);
      expect(__test.cloneLooksComplete(dir)).toBe(true);
    });

    it('sweeps a clone that fetched a pack but died before writing refs', () => {
      const dir = makeRefless('pack-no-refs');
      writeFileSync(path.join(dir, '.git', 'objects', 'pack', 'pack-abc.pack'), 'PACK');
      expect(__test.objectStoreIsEmpty(path.join(dir, '.git'))).toBe(false);
      expect(__test.cloneLooksComplete(dir)).toBe(false);
    });

    it('sweeps a clone that copied loose objects but died before writing refs', () => {
      const dir = makeRefless('loose-no-refs');
      mkdirSync(path.join(dir, '.git', 'objects', 'ab'), { recursive: true });
      writeFileSync(path.join(dir, '.git', 'objects', 'ab', 'cdef'), 'x');
      expect(__test.objectStoreIsEmpty(path.join(dir, '.git'))).toBe(false);
      expect(__test.cloneLooksComplete(dir)).toBe(false);
    });

    it('does not count objects/info metadata as transferred objects', () => {
      const dir = makeRefless('info-only');
      writeFileSync(path.join(dir, '.git', 'objects', 'info', 'commit-graph'), 'x');
      expect(__test.objectStoreIsEmpty(path.join(dir, '.git'))).toBe(true);
      expect(__test.cloneLooksComplete(dir)).toBe(true);
    });
  });

  it('does not let the marker override the structural checks', () => {
    // The marker records that provisioning once succeeded. It must not mask a
    // workspace that was damaged afterwards — a reuse-time fetch, rebase or
    // branch reposition can fail and leave the clone partial.
    const dir = makeHalfBuiltClone(path.join(root, 'marked-partial'));
    __test.markCloneComplete(dir);
    expect(existsSync(path.join(dir, '.git', __test.CLONE_COMPLETE_MARKER))).toBe(true);
    // Remote-tracking refs with HEAD unsettled and no checkout: still partial.
    expect(__test.cloneLooksComplete(dir)).toBe(false);
  });

  it('lets the marker corroborate an otherwise ambiguous workspace', () => {
    // No refs at all is ambiguous on structure alone; the marker resolves it.
    const dir = path.join(root, 'marked-ambiguous');
    mkdirSync(path.join(dir, '.git', 'objects', 'ab'), { recursive: true });
    mkdirSync(path.join(dir, '.git', 'refs', 'heads'), { recursive: true });
    writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(path.join(dir, '.git', 'objects', 'ab', 'cdef'), 'x');

    expect(__test.cloneLooksComplete(dir)).toBe(false);
    __test.markCloneComplete(dir);
    expect(__test.cloneLooksComplete(dir)).toBe(true);
  });

  it('marker does not resurrect a workspace whose branch and index were lost', () => {
    // Reviewer's case: provisioning succeeded (marker written), then a later
    // operation removed the session branch and index. Structure must win.
    const dir = makeHalfBuiltClone(path.join(root, 'marked-damaged'));
    writeFileSync(path.join(dir, '.git', 'refs', 'heads', 'main'), `${'a'.repeat(40)}\n`);
    writeFileSync(path.join(dir, '.git', 'index'), 'DIRC');
    __test.markCloneComplete(dir);
    expect(__test.cloneLooksComplete(dir)).toBe(true);

    rmSync(path.join(dir, '.git', 'refs', 'heads', 'main'));
    rmSync(path.join(dir, '.git', 'index'));
    expect(__test.cloneLooksComplete(dir)).toBe(false);
  });
});

describe('hasLocalState — never destroy work', () => {
  let root: string;

  beforeEach(() => {
    root = path.join(
      os.tmpdir(),
      `localstate-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(root, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const git = (cmd: string, cwd: string) => execSync(`git ${cmd}`, { cwd, stdio: 'pipe' });

  function initRepo(name: string): string {
    const dir = path.join(root, name);
    mkdirSync(dir, { recursive: true });
    git('init --quiet --initial-branch=main', dir);
    git('config user.email t@example.com', dir);
    git('config user.name Test', dir);
    return dir;
  }

  it('preserves a clone of an empty upstream once work is staged', () => {
    // The regression this guards: a clone of an empty repo has no branch and no
    // commits, so as soon as an agent runs `git add` the object store becomes
    // non-empty while refs stay empty. Classifying that as an unfinished clone
    // and sweeping it destroys the staged work.
    const bare = path.join(root, 'empty.git');
    mkdirSync(bare, { recursive: true });
    execSync('git init --bare --quiet --initial-branch=main', { cwd: bare, stdio: 'pipe' });
    const ws = path.join(root, 'ws');
    execSync(`git clone --quiet "${bare}" "${ws}"`, { stdio: 'pipe' });
    git('config user.email t@example.com', ws);
    git('config user.name Test', ws);
    writeFileSync(path.join(ws, 'draft.txt'), 'important work\n');
    git('add draft.txt', ws);

    expect(__test.cloneLooksComplete(ws)).toBe(true);
    expect(__test.removeZombieCloneDir(ws)).toBe(false);
    expect(existsSync(path.join(ws, 'draft.txt'))).toBe(true);
  });

  it('preserves an unborn repository with a staged index', () => {
    const dir = initRepo('unborn');
    writeFileSync(path.join(dir, 'a.txt'), 'staged\n');
    git('add a.txt', dir);
    // Unborn HEAD: no commit, so no local branch exists yet.
    expect(existsSync(path.join(dir, '.git', 'index'))).toBe(true);
    expect(__test.hasLocalBranch(path.join(dir, '.git'))).toBe(false);

    expect(__test.hasLocalState(path.join(dir, '.git'), path.join(dir, '.git'), dir)).toBe(true);
    expect(__test.removeZombieCloneDir(dir)).toBe(false);
    expect(existsSync(path.join(dir, 'a.txt'))).toBe(true);
  });

  it('preserves a detached-HEAD workspace', () => {
    const dir = initRepo('detached');
    writeFileSync(path.join(dir, 'a.txt'), 'v1\n');
    git('add a.txt', dir);
    git('commit -qm init', dir);
    git('checkout -q --detach', dir);
    expect(__test.hasLocalState(path.join(dir, '.git'), path.join(dir, '.git'), dir)).toBe(true);
    expect(__test.removeZombieCloneDir(dir)).toBe(false);
    expect(existsSync(path.join(dir, 'a.txt'))).toBe(true);
  });

  it('recognises a detached HEAD even with every branch deleted', () => {
    const dir = initRepo('detached-no-branch');
    writeFileSync(path.join(dir, 'a.txt'), 'v1\n');
    git('add a.txt', dir);
    git('commit -qm init', dir);
    git('checkout -q --detach', dir);
    git('branch -D main', dir);
    rmSync(path.join(dir, '.git', 'index'));

    // No branch and no index — only the detached HEAD says this is real.
    expect(__test.hasLocalBranch(path.join(dir, '.git'))).toBe(false);
    expect(__test.hasLocalState(path.join(dir, '.git'), path.join(dir, '.git'), dir)).toBe(true);
    expect(__test.removeZombieCloneDir(dir)).toBe(false);
    expect(existsSync(path.join(dir, 'a.txt'))).toBe(true);
  });

  it('accepts a real detached clone that still has remote-tracking refs', () => {
    // `git clone --branch <tag>` is a healthy clone with ZERO local branches,
    // remote-tracking refs, an index and a detached HEAD. Rejecting it on the
    // remote-refs rule would leave the workspace neither reusable nor
    // deletable, stranding the session on the project checkout.
    const seed = initRepo('det-seed');
    writeFileSync(path.join(seed, 'a.txt'), 'v1\n');
    git('add a.txt', seed);
    git('commit -qm init', seed);
    git('tag v1.0', seed);
    const ws = path.join(root, 'det-tagclone');
    execSync(`git clone --quiet --branch v1.0 "${seed}" "${ws}"`, { stdio: 'pipe' });

    const gitDir = path.join(ws, '.git');
    expect(__test.hasLocalBranch(gitDir)).toBe(false);
    expect(__test.hasRemoteTrackingRef(gitDir)).toBe(true);
    expect(__test.headIsDetached(gitDir)).toBe(true);
    expect(__test.headIsSettled(gitDir, gitDir)).toBe(true);

    expect(__test.cloneLooksComplete(ws)).toBe(true);
    expect(__test.removeZombieCloneDir(ws)).toBe(false);
    expect(existsSync(path.join(ws, 'a.txt'))).toBe(true);
  });

  it('accepts a real clone detached after the fact', () => {
    const seed = initRepo('det2-seed');
    writeFileSync(path.join(seed, 'a.txt'), 'v1\n');
    git('add a.txt', seed);
    git('commit -qm init', seed);
    const ws = path.join(root, 'det-checkout');
    execSync(`git clone --quiet "${seed}" "${ws}"`, { stdio: 'pipe' });
    git('checkout -q --detach', ws);

    expect(__test.headIsDetached(path.join(ws, '.git'))).toBe(true);
    expect(__test.cloneLooksComplete(ws)).toBe(true);
    expect(__test.removeZombieCloneDir(ws)).toBe(false);
  });

  it('does not let a detached HEAD rescue a clone that never checked out', () => {
    // Ordering guard the other way: HEAD settled but no index still means the
    // clone died before `checkout`.
    const dir = path.join(root, 'detached-no-checkout');
    mkdirSync(path.join(dir, '.git', 'refs', 'remotes', 'origin'), { recursive: true });
    mkdirSync(path.join(dir, '.git', 'objects'), { recursive: true });
    writeFileSync(path.join(dir, '.git', 'HEAD'), `${'a'.repeat(40)}\n`);
    writeFileSync(
      path.join(dir, '.git', 'refs', 'remotes', 'origin', 'master'),
      `${'0'.repeat(40)}\n`,
    );

    expect(__test.headIsSettled(path.join(dir, '.git'), path.join(dir, '.git'))).toBe(true);
    expect(__test.checkoutLooksDone(path.join(dir, '.git'))).toBe(false);
    expect(__test.cloneLooksComplete(dir)).toBe(false);
  });

  it('rejects a real clone interrupted between update_head and checkout', () => {
    // Drive real git, then reproduce the interruption: branch and remote refs
    // written, index and working tree not yet.
    const seed = initRepo('ckwin-seed');
    writeFileSync(path.join(seed, 'a.txt'), 'v1\n');
    git('add a.txt', seed);
    git('commit -qm init', seed);
    const ws = path.join(root, 'ckwin-ws');
    execSync(`git clone --quiet "${seed}" "${ws}"`, { stdio: 'pipe' });
    expect(__test.cloneLooksComplete(ws)).toBe(true);

    rmSync(path.join(ws, '.git', 'index'));
    rmSync(path.join(ws, 'a.txt'));

    expect(__test.hasLocalBranch(path.join(ws, '.git'))).toBe(true);
    expect(__test.checkoutLooksDone(path.join(ws, '.git'))).toBe(false);
    // Not reusable: an agent would get a repository with no files.
    expect(__test.cloneLooksComplete(ws)).toBe(false);
    // The branch merely duplicates the remote tip and nothing was checked out,
    // so a re-clone reproduces everything — sweeping it loses nothing and
    // avoids stranding the session on "destination path already exists".
    expect(__test.hasUnpushedLocalBranch(path.join(ws, '.git'))).toBe(false);
    expect(__test.removeZombieCloneDir(ws)).toBe(true);
    expect(existsSync(ws)).toBe(false);
  });

  it('preserves a branch-bearing clone once the branch is ahead of its remote', () => {
    const seed = initRepo('ahead-seed');
    writeFileSync(path.join(seed, 'a.txt'), 'v1\n');
    git('add a.txt', seed);
    git('commit -qm init', seed);
    const ws = path.join(root, 'ahead-ws');
    execSync(`git clone --quiet "${seed}" "${ws}"`, { stdio: 'pipe' });
    git('config user.email t@example.com', ws);
    git('config user.name Test', ws);
    writeFileSync(path.join(ws, 'b.txt'), 'local work\n');
    git('add b.txt', ws);
    git('commit -qm local', ws);

    // Now strip the checkout markers, leaving a branch that HAS diverged.
    rmSync(path.join(ws, '.git', 'index'));
    expect(__test.hasUnpushedLocalBranch(path.join(ws, '.git'))).toBe(true);
    expect(__test.removeZombieCloneDir(ws)).toBe(false);
    expect(existsSync(ws)).toBe(true);
  });

  it('preserves a branch-bearing clone that has files in the working tree', () => {
    const seed = initRepo('files-seed');
    writeFileSync(path.join(seed, 'a.txt'), 'v1\n');
    git('add a.txt', seed);
    git('commit -qm init', seed);
    const ws = path.join(root, 'files-ws');
    execSync(`git clone --quiet "${seed}" "${ws}"`, { stdio: 'pipe' });
    rmSync(path.join(ws, '.git', 'index'));
    // a.txt is still on disk — someone's files must never be swept.
    expect(__test.workingTreeHasFiles(ws)).toBe(true);
    expect(__test.removeZombieCloneDir(ws)).toBe(false);
    expect(existsSync(path.join(ws, 'a.txt'))).toBe(true);
  });

  it('preserves a linked worktree whose host repo has been deleted', () => {
    // The `.git` pointer dangles, so there is no git dir to inspect — but the
    // working tree beside it can still hold uncommitted files. Sweeping on an
    // unresolvable `.git` is strictly worse than the original guard, which
    // bailed whenever `.git` existed at all.
    const host = initRepo('dangle-host');
    writeFileSync(path.join(host, 'a.txt'), 'v1\n');
    git('add a.txt', host);
    git('commit -qm init', host);
    const wt = path.join(root, 'dangle-wt');
    git(`worktree add -q "${wt}" -b wtbranch`, host);
    writeFileSync(path.join(wt, 'precious.txt'), 'uncommitted work\n');
    rmSync(host, { recursive: true, force: true });

    expect(__test.resolveGitDir(wt)).toBeNull();
    expect(__test.cloneLooksComplete(wt)).toBe(false);
    expect(__test.removeZombieCloneDir(wt)).toBe(false);
    expect(existsSync(path.join(wt, 'precious.txt'))).toBe(true);
  });

  it('preserves a directory whose .git is malformed or a dangling symlink', () => {
    for (const [name, make] of [
      ['garbage-gitfile', (d: string) => writeFileSync(path.join(d, '.git'), 'total garbage\n')],
      ['empty-gitfile', (d: string) => writeFileSync(path.join(d, '.git'), '')],
      ['dangling-symlink', (d: string) => symlinkSync('/nowhere/gone', path.join(d, '.git'))],
    ] as const) {
      const dir = path.join(root, name);
      mkdirSync(dir, { recursive: true });
      make(dir);
      writeFileSync(path.join(dir, 'keep.txt'), 'work\n');

      expect(__test.resolveGitDir(dir)).toBeNull();
      expect(__test.removeZombieCloneDir(dir)).toBe(false);
      expect(existsSync(path.join(dir, 'keep.txt'))).toBe(true);
    }
  });

  it('still sweeps a directory with no .git entry at all', () => {
    // The original zombie case must keep working: an interrupted clone that
    // created the target directory but never got as far as `.git`.
    const dir = path.join(root, 'no-git-entry');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'leftover.txt'), 'junk\n');

    expect(__test.removeZombieCloneDir(dir)).toBe(true);
    expect(existsSync(dir)).toBe(false);
  });

  it('still sweeps a carcass with no index, no branch and a symbolic HEAD', () => {
    // The real poisoned shape must remain sweepable — the veto is targeted, not
    // a blanket refusal to ever delete.
    const dir = path.join(root, 'carcass');
    mkdirSync(path.join(dir, '.git', 'refs', 'remotes', 'origin'), { recursive: true });
    mkdirSync(path.join(dir, '.git', 'objects'), { recursive: true });
    writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/master\n');
    writeFileSync(
      path.join(dir, '.git', 'refs', 'remotes', 'origin', 'master'),
      `${'0'.repeat(40)}\n`,
    );

    expect(__test.hasLocalState(path.join(dir, '.git'), path.join(dir, '.git'), dir)).toBe(false);
    expect(__test.removeZombieCloneDir(dir)).toBe(true);
    expect(existsSync(dir)).toBe(false);
  });

  it('a stray index cannot rescue a partially fetched clone', () => {
    // Ordering guard: the remote-tracking check runs before the local-state
    // check, so the poisoned shape is not rescued by an index appearing.
    const dir = path.join(root, 'partial-with-index');
    mkdirSync(path.join(dir, '.git', 'refs', 'remotes', 'origin'), { recursive: true });
    mkdirSync(path.join(dir, '.git', 'objects'), { recursive: true });
    writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/master\n');
    writeFileSync(
      path.join(dir, '.git', 'refs', 'remotes', 'origin', 'master'),
      `${'0'.repeat(40)}\n`,
    );
    writeFileSync(path.join(dir, '.git', 'index'), 'DIRC');

    expect(__test.cloneLooksComplete(dir)).toBe(false);
    // ...but the sweep is still vetoed, because an index means staged content.
    expect(__test.removeZombieCloneDir(dir)).toBe(false);
    expect(existsSync(dir)).toBe(true);
  });
});

describe('removeZombieCloneDir', () => {
  let root: string;

  beforeEach(() => {
    root = path.join(os.tmpdir(), `zombie-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(root, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('sweeps a half-built .git left by an aborted clone', () => {
    // Mirrors the real carcass: the racing fetch landed remote-tracking refs,
    // then the clone aborted before writing a local branch or an index.
    const dir = path.join(root, 'poisoned');
    mkdirSync(path.join(dir, '.git', 'refs', 'remotes', 'origin'), { recursive: true });
    mkdirSync(path.join(dir, '.git', 'objects'), { recursive: true });
    writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/master\n');
    writeFileSync(
      path.join(dir, '.git', 'refs', 'remotes', 'origin', 'master'),
      `${'0'.repeat(40)}\n`,
    );

    expect(__test.removeZombieCloneDir(dir)).toBe(true);
    expect(existsSync(dir)).toBe(false);
  });

  it('leaves an empty-but-initialised clone dir alone rather than guessing', () => {
    // An empty `refs/remotes/origin/` with no ref inside proves nothing, and
    // deleting on that basis risks destroying a legitimately empty workspace.
    const dir = path.join(root, 'ambiguous');
    mkdirSync(path.join(dir, '.git', 'refs', 'remotes', 'origin'), { recursive: true });
    mkdirSync(path.join(dir, '.git', 'objects'), { recursive: true });
    writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');

    expect(__test.removeZombieCloneDir(dir)).toBe(false);
    expect(existsSync(dir)).toBe(true);
  });

  it('never sweeps a clone carrying real work', () => {
    const dir = path.join(root, 'healthy');
    mkdirSync(path.join(dir, '.git', 'refs', 'heads'), { recursive: true });
    mkdirSync(path.join(dir, '.git', 'objects'), { recursive: true });
    writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(path.join(dir, '.git', 'refs', 'heads', 'main'), `${'d'.repeat(40)}\n`);
    writeFileSync(path.join(dir, 'work.txt'), 'precious\n');

    expect(__test.removeZombieCloneDir(dir)).toBe(false);
    expect(existsSync(path.join(dir, 'work.txt'))).toBe(true);
  });

  it('never sweeps a workspace the Hub marked as fully cloned', () => {
    const dir = path.join(root, 'marked');
    mkdirSync(path.join(dir, '.git', 'objects'), { recursive: true });
    writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    __test.markCloneComplete(dir);
    writeFileSync(path.join(dir, 'work.txt'), 'precious\n');

    expect(__test.removeZombieCloneDir(dir)).toBe(false);
    expect(existsSync(path.join(dir, 'work.txt'))).toBe(true);
  });
});

// ─── retry classification ────────────────────────────────────────────────────

describe('clone retry classification for the initial-ref-transaction BUG', () => {
  it('classifies the git BUG abort as transient', () => {
    expect(__test.isTransientCloneError(new Error(BUG_MESSAGE))).toBe(true);
  });

  it('retries and wipes the partial directory between attempts', async () => {
    const cleanup = vi.fn();
    const runner = vi
      .fn()
      .mockRejectedValueOnce(new Error(BUG_MESSAGE))
      .mockResolvedValueOnce('cloned');

    await __test.cloneWithRetry(['clone', '--quiet', '/src', '/dst'], {}, '/dst', {
      runner,
      cleanup,
      sleep: async () => {},
    });

    expect(runner).toHaveBeenCalledTimes(2);
    // Without the cleanup the retry would hit "destination path already exists".
    expect(cleanup).toHaveBeenCalledWith('/dst');
  });
});

describe('classifyWorktreeFailure', () => {
  it('names the concurrent-clone cause instead of falling back to unknown', () => {
    const diagnosis = classifyWorktreeFailure(BUG_MESSAGE);
    expect(diagnosis.cause).toBe('concurrent-clone');
    expect(diagnosis.reason).toMatch(/while `git clone` was still running/);
  });
});

// ─── end-to-end ──────────────────────────────────────────────────────────────

describe('ensureSessionWorkspace — concurrency and poisoned-dir recovery', () => {
  let tmpRoot: string;
  let sourceRepo: string;
  let sessionId: string;
  let createdWorkspace: string | null = null;

  function git(cwd: string, cmd: string): string {
    return execSync(`git ${cmd}`, { cwd, stdio: 'pipe' }).toString().trim();
  }

  beforeEach(() => {
    tmpRoot = path.join(
      os.tmpdir(),
      `clone-race-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tmpRoot, { recursive: true });

    const originBare = path.join(tmpRoot, 'origin.git');
    mkdirSync(originBare, { recursive: true });
    execSync('git init --bare --initial-branch=main', { cwd: originBare, stdio: 'pipe' });

    sourceRepo = path.join(tmpRoot, 'source');
    execSync(`git clone --quiet "${originBare}" "${sourceRepo}"`, { stdio: 'pipe' });
    git(sourceRepo, 'config user.email "test@example.com"');
    git(sourceRepo, 'config user.name "Test"');
    git(sourceRepo, 'checkout -b main');
    writeFileSync(path.join(sourceRepo, 'README.md'), 'v1\n');
    git(sourceRepo, 'add README.md');
    git(sourceRepo, 'commit -m "initial"');
    git(sourceRepo, 'push -u origin main');

    sessionId = `sess${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    createdWorkspace = null;
  });

  afterEach(() => {
    if (createdWorkspace) removeWorkspace(createdWorkspace);
    try {
      const wsParent = path.join(homedir(), '.agent-hub', 'workspaces', path.basename(sourceRepo));
      if (existsSync(wsParent)) rmSync(wsParent, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function makeSession(): SessionRow {
    return {
      id: sessionId,
      agent_id: 'test-agent',
      name: 'test',
      engine: 'claude',
      model: 'claude-sonnet-4-20250514',
      engine_session_id: null,
      use_worktree: 1,
      worktree_path: null,
      worktree_branch: null,
      git_worktree_detected: 0,
      changes_ready: null,
      stale_pr_notified_at: null,
      ask_mode: 0,
      cron_id: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      deleted_at: null,
    } as SessionRow;
  }

  function expectedCloneDir(): string {
    return path.join(
      homedir(),
      '.agent-hub',
      'workspaces',
      path.basename(sourceRepo),
      `session-${sessionId.slice(0, 8)}`,
    );
  }

  it('survives overlapping calls for the same session', async () => {
    const onFailure = vi.fn();

    // Three spawn paths racing for one session — chat, autonomous, reviewer.
    // Pre-fix, whichever call lost the race fetched into the clone the winner
    // was still building and killed it with the initial-ref-transaction BUG.
    const results = await Promise.all([
      ensureSessionWorkspace(makeSession(), sourceRepo, 'test-agent', vi.fn(), null, onFailure),
      ensureSessionWorkspace(makeSession(), sourceRepo, 'test-agent', vi.fn(), null, onFailure),
      ensureSessionWorkspace(makeSession(), sourceRepo, 'test-agent', vi.fn(), null, onFailure),
    ]);
    createdWorkspace = results[0];

    expect(new Set(results).size).toBe(1);
    expect(results[0]).toBe(expectedCloneDir());
    // A silent fallback to projectCwd is how this failure surfaced in prod.
    expect(results[0]).not.toBe(sourceRepo);
    expect(onFailure).not.toHaveBeenCalled();
    expect(__test.cloneLooksComplete(results[0])).toBe(true);
    expect(git(results[0], 'rev-parse --abbrev-ref HEAD')).toMatch(
      /^agent-hub\/test-agent\/session-/,
    );
  });

  it('does not mark the workspace complete when branch setup fails', async () => {
    // The marker is authoritative for `cloneLooksComplete`, so it must not be
    // written until the workspace is genuinely reusable. `worktree_checkout_branch`
    // names a branch that does not exist on origin, which fails *after* the
    // clone succeeds but before the session branch is positioned.
    const onFailure = vi.fn();
    const session = { ...makeSession(), worktree_checkout_branch: 'no-such-branch' } as SessionRow;

    const result = await ensureSessionWorkspace(
      session,
      sourceRepo,
      'test-agent',
      vi.fn(),
      null,
      onFailure,
    );

    // Provisioning failed, so the session falls back to the project checkout.
    expect(result).toBe(sourceRepo);
    expect(onFailure).toHaveBeenCalledTimes(1);

    // Whatever is left on disk must NOT claim to be a finished workspace.
    const dir = expectedCloneDir();
    if (existsSync(dir)) {
      createdWorkspace = dir;
      expect(existsSync(path.join(dir, '.git', __test.CLONE_COMPLETE_MARKER))).toBe(false);
    }
  });

  it('marks the workspace complete once provisioning succeeds', async () => {
    const clonePath = await ensureSessionWorkspace(
      makeSession(),
      sourceRepo,
      'test-agent',
      vi.fn(),
    );
    createdWorkspace = clonePath;

    expect(clonePath).toBe(expectedCloneDir());
    expect(existsSync(path.join(clonePath, '.git', __test.CLONE_COMPLETE_MARKER))).toBe(true);
    // The marker means what it says: the session branch exists and is checked out.
    expect(git(clonePath, 'rev-parse --abbrev-ref HEAD')).toMatch(
      /^agent-hub\/test-agent\/session-/,
    );
  });

  it('recovers a session directory poisoned by a previously aborted clone', async () => {
    // Reproduce the on-disk carcass observed in prod: HEAD + config + objects +
    // remote-tracking refs from the racing fetch, no local branch, no index.
    const dir = expectedCloneDir();
    mkdirSync(path.join(dir, '.git', 'objects'), { recursive: true });
    mkdirSync(path.join(dir, '.git', 'refs', 'heads'), { recursive: true });
    mkdirSync(path.join(dir, '.git', 'refs', 'remotes', 'origin'), { recursive: true });
    writeFileSync(
      path.join(dir, '.git', 'refs', 'remotes', 'origin', 'main'),
      `${'e'.repeat(40)}\n`,
    );
    writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(path.join(dir, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n');

    const onFailure = vi.fn();
    const clonePath = await ensureSessionWorkspace(
      makeSession(),
      sourceRepo,
      'test-agent',
      vi.fn(),
      null,
      onFailure,
    );
    createdWorkspace = clonePath;

    // Pre-fix this returned projectCwd forever: the reuse gate adopted the
    // carcass and removeZombieCloneDir refused to touch it.
    expect(clonePath).toBe(dir);
    expect(onFailure).not.toHaveBeenCalled();
    expect(__test.cloneLooksComplete(clonePath)).toBe(true);
    expect(existsSync(path.join(clonePath, 'README.md'))).toBe(true);
  });
});
