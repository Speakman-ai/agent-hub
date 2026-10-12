/**
 * The {@link PrEnvironmentRuntime} that runs PR environments on an
 * {@link EnvironmentRunner} (runner fleet or Hub-local DinD).
 *
 * build: read the `preview:` block at the head, resolve its secrets, start
 * the stack, then watch it. The watch polls the runner's durable status, so
 * the same loop serves a build started in this process and one adopted after
 * a Hub restart (`reattach`). A runner that dies is reported as lost: the
 * environment is failed and requeued, a bounded number of times in a row.
 */
import { randomUUID } from 'crypto';
import type { Project } from '../types.js';
import type { PreviewConfig } from '../deploy/deploy-preview-config.js';
import type { RunnerEnvironmentSpec } from '../finalize/runner-environment.js';
import type {
  PrEnvironmentDto,
  PrEnvironmentReporter,
  PrEnvironmentRuntime,
} from './pr-environments.js';
import type {
  EnvironmentRunner,
  EnvironmentRunnerStatus,
  EnvironmentUpstream,
} from './pr-environment-runner.js';

/** Consecutive runner losses that are rebuilt automatically before giving up. */
export const DEFAULT_MAX_LOSS_REQUEUES = 2;

/** How long a build may wait for a runner before it fails. */
export const DEFAULT_ENVIRONMENT_QUEUE_TIMEOUT_MS = 30 * 60_000;

export const DEFAULT_ENVIRONMENT_POLL_MS = 5_000;

export interface RunnerPrEnvironmentRuntimeDeps {
  runner: EnvironmentRunner;
  /** The `preview:` block at exactly `headSha`; null when it has none. */
  readPreviewConfig: (project: Project, headSha: string) => Promise<PreviewConfig | null>;
  /** Decrypted values of `preview.secrets`. Throws when one is missing. */
  resolveSecrets: (preview: PreviewConfig, projectId: string) => Record<string, string>;
  /** Org that owns the environment (tenant of the runner queue job). */
  orgId: () => string;
  pollMs?: number;
  maxLossRequeues?: number;
  queueTimeoutMs?: number;
  now?: () => number;
  /** Start the poll timer. Tests pass a no-op and drive `tick()`. */
  startTimer?: (fn: () => void, ms: number) => { stop: () => void };
  log?: (msg: string) => void;
}

export interface RunnerPrEnvironmentRuntime extends PrEnvironmentRuntime {
  /** Poll every watched environment once. */
  tick(): Promise<void>;
  /** Refs currently watched (tests and diagnostics). */
  watched(): string[];
  /** The upstream of a ready environment, by runner ref. */
  upstreamFor(ref: string): EnvironmentUpstream | null;
  dispose(): void;
}

interface Watch {
  ref: string;
  envId: string;
  reporter: PrEnvironmentReporter;
  since: number;
  readyReported: boolean;
  logCursor: number;
  upstream: EnvironmentUpstream | null;
}

export function upstreamUrl(u: EnvironmentUpstream): string {
  const host = u.host.includes(':') ? `[${u.host}]` : u.host;
  return `http://${host}:${u.port}`;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function previewToEnvironmentSpec(
  preview: PreviewConfig,
  prNumber: number,
): RunnerEnvironmentSpec {
  return {
    composeProject: `pr-${prNumber}`,
    composeFile: preview.compose,
    service: preview.service,
    port: preview.port,
    health: preview.health,
    steps: preview.steps.map((s) => ({ name: s.name, run: s.run })),
  };
}

export function createRunnerPrEnvironmentRuntime(
  deps: RunnerPrEnvironmentRuntimeDeps,
): RunnerPrEnvironmentRuntime {
  const { runner } = deps;
  const now = deps.now ?? Date.now;
  const logWarn = deps.log ?? ((m: string) => console.warn(m));
  const maxRequeues = deps.maxLossRequeues ?? DEFAULT_MAX_LOSS_REQUEUES;
  const queueTimeoutMs = deps.queueTimeoutMs ?? DEFAULT_ENVIRONMENT_QUEUE_TIMEOUT_MS;
  const pollMs = deps.pollMs ?? DEFAULT_ENVIRONMENT_POLL_MS;
  const startTimer =
    deps.startTimer ??
    ((fn: () => void, ms: number) => {
      const t = setInterval(fn, ms);
      (t as { unref?: () => void }).unref?.();
      return { stop: () => clearInterval(t) };
    });

  const watches = new Map<string, Watch>();
  // Runner losses in a row per environment; reset once it is ready again.
  const losses = new Map<string, number>();
  // Bumped by every teardown so a start that resolves afterwards is undone.
  const epochs = new Map<string, number>();
  let timer: { stop: () => void } | null = null;
  let ticking = false;

  function ensureTimer(): void {
    if (timer || watches.size === 0) return;
    timer = startTimer(() => void self.tick(), pollMs);
  }

  function unwatch(ref: string): void {
    watches.delete(ref);
    if (watches.size === 0 && timer) {
      timer.stop();
      timer = null;
    }
  }

  function watch(ref: string, envId: string, reporter: PrEnvironmentReporter): void {
    watches.set(ref, {
      ref,
      envId,
      reporter,
      since: now(),
      readyReported: false,
      // Remote frames start at seq 0; the cursor is the last seq read.
      logCursor: -1,
      upstream: null,
    });
    ensureTimer();
  }

  function reportLoss(w: Watch, detail: string): void {
    const count = losses.get(w.envId) ?? 0;
    const requeue = count < maxRequeues;
    losses.set(w.envId, count + 1);
    w.reporter.log(`Runner lost: ${detail}${requeue ? ' (rebuilding)' : ''}`);
    w.reporter.lost(
      requeue
        ? `The runner hosting this environment was lost (${detail}). Rebuilding.`
        : `The runner hosting this environment was lost (${detail}) ${count + 1} times in a row. Retry to rebuild.`,
      { requeue },
    );
  }

  async function apply(w: Watch, st: EnvironmentRunnerStatus): Promise<void> {
    switch (st.state) {
      case 'pending':
        if (now() - w.since > queueTimeoutMs) {
          unwatch(w.ref);
          await runner.stop(w.ref).catch(() => {});
          w.reporter.failed(
            `No runner picked up this environment within ${Math.round(queueTimeoutMs / 60_000)} minutes.`,
          );
        }
        return;
      case 'starting':
        return;
      case 'ready':
        w.upstream = st.upstream;
        if (!w.readyReported && st.upstream) {
          w.readyReported = true;
          losses.delete(w.envId);
          w.reporter.ready(upstreamUrl(st.upstream));
        }
        return;
      case 'failed':
        unwatch(w.ref);
        w.reporter.failed(st.detail ?? 'The environment failed to start.');
        return;
      case 'lost':
        unwatch(w.ref);
        reportLoss(w, st.detail ?? 'unknown');
        return;
      case 'stopped':
        unwatch(w.ref);
        return;
    }
  }

  async function poll(w: Watch): Promise<void> {
    try {
      const logs = await runner.readLogs(w.ref, w.logCursor);
      w.logCursor = logs.cursor;
      if (logs.lines.length) w.reporter.log(logs.lines);
    } catch {
      /* logs are best-effort */
    }
    let st: EnvironmentRunnerStatus;
    try {
      st = await runner.status(w.ref);
    } catch (err) {
      logWarn(`[pr-env] status of ${w.ref} failed: ${message(err)}`);
      return;
    }
    // Torn down while the status read was in flight.
    if (watches.get(w.ref) !== w) return;
    await apply(w, st);
  }

  const self: RunnerPrEnvironmentRuntime = {
    async build({ project, env, reporter }) {
      const epoch = epochs.get(env.id) ?? 0;
      let preview: PreviewConfig | null;
      try {
        preview = await deps.readPreviewConfig(project, env.headSha);
      } catch (err) {
        reporter.failed(
          `Could not read the preview config at ${env.headSha.slice(0, 12)}: ${message(err)}`,
        );
        return;
      }
      if (!preview) {
        reporter.failed(
          `No \`preview:\` block in .agent-hub/deploy.yaml at ${env.headSha.slice(0, 12)}.`,
        );
        return;
      }
      let secrets: Record<string, string>;
      try {
        secrets = deps.resolveSecrets(preview, project.id);
      } catch (err) {
        reporter.failed(message(err));
        return;
      }
      const spec = previewToEnvironmentSpec(preview, env.prNumber);
      reporter.log(
        `Starting on the ${runner.kind} runner (compose project ${spec.composeProject})`,
      );
      const ref = await runner.start({
        key: `${env.id}-${randomUUID().slice(0, 8)}`,
        orgId: deps.orgId(),
        project,
        prNumber: env.prNumber,
        headSha: env.headSha,
        spec,
        env: secrets,
      });
      if ((epochs.get(env.id) ?? 0) !== epoch) {
        // Stopped or superseded while starting: nothing tracks this ref.
        await runner.stop(ref).catch(() => {});
        return;
      }
      reporter.building(ref);
      watch(ref, env.id, reporter);
    },

    async teardown({ env }: { project: Project; env: PrEnvironmentDto }) {
      epochs.set(env.id, (epochs.get(env.id) ?? 0) + 1);
      const refs = new Set<string>();
      if (env.runnerRef) refs.add(env.runnerRef);
      for (const w of watches.values()) if (w.envId === env.id) refs.add(w.ref);
      for (const ref of refs) {
        unwatch(ref);
        // Throws on failure: the service records it and retries.
        await runner.stop(ref);
      }
    },

    async reattach({ env, reporter }) {
      const ref = env.runnerRef;
      if (!ref) return false;
      let st: EnvironmentRunnerStatus;
      try {
        st = await runner.status(ref);
      } catch (err) {
        // Status unknown (docker or DB hiccup): adopt it and let the next
        // tick decide, rather than declaring a possibly healthy stack gone.
        logWarn(`[pr-env] status of ${ref} failed during reattach: ${message(err)}`);
        watch(ref, env.id, reporter);
        return true;
      }
      if (st.state === 'stopped') return false;
      watch(ref, env.id, reporter);
      await apply(watches.get(ref)!, st);
      return true;
    },

    async tick() {
      if (ticking) return;
      ticking = true;
      try {
        for (const w of [...watches.values()]) await poll(w);
      } finally {
        ticking = false;
      }
    },

    watched: () => [...watches.keys()],

    upstreamFor: (ref) => watches.get(ref)?.upstream ?? null,

    dispose() {
      timer?.stop();
      timer = null;
      watches.clear();
    },
  };
  return self;
}
