/**
 * Append-only Finalize timeline messages into the session chat.
 *
 * Each fix-loop iteration writes durable system messages so review + CI
 * history survives thread deletion and step upserts.
 */
import { randomUUID } from 'crypto';
import type { FinalizeRunRow, MessageRow, Stmts } from '../types.js';
import type { BroadcastFn } from '../react-loop-observability.js';

export const FINALIZE_TIMELINE_KINDS = [
  'finalize_run_started',
  'finalize_rebase_result',
  'finalize_review_round',
  'finalize_ci_absent',
  'finalize_checks_round',
  'finalize_flake_recovered',
  'finalize_ready_to_push',
  'finalize_run_summary',
  'finalize_run_terminal',
  // The reviewer step could not complete for an infra reason (engine timeout /
  // quota / auth exhaustion) — parked as `review_stalled`, NOT a code problem.
  'finalize_review_stalled',
  // The review loop was escalated to a human after N consecutive
  // `changes_requested` rounds (non-convergence) instead of grinding the budget.
  'finalize_review_not_converging',
] as const;

export type FinalizeTimelineKind = (typeof FINALIZE_TIMELINE_KINDS)[number];

export interface TimelineMessageDeps {
  stmts: Pick<Stmts, 'addMessage' | 'touchSession' | 'getMessageById'>;
  broadcast: BroadcastFn;
  newId?: () => string;
  log?: (msg: string) => void;
}

export interface ReviewRoundThreadSnapshot {
  id: string;
  file_path: string;
  line_start: number | null;
  line_end: number | null;
  body: string;
}

export interface ChecksRoundStepSnapshot {
  index: number;
  name: string;
  state: string;
  exitCode: number | null;
  startedAt: number | null;
  endedAt: number | null;
}

function parseMetadata(raw: string | null | undefined): Record<string, unknown> | null {
  if (raw == null) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Best-effort read of `loop_round` from a finalize run row. */
export function readFinalizeLoopRound(
  row: Pick<FinalizeRunRow, 'loop_round'> | null | undefined,
): number {
  const round = row?.loop_round;
  return typeof round === 'number' && Number.isFinite(round) && round > 0 ? round : 0;
}

/**
 * Insert a system message and broadcast `{ type: 'message' }`.
 * Returns the message id, or null when sessionId is missing / insert fails.
 */
export function writeFinalizeTimelineMessage(
  deps: TimelineMessageDeps,
  args: {
    sessionId: string | null | undefined;
    kind: FinalizeTimelineKind;
    content: string;
    payload: Record<string, unknown>;
  },
): string | null {
  if (!args.sessionId) return null;

  const newId = deps.newId ?? (() => randomUUID());
  const log = deps.log ?? (() => {});
  const messageId = newId();
  const metadata = JSON.stringify({ kind: args.kind, ...args.payload });

  try {
    deps.stmts.addMessage.run(
      messageId,
      args.sessionId,
      'system',
      args.content,
      null,
      null,
      null,
      metadata,
      null,
      null,
      null,
    );
  } catch (err) {
    log(
      `[finalize-timeline] addMessage failed session=${args.sessionId} kind=${args.kind}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }

  try {
    deps.stmts.touchSession.run(args.sessionId);
  } catch {
    /* best-effort */
  }

  try {
    const inserted = deps.stmts.getMessageById.get(messageId) as MessageRow | undefined;
    if (inserted) {
      deps.broadcast({ type: 'message', sessionId: args.sessionId, message: inserted });
    }
  } catch (err) {
    log(
      `[finalize-timeline] broadcast failed session=${args.sessionId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  return messageId;
}

export function writeFinalizeRunStartedTimeline(
  deps: TimelineMessageDeps,
  args: {
    sessionId: string | null | undefined;
    runId: string;
    triggerSource: string;
    headSha: string;
  },
): string | null {
  return writeFinalizeTimelineMessage(deps, {
    sessionId: args.sessionId,
    kind: 'finalize_run_started',
    content: 'Finalize run started',
    payload: {
      runId: args.runId,
      triggerSource: args.triggerSource,
      headSha: args.headSha,
      round: 0,
    },
  });
}

/**
 * Why a fix-loop round re-entered rebase without any code change from the
 * session. Surfaced so a user watching Finalize does not read a fresh
 * rebase/review/checks round as unexplained churn:
 *   - `base_branch_moved` — the base branch advanced onto ground this branch
 *     also touches while review + checks ran, so the prior signals are stale.
 *   - `head_sha_moved` — a new commit landed on the feature branch between the
 *     post-rebase snapshot and the push gate, so we re-validate the new HEAD.
 */
export type FinalizeRebaseReloopReason = 'base_branch_moved' | 'head_sha_moved';

function reloopReasonText(reason: FinalizeRebaseReloopReason): string {
  return reason === 'base_branch_moved'
    ? 're-validating after the base branch advanced'
    : 're-validating after a new commit landed';
}

export function writeFinalizeRebaseResultTimeline(
  deps: TimelineMessageDeps,
  args: {
    sessionId: string | null | undefined;
    runId: string;
    round: number;
    ok: boolean;
    conflict?: boolean;
    headSha?: string | null;
    detail?: string | null;
    /**
     * Set when this round was triggered by a push-gate re-loop rather than a
     * reviewer/checks fix. Annotates the message so the user sees why a fresh
     * round appeared even though nothing they did changed.
     */
    reloopReason?: FinalizeRebaseReloopReason | null;
  },
): string | null {
  const label = args.ok
    ? args.conflict
      ? 'Rebase completed (conflicts resolved)'
      : 'Rebase completed'
    : 'Rebase failed';
  const roundLabel = args.round > 0 ? `${label} · round ${args.round}` : label;
  const content = args.reloopReason
    ? `${roundLabel} · ${reloopReasonText(args.reloopReason)}`
    : roundLabel;
  return writeFinalizeTimelineMessage(deps, {
    sessionId: args.sessionId,
    kind: 'finalize_rebase_result',
    content,
    payload: {
      runId: args.runId,
      round: args.round,
      ok: args.ok,
      conflict: Boolean(args.conflict),
      headSha: args.headSha ?? null,
      detail: args.detail ?? null,
      reloopReason: args.reloopReason ?? null,
    },
  });
}

export function writeFinalizeReviewRoundTimeline(
  deps: TimelineMessageDeps,
  args: {
    sessionId: string | null | undefined;
    runId: string;
    round: number;
    verdict: string;
    threads: ReviewRoundThreadSnapshot[];
  },
): string | null {
  const verdictLabel = args.verdict === 'approved' ? 'approved' : 'changes requested';
  return writeFinalizeTimelineMessage(deps, {
    sessionId: args.sessionId,
    kind: 'finalize_review_round',
    content: `Review · round ${args.round} · ${verdictLabel}`,
    payload: {
      runId: args.runId,
      round: args.round,
      verdict: args.verdict,
      threads: args.threads,
    },
  });
}

/**
 * The run found no CI config (no committed `.agent-hub/ci.yaml`, no
 * server-stored one) and is proceeding checks-free. Written once per round so
 * an operator who deleted a working config sees why nothing ran, rather than
 * reading a green run as "the tests passed".
 */
export function writeFinalizeCiAbsentTimeline(
  deps: TimelineMessageDeps,
  args: {
    sessionId: string | null | undefined;
    runId: string;
    round: number;
  },
): string | null {
  return writeFinalizeTimelineMessage(deps, {
    sessionId: args.sessionId,
    kind: 'finalize_ci_absent',
    content:
      'No CI config for this project — Finalize is running review-only, with no checks. ' +
      'Commit a .agent-hub/ci.yaml or store one on the server to gate this branch on tests.',
    payload: { runId: args.runId, round: args.round },
  });
}

export function writeFinalizeChecksRoundTimeline(
  deps: TimelineMessageDeps,
  args: {
    sessionId: string | null | undefined;
    runId: string;
    round: number;
    steps: ChecksRoundStepSnapshot[];
  },
): string | null {
  const failed = args.steps.find((s) => s.state === 'failed');
  const passed = args.steps.filter((s) => s.state === 'passed').length;
  const content = failed
    ? `Checks · round ${args.round} · ${failed.name} failed`
    : args.steps.length === 0
      ? `Checks · round ${args.round} · no steps`
      : `Checks · round ${args.round} · ${passed}/${args.steps.length} passed`;
  return writeFinalizeTimelineMessage(deps, {
    sessionId: args.sessionId,
    kind: 'finalize_checks_round',
    content,
    payload: {
      runId: args.runId,
      round: args.round,
      steps: args.steps,
    },
  });
}

export interface FlakeRecoveredJobSnapshot {
  jobId: string;
  matrixKey: string;
  failureCount: number;
  failedRounds: number[];
  passedRound: number | null;
}

/**
 * Surface "passed on retry after N failures" in the session timeline. Written
 * when a run reaches ready_to_push with one or more jobs that recovered from
 * an earlier failure with no relevant fixer commit — i.e. a laundered flake.
 * Auto-push/merge is withheld for these runs; the message tells the human a
 * manual push is required to acknowledge.
 */
export function writeFinalizeFlakeRecoveredTimeline(
  deps: TimelineMessageDeps,
  args: {
    sessionId: string | null | undefined;
    runId: string;
    round: number;
    jobs: FlakeRecoveredJobSnapshot[];
  },
): string | null {
  const n = args.jobs.length;
  const detail = args.jobs
    .map((j) => {
      const label = j.matrixKey ? `${j.jobId} [${j.matrixKey}]` : j.jobId;
      return `${label} (${j.failureCount} failure${j.failureCount === 1 ? '' : 's'})`;
    })
    .join(', ');
  return writeFinalizeTimelineMessage(deps, {
    sessionId: args.sessionId,
    kind: 'finalize_flake_recovered',
    content:
      `${n} job${n === 1 ? '' : 's'} passed only on retry — auto-merge blocked, ` +
      `manual push required: ${detail}`,
    payload: {
      runId: args.runId,
      round: args.round,
      jobs: args.jobs,
    },
  });
}

export function writeFinalizeReadyToPushTimeline(
  deps: TimelineMessageDeps,
  args: {
    sessionId: string | null | undefined;
    runId: string;
    validatedHeadSha: string;
    round: number;
    /** 'agenthub' for Hub-hosted projects — drives the client block label. */
    host?: 'agenthub' | 'github';
  },
): string | null {
  const hostLabel = args.host === 'agenthub' ? 'Agent Hub' : 'GitHub';
  return writeFinalizeTimelineMessage(deps, {
    sessionId: args.sessionId,
    kind: 'finalize_ready_to_push',
    content: `Ready to push to ${hostLabel}`,
    payload: {
      runId: args.runId,
      round: args.round,
      validatedHeadSha: args.validatedHeadSha,
      host: args.host ?? 'github',
    },
  });
}

/**
 * End-of-run briefing: what changed, what the reviewer raised, what a human
 * should still test by hand. Written once per run when it parks at a fully
 * validated ready-to-push, so the operator deciding whether to push has the
 * whole picture in one block instead of scrolling the round-by-round history.
 *
 * `content` carries the full markdown because the web client renders the
 * structured payload but mobile and plain-text consumers only see the string.
 */
export function writeFinalizeRunSummaryTimeline(
  deps: TimelineMessageDeps,
  args: {
    sessionId: string | null | undefined;
    content: string;
    payload: Record<string, unknown>;
  },
): string | null {
  return writeFinalizeTimelineMessage(deps, {
    sessionId: args.sessionId,
    kind: 'finalize_run_summary',
    content: args.content,
    payload: args.payload,
  });
}

export function writeFinalizeRunTerminalTimeline(
  deps: TimelineMessageDeps,
  args: {
    sessionId: string | null | undefined;
    runId: string;
    status: string;
    failureReason?: string | null;
    round?: number;
    /**
     * True when the push skipped the review + checks gate (an operator
     * "push anyway" / force push, or a session push with no finalize run).
     * Drives the amber "pushed without tests or review" warning client-side.
     */
    bypassedGates?: boolean;
    /**
     * True when the push landed over a base that had moved onto ground the
     * branch touches (a forced push only — the gated path refuses instead).
     * Recorded so a stale landing is visible in the session timeline rather
     * than only in server logs.
     */
    baseDrifted?: boolean;
    /**
     * The opened/updated PR URL for a successful push. Carried in the
     * payload so the session's terminal block can render a clickable PR
     * link instead of plain "Pushed to GitHub" text.
     */
    prUrl?: string | null;
  },
): string | null {
  const bypassedGates = Boolean(args.bypassedGates);
  const baseDrifted = Boolean(args.baseDrifted);
  const prUrl = typeof args.prUrl === 'string' && args.prUrl.length > 0 ? args.prUrl : null;
  const content =
    args.status === 'pushed'
      ? bypassedGates
        ? baseDrifted
          ? 'Pushed to GitHub without running tests or review, over a base branch that ' +
            'changed the same files'
          : 'Pushed to GitHub without running tests or review'
        : 'Finalize run pushed'
      : args.status === 'cancelled'
        ? 'Finalize run cancelled'
        : args.status === 'ready_to_push'
          ? 'Finalize run ready to push'
          : args.failureReason
            ? `Finalize run ${args.status} (${args.failureReason})`
            : `Finalize run ${args.status}`;
  return writeFinalizeTimelineMessage(deps, {
    sessionId: args.sessionId,
    kind: 'finalize_run_terminal',
    content,
    payload: {
      runId: args.runId,
      status: args.status,
      failureReason: args.failureReason ?? null,
      round: args.round ?? 0,
      bypassedGates,
      baseDrifted,
      prUrl,
    },
  });
}

/** Parse finalize timeline metadata from a message row. */
export function parseFinalizeTimelineMetadata(metadataString: string | null | undefined): {
  kind: FinalizeTimelineKind;
  payload: Record<string, unknown>;
} | null {
  const parsed = parseMetadata(metadataString);
  if (!parsed || typeof parsed.kind !== 'string') return null;
  if (!(FINALIZE_TIMELINE_KINDS as readonly string[]).includes(parsed.kind)) return null;
  return { kind: parsed.kind as FinalizeTimelineKind, payload: parsed };
}
