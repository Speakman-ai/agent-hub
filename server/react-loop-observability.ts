/**
 * Structured per-step events for the host ReAct / auto-continuation loop.
 * Emits WebSocket `react_loop_step` plus an optional grep-friendly log line.
 */

export type ReactLoopPhase = 'host_action' | 'cli_turn' | 'chain_gate';

export interface ReactLoopStepPayload {
  sessionId: string;
  messageId: string;
  stepId: string;
  phase: ReactLoopPhase;
  /** Host tool name (`wiki` | `web` | `skill`), engine id for `cli_turn`, or `chain` for gate. */
  tool: string;
  /** 0 = success, 1 = error, 2 = skipped / budget / blocked. */
  exitCode: number;
  durationMs: number;
  continuationDepth: number;
  detail?: string;
  /** Milliseconds since the outer chain started (first handleChat in the chain). */
  chainElapsedMs?: number;
}

export type BroadcastFn = (data: Record<string, unknown>) => void;

/**
 * When a host ReAct action throws before branch exit codes are finalized,
 * telemetry must report failure (exit 1), not the default branch exit 0.
 */
export function mergeHostActionExitForEmit(params: {
  thrown: boolean;
  err: unknown;
  branchExit: number;
  branchDetail?: string;
}): { exitCode: number; detail?: string } {
  if (params.thrown) {
    const m = params.err instanceof Error ? params.err.message : String(params.err ?? 'unknown');
    const prefix = params.branchDetail ? `${params.branchDetail}: ` : '';
    return { exitCode: 1, detail: `${prefix}${m}`.trim() || 'host_action_error' };
  }
  return { exitCode: params.branchExit, detail: params.branchDetail };
}

export function emitReactLoopStep(
  broadcast: BroadcastFn,
  payload: ReactLoopStepPayload,
  logToConsole = true,
): void {
  broadcast({ type: 'react_loop_step', ...payload });
  if (logToConsole) {
    console.log('[react-loop-step]', JSON.stringify(payload));
  }
}
