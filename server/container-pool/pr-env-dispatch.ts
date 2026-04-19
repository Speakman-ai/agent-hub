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
import type { Stmts, KanbanCardRow } from '../types.js';
import {
  buildPrEnv,
  teardownPrEnv,
  type PrEnvBuilderDeps,
  type PrEnvBuildResult,
} from './pr-env-builder.js';
import { PortPoolExhaustedError } from './port-pool.js';
import { EnvTemplateError } from './env-template.js';

/**
 * Per-PR build serialization. Two rapid synchronize events for the same PR
 * must not race — the second waits for the first to finish before starting.
 * Keyed by `${repoFullName}#${prNumber}`.
 */
const inflightBuilds = new Map<string, Promise<PrEnvBuildResult | null>>();

function buildKey(repo: string, pr: number): string {
  return `${repo}#${pr}`;
}

export interface PrEnvDispatchDeps {
  db: Database.Database;
  stmts: Stmts;
  /**
   * Lazy accessor for the builder deps. Returns null when the feature
   * flag is off, in which case dispatch becomes a silent no-op.
   */
  getBuilderDeps: () => PrEnvBuilderDeps | null;
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

  // Serialize builds for the same PR — two rapid synchronize events must
  // not race on the same env file / compose project.
  const key = buildKey(request.repoFullName, request.prNumber);
  const prev = inflightBuilds.get(key) ?? Promise.resolve(null);
  const next = prev
    .catch(() => null) // don't let a prior failure block the next build
    .then(() => doPrEnvBuild(deps, builder, request));
  inflightBuilds.set(key, next);
  try {
    return await next;
  } finally {
    // Clean up if we're still the latest in the chain.
    if (inflightBuilds.get(key) === next) inflightBuilds.delete(key);
  }
}

async function doPrEnvBuild(
  deps: PrEnvDispatchDeps,
  builder: PrEnvBuilderDeps,
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
  try {
    await teardownPrEnv(builder, {
      repoFullName: request.repoFullName,
      prNumber: request.prNumber,
    });
    console.log(`[pr-env] torn down ${request.repoFullName}#${request.prNumber}`);
    if (request.card) {
      notifyPrEnvComment(deps.stmts, request.card, { kind: 'torndown' });
    }
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
  if (err instanceof EnvTemplateError) {
    return `.env.preview missing required fields: ${err.missing.join(', ')}.`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
