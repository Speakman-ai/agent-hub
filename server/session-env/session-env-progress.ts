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

export { SESSION_ENV_LAUNCH_STEP };

type StmtRun = { run: (...args: any[]) => unknown };

export type SessionEnvProgressStmts = {
  addSessionEvent: StmtRun;
  addSessionProgress: StmtRun;
  completeSessionProgress: StmtRun;
};

export function emitSessionEnvLaunchProgress(args: {
  stmts: SessionEnvProgressStmts;
  broadcast: BroadcastFn;
  sessionId: string;
  messageId: string;
  nextSeq: () => number;
  status: ProgressStepStatus;
  startedAt: number;
  finishedAt?: number;
  log?: (msg: string) => void;
}): void {
  const event: ProgressStepEvent = {
    type: 'progress_step',
    step: SESSION_ENV_LAUNCH_STEP,
    status: args.status,
    startedAt: args.startedAt,
    ...(args.finishedAt != null ? { finishedAt: args.finishedAt } : {}),
  };
  const seq = args.nextSeq();
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
  try {
    if (args.status === 'started') {
      args.stmts.addSessionProgress.run(
        args.sessionId,
        args.messageId,
        event.step,
        'started',
        event.startedAt,
        null,
      );
    } else {
      const finishedAt = args.finishedAt ?? Date.now();
      const info = args.stmts.completeSessionProgress.run(
        args.status,
        finishedAt,
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
  });
}
