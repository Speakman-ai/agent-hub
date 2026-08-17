/**
 * runner-fleet-scaler.ts — queue-depth autoscaler for the remote runner fleet.
 *
 * The fleet runs one job per agent task (one task per instance, by memory
 * reservation). To run Finalize jobs CONCURRENTLY we need as many agents as
 * there are active jobs. This driver — run inside the Hub, which owns the queue —
 * sets the agent ECS service's desiredCount = clamp(activeJobs, min, max). The
 * ECS capacity provider then launches/drains EC2 instances to match.
 *
 * Scale-up is immediate (on enqueue + on a timer). Scale-DOWN has two modes:
 *
 *   - DEFAULT (safe): only when the queue is fully drained (depth 0) after a
 *     cooldown — never mid-run — so a shrink can't kill an agent in the middle
 *     of a job. A long tail of a few jobs therefore pins the whole warm fleet.
 *
 *   - DYNAMIC (FINALIZE_FLEET_DYNAMIC_SCALE_DOWN=1): also trims IDLE agents
 *     mid-run. The target separates the two demands instead of lumping them as
 *     one `depth`:
 *         target = clamp( max(depth, inflight + warmHeadroom), min, max )
 *     where inflight = claimed+running (jobs that own an agent) and
 *     depth = queued+inflight. So a genuine queued backlog still scales the
 *     fleet UP (depth term — claimable queued jobs are NOT starved: idle agents
 *     loop and claim them), while a drained queue lets us shrink down to just
 *     in-flight work + a warm headroom of spares. ECS *task scale-in
 *     protection* (ecs-task-protection.ts / runner-agent.ts — a busy task
 *     self-protects, an idle one is freely replaceable) guarantees ECS reaps
 *     only the idle tasks. This is what lets 50 idle runners collapse to ~2
 *     while the last 2 jobs finish, instead of holding all 50.
 *
 * No-op unless FINALIZE_FLEET_ECS_CLUSTER + FINALIZE_FLEET_ECS_SERVICE are set,
 * so the local backend and every non-fleet env are unaffected.
 */
import { ECSClient, UpdateServiceCommand, DescribeServicesCommand } from '@aws-sdk/client-ecs';
import { runnerQueueDepth, runnerInflightCount, reapExpiredRunnerLeases } from './runner-queue.js';
import type { ReapedRunnerJob } from './runner-queue.js';
import { clearHubTaskProtection, loadHubTaskProtectionConfig } from './hub-task-protection.js';
import { getJobChannel } from './runner-job-channel.js';
import { spotReclaimDetail } from './spot-interruption.js';
import { hubUnavailableDetail } from './hub-unavailable.js';
import { DEFAULT_FLEET_MAX_AGENTS, DEFAULT_FLEET_MIN_AGENTS } from './runner-fleet-constants.js';

interface FleetScalerConfig {
  cluster: string;
  service: string;
  min: number;
  max: number;
  region?: string;
  /** Trim idle agents mid-run (depth>0) instead of holding until depth==0. */
  dynamicScaleDown: boolean;
  /** Warm spares to keep above in-flight work in dynamic mode (0 = none). */
  warmHeadroom: number;
}

function intEnv(name: string, dflt: number): number {
  const n = Number.parseInt(process.env[name]?.trim() ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

function boolEnv(name: string): boolean {
  const v = process.env[name]?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on' || v === 'yes';
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
    dynamicScaleDown: boolEnv('FINALIZE_FLEET_DYNAMIC_SCALE_DOWN'),
    warmHeadroom: intEnv('FINALIZE_FLEET_WARM_HEADROOM', 0),
  };
}

/** Target agent count for a given queue depth (pure; unit-tested). */
export function desiredAgents(depth: number, min: number, max: number): number {
  if (depth <= 0) return min;
  return Math.min(max, Math.max(min, depth));
}

/**
 * Dynamic target that separates queued backlog from in-flight work (pure;
 * unit-tested). `depth` = queued+claimed+running drives scale-UP so a claimable
 * backlog isn't starved; `inflight` = claimed+running plus `headroom` is the
 * warm FLOOR we never shrink below. The two are combined with `max` (not summed)
 * so headroom never stacks on top of a full backlog:
 *
 *   - drained queue (depth ≈ inflight): target = inflight + headroom  (shrink)
 *   - real backlog (depth ≫ inflight):  target = depth                (hold/grow)
 *
 * The result is ALWAYS ≥ inflight — even when `max < inflight` (e.g. the ceiling
 * was lowered while jobs are running, or more jobs are in flight than a freshly
 * reduced `max` allows). The in-flight floor wins over the `max` ceiling on
 * purpose: briefly exceeding `max` is strictly safer than asking ECS to drop
 * desiredCount below the number of busy agents (which, absent perfect task
 * scale-in protection, risks killing a running job). The fleet reconverges under
 * `max` as those jobs finish and depth falls.
 */
export function desiredAgentsDynamic(
  depth: number,
  inflight: number,
  headroom: number,
  min: number,
  max: number,
): number {
  if (depth <= 0) return min; // fully drained → collapse to the warm-pool floor
  const want = Math.max(depth, inflight + Math.max(0, headroom));
  const bounded = Math.min(max, Math.max(min, want));
  // In-flight floor overrides the max ceiling: never target below busy agents.
  return Math.max(bounded, inflight);
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
 * scale-down requires a stable observation AND no recent reap.
 *
 * `dynamicScaleDown` flips the mid-run behaviour: when false (default) the fleet
 * never shrinks while depth>0; when true it trims idle agents down to
 * desiredAgentsDynamic(depth, inflight, headroom) — i.e. it still scales up for a
 * queued backlog but can shrink to in-flight + headroom once the queue drains,
 * leaning on ECS task scale-in protection to keep the busy tasks alive. The
 * target is always ≥ inflight, so a shrink can never fall below jobs that own an
 * agent.
 */
export function planFleetChange(args: {
  depth: number;
  current: number;
  min: number;
  max: number;
  reapedThisTick: number;
  now: number;
  state: ScalerHysteresis;
  dynamicScaleDown?: boolean;
  warmHeadroom?: number;
  /** claimed+running (jobs that own an agent). Defaults to `depth` (conservative:
   *  treat everything as in-flight so nothing extra is trimmed). */
  inflight?: number;
}): FleetPlan {
  const { depth, current, min, max, reapedThisTick, now } = args;
  const dynamic = args.dynamicScaleDown ?? false;
  const headroom = dynamic ? Math.max(0, args.warmHeadroom ?? 0) : 0;
  // In-flight (claimed+running) is the floor a dynamic shrink must never cross.
  // Default to `depth` so an omitted count never causes an over-aggressive trim.
  const inflight = Math.min(depth, args.inflight ?? depth);
  let { emptySinceMs, lastReapAtMs } = args.state;
  if (reapedThisTick > 0) lastReapAtMs = now;

  // Dynamic mode separates queued backlog (scale-up) from in-flight work (the
  // shrink floor); legacy mode keeps the single depth-based target.
  const target = dynamic
    ? desiredAgentsDynamic(depth, inflight, headroom, min, max)
    : desiredAgents(depth, min, max);

  if (target === current) {
    if (depth > 0) emptySinceMs = 0;
    return { target: null, state: { emptySinceMs, lastReapAtMs } };
  }

  if (target < current) {
    // SAFE mode: never shrink while work is queued/claimed/running.
    if (!dynamic && depth > 0) {
      return { target: null, state: { emptySinceMs: 0, lastReapAtMs } };
    }
    // Anchor the shrink-debounce clock on the first shrinkable observation. In
    // safe mode this only runs at depth==0; in dynamic mode it also debounces a
    // mid-run shrink so a brief dip can't churn the fleet.
    if (emptySinceMs === 0) emptySinceMs = now;
    // Suppress scale-down for a grace window after any reap: the low reading is
    // suspect (reaped jobs are about to be retried). See REAP_SCALE_DOWN_GRACE_MS.
    // This guard applies in BOTH modes — a reap can fool the dynamic path too.
    if (lastReapAtMs > 0 && now - lastReapAtMs < REAP_SCALE_DOWN_GRACE_MS) {
      return { target: null, state: { emptySinceMs, lastReapAtMs } };
    }
    // Standard drain/shrink cooldown.
    if (now - emptySinceMs < SCALE_DOWN_COOLDOWN_MS) {
      return { target: null, state: { emptySinceMs, lastReapAtMs } };
    }
    // Dynamic mid-run shrink is safe ONLY because busy ECS tasks self-protect
    // (ecs-task-protection.ts); ECS scale-in then reaps the idle tasks and the
    // target (>= in-flight) never asks it to kill a running one.
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
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
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
 * Reap expired runner-job leases and settle their in-flight steps.
 *
 * This is the liveness backstop for the remote runner backend: a runner-agent
 * that dies (crash, OOM kill, Spot reclaim, dropped transport) stops
 * heartbeating, its lease expires (~5 min), and this reap marks the queue row
 * `lost` AND fails the in-process job channel so the awaiting step promise
 * settles as an infra failure the job-runner can retry on a fresh agent —
 * instead of hanging until the per-step hard timeout (up to 60 min).
 *
 * Deliberately independent of the ECS fleet-scaler config: deployments running
 * a static/manual runner fleet (no FINALIZE_FLEET_ECS_* env) still need dead
 * runners reaped. `startFleetScaler` runs this on its tick whether or not
 * scaling is configured (card d8a76929 — a dead-runner zombie step previously
 * hung for the full hard timeout on non-ECS fleets because nothing ever
 * called the reaper).
 */
export function reapDeadRunnerJobs(now: number = Date.now()): ReapedRunnerJob[] {
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
    // points at the Hub side, not N independent agent deaths — mark those with
    // the hub_unavailable seam so they earn the generous transient retry cap
    // (a Hub restart recovers on its own, exactly like a Spot reclaim) instead
    // of the conservative `container_unavailable` cap that parks a run caught by
    // back-to-back restart windows. A single reap stays ambiguous (crash / OOM /
    // deploy / Hub blip), so it keeps the conservative reason.
    const genericDetail =
      reaped.length > 1
        ? hubUnavailableDetail(
            `runner agent lost — lease expired with no heartbeat; ${reaped.length} jobs reaped in one tick, ` +
              `so the Hub was likely briefly unreachable or restarting (not a per-agent crash)`,
          )
        : `runner agent lost — lease expired with no heartbeat (agent crashed, was killed, or lost contact with the Hub)`;
    // Clear Hub task protection on each reaped agent's task. The lease expired,
    // so either the task is already gone (clear is a harmless no-op) or it's a
    // stuck-but-alive worker — in which case it would otherwise stay protected
    // for the full Hub lease (up to 120 min), blocking scale-in / deploy from
    // reclaiming it. Fire-and-forget; clearHubTaskProtection is bounded + no-op
    // off-ECS / for a null ARN.
    const protectionCfg = loadHubTaskProtectionConfig();
    for (const job of reaped) {
      const detail = job.spotReclaimed
        ? spotReclaimDetail(
            'runner agent lost after an EC2 Spot interruption notice — instance reclaimed',
          )
        : genericDetail;
      getJobChannel(job.id)?.fail(new Error(detail));
      void clearHubTaskProtection(job.ecsTaskArn, protectionCfg);
    }
  }
  return reaped;
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
    const reaped = reapDeadRunnerJobs(now);
    const depth = runnerQueueDepth(); // queued + claimed + running, across all orgs
    // claimed+running only — the floor a dynamic shrink must never cross. Cheap
    // extra COUNT, so only taken when dynamic scale-down is actually enabled.
    const inflight = cfg.dynamicScaleDown ? runnerInflightCount() : depth;
    const current = await currentDesired(cfg);
    const plan = planFleetChange({
      depth,
      inflight,
      current,
      min: cfg.min,
      max: cfg.max,
      reapedThisTick: reaped.length,
      now,
      state: scalerState,
      dynamicScaleDown: cfg.dynamicScaleDown,
      warmHeadroom: cfg.warmHeadroom,
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
    const shrunkMidRun = plan.target < current && depth > 0;
    console.log(
      `[fleet-scaler] queue depth=${depth} → agents ${current}→${plan.target}` +
        (shrunkMidRun ? ' (dynamic mid-run shrink; idle tasks reaped, busy protected)' : ''),
    );
  } catch (err) {
    console.error(`[fleet-scaler] reconcile failed: ${(err as Error).message}`);
  } finally {
    reconciling = false;
  }
}

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Start the periodic reconcile loop (idempotent).
 *
 * With FINALIZE_FLEET_ECS_* configured this runs the full reap + autoscale
 * tick. WITHOUT fleet config it still starts a reap-only tick: lease reaping
 * is the liveness backstop that settles in-flight remote steps when a
 * runner-agent dies, and it must run for static/manual runner fleets too —
 * previously nothing called the reaper off-ECS, so a dead runner's step hung
 * until the per-step hard timeout (card d8a76929).
 */
export function startFleetScaler(intervalMs = 30_000): void {
  if (timer) return;
  if (!readConfig()) {
    const reapTick = (): void => {
      try {
        reapDeadRunnerJobs();
      } catch (err) {
        console.error(`[fleet-scaler] lease reap failed: ${(err as Error).message}`);
      }
    };
    reapTick();
    timer = setInterval(reapTick, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
    console.log('[fleet-scaler] started (lease reaping only — no ECS fleet configured)');
    return;
  }
  void reconcileFleetCapacity();
  timer = setInterval(() => void reconcileFleetCapacity(), intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  console.log('[fleet-scaler] started (queue-depth autoscaling enabled)');
}
