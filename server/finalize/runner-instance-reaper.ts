/**
 * Terminates runner-fleet EC2 instances that have sat with no ECS task.
 *
 * The fleet scaler (runner-fleet-scaler.ts) trims the agent SERVICE to the job
 * count within ~90s, but the instances under it are scaled in by ECS managed
 * scaling, whose target-tracking low alarm needs ~15 minutes of breach before it
 * removes anything, and then removes in steps. After a CI burst that leaves
 * dozens of empty instances billing for a quarter hour or more; measured over
 * two weeks, about a third of fleet capacity was idle.
 *
 * Each tick this module:
 *   1. Skips the cluster entirely while any task is waiting for capacity
 *      (cluster pending > 0, or a fleet service has running < desired): an empty
 *      instance may be about to receive it.
 *   2. Tracks how long each ACTIVE container instance has had zero running and
 *      zero pending tasks, and picks the ones empty past the grace period.
 *   3. Drains each pick (ECS stops placing tasks on it), re-reads it, and only if
 *      it is still empty terminates it through Auto Scaling with
 *      ShouldDecrementDesiredCapacity, so the ASG does not launch a replacement.
 *      If a task landed in the meantime it is set back to ACTIVE.
 *
 * TerminateInstanceInAutoScalingGroup is not blocked by instance scale-in
 * protection, which ECS managed termination protection sets on every instance.
 *
 * Env:
 *   FINALIZE_FLEET_IDLE_INSTANCE_REAP          on by default; 0/false/off disables
 *   FINALIZE_FLEET_IDLE_INSTANCE_GRACE_SECONDS seconds empty before reaping (180)
 *   FINALIZE_FLEET_IDLE_INSTANCE_MIN_KEEP      empty instances to keep warm (0)
 *   FINALIZE_FLEET_IDLE_INSTANCE_MAX_PER_TICK  terminations per tick (10)
 */
import {
  ECSClient,
  DescribeClustersCommand,
  DescribeServicesCommand,
  ListContainerInstancesCommand,
  DescribeContainerInstancesCommand,
  UpdateContainerInstancesStateCommand,
} from '@aws-sdk/client-ecs';
import {
  AutoScalingClient,
  TerminateInstanceInAutoScalingGroupCommand,
} from '@aws-sdk/client-auto-scaling';

export interface IdleReaperConfig {
  enabled: boolean;
  graceMs: number;
  minKeep: number;
  maxPerTick: number;
}

export const DEFAULT_IDLE_INSTANCE_GRACE_SECONDS = 180;
export const DEFAULT_IDLE_INSTANCE_MAX_PER_TICK = 10;
/** After an AccessDenied (IAM not applied yet), stop calling AWS for this long. */
export const ACCESS_DENIED_BACKOFF_MS = 30 * 60_000;

function intEnv(name: string, dflt: number): number {
  const n = Number.parseInt(process.env[name]?.trim() ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

export function readIdleReaperConfig(): IdleReaperConfig {
  const raw = process.env.FINALIZE_FLEET_IDLE_INSTANCE_REAP?.trim().toLowerCase();
  const enabled = !(raw === '0' || raw === 'false' || raw === 'off' || raw === 'no');
  return {
    enabled,
    graceMs:
      intEnv('FINALIZE_FLEET_IDLE_INSTANCE_GRACE_SECONDS', DEFAULT_IDLE_INSTANCE_GRACE_SECONDS) *
      1000,
    minKeep: intEnv('FINALIZE_FLEET_IDLE_INSTANCE_MIN_KEEP', 0),
    maxPerTick: intEnv(
      'FINALIZE_FLEET_IDLE_INSTANCE_MAX_PER_TICK',
      DEFAULT_IDLE_INSTANCE_MAX_PER_TICK,
    ),
  };
}

export interface ObservedInstance {
  arn: string;
  ec2InstanceId: string | undefined;
  status: string | undefined;
  runningTasksCount: number;
  pendingTasksCount: number;
}

export function isEmptyActive(i: ObservedInstance): boolean {
  return (
    i.status === 'ACTIVE' &&
    !!i.ec2InstanceId &&
    i.runningTasksCount === 0 &&
    i.pendingTasksCount === 0
  );
}

/**
 * Pure selection step. Updates `emptySince` in place (first time each instance
 * was seen empty; entries for busy or vanished instances are dropped) and returns
 * the instances to reap, longest-empty first, leaving `minKeep` of the most
 * recently emptied ones alone and capping at `maxPerTick`.
 */
export function selectIdleInstances(
  instances: ObservedInstance[],
  emptySince: Map<string, number>,
  now: number,
  cfg: Pick<IdleReaperConfig, 'graceMs' | 'minKeep' | 'maxPerTick'>,
): ObservedInstance[] {
  const empty = instances.filter(isEmptyActive);
  const emptyArns = new Set(empty.map((i) => i.arn));
  for (const arn of [...emptySince.keys()]) {
    if (!emptyArns.has(arn)) emptySince.delete(arn);
  }
  for (const i of empty) {
    if (!emptySince.has(i.arn)) emptySince.set(i.arn, now);
  }
  const byAge = [...empty].sort(
    (a, b) => (emptySince.get(a.arn) ?? now) - (emptySince.get(b.arn) ?? now),
  );
  const reapable = byAge.length - cfg.minKeep;
  if (reapable <= 0) return [];
  return byAge
    .slice(0, reapable)
    .filter((i) => now - (emptySince.get(i.arn) ?? now) >= cfg.graceMs)
    .slice(0, cfg.maxPerTick);
}

export interface ReaperClients {
  ecs: Pick<ECSClient, 'send'>;
  autoscaling: Pick<AutoScalingClient, 'send'>;
}

interface ClusterState {
  emptySince: Map<string, number>;
  disabledUntilMs: number;
  /** Instances we drained but could not restore to ACTIVE; retried every pass. */
  pendingReactivate: Set<string>;
}

const clusterState = new Map<string, ClusterState>();
let clients: ReaperClients | null = null;

function stateFor(cluster: string): ClusterState {
  let st = clusterState.get(cluster);
  if (!st) {
    st = { emptySince: new Map(), disabledUntilMs: 0, pendingReactivate: new Set() };
    clusterState.set(cluster, st);
  }
  return st;
}

function getClients(region?: string): ReaperClients {
  if (!clients) {
    const opts = region ? { region } : {};
    clients = { ecs: new ECSClient(opts), autoscaling: new AutoScalingClient(opts) };
  }
  return clients;
}

/** Test-only: inject clients / reset module state. */
export function __setIdleReaperClientsForTests(c: ReaperClients | null): void {
  clients = c;
}
export function __pendingReactivateForTests(cluster: string): string[] {
  return [...(clusterState.get(cluster)?.pendingReactivate ?? [])];
}
export function __resetIdleReaperStateForTests(): void {
  clients = null;
  clusterState.clear();
}

function isAccessDenied(err: unknown): boolean {
  const name = (err as { name?: string })?.name ?? '';
  return /AccessDenied|UnauthorizedOperation|NotAuthorized/i.test(name);
}

/** True when a task is waiting for capacity anywhere we can see. */
async function capacityDemandPending(
  ecs: ReaperClients['ecs'],
  cluster: string,
  services: string[],
): Promise<boolean> {
  const c = await ecs.send(new DescribeClustersCommand({ clusters: [cluster] }));
  if ((c.clusters?.[0]?.pendingTasksCount ?? 0) > 0) return true;
  if (!services.length) return false;
  const s = await ecs.send(new DescribeServicesCommand({ cluster, services }));
  return (s.services ?? []).some(
    (svc) => (svc.pendingCount ?? 0) > 0 || (svc.runningCount ?? 0) < (svc.desiredCount ?? 0),
  );
}

async function describeInstances(
  ecs: ReaperClients['ecs'],
  cluster: string,
  arns: string[],
): Promise<ObservedInstance[]> {
  const out: ObservedInstance[] = [];
  for (let i = 0; i < arns.length; i += 100) {
    const res = await ecs.send(
      new DescribeContainerInstancesCommand({
        cluster,
        containerInstances: arns.slice(i, i + 100),
      }),
    );
    for (const ci of res.containerInstances ?? []) {
      if (!ci.containerInstanceArn) continue;
      out.push({
        arn: ci.containerInstanceArn,
        ec2InstanceId: ci.ec2InstanceId,
        status: ci.status,
        runningTasksCount: ci.runningTasksCount ?? 0,
        pendingTasksCount: ci.pendingTasksCount ?? 0,
      });
    }
  }
  return out;
}

async function listActiveInstanceArns(
  ecs: ReaperClients['ecs'],
  cluster: string,
): Promise<string[]> {
  const arns: string[] = [];
  let nextToken: string | undefined;
  do {
    const res = await ecs.send(
      new ListContainerInstancesCommand({ cluster, status: 'ACTIVE', nextToken }),
    );
    arns.push(...(res.containerInstanceArns ?? []));
    nextToken = res.nextToken;
  } while (nextToken);
  return arns;
}

/**
 * Set one container instance's state and confirm ECS accepted it. The API
 * reports per-instance rejections as `failures` inside a successful response,
 * so a bare resolve does not mean the state changed. A MISSING instance is
 * already gone, which counts as success when restoring it to ACTIVE.
 */
async function setInstanceState(
  ecs: ReaperClients['ecs'],
  cluster: string,
  arn: string,
  status: 'ACTIVE' | 'DRAINING',
): Promise<void> {
  const res = await ecs.send(
    new UpdateContainerInstancesStateCommand({ cluster, containerInstances: [arn], status }),
  );
  const failures = (res.failures ?? []).filter(
    (f) => !(status === 'ACTIVE' && f.reason === 'MISSING'),
  );
  if (failures.length) {
    const why = failures.map((f) => `${f.reason ?? 'unknown'}${f.detail ? ` (${f.detail})` : ''}`);
    throw new Error(`ECS refused ${status} for ${arn}: ${why.join(', ')}`);
  }
}

/**
 * Drain, re-check, terminate. Returns true when the instance was terminated.
 * Any failure once the drain has been requested restores the instance to
 * ACTIVE; if that also fails the ARN goes on `pendingReactivate` so a later
 * pass retries it (listing only sees ACTIVE instances, so a stranded DRAINING
 * one would otherwise never be looked at again).
 */
async function reapOne(
  c: ReaperClients,
  cluster: string,
  inst: ObservedInstance,
  pendingReactivate: Set<string>,
): Promise<boolean> {
  try {
    await setInstanceState(c.ecs, cluster, inst.arn, 'DRAINING');
    const [after] = await describeInstances(c.ecs, cluster, [inst.arn]);
    const drainedAndEmpty =
      !!after &&
      after.status === 'DRAINING' &&
      after.runningTasksCount === 0 &&
      after.pendingTasksCount === 0;
    if (!drainedAndEmpty) {
      await restore(c, cluster, inst.arn, pendingReactivate);
      return false;
    }
    await c.autoscaling.send(
      new TerminateInstanceInAutoScalingGroupCommand({
        InstanceId: inst.ec2InstanceId,
        ShouldDecrementDesiredCapacity: true,
      }),
    );
    return true;
  } catch (err) {
    await restore(c, cluster, inst.arn, pendingReactivate);
    throw err;
  }
}

/** Set back to ACTIVE, queueing the ARN for retry when that fails. Never throws. */
async function restore(
  c: ReaperClients,
  cluster: string,
  arn: string,
  pendingReactivate: Set<string>,
): Promise<void> {
  try {
    await setInstanceState(c.ecs, cluster, arn, 'ACTIVE');
    pendingReactivate.delete(arn);
  } catch (err) {
    pendingReactivate.add(arn);
    console.error(
      `[fleet-reaper] could not restore ${arn} to ACTIVE, will retry: ${(err as Error).message}`,
    );
  }
}

/**
 * One reaper pass over `cluster`. `services` are the fleet services placed on
 * it; their running < desired counts as pending demand. Never throws.
 */
export async function reapIdleRunnerInstances(args: {
  cluster: string;
  services: string[];
  region?: string;
  now?: number;
  config?: IdleReaperConfig;
}): Promise<string[]> {
  const cfg = args.config ?? readIdleReaperConfig();
  if (!cfg.enabled) return [];
  const now = args.now ?? Date.now();
  const st = stateFor(args.cluster);
  const c = getClients(args.region);
  // Restoring capacity only needs ECS permissions, so it runs even while an
  // Auto Scaling AccessDenied has paused reaping.
  for (const arn of [...st.pendingReactivate]) {
    await restore(c, args.cluster, arn, st.pendingReactivate);
  }
  if (now < st.disabledUntilMs) return [];
  const terminated: string[] = [];
  try {
    if (await capacityDemandPending(c.ecs, args.cluster, args.services)) {
      // A waiting task may land on any empty instance; restart every grace clock.
      st.emptySince.clear();
      return [];
    }
    const arns = await listActiveInstanceArns(c.ecs, args.cluster);
    const observed = await describeInstances(c.ecs, args.cluster, arns);
    const picks = selectIdleInstances(observed, st.emptySince, now, cfg);
    for (const inst of picks) {
      try {
        if (await reapOne(c, args.cluster, inst, st.pendingReactivate)) {
          terminated.push(inst.ec2InstanceId as string);
          st.emptySince.delete(inst.arn);
        }
      } catch (err) {
        if (isAccessDenied(err)) throw err;
        console.error(
          `[fleet-reaper] could not reap ${inst.ec2InstanceId}: ${(err as Error).message}`,
        );
      }
    }
    if (terminated.length) {
      console.log(
        `[fleet-reaper] terminated ${terminated.length} empty runner instance(s) in ${args.cluster}: ${terminated.join(', ')}`,
      );
    }
  } catch (err) {
    if (isAccessDenied(err)) {
      st.disabledUntilMs = now + ACCESS_DENIED_BACKOFF_MS;
      console.error(
        `[fleet-reaper] missing IAM permission, pausing idle-instance reaping for 30 min: ${(err as Error).message}`,
      );
    } else {
      console.error(`[fleet-reaper] pass failed for ${args.cluster}: ${(err as Error).message}`);
    }
  }
  return terminated;
}
