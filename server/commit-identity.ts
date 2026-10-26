/**
 * Per-project "commit as my GitHub account" support.
 *
 * Session worktrees normally inherit `user.name` / `user.email` from the
 * project checkout (or fall back to an Agent Hub identity at commit time), so
 * GitHub attributes every agent commit to Agent Hub even though the push uses
 * the session owner's token. When `Project.commitAsOwner.enabled` is on, this
 * module rewrites the worktree's local identity to the session owner's GitHub
 * account: their login as the author name and the ID-based noreply address,
 * which GitHub attributes to the account even after a username change and
 * without exposing a private email.
 *
 * The identity is written to the worktree's local git config, so it applies to
 * the agent's own commits and to Finalize's commit step alike. The values we
 * wrote are recorded alongside, so turning the toggle off (or disconnecting
 * GitHub) restores the project identity only for keys still holding what we
 * wrote, never clobbering an identity a human set afterwards.
 */
import { execFile } from 'child_process';
import { createHash } from 'crypto';
import path from 'path';
import { promisify } from 'util';
import config from './config.js';
import { fetchUserInfo } from './github-oauth.js';
import { resolveUserGithubToken } from './skill-credentials-github.js';
import { resolveOAuthAppCredentials } from './spawn-github-credentials.js';
import type { Project } from './types.js';

const execFileAsync = promisify(execFile);

const PROFILE_TTL_MS = 60 * 60 * 1000;

/** Worktree config keys recording the identity this module last wrote. */
export const APPLIED_IDENTITY_KEYS = {
  'user.name': 'agenthub.commitIdentityName',
  'user.email': 'agenthub.commitIdentityEmail',
} as const;
const IDENTITY_KEYS = ['user.name', 'user.email'] as const;

export interface CommitIdentity {
  name: string;
  email: string;
}

export interface GithubProfile {
  id: number;
  login: string;
}

export interface CommitIdentityDeps {
  resolveToken: (userId: string) => Promise<string | null>;
  fetchProfile: (token: string) => Promise<GithubProfile>;
  now: () => number;
}

export function githubNoreplyEmail(id: number, login: string): string {
  return `${id}+${login}@users.noreply.github.com`;
}

export function identityFromGithubProfile(profile: GithubProfile): CommitIdentity {
  return {
    name: profile.login,
    email: githubNoreplyEmail(profile.id, profile.login),
  };
}

export function isCommitAsOwnerEnabled(project: Pick<Project, 'commitAsOwner'> | null | undefined) {
  return project?.commitAsOwner?.enabled === true;
}

const defaultDeps: CommitIdentityDeps = {
  resolveToken: (userId) =>
    resolveUserGithubToken(userId, { oauthCredentials: resolveOAuthAppCredentials(config) }),
  fetchProfile: (token) => fetchUserInfo({ accessToken: token }),
  now: () => Date.now(),
};

// Keyed by a token hash, so reconnecting as a different GitHub account
// misses the cache instead of reusing the old profile.
const profileCache = new Map<string, { identity: CommitIdentity; expiresAt: number }>();

export function clearCommitIdentityCache(): void {
  profileCache.clear();
}

/**
 * The owner's GitHub commit identity, or null when they have no usable GitHub
 * token or the profile lookup fails. Never throws.
 */
export async function resolveOwnerCommitIdentity(
  userId: string,
  deps: CommitIdentityDeps = defaultDeps,
): Promise<CommitIdentity | null> {
  try {
    const token = await deps.resolveToken(userId);
    if (!token) return null;
    const cacheKey = createHash('sha256').update(token).digest('hex');
    const cached = profileCache.get(cacheKey);
    if (cached && cached.expiresAt > deps.now()) return cached.identity;
    const identity = identityFromGithubProfile(await deps.fetchProfile(token));
    profileCache.set(cacheKey, { identity, expiresAt: deps.now() + PROFILE_TTL_MS });
    return identity;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[commit-identity] Could not resolve GitHub identity for user ${userId}: ${msg}`);
    return null;
  }
}

async function gitConfigGet(cwd: string, key: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['config', '--get', key], { cwd });
    return stdout.trim();
  } catch {
    return '';
  }
}

async function gitConfigSet(cwd: string, key: string, value: string): Promise<void> {
  await execFileAsync('git', ['config', '--local', key, value], { cwd });
}

async function gitConfigUnset(cwd: string, key: string): Promise<void> {
  try {
    await execFileAsync('git', ['config', '--local', '--unset-all', key], { cwd });
  } catch {
    // Exit 5: key was not set. Nothing to remove.
  }
}

export type CommitIdentityOutcome = 'owner' | 'restored' | 'unchanged';

/**
 * Bring the worktree's commit identity in line with the project toggle.
 *
 * - Toggle on and the owner has a GitHub identity: write it and record the
 *   written values.
 * - Otherwise, for each identity key still holding the value we recorded,
 *   restore the project checkout's value (falling back to global config, the
 *   same source the worktree was seeded from). Keys changed since we wrote
 *   them are left alone. The records are dropped either way.
 * - With no record, leave the worktree alone.
 *
 * No-op when `cwd` is the project checkout itself.
 */
export async function applySessionCommitIdentity(
  args: {
    cwd: string;
    projectCwd: string;
    project: Pick<Project, 'commitAsOwner'> | null | undefined;
    ownerUserId: string | null | undefined;
  },
  deps: CommitIdentityDeps = defaultDeps,
): Promise<CommitIdentityOutcome> {
  const { cwd, projectCwd, project, ownerUserId } = args;
  // No worktree (the session fell back to the shared checkout): never write
  // one user's identity into a working copy every session shares.
  if (path.resolve(cwd) === path.resolve(projectCwd)) return 'unchanged';
  if (isCommitAsOwnerEnabled(project) && ownerUserId) {
    const identity = await resolveOwnerCommitIdentity(ownerUserId, deps);
    if (identity) {
      const values = { 'user.name': identity.name, 'user.email': identity.email };
      for (const key of IDENTITY_KEYS) {
        await gitConfigSet(cwd, key, values[key]);
        await gitConfigSet(cwd, APPLIED_IDENTITY_KEYS[key], values[key]);
      }
      return 'owner';
    }
  }

  let hadRecord = false;
  for (const key of IDENTITY_KEYS) {
    const recordKey = APPLIED_IDENTITY_KEYS[key];
    const applied = await gitConfigGet(cwd, recordKey);
    if (!applied) continue;
    hadRecord = true;
    if ((await gitConfigGet(cwd, key)) === applied) {
      const value = await gitConfigGet(projectCwd, key);
      if (value) await gitConfigSet(cwd, key, value);
      else await gitConfigUnset(cwd, key);
    }
    await gitConfigUnset(cwd, recordKey);
  }
  return hadRecord ? 'restored' : 'unchanged';
}
