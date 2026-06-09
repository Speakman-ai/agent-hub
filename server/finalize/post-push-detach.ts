/**
 * post-push-detach.ts — Finalize Code Changes, §15 post-push detach.
 *
 * Runs at the `pushed` terminal of a finalize run. Once the orchestrator
 * has pushed the branch and opened the PR on GitHub, Agent Hub's job on
 * the change is done: the developer (or downstream reviewer) owns it from
 * here. This module is the explicit hand-off point onto the kanban card:
 *
 *   1. Posts a comment that reads as "finalized, here is the PR, you own
 *      it now". For runs triggered by the autonomous dispatcher (the
 *      `agent_block` trigger source), the comment also names the trigger
 *      so a human scanning the card thread can tell at a glance whether
 *      the run was kicked off manually or by autonomous mode.
 *
 * Column moves are manual — operators move cards to Done when the PR merges.
 *
 * **Why a dedicated module.** This terminal is the single moment the
 * finalize run "leaves" Agent Hub and lives on GitHub. Keeping it in its
 * own file (rather than inline in `card-lifecycle.ts` or the orchestrator)
 * makes the wording, the order of side effects, and the autonomous-trigger
 * branch testable in isolation — and makes future changes to the handoff
 * message a one-file patch.
 *
 * **Side effects.** Posts the handoff comment only.
 *
 * **Non-throwing contract.** Every side effect is wrapped in a try/catch
 * and logged via the injected `log` sink. The orchestrator already wrote
 * the terminal `pushed` status and the `pr_url` to `finalize_runs` before
 * calling us — a missed card comment or a missed column move is cosmetic,
 * not grounds to retroactively fail a successful push.
 *
 * We do NOT dedup comments — every detach call leaves a timeline entry.
 *
 * See wiki: `finalize-code-changes-architecture-v0` (§15).
 */
import { randomUUID } from 'crypto';
import type { BroadcastFn, Stmts } from '../types.js';

// ─── Public types ────────────────────────────────────────────────────

/**
 * Trigger source of the finalize run. Mirrors
 * `OrchestratorOptions.triggerSource` so the orchestrator can pass it
 * straight through without translation.
 *
 *   - `'ui_button'` — a human clicked Finalize in the UI.
 *   - `'agent_block'` — the autonomous dispatcher fired the run.
 *
 * The comment wording adopts a small suffix for `agent_block` so the
 * card timeline records the trigger provenance in human-readable form
 * (the kanban UI does not surface `finalize_runs.trigger_source`
 * directly today, so the comment is the only place a human-in-the-loop
 * sees the difference).
 */
export type PostPushTriggerSource = 'ui_button' | 'agent_block';

export interface PostPushDetachDeps {
  stmts: Pick<Stmts, 'createKanbanCardComment'>;
  broadcast: BroadcastFn;
  /** Optional UUID minter for comment ids. Defaults to `crypto.randomUUID`. */
  newId?: () => string;
  /** Optional log sink. Defaults to `console.warn`. */
  log?: (msg: string) => void;
}

export interface PostPushDetachOpts {
  /** The kanban card the finalize run is anchored to. */
  cardId: string;
  /** The project the card belongs to (used for the `kanban_update` broadcast). */
  projectId: string;
  /** The PR URL that was just pushed to GitHub. */
  prUrl: string;
  /** The finalize run id (for the comment trailer). */
  runId: string;
  /** Trigger source of the finalize run. Drives the autonomous suffix. */
  triggerSource: PostPushTriggerSource;
  /** Author tag on the emitted comment. Defaults to `'finalize'`. */
  author?: string;
}

// ─── Pure helpers ────────────────────────────────────────────────────

/**
 * Format the post-push handoff comment.
 *
 * Pure / synchronous / no side effects — exported so tests can pin the
 * wording without standing up the surrounding deps. Body shape:
 *
 *   line 1: handoff statement (always)
 *   line 2: PR URL (always)
 *   line 3: autonomous-trigger note (only when `triggerSource === 'agent_block'`)
 *   line N: `(run <runId>)` trailer (always)
 *
 * The wording matches the §15 acceptance spec; any change here is a
 * user-visible change to the card timeline and should be reviewed by
 * whoever owns the finalize architecture doc.
 */
export function formatPostPushComment(args: {
  prUrl: string;
  runId: string;
  triggerSource: PostPushTriggerSource;
}): string {
  const lines: string[] = [
    'Finalized. PR is on GitHub, owned by the developer from here.',
    args.prUrl,
  ];
  if (args.triggerSource === 'agent_block') {
    lines.push('(triggered by autonomous agent)');
  }
  lines.push(`(run ${args.runId})`);
  return lines.join('\n');
}

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Run the §15 post-push detach for one finalize run.
 *
 * Side effects, in order:
 *
 *   1. Insert a `kanban_card_comments` row with the formatted comment
 *      and broadcast `kanban_update`.
 *
 * Wrapped in try/catch and swallows any error into
 * the `log` sink (see the JSDoc on the module for rationale). Callers
 * MUST treat this function as fire-and-forget for the orchestrator's
 * terminal contract — the `pushed` status is already persisted by the
 * time we are called.
 */
export function runPostPushDetach(deps: PostPushDetachDeps, opts: PostPushDetachOpts): void {
  const newId = deps.newId ?? randomUUID;
  const log = deps.log ?? ((msg: string) => console.warn(msg));
  const author = opts.author ?? 'finalize';

  const content = formatPostPushComment({
    prUrl: opts.prUrl,
    runId: opts.runId,
    triggerSource: opts.triggerSource,
  });

  // ── 1) post the handoff comment ────────────────────────────────────
  try {
    deps.stmts.createKanbanCardComment.run(newId(), opts.cardId, author, content);
    deps.broadcast({ type: 'kanban_update', projectId: opts.projectId });
  } catch (err) {
    log(
      `[post-push-detach] postComment failed for card=${opts.cardId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
