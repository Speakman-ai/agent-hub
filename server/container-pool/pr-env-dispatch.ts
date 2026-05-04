/**
 * Webhook → PR-env builder glue (W2).
 *
 * Sits between the GitHub webhook router and the PR-env builder so the
 * route file stays free of Docker/fs concerns. Three entry points:
 *
 *   dispatchPrEnvBuild   — pull_request.opened / pull_request.synchronize
 *   dispatchPrEnvTeardown — pull_request.closed (merged OR closed)
 *   notifyPrEnvComment    — post the preview URL back as a card comment
 *
 * All three are fire-and-forget from the webhook's perspective: failures
 * log + append a dispatch-failure comment to the linked card but never
 * throw back into the HTTP handler. GitHub will retry with its own
 * backoff if the 200 never comes back, which we don't want here — the
 * build may well have succeeded and a retry would duplicate the compose
 * project.
 */

import { v4 as uuidv4 } from 'uuid';
import type Database from 'better-sqlite3';
import type { Stmts, KanbanCardRow, PrEnvProjectConfig } from '../types.js';
import {
  buildPrEnv,
  teardownPrEnv,
  type PrEnvBuilderDeps,
  type PrEnvBuildResult,
  type PrEnvGithubCreds,
} from './pr-env-builder.js';
import { PortPoolExhaustedError } from './port-pool.js';
import { githubApiRequest } from '../github-app.js';
import {
  buildStickyCommentBody,
  upsertPrStickyComment,
  type GitHubApiClient,
  type PrStickyCommentPayload,
} from './pr-sticky-comment.js';

/**
 * Per-PR build serialization. Two rapid synchronize events for the same PR
 * must not race — the second waits for the first to finish before starting.
 * Keyed by `${repoFullName}#${prNumber}`.
 */
const inflightBuilds = new Map<string, Promise<PrEnvBuildResult | null>>();

/**
 * Per-project tracker of which (repo, pr) pairs currently have in-flight
 * builds. Drives the concurrency cap: a runaway repo (e.g. mass PR
 * rebase) can't starve every other project of host resources by
 * spinning up dozens of containers in parallel. Synchronize events for
 * an already-in-flight PR don't count again — they chain onto the
 * existing entry via `inflightBuilds`.
 */
const inflightByProject = new Map<string, Set<string>>();

/** Default cap; overridable via deps for tests. */
const DEFAULT_MAX_CONCURRENT_BUILDS_PER_PROJECT = 10;

function buildKey(repo: string, pr: number): string {
  return `${repo}#${pr}`;
}

/**
 * Thrown (and caught internally) when a project has already reached its
 * concurrent-build cap. Surfaced via the sticky comment + card-comment
 * paths so the user sees a clear "try again after current builds finish"
 * message instead of a generic failure.
 */
export class PrEnvConcurrencyCapError extends Error {
  constructor(
    public readonly projectSlug: string,
    public readonly cap: number,
    public readonly inFlight: number,
  ) {
    super(
      `PR-env concurrency cap reached for project "${projectSlug}": ` +
        `${inFlight}/${cap} builds in flight. Wait for an in-flight build to ` +
        `finish, then push again to retry.`,
    );
    this.name = 'PrEnvConcurrencyCapError';
  }
}

/**
 * Test hook — clears in-flight tracking maps so vitest suites that
 * dispatch builds in isolation don't leak state between cases. Not
 * called from production code paths.
 */
export function __resetPrEnvDispatchInflightForTests(): void {
  inflightBuilds.clear();
  inflightByProject.clear();
}

export interface PrEnvProjectResolution {
  config: PrEnvProjectConfig;
  /** Filesystem-safe project slug used to namespace checkouts/containers. */
  slug: string;
}

export interface PrEnvDispatchDeps {
  db: Database.Database;
  stmts: Stmts;
  /**
   * Lazy accessor for the builder deps. Returns null when the feature
   * flag is off, in which case dispatch becomes a silent no-op.
   */
  getBuilderDeps: () => PrEnvBuilderDeps | null;
  /**
   * Resolve the per-project PR-env config + slug for a given repo full
   * name. Returns null when no Project is linked to the repo or when
   * the project's `prEnv` slot is missing/disabled — dispatch becomes a
   * silent no-op in that case.
   */
  getProjectConfig: (repoFullName: string) => PrEnvProjectResolution | null;
  /**
   * Override the GitHub API client used to upsert the sticky PR
   * comment. Production wiring is unset → uses the real installation
   * token via `githubApiRequest`. Tests inject a fake to assert on the
   * outbound calls without hitting the network.
   */
  githubApiClientFactory?: (creds: PrEnvGithubCreds) => GitHubApiClient;
  /**
   * Maximum simultaneous in-flight builds for a single project. New
   * builds beyond this cap are rejected with `PrEnvConcurrencyCapError`
   * and surface via the sticky-comment / card-comment failure path.
   * Defaults to {@link DEFAULT_MAX_CONCURRENT_BUILDS_PER_PROJECT}.
   */
  maxConcurrentBuildsPerProject?: number;
}

/**
 * Kick off a PR-env build for opened/synchronize events. Returns the
 * build result on success so the caller can surface the preview URL,
 * or null on failure / disabled.
 */
export async function dispatchPrEnvBuild(
  deps: PrEnvDispatchDeps,
  request: {
    repoFullName: string;
    prNumber: number;
    branch: string;
    commitSha?: string;
    /** Linked kanban card, if any — used to post the preview URL back. */
    card?: KanbanCardRow | null;
  },
): Promise<PrEnvBuildResult | null> {
  const builder = deps.getBuilderDeps();
  if (!builder) {
    console.log(
      `[pr-env] build skipped for ${request.repoFullName}#${request.prNumber} — feature disabled`,
    );
    return null;
  }

  const project = deps.getProjectConfig(request.repoFullName);
  if (!project || !project.config.enabled) {
    console.log(
      `[pr-env] build skipped for ${request.repoFullName}#${request.prNumber} — project not configured or disabled`,
    );
    return null;
  }

  // Per-project concurrency cap. Synchronize events for an already
  // in-flight PR chain onto the existing entry and don't count toward
  // the cap; only *new* PR builds for the project consume a slot.
  const key = buildKey(request.repoFullName, request.prNumber);
  const cap = deps.maxConcurrentBuildsPerProject ?? DEFAULT_MAX_CONCURRENT_BUILDS_PER_PROJECT;
  let projectSet = inflightByProject.get(project.slug);
  const isNewBuild = !projectSet?.has(key);
  if (isNewBuild && (projectSet?.size ?? 0) >= cap) {
    const inFlight = projectSet?.size ?? 0;
    const err = new PrEnvConcurrencyCapError(project.slug, cap, inFlight);
    console.warn(
      `[pr-env] build rejected for ${request.repoFullName}#${request.prNumber}: ${err.message}`,
    );
    if (request.card) {
      notifyPrEnvComment(deps.stmts, request.card, { kind: 'failed', reason: err.message });
    }
    await notifyPrStickyComment(deps, builder, request.repoFullName, request.prNumber, {
      kind: 'failed',
      reason: err.message,
    });
    return null;
  }
  if (!projectSet) {
    projectSet = new Set();
    inflightByProject.set(project.slug, projectSet);
  }
  projectSet.add(key);

  // Serialize builds for the same PR — two rapid synchronize events must
  // not race on the same checkout dir / container.
  const prev = inflightBuilds.get(key) ?? Promise.resolve(null);
  const next = prev
    .catch(() => null) // don't let a prior failure block the next build
    .then(() => doPrEnvBuild(deps, builder, project, request));
  inflightBuilds.set(key, next);
  try {
    return await next;
  } finally {
    // Clean up if we're still the latest in the chain.
    if (inflightBuilds.get(key) === next) {
      inflightBuilds.delete(key);
      projectSet.delete(key);
      if (projectSet.size === 0) inflightByProject.delete(project.slug);
    }
  }
}

async function doPrEnvBuild(
  deps: PrEnvDispatchDeps,
  builder: PrEnvBuilderDeps,
  project: PrEnvProjectResolution,
  request: {
    repoFullName: string;
    prNumber: number;
    branch: string;
    commitSha?: string;
    card?: KanbanCardRow | null;
  },
): Promise<PrEnvBuildResult | null> {
  try {
    const result = await buildPrEnv(builder, {
      repoFullName: request.repoFullName,
      prNumber: request.prNumber,
      branch: request.branch,
      commitSha: request.commitSha,
      projectConfig: project.config,
      projectSlug: project.slug,
    });
    console.log(
      `[pr-env] built ${request.repoFullName}#${request.prNumber} → ${result.previewUrl} (port ${result.port})`,
    );
    if (request.card) {
      notifyPrEnvComment(deps.stmts, request.card, {
        kind: 'ready',
        previewUrl: result.previewUrl,
        port: result.port,
      });
    }
    await notifyPrStickyComment(deps, builder, request.repoFullName, request.prNumber, {
      kind: 'ready',
      previewUrl: result.previewUrl,
      port: result.port,
      commitSha: request.commitSha,
    });
    return result;
  } catch (err) {
    const message = classifyDispatchError(err);
    console.error(
      `[pr-env] build failed for ${request.repoFullName}#${request.prNumber}: ${message}`,
      err,
    );
    if (request.card) {
      notifyPrEnvComment(deps.stmts, request.card, { kind: 'failed', reason: message });
    }
    await notifyPrStickyComment(deps, builder, request.repoFullName, request.prNumber, {
      kind: 'failed',
      reason: message,
    });
    return null;
  }
}

/**
 * Tear down the PR env when the PR closes or merges. Idempotent — a
 * replayed webhook just finds the resources already gone.
 */
export async function dispatchPrEnvTeardown(
  deps: PrEnvDispatchDeps,
  request: {
    repoFullName: string;
    prNumber: number;
    card?: KanbanCardRow | null;
  },
): Promise<void> {
  const builder = deps.getBuilderDeps();
  if (!builder) return;
  const project = deps.getProjectConfig(request.repoFullName);
  if (!project) {
    // No project linkage → nothing to tear down (and we don't know the
    // slug used at build time). Replayed webhook for a deleted project
    // — silent no-op.
    return;
  }
  try {
    await teardownPrEnv(builder, {
      repoFullName: request.repoFullName,
      prNumber: request.prNumber,
      projectSlug: project.slug,
    });
    console.log(`[pr-env] torn down ${request.repoFullName}#${request.prNumber}`);
    if (request.card) {
      notifyPrEnvComment(deps.stmts, request.card, { kind: 'torndown' });
    }
    await notifyPrStickyComment(deps, builder, request.repoFullName, request.prNumber, {
      kind: 'torndown',
    });
  } catch (err) {
    console.warn(`[pr-env] teardown failed for ${request.repoFullName}#${request.prNumber}`, err);
  }
}

type CommentPayload =
  | { kind: 'ready'; previewUrl: string; port: number }
  | { kind: 'torndown' }
  | { kind: 'failed'; reason: string };

export function notifyPrEnvComment(
  stmts: Stmts,
  card: KanbanCardRow,
  payload: CommentPayload,
): void {
  let body = '';
  switch (payload.kind) {
    case 'ready':
      body =
        `🚀 **Preview env ready**\n\n` +
        `URL: ${payload.previewUrl}\n` +
        `Port: \`${payload.port}\`\n\n` +
        `Rebuilt automatically on every \`pull_request.synchronize\` event.`;
      break;
    case 'torndown':
      body = `🧹 **Preview env torn down** — PR closed/merged; port released.`;
      break;
    case 'failed':
      body = `⚠️ **Preview env build failed**\n\n${payload.reason}`;
      break;
  }
  try {
    stmts.createKanbanCardComment.run(uuidv4(), card.id, 'system', body);
  } catch (err) {
    console.warn('[pr-env] failed to post card comment', err);
  }
}

function classifyDispatchError(err: unknown): string {
  if (err instanceof PortPoolExhaustedError) {
    return `Port pool exhausted (range ${err.range.min}..${err.range.max}, ${err.allocatedCount} in use).`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Default production-shaped GitHub API client backed by the Reviewer
 * App's installation token. Each call refreshes the token (cached
 * internally by `getInstallationToken`) and signs the request.
 */
function defaultGithubApiClient(creds: PrEnvGithubCreds): GitHubApiClient {
  return {
    async get(path) {
      return githubApiRequest(path, {
        method: 'GET',
        appId: creds.appId,
        privateKey: creds.privateKey,
        installationId: creds.installationId,
      });
    },
    async post(path, body) {
      return githubApiRequest(path, {
        method: 'POST',
        body: body as Record<string, unknown>,
        appId: creds.appId,
        privateKey: creds.privateKey,
        installationId: creds.installationId,
      });
    },
    async patch(path, body) {
      return githubApiRequest(path, {
        method: 'PATCH',
        body: body as Record<string, unknown>,
        appId: creds.appId,
        privateKey: creds.privateKey,
        installationId: creds.installationId,
      });
    },
  };
}

/**
 * Post (or edit) the sticky preview-env comment on the GitHub PR
 * itself. Best-effort: any error is logged and swallowed so a transient
 * GitHub API blip doesn't take down the build path. The kanban-card
 * comment posted by `notifyPrEnvComment` is a separate, internal
 * surface and is unaffected by failures here.
 *
 * Skipped silently when GitHub App creds aren't configured (e.g. in
 * tests or single-user dev installs without the Reviewer App
 * installed).
 */
export async function notifyPrStickyComment(
  deps: PrEnvDispatchDeps,
  builder: PrEnvBuilderDeps,
  repoFullName: string,
  prNumber: number,
  payload: PrStickyCommentPayload,
): Promise<void> {
  const creds = builder.github;
  if (!creds || !creds.appId || !creds.installationId || !creds.privateKey) {
    return;
  }
  const [owner, repo] = repoFullName.split('/');
  if (!owner || !repo) {
    console.warn(`[pr-env] sticky-comment: malformed repoFullName "${repoFullName}"`);
    return;
  }
  const factory = deps.githubApiClientFactory ?? defaultGithubApiClient;
  const client = factory(creds);
  try {
    await upsertPrStickyComment(client, {
      owner,
      repo,
      prNumber,
      body: buildStickyCommentBody(payload),
    });
  } catch (err) {
    console.warn(
      `[pr-env] sticky-comment upsert failed for ${repoFullName}#${prNumber}:`,
      err instanceof Error ? err.message : err,
    );
  }
}
