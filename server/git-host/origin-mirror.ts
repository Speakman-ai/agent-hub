/**
 * Local bare mirror of an externally hosted project's default branch (a
 * GitHub-hosted project has no Hub bare repo). Push CI clones its run
 * workspace from here, and default-branch health runs its ancestry checks
 * against it, exactly as it does against `<dataDir>/git/<id>.git` for
 * Hub-hosted repos.
 *
 * The origin URL is passed on every command and never written into the
 * mirror's config, so no credential lands on disk.
 */
import { execFile } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import path from 'path';
import { promisify } from 'util';
import type { Project } from '../types.js';

const execFileP = promisify(execFile);

const LS_REMOTE_TIMEOUT_MS = 30_000;
/** The first fetch copies full history (ancestry checks need it). */
const FETCH_TIMEOUT_MS = 10 * 60 * 1000;
const SAFE_BRANCH_RE = /^[A-Za-z0-9._/-]+$/;

export function originMirrorPath(projectId: string, dataDir: string): string {
  return path.join(dataDir, 'push-ci-mirrors', `${projectId}.git`);
}

export function originMirrorExists(projectId: string, dataDir: string): boolean {
  return existsSync(path.join(originMirrorPath(projectId, dataDir), 'HEAD'));
}

/**
 * The URL to watch: `repoUrl`, else `githubRepo` as a github.com HTTPS URL,
 * else the `origin` remote of the project's checkout. `null` when none is set.
 */
export async function resolveProjectOriginUrl(
  project: Pick<Project, 'repoUrl' | 'githubRepo' | 'cwd'>,
): Promise<string | null> {
  const repoUrl = project.repoUrl?.trim();
  if (repoUrl) return repoUrl;
  const slug = project.githubRepo?.trim().replace(/\.git$/, '');
  if (slug && /^[^/\s]+\/[^/\s]+$/.test(slug)) return `https://github.com/${slug}.git`;
  const cwd = project.cwd?.trim();
  if (!cwd || !existsSync(cwd)) return null;
  try {
    const { stdout } = await execFileP('git', ['-C', cwd, 'remote', 'get-url', 'origin'], {
      timeout: 10_000,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export interface RemoteHead {
  branch: string;
  sha: string;
}

/**
 * Parse `git ls-remote --symref <url> HEAD`:
 *
 *   ref: refs/heads/main\tHEAD
 *   <sha>\tHEAD
 */
export function parseSymrefHead(stdout: string): RemoteHead | null {
  let branch: string | null = null;
  let sha: string | null = null;
  for (const line of stdout.split('\n')) {
    const symref = line.match(/^ref: refs\/heads\/(\S+)\tHEAD$/);
    if (symref) {
      branch = symref[1];
      continue;
    }
    const plain = line.match(/^([0-9a-f]{40}|[0-9a-f]{64})\tHEAD$/);
    if (plain) sha = plain[1];
  }
  if (!branch || !sha || !SAFE_BRANCH_RE.test(branch)) return null;
  return { branch, sha };
}

/** The origin's default branch and its head, in one round trip. */
export async function lsRemoteDefaultHead(
  url: string,
  env: NodeJS.ProcessEnv,
): Promise<RemoteHead | null> {
  const { stdout } = await execFileP('git', ['ls-remote', '--symref', url, 'HEAD'], {
    env,
    timeout: LS_REMOTE_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  });
  return parseSymrefHead(stdout);
}

/**
 * Fetch `branch` from `url` into the mirror (created on first use) and
 * confirm `headSha` is present. Returns the mirror path.
 */
export async function syncOriginMirror(args: {
  projectId: string;
  dataDir: string;
  url: string;
  branch: string;
  headSha: string;
  env: NodeJS.ProcessEnv;
}): Promise<string> {
  if (!SAFE_BRANCH_RE.test(args.branch)) throw new Error(`unsafe branch name ${args.branch}`);
  const mirror = originMirrorPath(args.projectId, args.dataDir);
  if (!originMirrorExists(args.projectId, args.dataDir)) {
    mkdirSync(path.dirname(mirror), { recursive: true });
    await execFileP('git', ['init', '--quiet', '--bare', mirror], { timeout: 30_000 });
  }
  await execFileP(
    'git',
    [
      '-C',
      mirror,
      'fetch',
      '--quiet',
      '--force',
      '--no-tags',
      args.url,
      `+refs/heads/${args.branch}:refs/heads/${args.branch}`,
    ],
    { env: args.env, timeout: FETCH_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
  );
  // A clone of the mirror checks out HEAD, so point it at the fetched branch.
  await execFileP('git', ['-C', mirror, 'symbolic-ref', 'HEAD', `refs/heads/${args.branch}`], {
    timeout: 10_000,
  });
  await execFileP('git', ['-C', mirror, 'cat-file', '-e', `${args.headSha}^{commit}`], {
    timeout: 10_000,
  });
  return mirror;
}
