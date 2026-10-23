import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import type { ECSClient } from '@aws-sdk/client-ecs';
import {
  PREWARM_TTL_MS,
  __resetFleetPrewarmForTests,
  fleetPrewarmDemand,
  fleetPrewarmEnabled,
  fleetShardCount,
  releaseFleetPrewarm,
  reserveFleetPrewarm,
  syncFleetPrewarm,
  DB_PREWARM_QUEUE,
  type PrewarmQueue,
} from './runner-fleet-prewarm.js';
import {
  __resetFleetScalerStateForTests,
  __setFleetScalerEcsClientForTests,
  reconcileFleetCapacity,
  SCALE_DOWN_COOLDOWN_MS,
} from './runner-fleet-scaler.js';
import { initOrgsDb, setOrgsDbPathForTests } from '../orgs.js';
import { enqueueRunnerJob, reportRunnerJob } from './runner-queue.js';
import { jobInstanceKey } from './base-drift-policy.js';
import type { CiConfig, CiJob } from './ci-config-jobs.js';

function job(runsOn: string, rows: Array<Record<string, string>>): CiJob {
  return { runsOn, matrixInclude: rows } as unknown as CiJob;
}

const config: Pick<CiConfig, 'jobs'> = {
  jobs: {
    lint: job('ubuntu-24.04', [{}]),
    test: job('ubuntu-24.04', [{ group: 's1' }, { group: 's2' }, { group: 's3' }]),
    ios: job('macos-15', [{}]),
  },
};

const remoteEnv = { FINALIZE_RUNNER_BACKEND: 'remote' } as NodeJS.ProcessEnv;
// Unit tests run without the queue DB; the scaler block below uses the real one.
function fakeQueue(shards: Record<string, number> = {}): PrewarmQueue {
  return {
    watermark: () => 0,
    shardsEnqueuedSince: ({ runId }) => shards[runId] ?? 0,
  };
}
const noRows = fakeQueue();

beforeEach(() => __resetFleetPrewarmForTests());

describe('fleetShardCount', () => {
  it('counts container shards only, never native macOS jobs', () => {
    expect(fleetShardCount(config)).toBe(4);
  });

  it('leaves out skipped instances', () => {
    const skip = new Set([jobInstanceKey('test', 's2'), jobInstanceKey('lint', '')]);
    expect(fleetShardCount(config, skip)).toBe(2);
  });
});

describe('fleetPrewarmEnabled', () => {
  it('is on by default and off for falsy values', () => {
    expect(fleetPrewarmEnabled({} as NodeJS.ProcessEnv)).toBe(true);
    for (const v of ['0', 'false', 'off', 'NO']) {
      expect(fleetPrewarmEnabled({ FINALIZE_FLEET_PREWARM: v } as NodeJS.ProcessEnv)).toBe(false);
    }
  });
});

describe('fleetPrewarmDemand', () => {
  it('subtracts the distinct shards the run has enqueued', () => {
    reserveFleetPrewarm('r1', { count: 4, now: 0 });
    const shards: Record<string, number> = { r1: 0 };
    const queue = fakeQueue(shards);
    expect(fleetPrewarmDemand(undefined, queue, 1)).toBe(4);
    shards.r1 = 1; // warmup job enqueued alone: the rest stay warm
    expect(fleetPrewarmDemand(undefined, queue, 1)).toBe(3);
    shards.r1 = 4;
    expect(fleetPrewarmDemand(undefined, queue, 1)).toBe(0);
  });

  it('only counts reservations for classes the pool serves', () => {
    reserveFleetPrewarm('spot', { count: 3, now: 0 });
    reserveFleetPrewarm('od', { count: 2, runnerClass: 'ondemand', now: 0 });
    const none = fakeQueue();
    expect(fleetPrewarmDemand({ exclude: ['ondemand'] }, none, 1)).toBe(3);
    expect(fleetPrewarmDemand({ include: ['ondemand'] }, none, 1)).toBe(2);
  });

  it('drops released and expired reservations', () => {
    reserveFleetPrewarm('a', { count: 3, now: 0 });
    reserveFleetPrewarm('b', { count: 2, now: 0 });
    releaseFleetPrewarm('a');
    const none = fakeQueue();
    expect(fleetPrewarmDemand(undefined, none, 1)).toBe(2);
    expect(fleetPrewarmDemand(undefined, none, PREWARM_TTL_MS)).toBe(0);
    reserveFleetPrewarm('c', { count: 1, now: PREWARM_TTL_MS });
    expect(fleetPrewarmDemand(undefined, none, PREWARM_TTL_MS + 1)).toBe(1);
  });
});

describe('syncFleetPrewarm', () => {
  const none = fakeQueue();

  it('reserves on the remote backend', () => {
    expect(syncFleetPrewarm('r1', config, { env: remoteEnv, queue: noRows })).toBe(4);
    expect(fleetPrewarmDemand(undefined, none)).toBe(4);
  });

  it('resizes an existing reservation', () => {
    syncFleetPrewarm('r1', config, { env: remoteEnv, queue: noRows });
    syncFleetPrewarm('r1', config, {
      env: remoteEnv,
      queue: noRows,
      skip: new Set([jobInstanceKey('test', 's1')]),
    });
    expect(fleetPrewarmDemand(undefined, none)).toBe(3);
  });

  it('skips the prewarm instead of throwing when the queue is unreadable', () => {
    const broken = (): number => {
      throw new Error('orgs.db not initialized');
    };
    const brokenQueue: PrewarmQueue = { watermark: broken, shardsEnqueuedSince: broken };
    expect(syncFleetPrewarm('r1', config, { env: remoteEnv, queue: brokenQueue })).toBe(0);
    expect(fleetPrewarmDemand(undefined, noRows)).toBe(0);
  });

  it('releases on the local backend, when opted out, or without a config', () => {
    syncFleetPrewarm('r1', config, { env: remoteEnv, queue: noRows });
    expect(syncFleetPrewarm('r1', config, { env: {} as NodeJS.ProcessEnv, queue: noRows })).toBe(0);
    expect(fleetPrewarmDemand(undefined, none)).toBe(0);

    syncFleetPrewarm('r1', config, { env: remoteEnv, queue: noRows });
    syncFleetPrewarm('r1', config, {
      env: { ...remoteEnv, FINALIZE_FLEET_PREWARM: '0' },
      queue: noRows,
    });
    expect(fleetPrewarmDemand(undefined, none)).toBe(0);

    syncFleetPrewarm('r1', config, { env: remoteEnv, queue: noRows });
    syncFleetPrewarm('r1', null, { env: remoteEnv, queue: noRows });
    expect(fleetPrewarmDemand(undefined, none)).toBe(0);
  });
});

describe('fleet scaler with a prewarm reservation', () => {
  let dir: string;
  let sent: Array<{ service?: string; desiredCount?: number }>;
  const ENV_KEYS = [
    'FINALIZE_FLEET_ECS_CLUSTER',
    'FINALIZE_FLEET_ECS_SERVICE',
    'FINALIZE_FLEET_ONDEMAND_ECS_SERVICE',
    'FINALIZE_FLEET_MIN_AGENTS',
    'FINALIZE_FLEET_MAX_AGENTS',
    'FINALIZE_FLEET_DYNAMIC_SCALE_DOWN',
  ] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'fleet-prewarm-'));
    setOrgsDbPathForTests(path.join(dir, 'orgs.db'));
    initOrgsDb();
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    process.env.FINALIZE_FLEET_ECS_CLUSTER = 'c';
    process.env.FINALIZE_FLEET_ECS_SERVICE = 'agents';
    process.env.FINALIZE_FLEET_MAX_AGENTS = '8';
    __resetFleetScalerStateForTests();
    sent = [];
    __setFleetScalerEcsClientForTests({
      send: async (cmd: { input: { services?: string[]; desiredCount?: number } }) => {
        if (cmd.input.services) return { services: [{ desiredCount: 0 }] };
        sent.push({ desiredCount: cmd.input.desiredCount });
        return {};
      },
    } as unknown as ECSClient);
  });

  afterEach(() => {
    __resetFleetScalerStateForTests();
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    setOrgsDbPathForTests(null);
    rmSync(dir, { recursive: true, force: true });
  });

  const enq = (jobId: string, matrixKey = '', runnerClass?: string): string =>
    enqueueRunnerJob({
      orgId: 'orgA',
      projectId: 'p1',
      runId: 'run-1',
      jobId,
      matrixKey,
      image: 'img:latest',
      specJson: '{}',
      now: 1_000,
      ...(runnerClass ? { runnerClass } : {}),
    });
  const demand = (): number => fleetPrewarmDemand(undefined, DB_PREWARM_QUEUE, 3_000);

  it('scales up during review before any shard is enqueued', async () => {
    reserveFleetPrewarm('run-1', { count: 4, orgId: 'orgA', now: 1_000 });
    await reconcileFleetCapacity(2_000);
    expect(sent).toEqual([{ desiredCount: 4 }]);
  });

  it('does not double-count shards once enqueued, nor re-inflate as they finish', async () => {
    reserveFleetPrewarm('run-1', { count: 4, orgId: 'orgA', now: 1_000 });
    await reconcileFleetCapacity(2_000);
    const ids = ['a', 'b', 'c', 'd'].map((j) => enq(j));
    await reconcileFleetCapacity(3_000);
    expect(sent).toEqual([{ desiredCount: 4 }]); // still 4, not 8

    // Two shards finish: live depth 2, prewarm demand stays 0.
    for (const id of ids.slice(0, 2)) {
      reportRunnerJob({ jobId: id, state: 'succeeded', now: 4_000 });
    }
    await reconcileFleetCapacity(5_000);
    expect(sent).toEqual([{ desiredCount: 4 }]);
  });

  it('a later round is not consumed by rows from earlier rounds of the same run', async () => {
    // Round 1: four shards ran and finished under run-1.
    for (const id of ['a', 'b', 'c', 'd'].map((j) => enq(j))) {
      reportRunnerJob({ jobId: id, state: 'failed', now: 1_500 });
    }
    // Round 2 (after a fix turn) reserves the same four shards on the same run id.
    const env = { ...process.env, FINALIZE_RUNNER_BACKEND: 'remote' };
    syncFleetPrewarm('run-1', config, { env, orgId: 'orgA', now: 2_000 });
    await reconcileFleetCapacity(2_000);
    expect(sent).toEqual([{ desiredCount: 4 }]);

    // A resize keeps the round's baseline: one warmup row enqueued, three remain.
    enq('warmup');
    syncFleetPrewarm('run-1', config, {
      env,
      orgId: 'orgA',
      skip: new Set([jobInstanceKey('lint', '')]),
      now: 2_500,
    });
    expect(demand()).toBe(2);
  });

  it('warmup retries count as one shard, so downstream shards stay warm', () => {
    reserveFleetPrewarm('run-1', { count: 4, orgId: 'orgA', now: 1_000 });
    // The warmup shard is lost twice and retried: three rows, one shard.
    for (let i = 0; i < 2; i++) {
      reportRunnerJob({ jobId: enq('warmup'), state: 'lost', now: 1_500 });
    }
    enq('warmup');
    expect(demand()).toBe(3);
    // Downstream shards reach the queue; a matrix shard is distinct per key.
    enq('test', 's1');
    enq('test', 's2');
    expect(demand()).toBe(1);
  });

  it('native jobs in another runner class never consume the reservation', () => {
    reserveFleetPrewarm('run-1', { count: 2, orgId: 'orgA', now: 1_000 });
    enq('ios', '', 'macos');
    expect(demand()).toBe(2);
  });

  it('lets the fleet drain after release', async () => {
    reserveFleetPrewarm('run-1', { count: 3, orgId: 'orgA', now: 1_000 });
    await reconcileFleetCapacity(2_000);
    releaseFleetPrewarm('run-1'); // review requested changes
    await reconcileFleetCapacity(3_000);
    await reconcileFleetCapacity(3_000 + SCALE_DOWN_COOLDOWN_MS + 1);
    expect(sent).toEqual([{ desiredCount: 3 }, { desiredCount: 0 }]);
  });
});
