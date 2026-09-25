/**
 * Last-run state for custom background agents, so the settings page can show
 * what a test run (or the latest scheduled run) did. In-memory only: a Hub
 * restart clears it, which is fine for "did my prompt work" feedback. Session
 * runs are durable anyway (the session itself is the record).
 */

export type BackgroundAgentRunStatus = 'running' | 'succeeded' | 'failed';

export interface BackgroundAgentRun {
  status: BackgroundAgentRunStatus;
  trigger: 'manual' | 'schedule';
  startedAt: string;
  finishedAt: string | null;
  /** Tail of the one-shot output (session runs leave this null). */
  output: string | null;
  error: string | null;
  sessionId: string | null;
  sessionAgentId: string | null;
}

/** Keep the stored output bounded; the UI only needs enough to eyeball. */
export const BACKGROUND_RUN_OUTPUT_LIMIT = 20_000;

const runs = new Map<string, BackgroundAgentRun>();

function key(projectId: string, agentId: string): string {
  return `${projectId}:${agentId}`;
}

export function getBackgroundAgentRun(
  projectId: string,
  agentId: string,
): BackgroundAgentRun | null {
  return runs.get(key(projectId, agentId)) ?? null;
}

export function isBackgroundAgentRunning(projectId: string, agentId: string): boolean {
  return getBackgroundAgentRun(projectId, agentId)?.status === 'running';
}

export function startBackgroundAgentRun(
  projectId: string,
  agentId: string,
  trigger: BackgroundAgentRun['trigger'],
): BackgroundAgentRun {
  const run: BackgroundAgentRun = {
    status: 'running',
    trigger,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    output: null,
    error: null,
    sessionId: null,
    sessionAgentId: null,
  };
  runs.set(key(projectId, agentId), run);
  return run;
}

function truncateTail(text: string): string {
  if (text.length <= BACKGROUND_RUN_OUTPUT_LIMIT) return text;
  return `…${text.slice(text.length - BACKGROUND_RUN_OUTPUT_LIMIT)}`;
}

export function finishBackgroundAgentRun(
  run: BackgroundAgentRun,
  result: {
    ok: boolean;
    output?: string | null;
    error?: string | null;
    sessionId?: string | null;
    sessionAgentId?: string | null;
  },
): void {
  run.status = result.ok ? 'succeeded' : 'failed';
  run.finishedAt = new Date().toISOString();
  run.output = result.output ? truncateTail(result.output) : null;
  run.error = result.error ?? null;
  run.sessionId = result.sessionId ?? null;
  run.sessionAgentId = result.sessionAgentId ?? null;
}

export function forgetBackgroundAgentRun(projectId: string, agentId: string): void {
  runs.delete(key(projectId, agentId));
}

export function resetBackgroundAgentRuns(): void {
  runs.clear();
}
