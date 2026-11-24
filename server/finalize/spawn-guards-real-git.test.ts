/**
 * The spawn-guard `git` shim checked against real git.
 *
 * The stub-based tests in spawn-ship-guards.test.ts assert exit codes, but a
 * stub cannot show what git would have done with a command the shim let
 * through. These tests run every invocation through the shim into the real
 * git binary, inside a throwaway repository, and compare a fingerprint of the
 * whole tree (worktree, .git, a bare remote, and a sibling directory for
 * stray `--output` files) before and after. The property under test is the
 * outcome, not the shim's reasoning: in a write-blocked session nothing may
 * change, and under branch protection no branch may appear and HEAD may not
 * move, whatever the shim decided.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { createHash } from 'crypto';
import { spawnSync } from 'child_process';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const GUARD_GIT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'spawn-guards', 'git');

// Real git, skipping any spawn-guards shim on PATH (a test run inside a Hub
// session has one first).
const REAL_GIT =
  (process.env.PATH ?? '')
    .split(path.delimiter)
    .filter((dir) => dir && !dir.endsWith('spawn-guards'))
    .map((dir) => path.join(dir, 'git'))
    .find((candidate) => existsSync(candidate)) ?? '';

const BASE_ENV: Record<string, string> = {
  PATH: `${path.dirname(REAL_GIT)}:/usr/bin:/bin`,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_EDITOR: 'true',
  GIT_TERMINAL_PROMPT: '0',
  GIT_PAGER: 'cat',
};

let template = '';
let root = '';
let repo = '';

function git(cwd: string, args: string[]): string {
  const r = spawnSync(REAL_GIT, args, { cwd, encoding: 'utf8', env: BASE_ENV });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

/**
 * Content hash of every file and directory under `dir`, `.git/index`
 * included: the guard runs reads with optional locks off, so even the
 * index's cached stat data must not change.
 */
function fingerprint(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (abs: string, rel: string) => {
    for (const name of readdirSync(abs)) {
      const childAbs = path.join(abs, name);
      const childRel = rel ? `${rel}/${name}` : name;
      const st = lstatSync(childAbs);
      if (st.isDirectory()) {
        out[childRel] = 'dir';
        walk(childAbs, childRel);
      } else {
        out[childRel] = createHash('sha1').update(readFileSync(childAbs)).digest('hex');
      }
    }
  };
  walk(dir, '');
  out['::staged'] = git(path.join(dir, 'repo'), ['ls-files', '-s']);
  return out;
}

function branchState(): string {
  return [
    git(repo, ['for-each-ref', '--format=%(refname)', 'refs/heads']),
    git(repo, ['symbolic-ref', '-q', 'HEAD']),
    git(repo, ['worktree', 'list', '--porcelain']),
  ].join('\n');
}

// An absolute sed, so the case proves the guard holds even for a program
// that does not need PATH.
const SED = ['/usr/bin/sed', '/bin/sed'].find((candidate) => existsSync(candidate)) ?? '/bin/sed';

let partialBlob = '';

function runShim(args: string[], guardEnv: Record<string, string>, cwd = repo) {
  return spawnSync('sh', [GUARD_GIT, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...BASE_ENV, AGENT_HUB_REAL_GIT: REAL_GIT, ...guardEnv },
  });
}

beforeAll(() => {
  template = mkdtempSync(path.join(os.tmpdir(), 'guard-real-git-'));
  const t = path.join(template, 'repo');
  spawnSync(REAL_GIT, ['init', '-q', '-b', 'main', t], { env: BASE_ENV });
  // A caching textconv driver: with it, a plain `git log -p` writes
  // refs/notes/textconv/up and its objects (see gitattributes).
  git(t, ['config', 'diff.up.textconv', 'cat']);
  git(t, ['config', 'diff.up.cachetextconv', 'true']);
  spawnSync('sh', ['-c', 'printf "*.txt diff=up\\n" > .gitattributes'], { cwd: t });
  // Programs config makes git run on reads. Each leaves a marker in
  // ../outside when it runs; they are switched on after setup below.
  //   *.md      textconv program  (log -p, diff, blame, grep)
  //   *.cfg     clean filter      (diff and status read the working tree)
  //   diff.external               (plain `git diff`)
  spawnSync('sh', ['-c', 'printf "*.md diff=prog\\n*.cfg filter=fl\\n" >> .gitattributes'], {
    cwd: t,
  });
  spawnSync('sh', ['-c', 'printf "md one\\n" > b.md && printf "cfg one\\n" > c.cfg'], { cwd: t });
  // A tracked file containing `--`, for `grep -e --` (the pattern is the
  // `--`, not the end of options).
  spawnSync('sh', ['-c', 'printf "a -- b\\n" > dash.txt'], { cwd: t });
  git(t, ['add', 'b.md', 'c.cfg', 'dash.txt']);
  spawnSync('sh', ['-c', 'printf "one\\n" > a.txt'], { cwd: t });
  // m.txt uses the `probe` merge driver, configured after setup.
  spawnSync(
    'sh',
    ['-c', 'printf "m.txt merge=probe\\n" >> .gitattributes && printf "base\\n" > m.txt'],
    {
      cwd: t,
    },
  );
  git(t, ['add', 'a.txt', 'm.txt', '.gitattributes']);
  git(t, ['commit', '-q', '-m', 'init']);
  git(t, ['tag', 'v0']);
  git(t, ['branch', 'other']);
  // A merge whose parents change m.txt differently, recorded with -s ours
  // so setup never runs a merge driver. --remerge-diff re-merges it.
  git(t, ['checkout', '-q', '-b', 'side']);
  spawnSync('sh', ['-c', 'printf "side\\n" > m.txt'], { cwd: t });
  git(t, ['commit', '-q', '-am', 'side']);
  git(t, ['checkout', '-q', 'main']);
  spawnSync('sh', ['-c', 'printf "main\\n" > m.txt'], { cwd: t });
  git(t, ['commit', '-q', '-am', 'main']);
  git(t, ['merge', '-q', '-s', 'ours', '--no-edit', 'side']);
  git(t, ['tag', 'merged']);
  git(template, ['clone', '-q', '--bare', t, 'origin.git']);
  git(path.join(template, 'origin.git'), ['branch', 'remote-only', 'main']);
  git(t, ['remote', 'add', 'origin', '../origin.git']);
  git(t, ['fetch', '-q', 'origin']);

  // A commit carrying an OpenPGP signature, so %G? and friends verify it.
  // The verifier is gpg.program (absolute path) and leaves a marker; with
  // the guard on it must never run.
  const verifier = path.join(template, 'verifier.sh');
  spawnSync('sh', [
    '-c',
    `printf '#!/bin/sh\\ntouch "$PWD/../outside/verifier-ran"\\nexit 1\\n' > '${verifier}' && chmod +x '${verifier}'`,
  ]);
  const body = git(t, ['cat-file', 'commit', 'HEAD']);
  const signed = body.replace(
    /^(committer .*)$/m,
    '$1\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n iQEzBAABCAAdFiEEfakefakefake\n -----END PGP SIGNATURE-----',
  );
  const signedOid = spawnSync(REAL_GIT, ['hash-object', '-t', 'commit', '-w', '--stdin'], {
    cwd: t,
    input: signed,
    encoding: 'utf8',
    env: BASE_ENV,
  }).stdout.trim();
  git(t, ['update-ref', 'refs/heads/signed', signedOid]);
  git(t, ['config', 'gpg.program', verifier]);

  // A blobless partial clone: reading a blob it lacks makes git fetch it
  // from the promisor remote and write it into the object store.
  git(path.join(template, 'origin.git'), ['config', 'uploadpack.allowFilter', 'true']);
  git(template, [
    'clone',
    '-q',
    '--filter=blob:none',
    '--no-checkout',
    `file://${path.join(template, 'origin.git')}`,
    'partial',
  ]);
  partialBlob = git(path.join(template, 'partial'), ['rev-parse', 'HEAD:a.txt']).trim();
  spawnSync(
    'sh',
    ['-c', 'printf "two\\n" > a.txt && printf "md two\\n" > b.md && printf "cfg two\\n" > c.cfg'],
    {
      cwd: t,
    },
  );
  spawnSync('mkdir', [path.join(template, 'outside')]);
  git(t, ['config', 'diff.prog.textconv', 'touch ../outside/textconv-ran; cat']);
  git(t, ['config', 'filter.fl.clean', 'touch ../outside/filter-ran; cat']);
  git(t, ['config', 'filter.fl.required', 'true']);
  git(t, ['config', 'diff.external', 'touch ../outside/extdiff-ran; true']);
  // A shell builtin with a redirect: needs no PATH at all.
  git(t, ['config', 'merge.probe.driver', 'printf ran > ../outside/merge-ran']);
  // Installed last so setup itself does not fire it. Git runs it whenever a
  // command writes the index, including the refresh `git status` does.
  spawnSync(
    'sh',
    [
      '-c',
      'printf "#!/bin/sh\\ntouch ../outside/hook-ran\\n" > .git/hooks/post-index-change && chmod +x .git/hooks/post-index-change',
    ],
    { cwd: t },
  );
});

afterAll(() => {
  if (template) rmSync(template, { recursive: true, force: true });
});

beforeEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = mkdtempSync(path.join(os.tmpdir(), 'guard-real-git-case-'));
  cpSync(template, root, { recursive: true });
  repo = path.join(root, 'repo');
});

describe.skipIf(!REAL_GIT)('git shim against real git', () => {
  // Controls: each of these changes the repository without the guard, so
  // the matching write-block cases below are meaningful.
  it.each([
    [['branch', '-v', 'unguarded'], 'refs/heads/unguarded'],
    [['log', '-p'], 'refs/notes/textconv/up'],
    [['status'], 'outside/hook-ran'],
    [['diff'], 'outside/extdiff-ran'],
    [['log', '--remerge-diff', '-1', 'merged'], 'outside/merge-ran'],
    [
      ['-c', 'diff.prog.textconv=printf x > ../outside/t1; cat', 'log', '-p', '--', 'b.md'],
      'outside/t1',
    ],
    [['grep', '-e', '--', `--open-files-in-pager=${SED} -i s/--/changed/g`], 'dash.txt rewritten'],
    [['diff', '--no-ext-diff'], 'outside/filter-ran'],
    [['log', '-p', '-1', '--', 'b.md'], 'outside/textconv-ran'],
    [['grep', '--open-files-in-pager=sed -i s/two/three/', 'two'], 'a.txt rewritten'],
    [['grep', '-Osed -i s/two/three/', 'two'], 'a.txt rewritten'],
    [['log', '--format=%G?', '-1', 'signed'], 'outside/verifier-ran'],
  ])('without the guard, git %j changes the repository (%s)', (args, _what) => {
    const before = fingerprint(root);
    runShim(args as string[], {});
    expect(fingerprint(root)).not.toEqual(before);
  });

  it('the fingerprint sees a mutation the guard would have to stop', () => {
    const before = fingerprint(root);
    runShim(['branch', '-v', 'unguarded'], {});
    expect(fingerprint(root)).not.toEqual(before);
  });

  // Every invocation here must leave the repository exactly as it was.
  // Reads are included on purpose: allowed commands must not write either.
  const WRITE_BLOCK_CASES: string[][] = [
    // reads that must run and still change nothing
    ['status'],
    ['log', '--oneline'],
    // config-driven writes by allowed reads: textconv cache, index refresh
    // and the post-index-change hook it fires
    ['log', '-p'],
    ['log', '-p', '--textconv'],
    ['diff', 'HEAD'],
    ['show', 'HEAD'],
    ['show', 'HEAD:a.txt', '--textconv'],
    ['blame', 'a.txt'],
    ['grep', '--textconv', 'one'],
    ['-c', 'diff.up.cachetextconv=true', 'log', '-p'],
    ['-c', 'core.hooksPath=.git/hooks', 'status'],
    ['-c', 'core.fsmonitor=touch ../outside/fsmonitor-ran', 'status'],
    // every other read command on the allowlist, under the same setup
    ['annotate', 'a.txt'],
    ['shortlog', '-s', 'HEAD'],
    ['describe', '--tags'],
    ['rev-list', '--all'],
    ['ls-tree', '-r', 'HEAD'],
    ['cat-file', '-p', 'HEAD'],
    ['cat-file', '--textconv', 'HEAD:a.txt'],
    ['show-ref'],
    ['for-each-ref'],
    ['merge-base', 'HEAD', 'other'],
    ['name-rev', 'HEAD'],
    ['whatchanged', '-p'],
    ['diff-tree', '-p', 'HEAD'],
    ['diff-files', '-p'],
    ['diff-index', '-p', 'HEAD'],
    ['show-branch', '--all'],
    ['cherry', 'other'],
    ['range-diff', 'HEAD~0...other'],
    // options and config that run a program (-O pager, ext diff, textconv,
    // filters, gpg, viewers, upload-pack)
    ['grep', '--open-files-in-pager=sed -i s/two/three/', 'two'],
    ['grep', '--open-files-in-pager', 'two'],
    ['grep', '--open-files', 'two'],
    ['grep', '-Osed -i s/two/three/', 'two'],
    ['grep', '-iOsed -i s/two/three/', 'two'],
    ['grep', '-O', 'two'],
    ['grep', '--textconv', 'two'],
    ['grep', 'two'],
    ['diff'],
    ['diff', '--ext-diff'],
    ['diff', '--textconv'],
    ['diff', '--', 'c.cfg'],
    ['log', '-p'],
    ['log', '-p', '--ext-diff'],
    ['log', '-p', '--', 'b.md'],
    ['show', 'HEAD', '--', 'b.md'],
    ['blame', 'b.md'],
    ['status', '--porcelain'],
    ['-c', 'diff.external=touch ../outside/x; true', 'diff'],
    ['-c', 'filter.fl.clean=touch ../outside/y; cat', 'status'],
    ['-c', 'diff.prog.textconv=touch ../outside/z; cat', 'log', '-p'],
    ['cat-file', '--filters', 'HEAD:c.cfg'],
    ['cat-file', '--textconv', 'HEAD:b.md'],
    ['log', '--show-signature'],
    ['-c', 'log.showSignature=true', 'log'],
    ['describe', '--dirty'],
    ['ls-remote', 'origin'],
    ['ls-remote', '--upload-pack=touch ../outside/up; git-upload-pack', 'origin'],
    ['remote', 'show', 'origin'],
    ['--help'],
    ['help', 'log'],
    ['log', '--outp=../outside/x'],
    // remerge modes reach merge drivers; from the CLI and from config
    ['log', '--remerge-diff', '-1', 'merged'],
    ['show', '--remerge-diff', 'merged'],
    ['show', '--diff-merges=remerge', 'merged'],
    ['show', '--diff-merges=r', 'merged'],
    ['-c', 'log.diffMerges=remerge', 'log', '-p', '-1', 'merged'],
    ['-c', 'log.diffMerges=remerge', 'show', 'merged'],
    [
      '-c',
      'merge.default=probe',
      '-c',
      'merge.probe.driver=printf changed > ../outside/m2',
      'log',
      '--remerge-diff',
      '-1',
      'merged',
    ],
    [
      '-c',
      'merge.probe.driver=printf x > ../outside/m3',
      '-c',
      'log.diffMerges=remerge',
      'show',
      'merged',
    ],
    // command-valued config as a shell builtin + redirect (no PATH needed)
    ['-c', 'core.pager=printf x > ../outside/p1', 'log'],
    ['-c', 'pager.log=printf x > ../outside/p2', 'log'],
    ['-c', 'diff.prog.textconv=printf x > ../outside/t1; cat', 'log', '-p', '--', 'b.md'],
    ['-c', 'diff.prog.textconv=printf x > ../outside/t2; cat', 'blame', 'b.md'],
    ['-c', 'filter.fl.clean=printf x > ../outside/f1; cat', 'status'],
    ['-c', 'filter.fl.clean=printf x > ../outside/f2; cat', 'diff', '--', 'c.cfg'],
    ['-c', 'core.fsmonitor=printf x > ../outside/fs1', 'status'],
    ['-c', 'diff.external=printf x > ../outside/e1', 'diff'],
    ['-c', 'diff.prog.command=printf x > ../outside/e2', 'diff', '--', 'b.md'],
    ['-c', 'gpg.program=/bin/sh', 'log', '--format=%G?', '-1', 'signed'],
    // `--` as an option's value, so what follows is still an option to git
    ['grep', '-e', '--', `--open-files-in-pager=${SED} -i s/--/changed/g`],
    ['grep', '-e', '--', `-O${SED} -i s/--/changed/g`],
    ['grep', '--', `--open-files-in-pager=${SED} -i s/--/changed/g`],
    ['log', '--grep', '--', '--output=../outside/x'],
    ['log', '-S', '--', '-p', '--output=../outside/x'],
    ['show', '--format', '--', '--output=../outside/x', 'HEAD'],
    // signature checks requested by format placeholders and config
    ['log', '--format=%G?', '-1', 'signed'],
    ['log', '--format=%GG%GS%GK', '-1', 'signed'],
    ['show', '-s', '--format=%G?', 'signed'],
    ['for-each-ref', '--format=%(signature:grade)', 'refs/heads/signed'],
    ['branch', '--list', '--format=%(signature)', 'signed'],
    ['-c', 'pretty.sig=%G?', 'log', '--format=sig', '-1', 'signed'],
    ['-c', 'format.pretty=%G?', 'log', '-1', 'signed'],
    ['-c', 'log.showSignature=true', 'log', '-1', 'signed'],
    ['-c', 'gpg.program=touch ../outside/gpg-bare', 'log', '--format=%G?', '-1', 'signed'],
    [
      '-c',
      'gpg.format=ssh',
      '-c',
      'gpg.ssh.program=/bin/touch',
      'log',
      '--format=%G?',
      '-1',
      'signed',
    ],
    // trace output files
    ['-c', 'trace2.eventTarget=../outside/trace', 'status'],
    ['var', 'GIT_AUTHOR_IDENT'],
    ['check-ignore', 'a.txt'],
    ['check-attr', 'diff', 'a.txt'],
    ['check-ref-format', 'refs/heads/x'],
    ['count-objects', '-v'],
    ['verify-commit', 'HEAD'],
    ['help', '-a'],
    ['version'],
    ['--version'],
    ['reflog', 'show'],
    ['reflog', 'exists', 'HEAD'],
    ['stash', 'show'],
    ['remote', 'show', '-n', 'origin'],
    ['remote', 'get-url', 'origin'],
    ['diff'],
    ['diff', '--stat', 'HEAD'],
    ['show', 'HEAD'],
    ['branch'],
    ['branch', '-a', '-v'],
    ['branch', '--list', 'o*'],
    ['branch', '--contains', 'HEAD'],
    ['tag'],
    ['tag', '-l', 'v*'],
    ['config', '--get', 'remote.origin.url'],
    ['config', '--list'],
    ['symbolic-ref', 'HEAD'],
    ['stash', 'list'],
    ['worktree', 'list'],
    ['remote', '-v'],
    ['reflog'],
    ['rev-parse', 'HEAD'],
    ['ls-files'],
    ['ls-remote', 'origin'],
    // one argument whose value looks like more options: git sees a single
    // --format / --sort value, so these must be judged as one argument
    ['branch', '--format= --list ', 'unexpected'],
    ['branch', '--format=x --list', 'unexpected'],
    ['branch', '--sort=refname -l', 'unexpected'],
    ['branch', '--format= -d ', 'unexpected'],
    ['branch', '--format= --contains HEAD ', 'unexpected'],
    ['branch', '--format=x\n--list', 'unexpected'],
    ['branch', '--format=x\n-l\n', 'unexpected'],
    ['tag', '--format= -l ', 'v9'],
    ['log', '--format=%h --output=../outside/o'],
    // branch creation, including verbosity, which is not list mode
    ['branch', 'new-branch'],
    ['branch', '-v', 'new-branch'],
    ['branch', '-vv', 'new-branch'],
    ['branch', '--verbose', 'new-branch'],
    ['branch', '--verb', 'new-branch'],
    ['branch', '-a', 'new-branch'],
    ['branch', '-r', 'new-branch'],
    ['branch', '--sort=refname', 'new-branch'],
    ['branch', '--format=%(refname)', 'new-branch'],
    ['branch', '--color', 'new-branch'],
    ['branch', '--no-color', 'new-branch'],
    ['branch', '--column', 'new-branch'],
    ['branch', '--abbrev=7', 'new-branch'],
    ['branch', '-i', 'new-branch'],
    ['branch', '-qD', 'other'],
    ['branch', '--del', 'other'],
    ['branch', '-m', 'renamed'],
    ['branch', '-c', 'copied'],
    ['branch', '-u', 'origin/main'],
    ['branch', '--edit-description'],
    // tags
    ['tag', 'v1'],
    ['tag', '-v', 'v1'],
    ['tag', '-n', 'v1'],
    ['tag', '--sort=refname', 'v1'],
    ['tag', '-i', 'v1'],
    ['tag', '--contains', 'HEAD', 'v1'],
    ['tag', '-ld', 'v0'],
    ['tag', '--del', 'v0'],
    // symbolic refs
    ['symbolic-ref', '-qd', 'refs/remotes/origin/HEAD'],
    ['symbolic-ref', '--del', 'HEAD'],
    ['symbolic-ref', 'HEAD', 'refs/heads/other'],
    ['symbolic-ref', '-q', 'HEAD', 'refs/heads/other'],
    // config
    ['config', 'user.name', 'x'],
    ['config', 'set', 'user.name', 'x'],
    ['config', '--get', 'user.name', '--edit'],
    ['config', '--unset-a', 'remote.origin.url'],
    ['config', '--add', 'x.y', 'z'],
    ['config', '--rename-section', 'remote.origin', 'remote.up'],
    // stash, worktree, remote, reflog
    ['stash'],
    ['stash', '-u'],
    ['stash', '--', 'list'],
    ['stash', 'push'],
    ['worktree', 'add', '../wt'],
    ['worktree', 'list', '--expire=now'],
    ['remote', 'add', 'x', '../origin.git'],
    ['remote', '-v', 'add', 'x', '../origin.git'],
    ['remote', 'rename', 'origin', 'up'],
    ['remote', 'set-head', 'origin', 'main'],
    ['reflog', 'expire', '--expire=now', '--all'],
    ['reflog', 'delete', 'HEAD@{0}'],
    // working tree, index, history
    ['commit', '-am', 'wip'],
    ['add', 'a.txt'],
    ['restore', 'a.txt'],
    ['checkout', '--', 'a.txt'],
    ['checkout', 'other'],
    ['reset', '--hard'],
    ['read-tree', '--reset', '-u', 'HEAD'],
    ['checkout-index', '-a', '-f'],
    ['update-index', '--assume-unchanged', 'a.txt'],
    ['update-ref', 'refs/heads/x', 'HEAD'],
    ['hash-object', '-w', 'a.txt'],
    ['merge', 'other'],
    ['rebase', 'other'],
    ['cherry-pick', 'HEAD'],
    ['revert', '--no-edit', 'HEAD'],
    ['clean', '-fd'],
    ['gc'],
    ['notes', 'add', '-m', 'x'],
    ['fetch', 'origin'],
    ['fetch', 'origin', 'remote-only:remote-only'],
    ['fetch', '--refmap=+refs/heads/*:refs/heads/fetched/*', 'origin', 'main'],
    ['pull'],
    ['push', 'origin', 'HEAD:refs/heads/pushed'],
    // files written by read commands
    ['diff', '--output=../outside/out.txt', 'HEAD'],
    ['diff', '--output', '../outside/out.txt', 'HEAD'],
    ['diff', '--outp=../outside/out.txt', 'HEAD'],
    ['log', '-p', '--output=../outside/out.txt'],
    ['show', '--output=../outside/out.txt', 'HEAD'],
    ['format-patch', '-1', '-o', '../outside'],
    ['archive', '-o', '../outside/a.tar', 'HEAD'],
    ['bundle', 'create', '../outside/b.bundle', 'HEAD'],
    // aliases and global options
    ['-c', 'alias.save=commit -am wip', 'save'],
    ['-c', 'alias.nb=branch -v', 'nb', 'new-branch'],
    ['-c', "alias.l=log '--output=../outside/out.txt'", 'l'],
    ['-c', 'alias.l=log "--output=../outside/out.txt"', 'l'],
    ['-c', 'alias.s=!git commit -am wip', 's'],
    ['-C', '.', 'commit', '-am', 'wip'],
    ['--no-pager', 'branch', '-v', 'new-branch'],
    ['--attr-source', 'HEAD', 'commit', '-am', 'wip'],
  ];

  it('without the guard, reading a missing blob in a partial clone fetches it', () => {
    const before = fingerprint(root);
    runShim(['cat-file', '-p', partialBlob], {}, path.join(root, 'partial'));
    expect(fingerprint(root)).not.toEqual(before);
  });

  // Reads in a partial clone must not lazily fetch (and write) objects.
  it.each([
    ['cat-file', '-p', '__BLOB__'],
    ['cat-file', '-s', '__BLOB__'],
    ['show', 'HEAD:a.txt'],
    ['log', '-p'],
    ['diff', 'HEAD', '--stat'],
    ['grep', 'one', 'HEAD'],
    ['blame', 'HEAD', '--', 'a.txt'],
  ])('write block does not fetch into a partial clone: git %s', (...args) => {
    const before = fingerprint(root);
    runShim(
      args.map((a) => (a === '__BLOB__' ? partialBlob : a)),
      { AGENT_HUB_BLOCK_GIT_WRITES: '1' },
      path.join(root, 'partial'),
    );
    expect(fingerprint(root)).toEqual(before);
  });

  // Trace2 reads its targets from global config too, and ignores -c, so this
  // needs a real global config file with absolute targets.
  it('write block writes no trace from global trace2 targets', () => {
    const out = path.join(root, 'outside');
    const globalConfig = path.join(root, 'global.gitconfig');
    writeFileSync(
      globalConfig,
      [
        '[trace2]',
        `\teventTarget = ${path.join(out, 'event')}`,
        `\tnormalTarget = ${path.join(out, 'normal')}`,
        `\tperfTarget = ${path.join(out, 'perf')}`,
      ].join('\n') + '\n',
    );
    // Control: without the guard, git writes all three.
    runShim(['status'], { GIT_CONFIG_GLOBAL: globalConfig });
    expect(readdirSync(out)).toEqual(expect.arrayContaining(['event', 'normal', 'perf']));
    for (const name of readdirSync(out)) rmSync(path.join(out, name));

    const before = fingerprint(root);
    for (const args of [['status'], ['log', '--oneline'], ['-c', 'alias.x=log', 'x']]) {
      runShim(args, { AGENT_HUB_BLOCK_GIT_WRITES: '1', GIT_CONFIG_GLOBAL: globalConfig });
    }
    expect(fingerprint(root)).toEqual(before);
  });

  it('write block drops trace output requested through the environment', () => {
    const before = fingerprint(root);
    const out = path.join(root, 'outside');
    runShim(['status'], {
      AGENT_HUB_BLOCK_GIT_WRITES: '1',
      GIT_TRACE: path.join(out, 'trace'),
      GIT_TRACE2_EVENT: path.join(out, 'trace2'),
      GIT_TRACE_PACKET: path.join(out, 'packet'),
    });
    expect(fingerprint(root)).toEqual(before);
  });

  // c.cfg (modified in the worktree) uses filter `fl`, which is required.
  // With its commands emptied, reads must pass the file through, not fail.
  it.each([
    ['status'],
    ['status', '--porcelain'],
    ['diff'],
    ['diff', '--', 'c.cfg'],
    ['diff', '--stat'],
    ['-c', 'filter.fl.required=true', 'status'],
    ['-c', 'filter.fl.process=printf x > ../outside/fp', '-c', 'filter.fl.required=true', 'diff'],
  ])('write block reads a required-filter file and changes nothing: git %s', (...args) => {
    const before = fingerprint(root);
    const r = runShim(args, { AGENT_HUB_BLOCK_GIT_WRITES: '1' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).not.toContain('filter failed');
    expect(fingerprint(root)).toEqual(before);
  });

  it.each(WRITE_BLOCK_CASES)('write block leaves the repository unchanged: git %s', (...args) => {
    const before = fingerprint(root);
    runShim(args, { AGENT_HUB_BLOCK_GIT_WRITES: '1' });
    expect(fingerprint(root)).toEqual(before);
  });

  // The allowlist must not make ordinary reads useless.
  it.each([
    ['status'],
    ['status', '-sb'],
    ['status', '--porcelain'],
    ['log', '--oneline'],
    ['log', '--oneline', '-5'],
    ['log', '--stat'],
    ['log', '-p', '-1'],
    ['log', '--format=%h %s', '--author=Test'],
    ['branch', '--format=%(refname) %(upstream)'],
    ['branch', '--list', '--format=%(refname) %(upstream)', 'o*'],
    ['log', '--graph', '--decorate', '--all', '--oneline'],
    ['log', '-S', 'one', '--oneline'],
    ['diff'],
    ['diff', '--cached'],
    ['diff', '--stat', 'HEAD'],
    ['diff', '--name-only', 'HEAD'],
    ['diff', '-U5', 'HEAD', '--', 'a.txt'],
    ['show', '--stat', 'HEAD'],
    ['show', 'HEAD:a.txt'],
    ['grep', '-n', 'two'],
    ['grep', '-in', 'TWO'],
    ['grep', '-e', 'one', '--cached'],
    ['blame', 'a.txt'],
    ['rev-parse', '--show-toplevel'],
    ['rev-parse', '--abbrev-ref', 'HEAD'],
    ['rev-list', '--count', 'HEAD'],
    ['ls-files'],
    ['ls-tree', '-r', 'HEAD'],
    ['cat-file', '-p', 'HEAD'],
    ['shortlog', '-sn', 'HEAD'],
    ['branch', '-v'],
    ['branch', '-a'],
    ['tag', '-l'],
    ['remote', '-v'],
    ['config', '--list'],
    ['for-each-ref', '--format=%(refname)'],
    ['merge-base', 'HEAD', 'other'],
    ['stash', 'list'],
    ['worktree', 'list'],
    ['--version'],
    ['show', 'merged'],
    ['log', '-p', '-1', 'merged'],
    ['log', '--oneline', '--graph', '--all'],
    ['log', '--oneline', '--', 'a.txt'],
    ['diff', 'HEAD', '--', 'a.txt'],
    ['grep', '-e', 'two', '--', 'a.txt'],
  ])('write block still runs read-only git %s', (...args) => {
    const r = runShim(args, { AGENT_HUB_BLOCK_GIT_WRITES: '1' });
    expect(r.status, r.stderr).toBe(0);
  });

  // No new branch, HEAD stays put, no extra worktree.
  const BRANCH_PROTECT_CASES: string[][] = [
    // one argument whose value looks like more options: git sees a single
    // --format / --sort value, so these must be judged as one argument
    ['branch', '--format= --list ', 'unexpected'],
    ['branch', '--format=x --list', 'unexpected'],
    ['branch', '--sort=refname -l', 'unexpected'],
    ['branch', '--format= -d ', 'unexpected'],
    ['branch', '--format= --contains HEAD ', 'unexpected'],
    ['branch', '--format=x\n--list', 'unexpected'],
    ['branch', '--format=x\n-l\n', 'unexpected'],
    ['branch', '--format= -m ', 'unexpected'],
    ['branch', 'new-branch'],
    ['branch', '-v', 'new-branch'],
    ['branch', '-vv', 'new-branch'],
    ['branch', '--verbose', 'new-branch'],
    ['branch', '--verb', 'new-branch'],
    ['branch', '-q', 'new-branch'],
    ['branch', '-f', 'new-branch'],
    ['branch', '-t', 'new-branch', 'origin/main'],
    ['branch', '--track', 'new-branch', 'origin/main'],
    ['branch', '--no-track', 'new-branch'],
    ['branch', '--create-reflog', 'new-branch'],
    ['branch', '--sort=refname', 'new-branch'],
    ['branch', '--format', '-d', 'new-branch'],
    ['branch', '--color', 'new-branch'],
    ['branch', '-c', 'new-branch'],
    ['branch', '--copy', 'new-branch'],
    ['branch', '-m', 'renamed'],
    ['branch', '-M', 'main', 'renamed'],
    ['branch', '--mov', 'renamed'],
    ['branch', '-d', 'new-branch'],
    ['branch', '-l', 'new-branch'],
    ['branch', '--contains', 'HEAD', 'new-branch'],
    ['branch', '-u', 'origin/main'],
    ['checkout', '-b', 'new-branch'],
    ['checkout', '-qb', 'new-branch'],
    ['checkout', '-bnew-branch'],
    ['checkout', '-B', 'other'],
    ['checkout', '--orphan', 'new-branch'],
    ['checkout', '--orph', 'new-branch'],
    ['checkout', '-t', 'origin/remote-only'],
    ['checkout', '--track', 'origin/remote-only'],
    ['checkout', 'remote-only'],
    ['switch', '-c', 'new-branch'],
    ['switch', '-qc', 'new-branch'],
    ['switch', '--cre', 'new-branch'],
    ['switch', '-C', 'other'],
    ['switch', '--force-cr', 'other'],
    ['switch', '--orphan', 'new-branch'],
    ['switch', '--track', 'origin/remote-only'],
    ['switch', 'remote-only'],
    ['worktree', 'add', '../wt'],
    ['worktree', 'add', '-b', 'new-branch', '../wt'],
    ['-c', 'alias.nb=checkout -b', 'nb', 'new-branch'],
    ['-c', "alias.nb=checkout '-b'", 'nb', 'new-branch'],
    ['-c', "alias.nb=-c 'x.y=a b' checkout -b", 'nb', 'new-branch'],
    // an alias that defines the next alias, and a chain past any depth limit
    ['-c', 'alias.outer=-c alias.inner=branch inner', 'outer', 'new-branch'],
    [
      '-c',
      'alias.a1=a2',
      '-c',
      'alias.a2=a3',
      '-c',
      'alias.a3=a4',
      '-c',
      'alias.a4=a5',
      '-c',
      'alias.a5=a6',
      '-c',
      'alias.a6=a7',
      '-c',
      'alias.a7=a8',
      '-c',
      'alias.a8=a9',
      '-c',
      'alias.a9=a10',
      '-c',
      'alias.a10=a11',
      '-c',
      'alias.a11=a12',
      '-c',
      'alias.a12=branch',
      'a1',
      'new-branch',
    ],
    ['-c', 'alias.nb=-c "x.y=a b" branch', 'nb', 'new-branch'],
    ['-c', 'alias.nb=-c x.y=a\\ b switch -c', 'nb', 'new-branch'],
    ['-c', 'alias.nb=branch -v', 'nb', 'new-branch'],
    ['-c', 'alias.nb=!git branch new-branch', 'nb'],
    ['-C', '.', 'checkout', '-b', 'new-branch'],
    ['--attr-source', 'HEAD', 'checkout', '-b', 'new-branch'],
  ];

  it.each(BRANCH_PROTECT_CASES)(
    'branch protection keeps the branch set and HEAD: git %s',
    (...args) => {
      const before = branchState();
      runShim(args, { AGENT_HUB_PROTECT_SESSION_BRANCH: '1' });
      expect(branchState()).toEqual(before);
    },
  );

  it.each([
    ['branch', '-v'],
    ['branch', '-d', 'other'],
    ['checkout', '--', 'a.txt'],
  ])('branch protection still allows git %s', (...args) => {
    const r = runShim(args, { AGENT_HUB_PROTECT_SESSION_BRANCH: '1' });
    expect(r.status, r.stderr).toBe(0);
  });
});
