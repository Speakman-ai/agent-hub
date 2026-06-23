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
import { spotReclaimDetail } from './spot-interruption.js';
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

/** Queue must stay drained this long before we shrink (debounces brief lulls). */
export const SCALE_DOWN_COOLDOWN_MS = 90_000;

/**
 * After the reaper marks in-flight jobs `lost`, `runnerQueueDepth()` transiently
 * reads 0 even though the orchestrator is about to RETRY (re-enqueue) those jobs
 * on fresh agents. We MUST NOT scale the service down on that reading: doing so
 * issues UpdateService(desiredCount=min), which SIGKILLs agents that are usually
 * still alive — their heartbeats merely failed to reach a briefly unreachable Hub
 * — and tears the warm fleet out from under the imminent retries.
 *
 * This is the 2026-06-08 incident: heartbeats stopped landing (~Hub restart), all
 * 8 leases expired, one reaper tick marked them `lost`, depth read 0, and the
 * scaler drove desiredCount 8→0, killing every in-flight job mid-build before the
 * retries (which re-raised depth to 6→8 within ~90s) could land.
 *
 * Fix: suppress scale-down for a grace window past the LAST reap — comfortably
 * longer than the orchestrator's immediate infra_error re-enqueue — so a
 * reap-induced empty reading can never collapse the fleet.
 */
export const REAP_SCALE_DOWN_GRACE_MS = 120_000;

/** Carried hysteresis state between reconcile ticks (kept explicit so the
 *  decision is a pure, unit-testable function). */
export interface ScalerHysteresis {
  /** When the queue was first observed fully drained (cooldown anchor); 0 = not empty. */
  emptySinceMs: number;
  /** When we last reaped ≥1 expired lease (scale-down suppressor); 0 = never reaped. */
  lastReapAtMs: number;
}

export interface FleetPlan {
  /** Desired agent count to set, or null to leave the service unchanged. */
  target: number | null;
  /** Hysteresis state to carry into the next reconcile tick. */
  state: ScalerHysteresis;
}

/**
 * Pure scale decision (unit-tested). Given the observed queue depth, the current
 * desiredCount, the fleet bounds, how many leases were reaped THIS tick, and the
 * carried hysteresis state, decide the next desiredCount. Scale-up is immediate;
 * scale-down requires a stably-empty queue AND no recent reap.
 */
export function planFleetChange(args: {
  depth: number;
  current: number;
  min: number;
  max: number;
  reapedThisTick: number;
  now: number;
  state: ScalerHysteresis;
}): FleetPlan {
  const { depth, current, min, max, reapedThisTick, now } = args;
  let { emptySinceMs, lastReapAtMs } = args.state;
  if (reapedThisTick > 0) lastReapAtMs = now;

  const target = desiredAgents(depth, min, max);

  if (target === current) {
    if (depth > 0) emptySinceMs = 0;
    return { target: null, state: { emptySinceMs, lastReapAtMs } };
  }

  if (target < current) {
    // Never shrink while work is queued/claimed/running.
    if (depth > 0) return { target: null, state: { emptySinceMs: 0, lastReapAtMs } };
    // Anchor the empty-period clock on the first empty observation.
    if (emptySinceMs === 0) emptySinceMs = now;
    // Suppress scale-down for a grace window after any reap: the empty reading is
    // suspect (reaped jobs are about to be retried). See REAP_SCALE_DOWN_GRACE_MS.
    if (lastReapAtMs > 0 && now - lastReapAtMs < REAP_SCALE_DOWN_GRACE_MS) {
      return { target: null, state: { emptySinceMs, lastReapAtMs } };
    }
    // Standard drain cooldown.
    if (now - emptySinceMs < SCALE_DOWN_COOLDOWN_MS) {
      return { target: null, state: { emptySinceMs, lastReapAtMs } };
    }
    return { target, state: { emptySinceMs, lastReapAtMs } };
  }

  // Scale-up: immediate.
  return { target, state: { emptySinceMs: 0, lastReapAtMs } };
}

let client: ECSClient | null = null;
let lastSetDesired = -1; // cached so we don't hammer UpdateService
let scalerState: ScalerHysteresis = { emptySinceMs: 0, lastReapAtMs: 0 };
let reconciling = false;

/** Test-only: reset module-level scaler state so reconcile-level tests isolate. */
export function __resetFleetScalerStateForTests(): void {
  client = null;
  lastSetDesired = -1;
  scalerState = { emptySinceMs: 0, lastReapAtMs: 0 };
  reconciling = false;
}

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
      const reclaims = reaped.filter((r) => r.spotReclaimed).length;
      console.log(
        `[fleet-scaler] reaped ${reaped.length} expired lease(s)` +
          (reclaims ? ` (${reclaims} after a spot interruption notice)` : ''),
      );
      // Reaping marks the queue row `lost`, but the orchestrator is still awaiting
      // the in-process channel's in-flight step (the dead agent will never report
      // it). Fail those channels so the step surfaces as infra_error and the
      // job-runner can retry the instance on a fresh agent instead of hanging.
      //
      // For a job whose agent reported an EC2 Spot interruption notice (IMDS)
      // before its lease expired, we KNOW the loss is capacity reclamation, not a
      // crash — fail it with the spot_reclaimed marker so step-runner picks the
      // generous reclaim retry cap. For the rest, the message states only what we
      // OBSERVED — a missing heartbeat — and does NOT guess "Spot reclaim" (the
      // lease can expire from an agent crash, an OOM kill, a deploy/scale-in, OR
      // the Hub being briefly unreachable). A whole batch reaped in one tick
      // points at the Hub side, not N independent agent deaths.
      const genericDetail =
        reaped.length > 1
          ? `runner agent lost — lease expired with no heartbeat; ${reaped.length} jobs reaped in one tick, ` +
            `so the Hub was likely briefly unreachable or restarting (not a per-agent crash)`
          : `runner agent lost — lease expired with no heartbeat (agent crashed, was killed, or lost contact with the Hub)`;
      for (const job of reaped) {
        const detail = job.spotReclaimed
          ? spotReclaimDetail(
              'runner agent lost after an EC2 Spot interruption notice — instance reclaimed',
            )
          : genericDetail;
        getJobChannel(job.id)?.fail(new Error(detail));
      }
    }
    const depth = runnerQueueDepth(); // queued + claimed + running, across all orgs
    const current = await currentDesired(cfg);
    const plan = planFleetChange({
      depth,
      current,
      min: cfg.min,
      max: cfg.max,
      reapedThisTick: reaped.length,
      now,
      state: scalerState,
    });
    scalerState = plan.state;
    if (plan.target === null) return;

    await ecs(cfg).send(
      new UpdateServiceCommand({
        cluster: cfg.cluster,
        service: cfg.service,
        desiredCount: plan.target,
      }),
    );
    lastSetDesired = plan.target;
    console.log(`[fleet-scaler] queue depth=${depth} → agents ${current}→${plan.target}`);
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
