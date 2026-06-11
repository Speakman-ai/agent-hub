/**
 * repo-store.ts — bare repo storage & lifecycle for Agent Hub-hosted git.
 *
 * Projects opted into `gitHost: 'agenthub'` get a canonical bare repo at
 * `<dataDir>/git/<projectId>.git`. Everything in this module shells out to
 * the real `git` binary (same pattern as `worktree.ts`); there is no
 * libgit2-style reimplementation.
 *
 * Layout inside each bare repo:
 *   hooks/post-receive       — notifies the Hub of ref updates (always exit 0)
 *   agent-hub-notify.json    — { projectId, url, secret } read by the hook
 *
 * Import precedence on creation (see {@link createHostedRepo}):
 *   1. project.repoUrl set        → `git clone --mirror` from GitHub
 *   2. project.cwd is a git repo  → init bare + push all refs from cwd
 *   3. otherwise                  → empty init (--initial-branch=main)
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import config from '../config.js';
import type { Project } from '../types.js';
import {
  buildAuthenticatedUrl,
  classifyCloneUrl,
  redactAuthHeader,
  redactToken,
} from '../clone-url-auth.js';
import { gitAuthArgsForGithubPat, resolveUserGithubToken } from '../skill-credentials-github.js';
import { resolveOAuthAppCredentials } from '../spawn-github-credentials.js';
import { resolveDefaultBranch } from '../git-default-branch.js';

const execFileP = promisify(execFile);

/** Mirror clones of large repos can be slow; align with worktree clone budget. */
const IMPORT_TIMEOUT_MS = 10 * 60 * 1000;
const GIT_TIMEOUT_MS = 60 * 1000;

/**
 * Same shape as `worktree.ts`'s InstallationTokenResolver — redefined here
 * (it's two lines) so git-host has no import edge into worktree.ts, which
 * will later import from this module for the self-heal path.
 */
export type InstallationTokenResolver = (repoUrl: string) => Promise<string | null>;

/** Project ids are UUIDs / slug-safe strings; anything else is rejected. */
const PROJECT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function gitHostRootDir(dataDir: string = config.dataDir): string {
  return path.join(dataDir, 'git');
}

/**
 * Resolve the bare repo path for a project id. The single
 * validation/traversal-guard point: every other function in this module
 * (and any external caller) goes through here.
 */
export function gitHostRepoPath(projectId: string, dataDir: string = config.dataDir): string {
  if (!PROJECT_ID_RE.test(projectId) || projectId.includes('..')) {
    throw new Error(`gitHostRepoPath: invalid project id ${JSON.stringify(projectId)}`);
  }
  const root = gitHostRootDir(dataDir);
  const repoPath = path.resolve(root, `${projectId}.git`);
  if (!repoPath.startsWith(path.resolve(root) + path.sep)) {
    throw new Error(`gitHostRepoPath: resolved path escapes the git host root`);
  }
  return repoPath;
}

export function hostedRepoExists(projectId: string, dataDir: string = config.dataDir): boolean {
  const repoPath = gitHostRepoPath(projectId, dataDir);
  return existsSync(path.join(repoPath, 'HEAD'));
}

/**
 * Bare repo path when (and only when) the project is Agent Hub-hosted —
 * the single predicate callers thread into worktree self-heal so hosted
 * projects clone from the Hub repo instead of GitHub.
 */
export function hostedBarePathForProject(
  project: Pick<Project, 'id' | 'gitHost'>,
  dataDir: string = config.dataDir,
): string | null {
  if (project.gitHost !== 'agenthub') return null;
  try {
    return gitHostRepoPath(project.id, dataDir);
  } catch {
    return null;
  }
}

async function git(args: string[], cwd: string, timeoutMs = GIT_TIMEOUT_MS): Promise<string> {
  const { stdout } = await execFileP('git', args, {
    cwd,
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

/**
 * Default branch of a hosted bare repo, from its HEAD symref.
 * Returns null for a repo whose HEAD points at a ref that can't be read.
 */
export async function hostedRepoDefaultBranch(
  projectId: string,
  dataDir: string = config.dataDir,
): Promise<string | null> {
  const repoPath = gitHostRepoPath(projectId, dataDir);
  try {
    const out = await git(['symbolic-ref', 'HEAD'], repoPath);
    const ref = out.trim();
    return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : null;
  } catch {
    return null;
  }
}

export interface HostedRepoInfo {
  projectId: string;
  repoPath: string;
  defaultBranch: string | null;
  /** Count of refs/heads/* — cheap signal for "is this repo empty". */
  branchCount: number;
}

export async function getHostedRepoInfo(
  projectId: string,
  dataDir: string = config.dataDir,
): Promise<HostedRepoInfo | null> {
  if (!hostedRepoExists(projectId, dataDir)) return null;
  const repoPath = gitHostRepoPath(projectId, dataDir);
  const defaultBranch = await hostedRepoDefaultBranch(projectId, dataDir);
  let branchCount = 0;
  try {
    const out = await git(['for-each-ref', '--format=%(refname)', 'refs/heads'], repoPath);
    branchCount = out.split('\n').filter(Boolean).length;
  } catch {
    // leave 0 — caller treats the repo as empty
  }
  return { projectId, repoPath, defaultBranch, branchCount };
}

// ── notify hook ─────────────────────────────────────────────────────

export interface NotifyConfig {
  projectId: string;
  /** Absolute URL of the Hub's internal post-receive endpoint. */
  url: string;
  /** Per-repo shared secret; the endpoint compares against this file. */
  secret: string;
}

const NOTIFY_FILE = 'agent-hub-notify.json';

/**
 * The post-receive hook script. Locates the notify config relative to its
 * own path (robust regardless of hook cwd / GIT_DIR value in bare repos),
 * forwards stdin's `old new ref` lines as the request body, and always
 * exits 0 — a notify failure must never fail a push. Secret/projectId
 * travel as headers so the script needs no JSON escaping.
 */
const POST_RECEIVE_HOOK = `#!/bin/sh
# Installed by Agent Hub (server/git-host/repo-store.ts). Notifies the Hub
# of ref updates so mirror sync and UI events run. Always exits 0.
HOOK_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
NOTIFY_FILE="$HOOK_DIR/../${NOTIFY_FILE}"
[ -f "$NOTIFY_FILE" ] || exit 0
URL=$(sed -n 's/.*"url"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' "$NOTIFY_FILE")
SECRET=$(sed -n 's/.*"secret"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' "$NOTIFY_FILE")
PROJECT=$(sed -n 's/.*"projectId"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' "$NOTIFY_FILE")
[ -n "$URL" ] || exit 0
curl -fsS -m 10 -X POST "$URL" \\
  -H "Content-Type: text/plain" \\
  -H "X-AgentHub-Project: $PROJECT" \\
  -H "X-AgentHub-Secret: $SECRET" \\
  --data-binary @- >/dev/null 2>&1 || true
exit 0
`;

/** Branch-protection config file inside the bare repo (one branch per line). */
const PROTECTED_BRANCHES_FILE = 'agent-hub-protected-branches';

/**
 * Pre-receive hook: rejects any direct push that updates a branch listed
 * in the protected-branches file (including deletes and force pushes).
 * Native PR merges move the base branch via `git update-ref`, which does
 * NOT run receive hooks — merges keep working while direct pushes bounce.
 * No config file → exit 0 (hook is a no-op until protection is enabled).
 */
const PRE_RECEIVE_HOOK = `#!/bin/sh
# Installed by Agent Hub (server/git-host/repo-store.ts). Rejects direct
# pushes to protected branches; merge via a pull request instead.
HOOK_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROTECT_FILE="$HOOK_DIR/../${PROTECTED_BRANCHES_FILE}"
[ -f "$PROTECT_FILE" ] || exit 0
status=0
while read -r _old _new ref; do
  case "$ref" in
    refs/heads/*) branch=\${ref#refs/heads/} ;;
    *) continue ;;
  esac
  if grep -Fxq "$branch" "$PROTECT_FILE" 2>/dev/null; then
    echo "agent-hub: branch '$branch' is protected — direct pushes are blocked." >&2
    echo "agent-hub: open a pull request on Agent Hub and merge it instead." >&2
    status=1
  fi
done
exit $status
`;

/**
 * Write or clear the protected-branches config for a hosted repo. An
 * empty list removes the file (hook becomes a no-op). The hook script
 * itself is (re)installed by {@link writeNotifyConfig} on create + boot.
 */
export function writeProtectedBranchesConfig(
  projectId: string,
  branches: string[],
  dataDir: string = config.dataDir,
): void {
  const repoPath = gitHostRepoPath(projectId, dataDir);
  const filePath = path.join(repoPath, PROTECTED_BRANCHES_FILE);
  const list = branches.map((b) => b.trim()).filter(Boolean);
  if (list.length === 0) {
    if (existsSync(filePath)) rmSync(filePath, { force: true });
    return;
  }
  writeFileSync(filePath, list.join('\n') + '\n', { mode: 0o644 });
}

/**
 * Sync the pre-receive push block with the project's `branchProtection`
 * setting: `blockDirectPushes` protects the default branch; otherwise the
 * config is removed. Safe to call for non-hosted projects (no-op).
 */
export async function refreshBranchProtection(
  project: Pick<Project, 'id' | 'gitHost' | 'branchProtection'>,
  dataDir: string = config.dataDir,
): Promise<void> {
  if (project.gitHost !== 'agenthub' || !hostedRepoExists(project.id, dataDir)) return;
  if (project.branchProtection?.blockDirectPushes) {
    const defaultBranch = (await hostedRepoDefaultBranch(project.id, dataDir)) ?? 'main';
    writeProtectedBranchesConfig(project.id, [defaultBranch], dataDir);
  } else {
    writeProtectedBranchesConfig(project.id, [], dataDir);
  }
}

/**
 * Write (or refresh) the notify config and post-receive hook for a hosted
 * repo. The secret is preserved across rewrites when the file already
 * exists so an in-flight hook never races a rotation; the URL is always
 * refreshed because the Hub's port can change between boots.
 */
export function writeNotifyConfig(
  projectId: string,
  notifyUrl: string,
  dataDir: string = config.dataDir,
): NotifyConfig {
  const repoPath = gitHostRepoPath(projectId, dataDir);
  const notifyPath = path.join(repoPath, NOTIFY_FILE);
  let secret: string | null = null;
  if (existsSync(notifyPath)) {
    try {
      const existing = JSON.parse(readFileSync(notifyPath, 'utf8')) as Partial<NotifyConfig>;
      if (typeof existing.secret === 'string' && existing.secret.length >= 32) {
        secret = existing.secret;
      }
    } catch {
      // corrupt file — regenerate below
    }
  }
  const conf: NotifyConfig = {
    projectId,
    url: notifyUrl,
    secret: secret ?? randomBytes(32).toString('hex'),
  };
  writeFileSync(notifyPath, JSON.stringify(conf, null, 2) + '\n', { mode: 0o600 });

  const hooksDir = path.join(repoPath, 'hooks');
  mkdirSync(hooksDir, { recursive: true });
  const hookPath = path.join(hooksDir, 'post-receive');
  writeFileSync(hookPath, POST_RECEIVE_HOOK);
  chmodSync(hookPath, 0o755);
  // Pre-receive push block rides along — a no-op until a protected-
  // branches config exists (see refreshBranchProtection).
  const preReceivePath = path.join(hooksDir, 'pre-receive');
  writeFileSync(preReceivePath, PRE_RECEIVE_HOOK);
  chmodSync(preReceivePath, 0o755);
  return conf;
}

/** Read a hosted repo's notify config (null when absent/corrupt). */
export function readNotifyConfig(
  projectId: string,
  dataDir: string = config.dataDir,
): NotifyConfig | null {
  try {
    const raw = readFileSync(path.join(gitHostRepoPath(projectId, dataDir), NOTIFY_FILE), 'utf8');
    const parsed = JSON.parse(raw) as Partial<NotifyConfig>;
    if (
      typeof parsed.projectId === 'string' &&
      typeof parsed.url === 'string' &&
      typeof parsed.secret === 'string'
    ) {
      return parsed as NotifyConfig;
    }
    return null;
  } catch {
    return null;
  }
}

// ── creation / import ───────────────────────────────────────────────

export interface CreateHostedRepoOptions {
  /**
   * Import source. Default `'auto'` follows the documented precedence:
   * repoUrl → cwd → empty. Explicit values force one source and throw
   * when it isn't available.
   */
  importFrom?: 'auto' | 'github' | 'cwd' | 'empty';
  /** Per-user GitHub credential fallback for private-repo mirror clones. */
  requestingUserId?: string | null;
  /** Test seam — production default mints no installation token. */
  resolveToken?: InstallationTokenResolver;
  /** Test seam — defaults to {@link resolveUserGithubToken}. */
  resolveUserToken?: (userId: string) => Promise<string | null>;
  /** Hub notify endpoint URL; when set the post-receive hook is installed. */
  notifyUrl?: string;
  dataDir?: string;
}

export interface CreateHostedRepoResult {
  repoPath: string;
  defaultBranch: string;
  importedFrom: 'github' | 'cwd' | 'empty';
  /** True when the repo already existed and creation was skipped. */
  alreadyExisted: boolean;
}

/**
 * Create the hosted bare repo for a project. Idempotent: an existing repo
 * is left untouched (only the notify hook is refreshed when `notifyUrl`
 * is provided).
 */
export async function createHostedRepo(
  project: Pick<Project, 'id' | 'cwd' | 'repoUrl'>,
  options: CreateHostedRepoOptions = {},
): Promise<CreateHostedRepoResult> {
  const dataDir = options.dataDir ?? config.dataDir;
  const repoPath = gitHostRepoPath(project.id, dataDir);

  if (hostedRepoExists(project.id, dataDir)) {
    if (options.notifyUrl) writeNotifyConfig(project.id, options.notifyUrl, dataDir);
    const defaultBranch = (await hostedRepoDefaultBranch(project.id, dataDir)) ?? 'main';
    return { repoPath, defaultBranch, importedFrom: 'empty', alreadyExisted: true };
  }

  mkdirSync(gitHostRootDir(dataDir), { recursive: true });

  const mode = options.importFrom ?? 'auto';
  const cwdIsRepo = Boolean(project.cwd) && existsSync(path.join(project.cwd, '.git'));

  let importedFrom: 'github' | 'cwd' | 'empty';
  if (mode === 'github' || (mode === 'auto' && project.repoUrl)) {
    if (!project.repoUrl) {
      throw new Error(
        `createHostedRepo: importFrom=github but project ${project.id} has no repoUrl`,
      );
    }
    await importFromGithub(project.repoUrl, repoPath, project.id, options);
    importedFrom = 'github';
  } else if (mode === 'cwd' || (mode === 'auto' && cwdIsRepo)) {
    if (!cwdIsRepo) {
      throw new Error(`createHostedRepo: importFrom=cwd but ${project.cwd} is not a git repo`);
    }
    await git(['init', '--bare', repoPath], dataDir);
    await git(
      ['-C', project.cwd, 'push', repoPath, 'refs/heads/*:refs/heads/*', 'refs/tags/*:refs/tags/*'],
      project.cwd,
      IMPORT_TIMEOUT_MS,
    );
    // resolveDefaultBranch knows origin/HEAD + main/master; for cwds on a
    // non-standard branch with no origin, fall back to the checked-out one.
    let branch = await resolveDefaultBranch(project.cwd);
    if (!branch) {
      try {
        branch = (await git(['symbolic-ref', '--short', 'HEAD'], project.cwd)).trim() || null;
      } catch {
        branch = null;
      }
    }
    await git(['symbolic-ref', 'HEAD', `refs/heads/${branch ?? 'main'}`], repoPath);
    importedFrom = 'cwd';
  } else {
    await git(['init', '--bare', '--initial-branch=main', repoPath], dataDir);
    importedFrom = 'empty';
  }

  // Reflogs are the recovery net for force-pushes/merges in a bare repo
  // (off by default when bare). Never persist a remote: the bare repo is
  // canonical; mirror pushes pass the GitHub URL per invocation.
  await git(['config', 'core.logAllRefUpdates', 'true'], repoPath);
  try {
    await git(['remote', 'remove', 'origin'], repoPath);
  } catch {
    // no origin (cwd/empty imports) — fine
  }

  if (options.notifyUrl) writeNotifyConfig(project.id, options.notifyUrl, dataDir);

  const defaultBranch = (await hostedRepoDefaultBranch(project.id, dataDir)) ?? 'main';
  return { repoPath, defaultBranch, importedFrom, alreadyExisted: false };
}

async function importFromGithub(
  repoUrl: string,
  repoPath: string,
  projectId: string,
  options: CreateHostedRepoOptions,
): Promise<void> {
  const parsed = classifyCloneUrl(repoUrl);
  if (parsed.kind !== 'github-https') {
    throw new Error(
      `createHostedRepo: repoUrl ${repoUrl} for project ${projectId} is not a supported GitHub HTTPS URL`,
    );
  }

  // Token chain mirrors `ensureProjectRepoCloned` (worktree.ts): App
  // installation token preferred (embedded in URL), per-user OAuth/PAT as
  // a per-invocation extraheader fallback; neither persists because the
  // origin remote is removed right after the clone.
  let token: string | null = null;
  if (options.resolveToken) {
    try {
      token = await options.resolveToken(repoUrl);
    } catch {
      token = null;
    }
  }
  let userToken: string | null = null;
  if (!token && options.requestingUserId) {
    const resolve =
      options.resolveUserToken ??
      ((uid: string) =>
        resolveUserGithubToken(uid, { oauthCredentials: resolveOAuthAppCredentials(config) }));
    userToken = await resolve(options.requestingUserId);
  }

  const cloneUrl = token ? buildAuthenticatedUrl(parsed, token) : repoUrl;
  const authArgs = userToken ? gitAuthArgsForGithubPat(userToken) : [];

  try {
    await execFileP('git', [...authArgs, 'clone', '--mirror', '--quiet', cloneUrl, repoPath], {
      timeout: IMPORT_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (err: unknown) {
    const raw = err instanceof Error ? err.message : String(err);
    const safe = redactAuthHeader(redactToken(redactToken(raw, token), userToken));
    throw new Error(`createHostedRepo: mirror clone of ${repoUrl} failed: ${safe}`);
  }
}

/**
 * Archive (never delete) a hosted repo when its project is removed.
 * Returns the archived path, or null when there was nothing to archive.
 */
export function archiveHostedRepo(
  projectId: string,
  dataDir: string = config.dataDir,
): string | null {
  if (!hostedRepoExists(projectId, dataDir)) return null;
  const repoPath = gitHostRepoPath(projectId, dataDir);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const archived = `${repoPath}.deleted-${stamp}`;
  renameSync(repoPath, archived);
  return archived;
}
