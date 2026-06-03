/**
 * runner-agent.ts — the pull-based runner agent that executes one Finalize job.
 *
 * Runs inside a fleet task. Loop: register → claim → materialize the worktree
 * bundle → start a fresh DinD container (via the SHARED runner-exec-args, for
 * local/remote parity) → poll for run_step directives, exec each into the
 * container while streaming stdout/stderr back, report each exit code → on a
 * `finish` directive (or 410 = channel gone) tear the container down and exit.
 *
 * The job loop takes injected `transport` + `docker` so it's unit-testable with
 * fakes (no real HTTP/Docker); `realDockerOps`/`httpTransport`/`runAgentMain`
 * wire the production implementations.
 */
import { spawn } from 'child_process';
import path from 'path';
import { buildExecJobStepArgv, sanitizeJobContainerName } from './runner-exec-args.js';
import { startJobContainer, stopJobContainer } from './job-container.js';
import type { RunnerDirective } from './runner-job-channel.js';
import type { RunnerJobWireSpec } from './runner-backend-remote.js';
import { LocalDirBundleStore, materializeWorktree, type BundleStore } from './worktree-bundle.js';

export interface AgentLogFrame {
  seq: number;
  stepIndex: number;
  stream: 'stdout' | 'stderr';
  data: string;
}

export type AgentPollResult = RunnerDirective | { type: 'idle' } | { type: 'gone' };

export interface AgentTransport {
  claim(): Promise<{ jobId: string; spec: RunnerJobWireSpec } | null>;
  poll(jobId: string): Promise<AgentPollResult>;
  postLogs(jobId: string, frames: AgentLogFrame[]): Promise<void>;
  postStepResult(jobId: string, stepIndex: number, exitCode: number | null): Promise<void>;
  postFinish(jobId: string, exitCode: number): Promise<void>;
  /** Extend the job's lease while it's alive (called on a background timer). */
  heartbeat(jobId: string): Promise<void>;
}

export interface AgentDocker {
  startContainer(spec: RunnerJobWireSpec, workspaceMount: string): Promise<string>;
  execStep(
    containerName: string,
    run: string,
    env: Record<string, string>,
    onLog: (stream: 'stdout' | 'stderr', data: string) => void,
  ): Promise<number>;
  stopContainer(containerName: string): Promise<void>;
}

/**
 * Run a single claimed job to completion. Returns the per-step exit codes.
 * Pure control flow over the injected transport/docker — the unit of test.
 */
export async function runAgentJob(args: {
  jobId: string;
  spec: RunnerJobWireSpec;
  workspaceDir: string;
  transport: AgentTransport;
  docker: AgentDocker;
  materialize?: (spec: RunnerJobWireSpec, destPath: string) => Promise<void>;
  logFlushMs?: number;
  heartbeatMs?: number;
}): Promise<{ stepExits: Array<{ stepIndex: number; exitCode: number | null }> }> {
  const { jobId, spec, transport, docker } = args;
  // Background heartbeat for the WHOLE job — through worktree materialize, DinD
  // startup, and long/silent steps — so the Hub's lease never expires under a
  // live agent (which would let the reaper mark it lost and the scaler kill it).
  const heartbeat = setInterval(
    () => void transport.heartbeat(jobId).catch(() => {}),
    args.heartbeatMs ?? 30_000,
  );
  if (typeof (heartbeat as { unref?: () => void }).unref === 'function') {
    (heartbeat as { unref: () => void }).unref();
  }
  const stepExits: Array<{ stepIndex: number; exitCode: number | null }> = [];
  try {
    // Materialize + run in a SUBDIR of the shared workspace, never the workspace
    // root itself: that root (/finalize-ws) is a bind-mount point — it can't be
    // rmdir'd, and materializeWorktree clears its dest before cloning.
    const jobWorkspace = path.join(args.workspaceDir, 'repo');
    if (spec.worktreeRef && args.materialize) {
      await args.materialize(spec, jobWorkspace);
    }
    const containerName = await docker.startContainer(spec, jobWorkspace);
    let seq = 0;
    try {
      for (;;) {
        const d = await transport.poll(jobId);
        if (d.type === 'idle') continue;
        if (d.type === 'finish' || d.type === 'gone') break;
        if (d.type === 'cancel') continue; // container teardown handles cancellation
        // run_step: exec, streaming logs (batched), then report the exit code.
        const buffer: AgentLogFrame[] = [];
        const flush = async (): Promise<void> => {
          if (buffer.length === 0) return;
          await transport.postLogs(jobId, buffer.splice(0));
        };
        const timer = setInterval(() => void flush(), args.logFlushMs ?? 200);
        let exitCode: number | null;
        try {
          exitCode = await docker.execStep(containerName, d.run, d.env, (stream, data) => {
            buffer.push({ seq: seq++, stepIndex: d.stepIndex, stream, data });
          });
        } finally {
          clearInterval(timer);
          await flush();
        }
        stepExits.push({ stepIndex: d.stepIndex, exitCode });
        await transport.postStepResult(jobId, d.stepIndex, exitCode);
      }
    } finally {
      await docker.stopContainer(containerName);
      await transport.postFinish(jobId, 0);
    }
  } finally {
    clearInterval(heartbeat);
  }
  return { stepExits };
}

// ── Production implementations ──────────────────────────────────────────────

const JOB_LABELS = (spec: RunnerJobWireSpec): Record<string, string> => ({
  'agent-hub.finalize.run_id': spec.runId,
  'agent-hub.finalize.job_id': spec.jobId,
  'agent-hub.finalize.matrix_key': spec.matrixKey,
});

export function realDockerOps(): AgentDocker {
  return {
    async startContainer(spec, workspaceMount) {
      const containerName = sanitizeJobContainerName(spec.runId, spec.jobId, spec.matrixKey);
      await startJobContainer({
        containerName,
        image: spec.image,
        worktreePath: workspaceMount,
        workspaceMount,
        composeProjectName: spec.composeProjectName,
        env: spec.env,
        labels: JOB_LABELS(spec),
      });
      return containerName;
    },
    execStep(containerName, run, env, onLog) {
      return new Promise<number>((resolve, reject) => {
        const argv = buildExecJobStepArgv({ containerName, run, env });
        const child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout?.on('data', (d) => onLog('stdout', d.toString()));
        child.stderr?.on('data', (d) => onLog('stderr', d.toString()));
        child.on('error', reject);
        child.on('close', (code) => resolve(code ?? -1));
      });
    },
    async stopContainer(containerName) {
      await stopJobContainer(containerName);
    },
  };
}

export function httpTransport(hubUrl: string, token: string): AgentTransport {
  const base = hubUrl.replace(/\/$/, '');
  const auth = { Authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  return {
    async claim() {
      const res = await fetch(`${base}/api/runners/claim`, {
        method: 'POST',
        headers: auth,
        body: '{}',
      });
      if (res.status === 204) return null;
      if (!res.ok) throw new Error(`claim failed: ${res.status}`);
      return (await res.json()) as { jobId: string; spec: RunnerJobWireSpec };
    },
    async poll(jobId) {
      const res = await fetch(`${base}/api/runners/jobs/${jobId}/poll`, {
        method: 'POST',
        headers: auth,
        body: '{}',
      });
      if (res.status === 410) return { type: 'gone' };
      if (!res.ok) throw new Error(`poll failed: ${res.status}`);
      return (await res.json()) as AgentPollResult;
    },
    async postLogs(jobId, frames) {
      await fetch(`${base}/api/runners/jobs/${jobId}/logs`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ frames }),
      });
    },
    async postStepResult(jobId, stepIndex, exitCode) {
      await fetch(`${base}/api/runners/jobs/${jobId}/step-result`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ stepIndex, exitCode }),
      });
    },
    async postFinish(jobId, exitCode) {
      await fetch(`${base}/api/runners/jobs/${jobId}/finish`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ exitCode }),
      });
    },
    async heartbeat(jobId) {
      await fetch(`${base}/api/runners/jobs/${jobId}/heartbeat`, {
        method: 'POST',
        headers: auth,
        body: '{}',
      });
    },
  };
}

export async function registerAgent(
  hubUrl: string,
  fleetToken: string,
  orgScope: string,
): Promise<{ agentId: string; token: string }> {
  const res = await fetch(`${hubUrl.replace(/\/$/, '')}/api/runners/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fleetToken, orgScope }),
  });
  if (!res.ok) throw new Error(`register failed: ${res.status}`);
  return (await res.json()) as { agentId: string; token: string };
}

/** CLI entry: register, then claim → run → repeat (one job at a time). */
export async function runAgentMain(): Promise<void> {
  const hubUrl =
    process.env.FINALIZE_RUNNER_HUB_URL || process.env.AGENT_HUB_URL || 'http://127.0.0.1:3051';
  const fleetToken = process.env.FINALIZE_RUNNER_FLEET_TOKEN;
  const orgScope = process.env.FINALIZE_RUNNER_ORG_SCOPE || 'shared';
  const workspaceDir = process.env.FINALIZE_RUNNER_WORKSPACE_DIR || '/github/workspace';
  const bundleDir = process.env.FINALIZE_RUNNER_BUNDLE_DIR;
  if (!fleetToken) throw new Error('FINALIZE_RUNNER_FLEET_TOKEN is required');

  const { token } = await registerAgent(hubUrl, fleetToken, orgScope);
  const transport = httpTransport(hubUrl, token);
  const docker = realDockerOps();
  // Cross-host fleet: the wire spec carries a presigned getUrl, so materialize
  // fetches credential-free (store stays null, no AWS SDK in this bundle).
  // Same-host 2a: no getUrl, so fall back to the local-dir store.
  const store: BundleStore | undefined = bundleDir ? new LocalDirBundleStore(bundleDir) : undefined;
  const materialize = (spec: RunnerJobWireSpec, dest: string) =>
    materializeWorktree({ ref: spec.worktreeRef!, store, destPath: dest, rev: undefined });

  console.log(`[runner-agent] registered; polling ${hubUrl} (scope=${orgScope})`);
  for (;;) {
    let claimed: { jobId: string; spec: RunnerJobWireSpec } | null = null;
    try {
      claimed = await transport.claim();
    } catch (err) {
      console.error(`[runner-agent] claim error: ${(err as Error).message}`);
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }
    if (!claimed) continue;
    console.log(`[runner-agent] claimed job ${claimed.jobId} (${claimed.spec.jobId})`);
    try {
      await runAgentJob({
        jobId: claimed.jobId,
        spec: claimed.spec,
        workspaceDir,
        transport,
        docker,
        materialize,
      });
    } catch (err) {
      console.error(`[runner-agent] job ${claimed.jobId} failed: ${(err as Error).message}`);
    }
  }
}
