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
  'finalize_checks_round',
  'finalize_ready_to_push',
  'finalize_run_terminal',
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
  },
): string | null {
  const label = args.ok
    ? args.conflict
      ? 'Rebase completed (conflicts resolved)'
      : 'Rebase completed'
    : 'Rebase failed';
  return writeFinalizeTimelineMessage(deps, {
    sessionId: args.sessionId,
    kind: 'finalize_rebase_result',
    content: args.round > 0 ? `${label} · round ${args.round}` : label,
    payload: {
      runId: args.runId,
      round: args.round,
      ok: args.ok,
      conflict: Boolean(args.conflict),
      headSha: args.headSha ?? null,
      detail: args.detail ?? null,
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

export function writeFinalizeReadyToPushTimeline(
  deps: TimelineMessageDeps,
  args: {
    sessionId: string | null | undefined;
    runId: string;
    validatedHeadSha: string;
    round: number;
  },
): string | null {
  return writeFinalizeTimelineMessage(deps, {
    sessionId: args.sessionId,
    kind: 'finalize_ready_to_push',
    content: 'Ready to push to GitHub',
    payload: {
      runId: args.runId,
      round: args.round,
      validatedHeadSha: args.validatedHeadSha,
    },
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
  },
): string | null {
  const content =
    args.status === 'pushed'
      ? 'Finalize run pushed'
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
