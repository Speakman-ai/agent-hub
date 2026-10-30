import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __pendingReactivateForTests,
  __resetIdleReaperStateForTests,
  __setIdleReaperClientsForTests,
  ACCESS_DENIED_BACKOFF_MS,
  readIdleReaperConfig,
  reapIdleRunnerInstances,
  selectIdleInstances,
  type IdleReaperConfig,
  type ObservedInstance,
} from './runner-instance-reaper.js';

const inst = (n: number, over: Partial<ObservedInstance> = {}): ObservedInstance => ({
  arn: `arn:ci/${n}`,
  ec2InstanceId: `i-${n}`,
  status: 'ACTIVE',
  runningTasksCount: 0,
  pendingTasksCount: 0,
  ...over,
});

const CFG: IdleReaperConfig = { enabled: true, graceMs: 60_000, minKeep: 0, maxPerTick: 10 };

describe('selectIdleInstances', () => {
  it('waits out the grace period before picking an empty instance', () => {
    const since = new Map<string, number>();
    expect(selectIdleInstances([inst(1)], since, 0, CFG)).toEqual([]);
    expect(selectIdleInstances([inst(1)], since, 59_999, CFG)).toEqual([]);
    expect(selectIdleInstances([inst(1)], since, 60_000, CFG).map((i) => i.arn)).toEqual([
      'arn:ci/1',
    ]);
  });

  it('never picks busy, pending, draining, or unlinked instances', () => {
    const since = new Map<string, number>();
    const list = [
      inst(1, { runningTasksCount: 1 }),
      inst(2, { pendingTasksCount: 1 }),
      inst(3, { status: 'DRAINING' }),
      inst(4, { ec2InstanceId: undefined }),
    ];
    selectIdleInstances(list, since, 0, CFG);
    expect(selectIdleInstances(list, since, 600_000, CFG)).toEqual([]);
    expect(since.size).toBe(0);
  });

  it('restarts the clock when an instance picks up a task in between', () => {
    const since = new Map<string, number>();
    selectIdleInstances([inst(1)], since, 0, CFG);
    selectIdleInstances([inst(1, { runningTasksCount: 1 })], since, 30_000, CFG);
    expect(selectIdleInstances([inst(1)], since, 70_000, CFG)).toEqual([]);
    expect(selectIdleInstances([inst(1)], since, 130_000, CFG)).toHaveLength(1);
  });

  it('keeps the most recently emptied minKeep instances and caps per tick', () => {
    const since = new Map<string, number>([
      ['arn:ci/1', 0],
      ['arn:ci/2', 1_000],
      ['arn:ci/3', 2_000],
      ['arn:ci/4', 3_000],
    ]);
    const all = [inst(4), inst(3), inst(2), inst(1)];
    const picked = selectIdleInstances(all, since, 600_000, { ...CFG, minKeep: 1, maxPerTick: 2 });
    expect(picked.map((i) => i.arn)).toEqual(['arn:ci/1', 'arn:ci/2']);
  });
});

describe('readIdleReaperConfig', () => {
  const KEYS = [
    'FINALIZE_FLEET_IDLE_INSTANCE_REAP',
    'FINALIZE_FLEET_IDLE_INSTANCE_GRACE_SECONDS',
    'FINALIZE_FLEET_IDLE_INSTANCE_MIN_KEEP',
  ];
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => KEYS.forEach((k) => ((saved[k] = process.env[k]), delete process.env[k])));
  afterEach(() =>
    KEYS.forEach((k) =>
      saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]),
    ),
  );

  it('is on by default with a 3 minute grace', () => {
    expect(readIdleReaperConfig()).toMatchObject({ enabled: true, graceMs: 180_000, minKeep: 0 });
  });

  it('honours the kill switch and knobs', () => {
    process.env.FINALIZE_FLEET_IDLE_INSTANCE_REAP = 'off';
    process.env.FINALIZE_FLEET_IDLE_INSTANCE_GRACE_SECONDS = '30';
    process.env.FINALIZE_FLEET_IDLE_INSTANCE_MIN_KEEP = '2';
    expect(readIdleReaperConfig()).toMatchObject({ enabled: false, graceMs: 30_000, minKeep: 2 });
  });
});

/** Fake AWS: one cluster whose instances can change between describe calls. */
function fakeAws(opts: {
  instances: ObservedInstance[];
  clusterPending?: number;
  service?: { desiredCount: number; runningCount: number; pendingCount?: number };
  /** Instance state returned on the re-check after DRAINING. */
  afterDrain?: (i: ObservedInstance) => ObservedInstance;
  terminateError?: Error;
  /** ECS rejects the DRAINING update via `failures` in a 200 response. */
  drainFailure?: boolean;
  /** Describe calls made after a drain reject with this error. */
  describeAfterDrainError?: Error;
  /** How many ACTIVE (restore) updates reject before one succeeds. */
  reactivateRejects?: number;
}) {
  let reactivateRejects = opts.reactivateRejects ?? 0;
  const calls: Array<{ cmd: string; input: Record<string, unknown> }> = [];
  const drained = new Set<string>();
  const ecs = {
    send: vi.fn(async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
      const name = cmd.constructor.name;
      calls.push({ cmd: name, input: cmd.input });
      switch (name) {
        case 'DescribeClustersCommand':
          return { clusters: [{ pendingTasksCount: opts.clusterPending ?? 0 }] };
        case 'DescribeServicesCommand':
          return { services: [opts.service ?? { desiredCount: 1, runningCount: 1 }] };
        case 'ListContainerInstancesCommand':
          return { containerInstanceArns: opts.instances.map((i) => i.arn) };
        case 'DescribeContainerInstancesCommand': {
          const want = cmd.input.containerInstances as string[];
          if (opts.describeAfterDrainError && want.some((a) => drained.has(a))) {
            throw opts.describeAfterDrainError;
          }
          const drainedView = (i: ObservedInstance): ObservedInstance => {
            const d = { ...i, status: 'DRAINING' };
            return opts.afterDrain ? opts.afterDrain(d) : d;
          };
          return {
            containerInstances: opts.instances
              .filter((i) => want.includes(i.arn))
              .map((i) => (drained.has(i.arn) ? drainedView(i) : i))
              .map((i) => ({
                containerInstanceArn: i.arn,
                ec2InstanceId: i.ec2InstanceId,
                status: i.status,
                runningTasksCount: i.runningTasksCount,
                pendingTasksCount: i.pendingTasksCount,
              })),
          };
        }
        case 'UpdateContainerInstancesStateCommand':
          if (cmd.input.status === 'DRAINING') {
            if (opts.drainFailure) {
              return { failures: [{ arn: 'arn:ci/1', reason: 'INVALID_STATE' }] };
            }
            for (const a of cmd.input.containerInstances as string[]) drained.add(a);
          } else if (reactivateRejects > 0) {
            reactivateRejects--;
            throw new Error('ECS throttled');
          } else {
            for (const a of cmd.input.containerInstances as string[]) drained.delete(a);
          }
          return {};
        default:
          throw new Error(`unexpected ${name}`);
      }
    }),
  };
  const autoscaling = {
    send: vi.fn(async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
      calls.push({ cmd: cmd.constructor.name, input: cmd.input });
      if (opts.terminateError) throw opts.terminateError;
      return {};
    }),
  };
  __setIdleReaperClientsForTests({ ecs, autoscaling } as never);
  return { calls, ecs, autoscaling };
}

const pass = (now: number, config: IdleReaperConfig = CFG) =>
  reapIdleRunnerInstances({ cluster: 'c', services: ['svc'], now, config });

describe('reapIdleRunnerInstances', () => {
  beforeEach(() => {
    __resetIdleReaperStateForTests();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    __resetIdleReaperStateForTests();
    vi.restoreAllMocks();
  });

  it('drains, re-checks, then terminates with desired-capacity decrement', async () => {
    const { calls } = fakeAws({ instances: [inst(1), inst(2, { runningTasksCount: 1 })] });
    expect(await pass(0)).toEqual([]);
    expect(await pass(60_000)).toEqual(['i-1']);
    const writes = calls.filter((c) => !/Describe|List/.test(c.cmd));
    expect(writes).toEqual([
      {
        cmd: 'UpdateContainerInstancesStateCommand',
        input: { cluster: 'c', containerInstances: ['arn:ci/1'], status: 'DRAINING' },
      },
      {
        cmd: 'TerminateInstanceInAutoScalingGroupCommand',
        input: { InstanceId: 'i-1', ShouldDecrementDesiredCapacity: true },
      },
    ]);
  });

  it('reactivates instead of terminating when a task landed during the drain', async () => {
    const { calls, autoscaling } = fakeAws({
      instances: [inst(1)],
      afterDrain: (i) => ({ ...i, runningTasksCount: 1 }),
    });
    await pass(0);
    expect(await pass(60_000)).toEqual([]);
    expect(autoscaling.send).not.toHaveBeenCalled();
    expect(
      calls
        .filter((c) => c.cmd === 'UpdateContainerInstancesStateCommand')
        .map((c) => c.input.status),
    ).toEqual(['DRAINING', 'ACTIVE']);
  });

  it('reactivates the instance when the terminate call fails', async () => {
    const { calls } = fakeAws({ instances: [inst(1)], terminateError: new Error('below min') });
    await pass(0);
    expect(await pass(60_000)).toEqual([]);
    expect(
      calls
        .filter((c) => c.cmd === 'UpdateContainerInstancesStateCommand')
        .map((c) => c.input.status),
    ).toEqual(['DRAINING', 'ACTIVE']);
  });

  it('does not terminate when ECS rejects the drain in a successful response', async () => {
    // Without the failures check the recheck would see an empty ACTIVE
    // instance and terminate it while ECS could still place tasks there.
    const { autoscaling, calls } = fakeAws({ instances: [inst(1)], drainFailure: true });
    await pass(0);
    expect(await pass(60_000)).toEqual([]);
    expect(autoscaling.send).not.toHaveBeenCalled();
    expect(
      calls
        .filter((c) => c.cmd === 'UpdateContainerInstancesStateCommand')
        .map((c) => c.input.status),
    ).toEqual(['DRAINING', 'ACTIVE']);
  });

  it('does not terminate when the rechecked instance is not DRAINING', async () => {
    const { autoscaling } = fakeAws({
      instances: [inst(1)],
      afterDrain: (i) => ({ ...i, status: 'ACTIVE' }),
    });
    await pass(0);
    expect(await pass(60_000)).toEqual([]);
    expect(autoscaling.send).not.toHaveBeenCalled();
  });

  it('restores the instance when the post-drain describe throws', async () => {
    const { autoscaling, calls } = fakeAws({
      instances: [inst(1)],
      describeAfterDrainError: new Error('ECS timeout'),
    });
    await pass(0);
    expect(await pass(60_000)).toEqual([]);
    expect(autoscaling.send).not.toHaveBeenCalled();
    expect(
      calls
        .filter((c) => c.cmd === 'UpdateContainerInstancesStateCommand')
        .map((c) => c.input.status),
    ).toEqual(['DRAINING', 'ACTIVE']);
    expect(__pendingReactivateForTests('c')).toEqual([]);
  });

  it('retries a failed restore on later passes until it sticks', async () => {
    const { calls } = fakeAws({
      instances: [inst(1)],
      describeAfterDrainError: new Error('ECS timeout'),
      reactivateRejects: 2,
    });
    await pass(0);
    await pass(60_000);
    expect(__pendingReactivateForTests('c')).toEqual(['arn:ci/1']);
    await pass(61_000);
    expect(__pendingReactivateForTests('c')).toEqual(['arn:ci/1']);
    await pass(62_000);
    expect(__pendingReactivateForTests('c')).toEqual([]);
    const restores = calls.filter(
      (c) => c.cmd === 'UpdateContainerInstancesStateCommand' && c.input.status === 'ACTIVE',
    );
    expect(restores.length).toBeGreaterThanOrEqual(3);
  });

  it.each([
    ['cluster has pending tasks', { clusterPending: 1 }],
    ['service is below desired', { service: { desiredCount: 5, runningCount: 3 } }],
    [
      'service has pending tasks',
      { service: { desiredCount: 5, runningCount: 5, pendingCount: 1 } },
    ],
  ])('does nothing while %s, and restarts grace clocks', async (_label, demand) => {
    const { calls, autoscaling } = fakeAws({ instances: [inst(1)], ...demand });
    await pass(0);
    await pass(600_000);
    expect(autoscaling.send).not.toHaveBeenCalled();
    expect(calls.some((c) => c.cmd === 'ListContainerInstancesCommand')).toBe(false);
  });

  it('does nothing when disabled', async () => {
    const { ecs } = fakeAws({ instances: [inst(1)] });
    await pass(600_000, { ...CFG, enabled: false });
    expect(ecs.send).not.toHaveBeenCalled();
  });

  it('backs off for 30 minutes after an AccessDenied', async () => {
    const denied = Object.assign(new Error('not authorized'), { name: 'AccessDeniedException' });
    const { ecs } = fakeAws({ instances: [inst(1)], terminateError: denied });
    await pass(0);
    await pass(60_000);
    const callsAfterDenied = ecs.send.mock.calls.length;
    await pass(60_000 + ACCESS_DENIED_BACKOFF_MS - 1);
    expect(ecs.send.mock.calls.length).toBe(callsAfterDenied);
    await pass(60_000 + ACCESS_DENIED_BACKOFF_MS);
    expect(ecs.send.mock.calls.length).toBeGreaterThan(callsAfterDenied);
  });
});
