/**
 * run-summary.ts — emit the end-of-run Finalize briefing into the session.
 *
 * A Finalize run's timeline already records each step as it happens (rebase,
 * review round N, checks round N, ready to push), but nothing answers the three
 * questions the operator actually has in front of the Push button: what changed,
 * what did the reviewer flag, and what do I need to test by hand. This writes
 * that summary once, when the run parks at a fully validated ready-to-push.
 *
 * Best-effort by construction: the git reads, the LLM call, and the message
 * insert are each allowed to fail without affecting the run. A missing summary
 * is a missing convenience, never a failed Finalize.
 */

import type { BroadcastFn } from '../react-loop-observability.js';
import type { MessageRow, Stmts } from '../types.js';
import { collectPrCommits, collectPrDiffStat } from './branch-facts.js';
import {
  buildFinalizeRunSummaryPayload,
  collectFinalizeReviewRounds,
  renderFinalizeRunSummaryMarkdown,
} from './run-summary-data.js';
import { generateFinalizeRunSummary } from './run-summary-llm.js';
import { writeFinalizeRunSummaryTimeline } from './timeline-message.js';
import type { TimelineMessageDeps } from './timeline-message.js';

/**
 * Host-wide API key the narrative step needs.
 *
 * OpenAI only, deliberately — `AppConfig` has no host-wide Anthropic key (Claude
 * credentials are strictly per-account; see the "Why OpenAI only" note in
 * `run-summary-llm.ts`). With no key the summary still renders its deterministic
 * half.
 */
export interface FinalizeRunSummaryConfig {
  openaiApiKey?: string | null;
}

export interface EmitFinalizeRunSummaryDeps {
  stmts: Pick<Stmts, 'getMessages' | 'addMessage' | 'touchSession' | 'getMessageById'>;
  broadcast: BroadcastFn;
  log?: (msg: string) => void;
  newId?: () => string;
  /** Injected for tests — defaults to the real git readers. */
  collectCommits?: typeof collectPrCommits;
  collectDiffStat?: typeof collectPrDiffStat;
  /** Injected for tests — defaults to the real LLM call. */
  generateNarrative?: typeof generateFinalizeRunSummary;
}

export interface EmitFinalizeRunSummaryArgs {
  sessionId: string | null | undefined;
  runId: string;
  round: number;
  worktreePath: string | null | undefined;
  baseBranch: string;
  headSha?: string | null;
  card?: { title?: string | null; description?: string | null } | null;
  config?: FinalizeRunSummaryConfig | null;
  env?: NodeJS.ProcessEnv;
}

/**
 * Gather the run's facts, ask for a narrative, and write the summary message.
 * Returns the message id, or `null` when there was nothing to write (no
 * session) or any step failed. Never throws.
 */
export async function emitFinalizeRunSummary(
  deps: EmitFinalizeRunSummaryDeps,
  args: EmitFinalizeRunSummaryArgs,
): Promise<string | null> {
  const log = deps.log ?? (() => {});
  if (!args.sessionId) return null;

  try {
    const collectCommits = deps.collectCommits ?? collectPrCommits;
    const collectDiffStat = deps.collectDiffStat ?? collectPrDiffStat;
    const generateNarrative = deps.generateNarrative ?? generateFinalizeRunSummary;
    const env = args.env ?? process.env;

    // A run with no worktree (spawn failed, path never recorded) still gets a
    // review-only summary — the reviewer history is the useful half there.
    const [commits, diffStat] = args.worktreePath
      ? await Promise.all([
          collectCommits(args.worktreePath, args.baseBranch, env).catch(() => []),
          collectDiffStat(args.worktreePath, args.baseBranch, env).catch(() => ''),
        ])
      : [[], ''];

    let messages: readonly Pick<MessageRow, 'metadata'>[] = [];
    try {
      messages = deps.stmts.getMessages.all(args.sessionId) as MessageRow[];
    } catch (err) {
      log(
        `[finalize-summary] getMessages failed run=${args.runId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    const reviewRounds = collectFinalizeReviewRounds(messages, args.runId);

    // With no commits and no diff there is no change to describe, and the only
    // context left is the card — from which the model happily writes confident
    // prose about work that was never committed. That narrative then sits
    // directly above "No commits found on the branch", which reads as a broken
    // summary rather than the empty branch it actually is. Stay silent instead.
    const hasChangeToDescribe = commits.length > 0 || diffStat.length > 0;
    const narrative = hasChangeToDescribe
      ? await generateNarrative({
          cardTitle: args.card?.title ?? null,
          cardDescription: args.card?.description ?? null,
          commits,
          diffStat,
          reviewRounds,
          openaiApiKey: args.config?.openaiApiKey ?? null,
        })
      : null;

    const payload = buildFinalizeRunSummaryPayload({
      runId: args.runId,
      round: args.round,
      headSha: args.headSha ?? null,
      commits,
      diffStat,
      reviewRounds,
      narrative,
    });

    const timelineDeps: TimelineMessageDeps = {
      stmts: deps.stmts,
      broadcast: deps.broadcast,
      newId: deps.newId,
      log: deps.log,
    };
    return writeFinalizeRunSummaryTimeline(timelineDeps, {
      sessionId: args.sessionId,
      content: renderFinalizeRunSummaryMarkdown(payload),
      payload: payload as unknown as Record<string, unknown>,
    });
  } catch (err) {
    log(
      `[finalize-summary] emit failed run=${args.runId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}
