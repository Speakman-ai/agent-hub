/**
 * runner-fleet-scaler.ts — queue-depth autoscaler for the remote runner fleet.
 *
 * The fleet runs one job per agent task (one task per instance, by memory
 * reservation). To run Finalize jobs CONCURRENTLY we need as many agents as
 * there are active jobs. This driver — run inside the Hub, which owns the queue —
 * sets the agent ECS service's desiredCount = clamp(activeJobs, min, max). The
 * ECS capacity provider then launches/drains EC2 instances to match.
 *
 * Scale-up is immediate (on enqueue + on a timer). Scale-DOWN only happens when
 * the queue is fully drained (depth 0) after a cooldown — never mid-run — so a
 * shrink can't kill an agent that's in the middle of a job. (Per-task scale-in
 * protection is a later hardening.)
 *
 * No-op unless FINALIZE_FLEET_ECS_CLUSTER + FINALIZE_FLEET_ECS_SERVICE are set,
 * so the local backend and every non-fleet env are unaffected.
 */
import { ECSClient, UpdateServiceCommand, DescribeServicesCommand } from '@aws-sdk/client-ecs';
import { runnerQueueDepth, reapExpiredRunnerLeases } from './runner-queue.js';
import { getJobChannel } from './runner-job-channel.js';
import { DEFAULT_FLEET_MAX_AGENTS, DEFAULT_FLEET_MIN_AGENTS } from './runner-fleet-constants.js';

interface FleetScalerConfig {
  cluster: string;
  service: string;
  min: number;
  max: number;
  region?: string;
}

function intEnv(name: string, dflt: number): number {
  const n = Number.parseInt(process.env[name]?.trim() ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

function readConfig(): FleetScalerConfig | null {
  const cluster = process.env.FINALIZE_FLEET_ECS_CLUSTER?.trim();
  const service = process.env.FINALIZE_FLEET_ECS_SERVICE?.trim();
  if (!cluster || !service) return null;
  return {
    cluster,
    service,
    min: intEnv('FINALIZE_FLEET_MIN_AGENTS', DEFAULT_FLEET_MIN_AGENTS),
    max: intEnv('FINALIZE_FLEET_MAX_AGENTS', DEFAULT_FLEET_MAX_AGENTS),
    region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION,
  };
}

/** Target agent count for a given queue depth (pure; unit-tested). */
export function desiredAgents(depth: number, min: number, max: number): number {
  if (depth <= 0) return min;
  return Math.min(max, Math.max(min, depth));
}

let client: ECSClient | null = null;
let lastSetDesired = -1; // cached so we don't hammer UpdateService
let emptySinceMs = 0; // when the queue first hit 0 (scale-down cooldown anchor)
const SCALE_DOWN_COOLDOWN_MS = 90_000;
let reconciling = false;

function ecs(cfg: FleetScalerConfig): ECSClient {
  if (!client) client = new ECSClient(cfg.region ? { region: cfg.region } : {});
  return client;
}

async function currentDesired(cfg: FleetScalerConfig): Promise<number> {
  if (lastSetDesired >= 0) return lastSetDesired;
  const res = await ecs(cfg).send(
    new DescribeServicesCommand({ cluster: cfg.cluster, services: [cfg.service] }),
  );
  const d = res.services?.[0]?.desiredCount;
  return typeof d === 'number' ? d : cfg.min;
}

/**
 * Bring the agent fleet size in line with the current queue depth. Safe to call
 * frequently (deduped against the last value it set; scale-down gated).
 */
export async function reconcileFleetCapacity(now: number = Date.now()): Promise<void> {
  const cfg = readConfig();
  if (!cfg || reconciling) return;
  reconciling = true;
  try {
    // Reap dead leases first so the depth signal is honest: a job whose agent
    // crashed mid-run stops heartbeating, its lease expires, and we mark it
    // `lost` (terminal). Live jobs heartbeat on every poll, so they're untouched.
    // Without this, a stranded job would pin the fleet above zero forever.
    const reaped = reapExpiredRunnerLeases(now);
    if (reaped.length) {
      console.log(`[fleet-scaler] reaped ${reaped.length} expired lease(s)`);
      // Reaping marks the queue row `lost`, but the orchestrator is still awaiting
      // the in-process channel's in-flight step (the dead agent will never report
      // it). Fail those channels so the step surfaces as infra_error and the
      // job-runner can retry the instance on a fresh agent instead of hanging.
      for (const jobId of reaped) {
        getJobChannel(jobId)?.fail(
          new Error('runner agent lost — lease expired (likely a Spot reclaim)'),
        );
      }
    }
    const depth = runnerQueueDepth(); // queued + claimed + running, across all orgs
    const target = desiredAgents(depth, cfg.min, cfg.max);
    const current = await currentDesired(cfg);

    if (target === current) {
      if (depth > 0) emptySinceMs = 0;
      return;
    }
    if (target < current) {
      // Only ever shrink when the queue is fully drained, after a cooldown —
      // never pull an instance out from under a running job mid-run.
      if (depth > 0) return;
      if (emptySinceMs === 0) emptySinceMs = now;
      if (now - emptySinceMs < SCALE_DOWN_COOLDOWN_MS) return;
    } else {
      emptySinceMs = 0;
    }

    await ecs(cfg).send(
      new UpdateServiceCommand({
        cluster: cfg.cluster,
        service: cfg.service,
        desiredCount: target,
      }),
    );
    lastSetDesired = target;
    console.log(`[fleet-scaler] queue depth=${depth} → agents ${current}→${target}`);
  } catch (err) {
    console.error(`[fleet-scaler] reconcile failed: ${(err as Error).message}`);
  } finally {
    reconciling = false;
  }
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Start the periodic reconcile loop (idempotent). No-op if the fleet isn't configured. */
export function startFleetScaler(intervalMs = 30_000): void {
  if (timer || !readConfig()) return;
  void reconcileFleetCapacity();
  timer = setInterval(() => void reconcileFleetCapacity(), intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  console.log('[fleet-scaler] started (queue-depth autoscaling enabled)');
}
