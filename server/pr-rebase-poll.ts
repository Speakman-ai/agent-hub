/**
 * pr-rebase-poll.ts — periodic sweep that catches stale PRs that drifted
 * into a conflict / failing-CI / changes-requested state without a webhook
 * waking us up.
 *
 * Companion to `pre-push-rebase.ts` (which catches drift at the moment we
 * push). This poller is the safety net for the case the user repeatedly
 * hit: a PR sits in `Review` for hours, a sibling lands on `main`, our PR
 * goes red, and nobody knows until they eyeball the board. Webhooks
 * *should* cover this (push-to-main → mergeability re-evaluation → fan
 * out conflict autofix), but webhook delivery is best-effort and the
 * fan-out path has its own failure modes. A simple periodic recheck
 * collapses every missed-event mode into the same "we noticed within ~5
 * minutes" behaviour.
 *
 * Behaviour:
 * - Every {@link PR_REBASE_POLL_INTERVAL_MS} ms, query cards in the
 *   `Review` column with a non-null `pr_url` that haven't been touched
 *   for {@link PR_REBASE_STALE_AGE_MS}.
 * - For each, ask the injected `triggerResolve` to run the same flow the
 *   `POST /api/projects/:id/pulls/:number/resolve` route exposes (which
 *   internally calls `detectKinds` and only spawns a session when one of
 *   `conflict | ci | review` actually applies — a no-op for clean PRs).
 * - Per-PR cooldown of {@link PR_REBASE_DISPATCH_COOLDOWN_MS} prevents
 *   re-dispatching the same PR every 5 minutes while a fix session is
 *   already in flight.
 *
 * Hardcoded tunables are exported so tests and (future) runtime config
 * surfaces can read the same values.
 */
import type { BroadcastFn } from './types.js';

export const PR_REBASE_POLL_INTERVAL_MS = 5 * 60 * 1000;
export const PR_REBASE_STALE_AGE_MS = 15 * 60 * 1000;
export const PR_REBASE_DISPATCH_COOLDOWN_MS = 30 * 60 * 1000;

/** Shape of a row returned by `stmts.getStalePrCardsForRebaseCheck`. */
export interface StalePrCardRow {
  card_id: string;
  card_title: string;
  project_id: string;
  pr_url: string;
  card_updated_at: string;
  session_agent_id: string | null;
}

/**
 * Shape returned by the underlying `triggerResolve` hook. Mirrors the
 * response body of `POST /api/projects/:projectId/pulls/:number/resolve`
 * minus the full session row — we only need to know whether anything was
 * actually dispatched so we can log + broadcast appropriately.
 */
export interface TriggerResolveResult {
  /** Spawned session id, or null when nothing needed to be done. */
  sessionId: string | null;
  /** Which autofix kinds were detected (empty when PR is clean). */
  triggered: string[];
  /** Optional explanation field set by the route on `triggered === []`. */
  reason?: string;
}

export interface TriggerResolveInput {
  projectId: string;
  prNumber: number;
  agentId: string;
}

/** Minimal stmt shape so unit tests can pass plain objects (no `better-sqlite3` runtime needed). */
export interface PrRebaseStmts {
  getStalePrCardsForRebaseCheck: { all: () => unknown[] };
}

export interface PrRebasePollDeps {
  stmts: PrRebaseStmts;
  triggerResolve: (input: TriggerResolveInput) => Promise<TriggerResolveResult>;
  broadcast?: BroadcastFn;
  now?: () => number;
  log?: (msg: string) => void;
}

/** Match the `#<n>` segment in a GitHub PR URL like `…/owner/repo/pull/42`. */
const PR_URL_NUMBER_RE = /\/pull\/(\d+)\b/;

function extractPrNumber(prUrl: string): number | null {
  const m = prUrl.match(PR_URL_NUMBER_RE);
  if (!m) return null;
  const n = Number.parseInt(m[1], 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * One sweep pass. Iterates the stale-card rows, honours per-PR cooldown,
 * and asks `triggerResolve` to do the actual work for each row.
 *
 * Returns the number of `triggerResolve` calls that surfaced at least one
 * autofix kind (i.e. the number of PRs we actually nudged). Errors per
 * row are logged and the sweep continues — never lets a single row break
 * the loop.
 *
 * The cooldown map is passed in (rather than module-scoped) so callers
 * can write deterministic tests that hold state across `await` boundaries
 * and tear it down cleanly afterward.
 */
export async function runPrRebasePoll(
  deps: PrRebasePollDeps,
  cooldown: Map<string, number>,
): Promise<number> {
  const now = deps.now ? deps.now() : Date.now();
  const log = deps.log ?? ((msg: string) => console.error(msg));

  let rows: StalePrCardRow[];
  try {
    rows = deps.stmts.getStalePrCardsForRebaseCheck.all() as StalePrCardRow[];
  } catch (err: unknown) {
    log(`[pr-rebase-poll] Failed to query stale PR cards: ${(err as Error).message}`);
    return 0;
  }

  let dispatched = 0;
  for (const row of rows) {
    const lastDispatch = cooldown.get(row.pr_url);
    if (typeof lastDispatch === 'number' && now - lastDispatch < PR_REBASE_DISPATCH_COOLDOWN_MS) {
      continue;
    }
    if (!row.session_agent_id) {
      // We have no agent to assign the resolve session to. Skip rather
      // than guess — surfacing this back to the user via a card comment
      // would be repetitive every sweep; leave it for a follow-up.
      continue;
    }
    const prNumber = extractPrNumber(row.pr_url);
    if (prNumber === null) {
      log(`[pr-rebase-poll] Could not parse PR number from URL: ${row.pr_url}`);
      continue;
    }

    try {
      const result = await deps.triggerResolve({
        projectId: row.project_id,
        prNumber,
        agentId: row.session_agent_id,
      });
      // Always cool down after a successful call, even on a no-op. The
      // poller only exists to catch missed-event drift; a clean PR right
      // now will fire again on the next sweep that follows a real edit.
      cooldown.set(row.pr_url, now);
      if (result.triggered.length > 0) {
        dispatched += 1;
        log(
          `[pr-rebase-poll] Dispatched [${result.triggered.join(',')}] for ${row.pr_url} (card ${row.card_id})`,
        );
        deps.broadcast?.({
          type: 'pr_stale_autofix_dispatched',
          projectId: row.project_id,
          cardId: row.card_id,
          prUrl: row.pr_url,
          triggered: result.triggered,
          sessionId: result.sessionId,
        });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`[pr-rebase-poll] triggerResolve failed for ${row.pr_url}: ${msg}`);
    }
  }

  return dispatched;
}

/**
 * Boot the periodic sweep. Schedules the first run one interval out so
 * server startup doesn't pay for an immediate database scan + GitHub
 * round-trip on every Hub container restart.
 */
export function startPrRebasePoll(
  deps: PrRebasePollDeps,
  intervalMs: number = PR_REBASE_POLL_INTERVAL_MS,
): () => void {
  const cooldown = new Map<string, number>();
  const timer = setInterval(() => {
    runPrRebasePoll(deps, cooldown).catch((err: unknown) => {
      const log = deps.log ?? ((msg: string) => console.error(msg));
      log(`[pr-rebase-poll] sweep failed: ${(err as Error).message}`);
    });
  }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearInterval(timer);
}

export const __test = { extractPrNumber };
