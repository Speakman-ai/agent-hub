/**
 * Real-git fixture for retarget tests: a bare `origin` with `main` and a
 * `release` branch cut from an older main, plus a session clone that forked
 * from the newest main and carries its own commits.
 *
 *   origin/main:    A ── B(main-only)
 *   origin/release: A ── R(release-only)
 *   origin/hotfix:  A ── H(hotfix-only)
 *   session HEAD:   A ── B ── S1 ── S2
 */
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const ID = ['-c', 'user.name=Agent Hub Test', '-c', 'user.email=test@example.com'];

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', [...ID, ...args], { cwd, encoding: 'utf8' }).trim();
}

function commitFile(cwd: string, file: string, body: string, msg: string): string {
  writeFileSync(join(cwd, file), body);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-qm', msg);
  return git(cwd, 'rev-parse', 'HEAD');
}

export interface RetargetRepo {
  root: string;
  seed: string;
  clone: string;
  releaseTip: string;
  mainOnlySha: string;
  cleanup: () => void;
}

/**
 * `conflictOnRelease`: the release commit edits the same line S1 edits.
 * `mergeOnlyChange`: the session ends with a merge commit whose only unique
 *   content (`merge-only.txt`) was added while resolving the merge.
 * `releaseHasS2`: release already carries a commit identical to S2.
 * `noMainOnly`: skip B, so main stays at A and release descends from main.
 */
export function makeRetargetRepo(
  opts: {
    conflictOnRelease?: boolean;
    mergeOnlyChange?: boolean;
    releaseHasS2?: boolean;
    noMainOnly?: boolean;
  } = {},
): RetargetRepo {
  const root = mkdtempSync(join(tmpdir(), 'agent-hub-retarget-'));
  const origin = join(root, 'origin.git');
  const seed = join(root, 'seed');
  const clone = join(root, 'clone');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['init', '-q', '-b', 'main', seed]);
  commitFile(seed, 'shared.txt', 'base\n', 'A');
  git(seed, 'branch', 'release');
  git(seed, 'branch', 'hotfix');
  const mainOnlySha = opts.noMainOnly
    ? git(seed, 'rev-parse', 'HEAD')
    : commitFile(seed, 'main-only.txt', 'main\n', 'B main-only');
  git(seed, 'checkout', '-q', 'release');
  let releaseTip = opts.conflictOnRelease
    ? commitFile(seed, 'shared.txt', 'release edit\n', 'R release-only')
    : commitFile(seed, 'release-only.txt', 'release\n', 'R release-only');
  if (opts.releaseHasS2) releaseTip = commitFile(seed, 'session.txt', 'session\n', 'S2 upstream');
  git(seed, 'checkout', '-q', 'hotfix');
  commitFile(seed, 'hotfix-only.txt', 'hotfix\n', 'H hotfix-only');
  git(seed, 'remote', 'add', 'origin', origin);
  git(seed, 'push', '-q', 'origin', 'main', 'release', 'hotfix');

  execFileSync('git', ['clone', '-q', origin, clone]);
  git(clone, 'checkout', '-q', '-b', 'agent-hub/dev/session-1', 'origin/main');
  commitFile(clone, 'shared.txt', 'session edit\n', 'S1');
  commitFile(clone, 'session.txt', 'session\n', 'S2');
  if (opts.mergeOnlyChange) {
    git(clone, 'checkout', '-q', '-b', 'side', 'origin/main');
    commitFile(clone, 'side.txt', 'side\n', 'side work');
    git(clone, 'checkout', '-q', 'agent-hub/dev/session-1');
    git(clone, 'merge', '--no-ff', '--no-commit', 'side');
    writeFileSync(join(clone, 'merge-only.txt'), 'only in the merge\n');
    git(clone, 'add', 'merge-only.txt');
    git(clone, 'commit', '-qm', 'M merge side');
  }

  return {
    root,
    seed,
    clone,
    releaseTip,
    mainOnlySha,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
