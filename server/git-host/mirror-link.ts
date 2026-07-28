/**
 * mirror-link.ts — attach a GitHub mirror target to a Hub-hosted project.
 *
 * A project born on the Hub's own forge (`gitHost: 'agenthub'` with no
 * `repoUrl`) has nowhere to mirror to: `mirrorPolicy` is off until
 * `project.repoUrl` points at a GitHub repo. This module supplies the two
 * ways to get one — link a repo that already exists, or create a fresh one
 * on the caller's GitHub account / one of their orgs — plus the owner list
 * that drives the picker.
 *
 * Everything here is a thin, injectable wrapper over the GitHub REST API
 * (`fetchImpl` is the test seam). Persisting the result onto the project
 * record is the route's job, so this stays free of project I/O.
 */

import { classifyCloneUrl } from '../clone-url-auth.js';

const GITHUB_API = 'https://api.github.com';
const USER_AGENT = 'agent-hub-mirror-link/1';
const REQUEST_TIMEOUT_MS = 15_000;

/** GitHub caps repo names at 100 chars; `.`, `-`, `_` are the only punctuation. */
const REPO_NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;
/** Logins are alphanumeric with single hyphens, 39 chars max. */
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

export interface GithubOwner {
  login: string;
  type: 'user' | 'organization';
}

export interface MirrorLinkDeps {
  /** Test seam — defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

export class GithubApiError extends Error {
  constructor(
    message: string,
    /** HTTP status we want the route to surface (not always GitHub's). */
    readonly status: number,
  ) {
    super(message);
    this.name = 'GithubApiError';
  }
}

function headers(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': USER_AGENT,
  };
}

async function githubFetch(
  path: string,
  token: string,
  init: RequestInit,
  deps: MirrorLinkDeps,
): Promise<Response> {
  const doFetch = deps.fetchImpl ?? fetch;
  try {
    return await doFetch(`${GITHUB_API}${path}`, {
      ...init,
      headers: { ...headers(token), ...(init.headers as Record<string, string> | undefined) },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err: unknown) {
    throw new GithubApiError(
      `GitHub request failed: ${err instanceof Error ? err.message : String(err)}`,
      502,
    );
  }
}

/** Best-effort `message` field out of a GitHub error body. */
async function errorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { message?: string; errors?: { message?: string }[] };
    const detail = body?.errors?.find((e) => e?.message)?.message;
    return detail || body?.message || fallback;
  } catch {
    return fallback;
  }
}

export interface ParsedRepoRef {
  owner: string | null;
  repo: string;
}

/**
 * Accept what a human is likely to paste: `owner/repo`, a bare repo name
 * (owner resolved separately), or a full GitHub HTTPS/SSH clone URL.
 * Throws {@link GithubApiError} with 400 on anything else.
 */
export function parseRepoRef(raw: string): ParsedRepoRef {
  const trimmed = (raw || '').trim();
  if (!trimmed) throw new GithubApiError('A repository name is required.', 400);

  if (/^(https?:|ssh:|git@)/i.test(trimmed)) {
    const parsed = classifyCloneUrl(trimmed);
    if ((parsed.kind === 'github-https' || parsed.kind === 'github-ssh') && parsed.owner) {
      return { owner: parsed.owner, repo: parsed.repo as string };
    }
    throw new GithubApiError(
      'Only GitHub repositories can be mirrored — paste a github.com URL or owner/repo.',
      400,
    );
  }

  const parts = trimmed.replace(/\.git$/i, '').split('/');
  if (parts.length > 2) {
    throw new GithubApiError('Use the form owner/repo.', 400);
  }
  const owner = parts.length === 2 ? parts[0] : null;
  const repo = parts[parts.length - 1];
  if (owner !== null && !OWNER_RE.test(owner)) {
    throw new GithubApiError(`"${owner}" is not a valid GitHub owner.`, 400);
  }
  if (!REPO_NAME_RE.test(repo)) {
    throw new GithubApiError(
      `"${repo}" is not a valid GitHub repository name (letters, digits, ".", "-", "_").`,
      400,
    );
  }
  return { owner, repo };
}

/** Canonical mirror push target for an `owner/repo`. */
export function mirrorCloneUrl(owner: string, repo: string): string {
  return `https://github.com/${owner}/${repo}.git`;
}

/**
 * Owners the caller can create a repo under: their own login first, then
 * every org their token can see. Drives the create-repo owner picker.
 */
export async function listGithubOwners(
  token: string,
  deps: MirrorLinkDeps = {},
): Promise<GithubOwner[]> {
  const userRes = await githubFetch('/user', token, { method: 'GET' }, deps);
  if (!userRes.ok) {
    throw new GithubApiError(
      await errorMessage(userRes, 'Could not read your GitHub account.'),
      userRes.status === 401 || userRes.status === 403 ? 400 : 502,
    );
  }
  const user = (await userRes.json()) as { login?: string };
  const owners: GithubOwner[] = [];
  if (user?.login) owners.push({ login: user.login, type: 'user' });

  // Orgs are a nicety — a token without `read:org` still lets the user
  // create a repo on their own account, so a failure here is not fatal.
  try {
    const orgRes = await githubFetch('/user/orgs?per_page=100', token, { method: 'GET' }, deps);
    if (orgRes.ok) {
      const orgs = (await orgRes.json()) as { login?: string }[];
      for (const org of Array.isArray(orgs) ? orgs : []) {
        if (org?.login) owners.push({ login: org.login, type: 'organization' });
      }
    }
  } catch {
    /* ignore — own-account creation still works */
  }
  return owners;
}

export interface GithubRepoInfo {
  owner: string;
  repo: string;
  cloneUrl: string;
  defaultBranch: string | null;
  private: boolean;
  empty: boolean;
}

/** Verify a repo exists and the token can push to it. */
export async function verifyGithubRepo(
  token: string,
  owner: string,
  repo: string,
  deps: MirrorLinkDeps = {},
): Promise<GithubRepoInfo> {
  const res = await githubFetch(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
    token,
    { method: 'GET' },
    deps,
  );
  if (res.status === 404) {
    throw new GithubApiError(
      `${owner}/${repo} was not found, or your GitHub account cannot see it.`,
      404,
    );
  }
  if (!res.ok) {
    throw new GithubApiError(
      await errorMessage(res, `GitHub rejected the lookup of ${owner}/${repo}.`),
      res.status === 401 || res.status === 403 ? 403 : 502,
    );
  }
  const body = (await res.json()) as {
    name?: string;
    default_branch?: string | null;
    private?: boolean;
    size?: number;
    permissions?: { push?: boolean; admin?: boolean };
    owner?: { login?: string };
  };
  // A mirror that cannot push is worse than no mirror — it fails silently
  // on every merge. Reject at link time while the user is watching.
  if (body.permissions && !body.permissions.push && !body.permissions.admin) {
    throw new GithubApiError(
      `Your GitHub account has read-only access to ${owner}/${repo} — mirroring needs push access.`,
      403,
    );
  }
  const resolvedOwner = body.owner?.login || owner;
  const resolvedRepo = body.name || repo;
  return {
    owner: resolvedOwner,
    repo: resolvedRepo,
    cloneUrl: mirrorCloneUrl(resolvedOwner, resolvedRepo),
    defaultBranch: body.default_branch ?? null,
    private: Boolean(body.private),
    empty: body.size === 0,
  };
}

export interface CreateRepoInput {
  /** Target account; `null`/own login → the authenticated user's account. */
  owner: string | null;
  repo: string;
  private: boolean;
  description?: string;
}

/**
 * Create the mirror target on GitHub. Never passes `auto_init` — an empty
 * repo lets the first mirror push fast-forward instead of diverging
 * against a generated initial commit.
 */
export async function createGithubRepo(
  token: string,
  input: CreateRepoInput,
  deps: MirrorLinkDeps = {},
): Promise<GithubRepoInfo> {
  if (!REPO_NAME_RE.test(input.repo)) {
    throw new GithubApiError(
      `"${input.repo}" is not a valid GitHub repository name (letters, digits, ".", "-", "_").`,
      400,
    );
  }
  if (input.owner !== null && !OWNER_RE.test(input.owner)) {
    throw new GithubApiError(`"${input.owner}" is not a valid GitHub owner.`, 400);
  }

  const owners = await listGithubOwners(token, deps);
  const login = owners.find((o) => o.type === 'user')?.login ?? null;
  const target = input.owner ?? login;
  if (!target) {
    throw new GithubApiError('Could not resolve your GitHub login.', 400);
  }
  // Anything that isn't the caller's own login goes through the org
  // endpoint — including an org the token couldn't list (no `read:org`).
  const isOrg = target.toLowerCase() !== (login ?? '').toLowerCase();

  const path = isOrg ? `/orgs/${encodeURIComponent(target)}/repos` : '/user/repos';
  const res = await githubFetch(
    path,
    token,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: input.repo,
        private: input.private,
        auto_init: false,
        ...(input.description ? { description: input.description } : {}),
      }),
    },
    deps,
  );
  if (res.status === 422) {
    throw new GithubApiError(
      await errorMessage(res, `${target}/${input.repo} already exists on GitHub.`),
      409,
    );
  }
  if (res.status === 401 || res.status === 403) {
    throw new GithubApiError(
      await errorMessage(
        res,
        `Your GitHub token is not allowed to create repositories under ${target}.`,
      ),
      403,
    );
  }
  if (!res.ok) {
    throw new GithubApiError(
      await errorMessage(res, `GitHub refused to create ${target}/${input.repo}.`),
      502,
    );
  }
  const body = (await res.json()) as {
    name?: string;
    default_branch?: string | null;
    private?: boolean;
    owner?: { login?: string };
  };
  const resolvedOwner = body.owner?.login || target;
  const resolvedRepo = body.name || input.repo;
  return {
    owner: resolvedOwner,
    repo: resolvedRepo,
    cloneUrl: mirrorCloneUrl(resolvedOwner, resolvedRepo),
    defaultBranch: body.default_branch ?? null,
    private: body.private ?? input.private,
    empty: true,
  };
}
