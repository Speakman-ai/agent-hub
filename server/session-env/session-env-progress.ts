/**
 * Host-side "Launching session VM" progress for env-owned (Firecracker) turns.
 *
 * Emitted before `ensureSessionEnv` so the chat tail and ProgressPanel can
 * show a spinner instead of a blank "Waiting for first event…" while disks
 * clone and the VMM boots.
 */
import type { BroadcastFn, ProgressStepEvent, ProgressStepStatus } from '../types.js';
import { buildSessionEventBroadcast } from '../session-event-broadcast.js';
import { clampPayload } from '../session-events-store.js';
import { SESSION_ENV_LAUNCH_STEP } from '../../shared/utils/sessionEnvLaunch.js';
import { SESSION_STARTUP_STEP } from './session-startup-hooks.js';

export { SESSION_ENV_LAUNCH_STEP, SESSION_STARTUP_STEP };

type StmtRun = { run: (...args: any[]) => unknown };

export type SessionEnvProgressStmts = {
  addSessionEvent: StmtRun;
  addSessionProgress: StmtRun;
  completeSessionProgress: StmtRun;
};

const SESSION_STARTUP_MESSAGE_ID = '__session_startup__';
const SESSION_ENV_LAUNCH_MESSAGE_ID = '__session_env_launch__';

function emitProgressStep(args: {
  stmts: SessionEnvProgressStmts;
  broadcast: BroadcastFn;
  sessionId: string;
  messageId: string;
  step: string;
  status: ProgressStepStatus;
  startedAt: number;
  finishedAt?: number;
  detail?: string;
  nextSeq?: () => number;
  log?: (msg: string) => void;
}): void {
  const event: ProgressStepEvent = {
    type: 'progress_step',
    step: args.step,
    status: args.status,
    startedAt: args.startedAt,
    ...(args.finishedAt != null ? { finishedAt: args.finishedAt } : {}),
    ...(args.detail ? { detail: args.detail } : {}),
  };
  const seq = args.nextSeq?.() ?? Date.now();
  const log = args.log ?? ((msg: string) => console.warn(msg));
  try {
    args.stmts.addSessionEvent.run(
      'message',
      args.messageId,
      seq,
      event.type,
      clampPayload(JSON.stringify(event)),
    );
  } catch (err: unknown) {
    log(
      `[session-env-progress] persist session_event failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  const detail = args.detail ?? null;
  try {
    if (args.status === 'started') {
      args.stmts.addSessionProgress.run(
        args.sessionId,
        args.messageId,
        event.step,
        'started',
        event.startedAt,
        null,
        detail,
      );
    } else {
      const finishedAt = args.finishedAt ?? Date.now();
      const info = args.stmts.completeSessionProgress.run(
        args.status,
        finishedAt,
        detail,
        args.sessionId,
        event.step,
      );
      if ((info as { changes?: number }).changes === 0) {
        args.stmts.addSessionProgress.run(
          args.sessionId,
          args.messageId,
          event.step,
          args.status,
          event.startedAt,
          finishedAt,
          detail,
        );
      }
    }
  } catch (err: unknown) {
    log(
      `[session-env-progress] persist session_progress failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  args.broadcast(
    buildSessionEventBroadcast({
      sessionId: args.sessionId,
      messageId: args.messageId,
      seq,
      event,
    }),
  );
  args.broadcast({
    type: 'session-progress',
    sessionId: args.sessionId,
    messageId: args.messageId,
    step: event.step,
    status: event.status,
    startedAt: event.startedAt,
    finishedAt: event.finishedAt ?? null,
    detail: event.detail ?? null,
  });
}

export function emitSessionEnvLaunchProgress(args: {
  stmts: SessionEnvProgressStmts;
  broadcast: BroadcastFn;
  sessionId: string;
  /** Defaults to `__session_env_launch__` when omitted (manager / non-chat paths). */
  messageId?: string;
  nextSeq?: () => number;
  status: ProgressStepStatus;
  startedAt: number;
  finishedAt?: number;
  log?: (msg: string) => void;
}): void {
  emitProgressStep({
    stmts: args.stmts,
    broadcast: args.broadcast,
    sessionId: args.sessionId,
    messageId: args.messageId ?? SESSION_ENV_LAUNCH_MESSAGE_ID,
    step: SESSION_ENV_LAUNCH_STEP,
    status: args.status,
    startedAt: args.startedAt,
    finishedAt: args.finishedAt,
    nextSeq: args.nextSeq,
    log: args.log,
  });
}

/** Background session-startup-hooks progress (no chat message required). */
export function emitSessionStartupProgress(args: {
  stmts: SessionEnvProgressStmts;
  broadcast: BroadcastFn;
  sessionId: string;
  status: ProgressStepStatus;
  startedAt: number;
  finishedAt?: number;
  detail?: string;
  log?: (msg: string) => void;
}): void {
  emitProgressStep({
    stmts: args.stmts,
    broadcast: args.broadcast,
    sessionId: args.sessionId,
    messageId: SESSION_STARTUP_MESSAGE_ID,
    step: SESSION_STARTUP_STEP,
    status: args.status,
    startedAt: args.startedAt,
    finishedAt: args.finishedAt,
    detail: args.detail,
    log: args.log,
  });
}
