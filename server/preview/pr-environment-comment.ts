/**
 * The "environment is ready" comment on a pull request.
 *
 * Posted the first time an environment becomes ready and edited in place on
 * every later ready (a rebuild for a new head, a retry), so the PR carries one
 * comment with the current URL instead of one per build. Which comment that is
 * lives in `pr_environment_comments`.
 */
import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import type { PrEnvironmentSource } from './pr-environment-state.js';

export const PR_ENVIRONMENT_COMMENTS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS pr_environment_comments (
    project_id  TEXT NOT NULL,
    source      TEXT NOT NULL,
    pr_number   INTEGER NOT NULL,
    comment_ref TEXT NOT NULL,
    -- head sha + ready time of the build the comment describes.
    build_key   TEXT NOT NULL,
    -- ready time (epoch ms) of that build; an older build never overwrites it.
    ready_at    INTEGER NOT NULL DEFAULT 0,
    updated_at  INTEGER NOT NULL,
    PRIMARY KEY (project_id, source, pr_number)
  );
`;

/** Where the comment goes: the native PR, or a GitHub PR for GitHub-hosted projects. */
export interface PrCommentPoster {
  /** Post a new comment; returns its reference. Null when the PR cannot take one. */
  create(body: string): string | null | Promise<string | null>;
  /** Edit an existing comment. False when it no longer exists. */
  update(ref: string, body: string): boolean | Promise<boolean>;
}

export interface ReadyEnvironment {
  projectId: string;
  source: PrEnvironmentSource;
  prNumber: number;
  headSha: string;
  readyAt: string | null;
}

export function prEnvironmentCommentBody(args: {
  url: string;
  headSha: string;
  readyAt: string | null;
}): string {
  const when = args.readyAt
    ? ` at ${args.readyAt.replace('T', ' ').replace(/\.\d+Z$/, ' UTC')}`
    : '';
  return [
    '**PR environment ready**',
    '',
    args.url,
    '',
    `Built from \`${args.headSha.slice(0, 7)}\`${when}. Hub members can open it from this pull request. To give someone outside Agent Hub access, create a share link in the PR environment panel.`,
  ].join('\n');
}

export type AnnounceResult = 'created' | 'updated' | 'unchanged' | 'stale' | 'skipped';

// One queue per (database, project, source, PR). The read of the stored
// comment, the awaited post/edit, and the save must not interleave: two
// overlapping ready hooks would otherwise both see no comment and post two.
const queues = new WeakMap<Database.Database, Map<string, Promise<unknown>>>();

function serialize<T>(db: Database.Database, key: string, work: () => Promise<T>): Promise<T> {
  let perDb = queues.get(db);
  if (!perDb) {
    perDb = new Map();
    queues.set(db, perDb);
  }
  const prev = perDb.get(key) ?? Promise.resolve();
  const run = prev.then(work, work);
  const tail = run.catch(() => undefined);
  perDb.set(key, tail);
  void tail.then(() => {
    if (perDb.get(key) === tail) perDb.delete(key);
  });
  return run;
}

/**
 * Post or update the PR's environment comment. Serialized per PR, and a
 * build older than the one the comment already describes (a late hook from a
 * superseded build) never overwrites it.
 */
export function announcePrEnvironmentReady(
  db: Database.Database,
  env: ReadyEnvironment,
  url: string,
  poster: PrCommentPoster,
  now: number = Date.now(),
): Promise<AnnounceResult> {
  const key = `${env.projectId}|${env.source}|${env.prNumber}`;
  return serialize(db, key, () => announceNow(db, env, url, poster, now));
}

async function announceNow(
  db: Database.Database,
  env: ReadyEnvironment,
  url: string,
  poster: PrCommentPoster,
  now: number,
): Promise<AnnounceResult> {
  const buildKey = `${env.headSha}|${env.readyAt ?? ''}`;
  const parsed = env.readyAt ? Date.parse(env.readyAt) : NaN;
  const readyMs = Number.isFinite(parsed) ? parsed : 0;
  const existing = db
    .prepare(
      'SELECT comment_ref, build_key, ready_at FROM pr_environment_comments WHERE project_id = ? AND source = ? AND pr_number = ?',
    )
    .get(env.projectId, env.source, env.prNumber) as
    | { comment_ref: string; build_key: string; ready_at: number }
    | undefined;
  if (existing?.build_key === buildKey) return 'unchanged';
  if (existing && existing.ready_at > readyMs) return 'stale';
  const body = prEnvironmentCommentBody({ url, headSha: env.headSha, readyAt: env.readyAt });
  const save = (ref: string) =>
    db
      .prepare(
        `INSERT INTO pr_environment_comments
           (project_id, source, pr_number, comment_ref, build_key, ready_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id, source, pr_number) DO UPDATE SET
           comment_ref = excluded.comment_ref,
           build_key = excluded.build_key,
           ready_at = excluded.ready_at,
           updated_at = excluded.updated_at`,
      )
      .run(env.projectId, env.source, env.prNumber, ref, buildKey, readyMs, now);
  if (existing && (await poster.update(existing.comment_ref, body))) {
    save(existing.comment_ref);
    return 'updated';
  }
  // First ready, or the earlier comment was deleted.
  const ref = await poster.create(body);
  if (!ref) return 'skipped';
  save(ref);
  return 'created';
}

/** Author shown on the comment. */
export const PR_ENVIRONMENT_COMMENT_AUTHOR = 'Agent Hub';

/**
 * Native PR comments are `commented` reviews (the PR conversation), the same
 * shape the auto-review failure note uses. A `commented` review never carries
 * a verdict, so it does not move the review decision.
 */
export function nativePrCommentPoster(args: {
  db: Database.Database;
  projectId: string;
  prNumber: number;
  now?: () => number;
  broadcast?: (data: Record<string, unknown>) => void;
}): PrCommentPoster {
  const now = args.now ?? (() => Date.now());
  const notify = () =>
    args.broadcast?.({
      type: 'native_pr_update',
      projectId: args.projectId,
      prNumber: args.prNumber,
      action: 'reviewed',
      reviewState: 'commented',
    });
  return {
    create(body) {
      const pr = args.db
        .prepare('SELECT status FROM pull_requests WHERE project_id = ? AND number = ?')
        .get(args.projectId, args.prNumber) as { status: string } | undefined;
      if (!pr || pr.status !== 'open') return null;
      const id = uuidv4();
      args.db
        .prepare(
          `INSERT INTO pull_request_reviews (id, project_id, pr_number, reviewer, state, body, created_at)
           VALUES (?, ?, ?, ?, 'commented', ?, ?)`,
        )
        .run(id, args.projectId, args.prNumber, PR_ENVIRONMENT_COMMENT_AUTHOR, body, now());
      notify();
      return id;
    },
    update(ref, body) {
      const r = args.db
        .prepare(
          'UPDATE pull_request_reviews SET body = ? WHERE id = ? AND project_id = ? AND pr_number = ?',
        )
        .run(body, ref, args.projectId, args.prNumber);
      if (r.changes > 0) notify();
      return r.changes > 0;
    },
  };
}

const GITHUB_API = 'https://api.github.com';
const OWNER_REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

/**
 * Issue comments on a GitHub PR (a PR is an issue for comment purposes).
 * The ref is the numeric comment id. `getToken` resolves lazily so a project
 * with no usable GitHub credential just skips the comment. Token, network,
 * and non-404 API failures throw; the ready hook logs them.
 */
export function githubPrCommentPoster(args: {
  /** `owner/repo`. */
  repo: string;
  prNumber: number;
  getToken: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
}): PrCommentPoster {
  const doFetch = args.fetchImpl ?? fetch;
  const validRepo = OWNER_REPO_RE.test(args.repo);
  const call = async (method: 'POST' | 'PATCH', path: string, body: string) => {
    const token = await args.getToken();
    if (!token) return null;
    return doFetch(`${GITHUB_API}/repos/${args.repo}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        'User-Agent': 'agent-hub-pr-environment/1',
      },
      body: JSON.stringify({ body }),
      signal: AbortSignal.timeout(15_000),
    });
  };
  return {
    async create(body) {
      if (!validRepo) return null;
      const res = await call('POST', `/issues/${args.prNumber}/comments`, body);
      if (!res) return null;
      if (res.status !== 201) throw new Error(`GitHub comment create failed: HTTP ${res.status}`);
      const json = (await res.json()) as { id?: number | string };
      return json.id != null ? String(json.id) : null;
    },
    async update(ref, body) {
      if (!validRepo || !/^\d+$/.test(ref)) return false;
      const res = await call('PATCH', `/issues/comments/${ref}`, body);
      if (!res || res.status === 404) return false;
      if (!res.ok) throw new Error(`GitHub comment update failed: HTTP ${res.status}`);
      return true;
    },
  };
}

/**
 * The poster for a project: native PR conversation for Agent Hub-hosted
 * projects, GitHub issue comments for GitHub-hosted ones (needs `githubRepo`).
 */
export function prCommentPosterFor(args: {
  hubHosted: boolean;
  githubRepo: string | null | undefined;
  native: () => PrCommentPoster;
  github: (repo: string) => PrCommentPoster;
}): PrCommentPoster | null {
  if (args.hubHosted) return args.native();
  const repo = args.githubRepo?.trim();
  return repo ? args.github(repo) : null;
}

/**
 * The environment service's `onReady` hook: post or update the PR comment
 * with the public URL. Nothing is posted without wildcard ingress (a direct
 * upstream address means nothing to anyone reading the PR).
 */
export function createPrEnvironmentReadyHandler(deps: {
  db: Database.Database;
  getBase: () => string | null | undefined;
  getPublicUrl: () => string | null | undefined;
  /** Agent Hub-hosted project (native PR conversation) vs GitHub-hosted. */
  isHubHosted: (project: { gitHost?: string | null }) => boolean;
  broadcast?: (data: Record<string, unknown>) => void;
  getGithubToken: (repo: string) => Promise<string | null>;
  fetchImpl?: typeof fetch;
  buildUrl: (
    prNumber: number,
    projectId: string,
    base: string | null | undefined,
    publicUrl: string | null | undefined,
  ) => string | null;
}): (
  project: { id: string; gitHost?: string | null; githubRepo?: string | null },
  env: ReadyEnvironment,
) => Promise<AnnounceResult | null> {
  return async (project, env) => {
    const url = deps.buildUrl(env.prNumber, env.projectId, deps.getBase(), deps.getPublicUrl());
    if (!url) return null;
    const poster = prCommentPosterFor({
      hubHosted: deps.isHubHosted(project),
      githubRepo: project.githubRepo,
      native: () =>
        nativePrCommentPoster({
          db: deps.db,
          projectId: project.id,
          prNumber: env.prNumber,
          broadcast: deps.broadcast,
        }),
      github: (repo) =>
        githubPrCommentPoster({
          repo,
          prNumber: env.prNumber,
          getToken: () => deps.getGithubToken(repo),
          fetchImpl: deps.fetchImpl,
        }),
    });
    if (!poster) return null;
    return announcePrEnvironmentReady(deps.db, env, url, poster);
  };
}
