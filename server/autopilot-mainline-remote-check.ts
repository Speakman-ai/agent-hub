/**
 * Ask the remote whether a commit is on the default branch.
 *
 * Spec invariant 4 (wiki: autopilot-mainline-mode-spec-default-branch-deploy-verification):
 * "absent" needs a completed git answer. That is either
 *   - `merge-base --is-ancestor <sha> <tip>` exiting 1, or
 *   - a `rev-list <tip>` that exited 0 and does not list the sha,
 * and both only after the tip itself was read by a fetch or ref read that
 * exited 0. A killed, timed-out, or failed-to-spawn git has exit code `null`
 * and is always unknown, as is any other non-zero exit.
 */
import { execFile } from 'child_process';
import type { GitRunResult } from './finalize/push-to-default-branch.js';

export type RemoteCommitAnswer =
  | { kind: 'present'; detail: string }
  | { kind: 'absent'; detail: string }
  | { kind: 'unknown'; detail: string };

/**
 * Where the remote's default branch is read from:
 * - `fetch`: a clone whose `origin` push URL is the remote; the branch is
 *   fetched from that push URL (never origin's fetch URL) into a private ref.
 * - `local`: the remote repository itself is on this host (Hub-hosted git),
 *   so its ref is read directly.
 */
export type RemoteCheckSource =
  | { kind: 'fetch'; repoPath: string; env: NodeJS.ProcessEnv | undefined }
  | { kind: 'local'; repoPath: string };

export type RemoteCheckGitRunner = (
  argv: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv | undefined; timeoutMs: number },
) => Promise<GitRunResult>;

const FETCH_TIMEOUT_MS = 2 * 60_000;
const READ_TIMEOUT_MS = 60_000;
const REV_LIST_TIMEOUT_MS = 2 * 60_000;
const MAX_BUFFER = 64 * 1024 * 1024;

const SHA_RE = /^[0-9a-f]{7,64}$/i;
const PROBE_REF_PREFIX = 'refs/agent-hub/mainline-reconcile/';

/** Runs git and reports its exit; never throws. Killed or unspawned → `exitCode: null`. */
export const runRemoteCheckGit: RemoteCheckGitRunner = (argv, opts) =>
  new Promise((resolve) => {
    execFile(
      'git',
      argv,
      { cwd: opts.cwd, env: opts.env, timeout: opts.timeoutMs, maxBuffer: MAX_BUFFER },
      (err, stdout, stderr) => {
        const out = String(stdout ?? '');
        const errOut = String(stderr ?? '');
        if (!err) return resolve({ exitCode: 0, stdout: out, stderr: errOut });
        const e = err as NodeJS.ErrnoException & { code?: unknown; killed?: boolean };
        const exitCode = typeof e.code === 'number' && !e.killed ? e.code : null;
        resolve({
          exitCode,
          stdout: out,
          stderr: errOut || (typeof e.message === 'string' ? e.message : ''),
        });
      },
    );
  });

function describeRun(step: string, result: GitRunResult): string {
  const code = result.exitCode === null ? 'no exit code' : `exit ${result.exitCode}`;
  const text = (result.stderr.trim() || result.stdout.trim()).split('\n').slice(-3).join(' | ');
  return text ? `${step} (${code}): ${text}` : `${step} (${code})`;
}

async function runSafely(
  git: RemoteCheckGitRunner,
  argv: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv | undefined; timeoutMs: number },
): Promise<GitRunResult> {
  try {
    return await git(argv, opts);
  } catch (err) {
    return { exitCode: null, stdout: '', stderr: err instanceof Error ? err.message : String(err) };
  }
}

/** A branch name git would accept as `refs/heads/<name>`, conservatively. */
export function isSafeBranchName(branch: string): boolean {
  return (
    branch.length > 0 &&
    !branch.startsWith('-') &&
    !branch.startsWith('/') &&
    !branch.endsWith('/') &&
    !branch.endsWith('.lock') &&
    !branch.includes('..') &&
    !branch.includes('@{') &&
    !/[\s~^:?*[\\]/.test(branch) &&
    ![...branch].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f)
  );
}

function matchesSha(candidate: string, sha: string): boolean {
  const c = candidate.trim().toLowerCase();
  const s = sha.toLowerCase();
  return c.length > 0 && (c === s || c.startsWith(s));
}

export async function checkCommitOnRemoteBranch(args: {
  source: RemoteCheckSource;
  sha: string;
  branch: string;
  git?: RemoteCheckGitRunner;
}): Promise<RemoteCommitAnswer> {
  const { source, branch } = args;
  const sha = args.sha.trim();
  const git = args.git ?? runRemoteCheckGit;
  if (!SHA_RE.test(sha)) return { kind: 'unknown', detail: `not a commit sha: ${sha}` };
  if (!isSafeBranchName(branch)) return { kind: 'unknown', detail: `unusable branch: ${branch}` };

  const cwd = source.repoPath;
  const env = source.kind === 'fetch' ? source.env : undefined;
  const branchRef = `refs/heads/${branch}`;

  let tipRef = branchRef;
  if (source.kind === 'fetch') {
    // Ask the repository the push went to. `origin` can fetch from one URL
    // (url) and push to another (pushurl), and only the push destination
    // knows whether the push landed.
    const urlRead = await runSafely(git, ['remote', 'get-url', '--push', '--all', 'origin'], {
      cwd,
      env,
      timeoutMs: READ_TIMEOUT_MS,
    });
    if (urlRead.exitCode !== 0) {
      return { kind: 'unknown', detail: describeRun('read origin push URL', urlRead) };
    }
    const pushUrls = urlRead.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    if (pushUrls.length !== 1) {
      return {
        kind: 'unknown',
        detail: `origin has ${pushUrls.length} push URLs; the push destination is ambiguous`,
      };
    }
    tipRef = `${PROBE_REF_PREFIX}${branch}`;
    // A bare URL (not the remote name): no remote-tracking ref is updated.
    const fetched = await runSafely(
      git,
      [
        'fetch',
        '--no-tags',
        '--no-recurse-submodules',
        '--no-write-fetch-head',
        '--',
        pushUrls[0],
        `+${branchRef}:${tipRef}`,
      ],
      { cwd, env, timeoutMs: FETCH_TIMEOUT_MS },
    );
    if (fetched.exitCode !== 0) {
      return { kind: 'unknown', detail: describeRun(`fetch ${branch}`, fetched) };
    }
  }

  const tipRead = await runSafely(git, ['rev-parse', '--verify', `${tipRef}^{commit}`], {
    cwd,
    env,
    timeoutMs: READ_TIMEOUT_MS,
  });
  const tip = tipRead.stdout.trim();
  if (tipRead.exitCode !== 0 || !SHA_RE.test(tip)) {
    return { kind: 'unknown', detail: describeRun(`read ${branch}`, tipRead) };
  }
  if (matchesSha(tip, sha)) return { kind: 'present', detail: `${branch} is at ${tip}` };

  const ancestry = await runSafely(git, ['merge-base', '--is-ancestor', sha, tip], {
    cwd,
    env,
    timeoutMs: READ_TIMEOUT_MS,
  });
  if (ancestry.exitCode === 0) {
    return { kind: 'present', detail: `${sha} is an ancestor of ${branch} (${tip})` };
  }
  if (ancestry.exitCode === 1) {
    return { kind: 'absent', detail: `${sha} is not an ancestor of ${branch} (${tip})` };
  }

  // merge-base could not answer (commonly: this repo does not have the sha's
  // object). Walking the branch does not need it.
  const walked = await runSafely(git, ['rev-list', tip], {
    cwd,
    env,
    timeoutMs: REV_LIST_TIMEOUT_MS,
  });
  if (walked.exitCode !== 0) {
    return {
      kind: 'unknown',
      detail: `${describeRun('merge-base', ancestry)}; ${describeRun('rev-list', walked)}`,
    };
  }
  const found = walked.stdout.split('\n').some((line) => matchesSha(line, sha));
  return found
    ? { kind: 'present', detail: `${sha} is on ${branch} (${tip})` }
    : { kind: 'absent', detail: `${sha} is not on ${branch} (${tip})` };
}
