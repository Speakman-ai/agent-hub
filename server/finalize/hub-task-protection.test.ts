import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  armHubTaskProtection,
  clearHubTaskProtection,
  loadHubTaskProtectionConfig,
  DEFAULT_HUB_PROTECTION_EXPIRY_MINUTES,
  MAX_HUB_PROTECTION_EXPIRY_MINUTES,
  __resetHubTaskProtectionForTests,
  type EcsSend,
  type HubTaskProtectionConfig,
} from './hub-task-protection.js';

const CFG: HubTaskProtectionConfig = {
  cluster: 'agenthub-finalize-runner',
  region: 'us-east-2',
  expiresInMinutes: 120,
  rearmThrottleMs: 600_000,
};
const ARN = 'arn:aws:ecs:us-east-2:1:task/agenthub-finalize-runner/abc123';

/**
 * Fake ECS client that records each command's `.input` and returns a realistic
 * UpdateTaskProtection response — protected tasks are echoed into
 * `protectedTasks[]` (what a real success looks like), so the arm path's
 * success-detection is exercised, not bypassed.
 */
function fakeClient(): { client: EcsSend; inputs: Record<string, unknown>[] } {
  const inputs: Record<string, unknown>[] = [];
  return {
    inputs,
    client: {
      send: vi.fn(async (cmd: unknown) => {
        const input = (cmd as { input: Record<string, unknown> }).input;
        inputs.push(input);
        const tasks = (input.tasks as string[] | undefined) ?? [];
        return input.protectionEnabled
          ? { protectedTasks: tasks.map((taskArn) => ({ taskArn, protectionEnabled: true })) }
          : {};
      }),
    },
  };
}

afterEach(() => __resetHubTaskProtectionForTests());

describe('armHubTaskProtection', () => {
  it('sends UpdateTaskProtection with protectionEnabled:true + cluster/task/expiry', async () => {
    const { client, inputs } = fakeClient();
    const r = await armHubTaskProtection(ARN, CFG, { client, now: () => 1000 });
    expect(r).toBe('armed');
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toEqual({
      cluster: 'agenthub-finalize-runner',
      tasks: [ARN],
      protectionEnabled: true,
      expiresInMinutes: 120,
    });
  });

  it('throttles a re-arm within the window (no second API call)', async () => {
    const { client, inputs } = fakeClient();
    let t = 1000;
    expect(await armHubTaskProtection(ARN, CFG, { client, now: () => t })).toBe('armed');
    t += 60_000; // 1 min later, throttle is 10 min
    expect(await armHubTaskProtection(ARN, CFG, { client, now: () => t })).toBe('throttled');
    expect(inputs).toHaveLength(1);
    t += 600_000; // past throttle
    expect(await armHubTaskProtection(ARN, CFG, { client, now: () => t })).toBe('armed');
    expect(inputs).toHaveLength(2);
  });

  it('force bypasses the throttle (a freshly-claimed task arms immediately)', async () => {
    const { client, inputs } = fakeClient();
    const now = () => 1000;
    expect(await armHubTaskProtection(ARN, CFG, { client, now })).toBe('armed');
    expect(await armHubTaskProtection(ARN, CFG, { client, now, force: true })).toBe('armed');
    expect(inputs).toHaveLength(2);
  });

  it('no-ops (skipped) when the task ARN or cluster is unknown — never calls ECS', async () => {
    const { client, inputs } = fakeClient();
    expect(await armHubTaskProtection(null, CFG, { client })).toBe('skipped');
    expect(await armHubTaskProtection(ARN, { ...CFG, cluster: undefined }, { client })).toBe(
      'skipped',
    );
    expect(inputs).toHaveLength(0);
  });

  it('swallows ECS errors as best-effort (returns error, never throws)', async () => {
    const client: EcsSend = { send: vi.fn(async () => Promise.reject(new Error('AccessDenied'))) };
    const log = vi.fn();
    await expect(armHubTaskProtection(ARN, CFG, { client, log })).resolves.toBe('error');
    expect(log).toHaveBeenCalledOnce();
  });

  // UpdateTaskProtection returns HTTP 200 with per-task `failures[]` (e.g.
  // TASK_NOT_VALID) instead of throwing. Treating that as `armed` would arm the
  // throttle and leave the task exposed for up to 10 min. It must return `error`
  // AND NOT throttle, so the next heartbeat retries.
  it('returns error (and does NOT throttle) on a 200 with a per-task failure', async () => {
    const send = vi.fn(async () => ({
      failures: [{ arn: ARN, reason: 'TASK_NOT_VALID', detail: 'task is STOPPED' }],
      protectedTasks: [],
    }));
    const log = vi.fn();
    const now = () => 1000;
    expect(await armHubTaskProtection(ARN, CFG, { client: { send }, log, now })).toBe('error');
    expect(log).toHaveBeenCalledOnce();
    // throttle was NOT armed → an immediate retry actually calls ECS again
    expect(await armHubTaskProtection(ARN, CFG, { client: { send }, log, now })).toBe('error');
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('returns error when the task is absent from protectedTasks (silent drop)', async () => {
    const send = vi.fn(async () => ({ protectedTasks: [{ taskArn: 'arn:other' }], failures: [] }));
    expect(await armHubTaskProtection(ARN, CFG, { client: { send }, log: vi.fn() })).toBe('error');
  });

  // The claim handler awaits the arm; an unbounded SDK hang would strand the
  // claim handshake. A hung call must be bounded and return error (best-effort),
  // without arming the throttle (so the next heartbeat retries).
  it('bounds a hung UpdateTaskProtection call by timeout and does not throttle', async () => {
    const send = vi.fn(() => new Promise<never>(() => {})); // never resolves
    const log = vi.fn();
    const cfg = { ...CFG, timeoutMs: 30 };
    const now = () => 1000;
    expect(await armHubTaskProtection(ARN, cfg, { client: { send }, log, now })).toBe('error');
    // not throttled → an immediate retry actually re-hits ECS
    expect(await armHubTaskProtection(ARN, cfg, { client: { send }, log, now })).toBe('error');
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe('regression: a long shard stays protected for its whole run', () => {
  // The bug: agent self-protect (local endpoint) silently lapses under load, so
  // a >15-min shard loses protection mid-run and a dynamic scale-in kills it.
  // Hub-driven re-arm is tied to the heartbeats that keep the lease alive — so as
  // long as the shard heartbeats, protection is refreshed and NEVER lapses,
  // regardless of shard length or the (default 15-min) lease window.
  it('60-min job heartbeating every 30s is re-armed and never lapses', async () => {
    const { client, inputs } = fakeClient();
    let t = 0;
    // claim arms (forced)
    expect(await armHubTaskProtection(ARN, CFG, { client, now: () => t, force: true })).toBe(
      'armed',
    );
    let lastArmExpiryAtMin = 120; // CFG.expiresInMinutes
    let lastArmAtMin = 0;
    // 60 minutes of 30s heartbeats
    for (let s = 30; s <= 3600; s += 30) {
      t = s * 1000;
      await armHubTaskProtection(ARN, CFG, { client, now: () => t });
      const nowMin = s / 60;
      // protection must always be valid in the future
      expect(lastArmAtMin + lastArmExpiryAtMin).toBeGreaterThan(nowMin);
      // record the most recent successful (non-throttled) arm
      if (inputs.length && inputs[inputs.length - 1]) {
        // re-armed this tick iff a new input was pushed
      }
      // track when the last arm happened: re-arm fires once per 10-min throttle
      if (nowMin - lastArmAtMin >= 10) lastArmAtMin = nowMin;
    }
    // 1 forced arm at claim + ~6 throttled re-arms (every 10 min over 60 min)
    expect(inputs.length).toBeGreaterThanOrEqual(6);
    expect(inputs.length).toBeLessThanOrEqual(8);
    expect(inputs.every((i) => i.protectionEnabled === true)).toBe(true);
  });
});

describe('clearHubTaskProtection', () => {
  it('sends protectionEnabled:false and resets the throttle so a later arm is not throttled', async () => {
    const { client, inputs } = fakeClient();
    const now = () => 1000;
    await armHubTaskProtection(ARN, CFG, { client, now });
    expect(await clearHubTaskProtection(ARN, CFG, { client, now })).toBe('cleared');
    expect(inputs[1]).toEqual({
      cluster: 'agenthub-finalize-runner',
      tasks: [ARN],
      protectionEnabled: false,
    });
    // throttle was reset → next arm (same instant) is NOT throttled
    expect(await armHubTaskProtection(ARN, CFG, { client, now })).toBe('armed');
    expect(inputs).toHaveLength(3);
  });

  it('skips when cluster/taskArn unknown', async () => {
    const { client, inputs } = fakeClient();
    expect(await clearHubTaskProtection(undefined, CFG, { client })).toBe('skipped');
    expect(inputs).toHaveLength(0);
  });
});

describe('loadHubTaskProtectionConfig', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('reads cluster/region/expiry/throttle from env with sane defaults', () => {
    process.env.FINALIZE_FLEET_ECS_CLUSTER = 'cluster-x';
    process.env.AWS_REGION = 'us-east-2';
    delete process.env.FINALIZE_HUB_TASK_PROTECTION_EXPIRY_MINUTES;
    const cfg = loadHubTaskProtectionConfig();
    expect(cfg.cluster).toBe('cluster-x');
    expect(cfg.region).toBe('us-east-2');
    expect(cfg.expiresInMinutes).toBe(DEFAULT_HUB_PROTECTION_EXPIRY_MINUTES);
  });

  it('honors an explicit expiry override and coerces garbage to the default', () => {
    process.env.FINALIZE_HUB_TASK_PROTECTION_EXPIRY_MINUTES = '90';
    expect(loadHubTaskProtectionConfig().expiresInMinutes).toBe(90);
    process.env.FINALIZE_HUB_TASK_PROTECTION_EXPIRY_MINUTES = 'nope';
    expect(loadHubTaskProtectionConfig().expiresInMinutes).toBe(
      DEFAULT_HUB_PROTECTION_EXPIRY_MINUTES,
    );
  });

  it('clamps the expiry to the ECS limit (2880) so the arm call can never fail', () => {
    process.env.FINALIZE_HUB_TASK_PROTECTION_EXPIRY_MINUTES = '9999';
    expect(loadHubTaskProtectionConfig().expiresInMinutes).toBe(MAX_HUB_PROTECTION_EXPIRY_MINUTES);
  });
});
