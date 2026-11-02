/**
 * Per-project session history for the Stats page.
 *
 * One row per recent work session (a session with a linked card, a PR, or at
 * least one Finalize run) with:
 *
 *   - card          → kanban_cards.session_id (+ board card_prefix for "AH-123")
 *   - pr            → native PR whose head_branch is the session branch, else the
 *                     newest finalize_runs.pr_url, else the card's pr_url
 *   - review rounds → in-hub Finalize review rounds (`finalize_review_round`
 *                     timeline messages, distinct runId:round) plus formal
 *                     reviews left on the native PR
 *   - ci rounds     → distinct (run, round) pairs in finalize_run_job_attempts,
 *                     i.e. how many times CI actually executed for the session
 *
 * Sessions carry no project column, so scoping goes through the project's
 * current agent roster (same caveat as model usage in project-stats.ts).
 */

import type BetterSqlite3 from 'better-sqlite3';
import { parseFinalizeTimelineMetadata } from './finalize/timeline-message.js';
import { parseNativePrUrl } from './native-pr/url.js';

export const SESSION_HISTORY_DEFAULT_LIMIT = 25;
export const SESSION_HISTORY_MAX_LIMIT = 100;

export interface SessionHistoryCard {
  id: string;
  short_id: number | null;
  card_prefix: string | null;
  title: string;
}

export interface SessionHistoryPr {
  /** Native PR number in this project; null for external or other-project URLs. */
  number: number | null;
  url: string;
  title: string | null;
  /** open | merged | closed for native PRs; null when unknown. */
  status: string | null;
}

export interface SessionHistoryRow {
  session_id: string;
  agent_id: string;
  title: string;
  created_at: string;
  updated_at: string;
  card: SessionHistoryCard | null;
  pr: SessionHistoryPr | null;
  review_rounds: number;
  finalize_review_rounds: number;
  pr_reviews: number;
  ci_rounds: number;
}

export function normalizeSessionHistoryLimit(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return SESSION_HISTORY_DEFAULT_LIMIT;
  const n = Math.floor(requested);
  if (n < 1) return 1;
  return Math.min(n, SESSION_HISTORY_MAX_LIMIT);
}

type SessionRow = {
  id: string;
  agent_id: string;
  name: string;
  created_at: string;
  updated_at: string;
  worktree_branch: string | null;
};

export function computeSessionHistory(
  db: BetterSqlite3.Database,
  opts: { projectId: string; agentIds: string[]; limit: number },
): SessionHistoryRow[] {
  const { projectId, agentIds, limit } = opts;
  if (agentIds.length === 0) return [];
  const agentPh = agentIds.map(() => '?').join(', ');

  const sessions = db
    .prepare(
      `SELECT s.id, s.agent_id, s.name, s.created_at, s.updated_at, s.worktree_branch
         FROM sessions s
        WHERE s.agent_id IN (${agentPh})
          AND s.deleted_at IS NULL
          AND (
            EXISTS (SELECT 1 FROM kanban_cards c WHERE c.session_id = s.id)
            OR EXISTS (SELECT 1 FROM finalize_runs f WHERE f.session_id = s.id)
            OR (s.worktree_branch IS NOT NULL AND EXISTS (
                  SELECT 1 FROM pull_requests p
                   WHERE p.project_id = ? AND p.head_branch = s.worktree_branch))
          )
        ORDER BY s.updated_at DESC, s.id DESC
        LIMIT ?`,
    )
    .all(...agentIds, projectId, limit) as SessionRow[];
  if (sessions.length === 0) return [];

  const ids = sessions.map((s) => s.id);
  const idPh = ids.map(() => '?').join(', ');

  const cards = db
    .prepare(
      `SELECT c.id, c.session_id, c.short_id, c.title, c.pr_url, b.card_prefix
         FROM kanban_cards c
         JOIN kanban_boards b ON b.id = c.board_id
        WHERE c.session_id IN (${idPh})
        ORDER BY c.created_at ASC`,
    )
    .all(...ids) as Array<{
    id: string;
    session_id: string;
    short_id: number | null;
    title: string;
    pr_url: string | null;
    card_prefix: string | null;
  }>;
  const cardBySession = new Map<string, (typeof cards)[number]>();
  for (const c of cards) if (!cardBySession.has(c.session_id)) cardBySession.set(c.session_id, c);

  const finalizePrs = db
    .prepare(
      `SELECT session_id, pr_url FROM finalize_runs
        WHERE session_id IN (${idPh}) AND pr_url IS NOT NULL AND pr_url != ''
        ORDER BY started_at DESC`,
    )
    .all(...ids) as Array<{ session_id: string; pr_url: string }>;
  const finalizePrBySession = new Map<string, string>();
  for (const r of finalizePrs) {
    if (!finalizePrBySession.has(r.session_id)) finalizePrBySession.set(r.session_id, r.pr_url);
  }

  const prByNumber = db.prepare(
    'SELECT number, title, status FROM pull_requests WHERE project_id = ? AND number = ?',
  );
  const prByBranch = db.prepare(
    `SELECT number, title, status FROM pull_requests
      WHERE project_id = ? AND head_branch = ? ORDER BY number DESC LIMIT 1`,
  );
  type PrLookup = { number: number; title: string; status: string } | undefined;

  const ciRows = db
    .prepare(
      `SELECT f.session_id AS session_id, COUNT(DISTINCT a.run_id || ':' || a.round) AS n
         FROM finalize_run_job_attempts a
         JOIN finalize_runs f ON f.id = a.run_id
        WHERE f.session_id IN (${idPh})
        GROUP BY f.session_id`,
    )
    .all(...ids) as Array<{ session_id: string; n: number }>;
  const ciBySession = new Map(ciRows.map((r) => [r.session_id, r.n]));

  // LIKE pre-filter keeps the JSON parse to the handful of timeline rows.
  const reviewMsgs = db
    .prepare(
      `SELECT session_id, metadata FROM messages
        WHERE session_id IN (${idPh}) AND metadata LIKE '%finalize_review_round%'`,
    )
    .all(...ids) as Array<{ session_id: string; metadata: string | null }>;
  const reviewKeys = new Map<string, Set<string>>();
  for (const m of reviewMsgs) {
    const parsed = parseFinalizeTimelineMetadata(m.metadata);
    if (!parsed || parsed.kind !== 'finalize_review_round') continue;
    const runId = parsed.payload.runId ?? parsed.payload.run_id;
    const round = parsed.payload.round;
    const key = `${typeof runId === 'string' ? runId : ''}:${String(round ?? '')}`;
    let set = reviewKeys.get(m.session_id);
    if (!set) reviewKeys.set(m.session_id, (set = new Set()));
    set.add(key);
  }

  const prReviewCount = db.prepare(
    'SELECT COUNT(*) AS n FROM pull_request_reviews WHERE project_id = ? AND pr_number = ?',
  );

  return sessions.map((s) => {
    const card = cardBySession.get(s.id) ?? null;

    let pr: SessionHistoryPr | null = null;
    const branchPr = s.worktree_branch
      ? (prByBranch.get(projectId, s.worktree_branch) as PrLookup)
      : undefined;
    if (branchPr) {
      pr = {
        number: branchPr.number,
        url: `/projects/${projectId}/pulls/${branchPr.number}`,
        title: branchPr.title,
        status: branchPr.status,
      };
    } else {
      const url = finalizePrBySession.get(s.id) ?? card?.pr_url ?? null;
      if (url) {
        const parsed = parseNativePrUrl(url);
        // A native link into another project must not surface its number: the
        // client routes numbers against the current project.
        const native = parsed && parsed.projectId === projectId ? parsed : null;
        const row = native ? (prByNumber.get(projectId, native.number) as PrLookup) : undefined;
        pr = {
          number: native?.number ?? null,
          url,
          title: row?.title ?? null,
          status: row?.status ?? null,
        };
      }
    }

    // status is only set when the PR resolved to a native row in this project.
    const prReviews =
      pr?.number != null && pr.status !== null
        ? (prReviewCount.get(projectId, pr.number) as { n: number }).n
        : 0;
    const finalizeReviews = reviewKeys.get(s.id)?.size ?? 0;

    return {
      session_id: s.id,
      agent_id: s.agent_id,
      title: s.name,
      created_at: s.created_at,
      updated_at: s.updated_at,
      card: card
        ? {
            id: card.id,
            short_id: card.short_id,
            card_prefix: card.card_prefix,
            title: card.title,
          }
        : null,
      pr,
      review_rounds: finalizeReviews + prReviews,
      finalize_review_rounds: finalizeReviews,
      pr_reviews: prReviews,
      ci_rounds: ciBySession.get(s.id) ?? 0,
    };
  });
}
