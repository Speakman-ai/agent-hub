/**
 * deploy-runner-loss.ts — classification of a failed deploy step as runner loss.
 *
 * Pure unit tests: no DB, no backend, no spawn. The regression these lock in is
 * the historical behaviour where a runner-agent that died under a deploy step
 * surfaced as a plain step failure and terminalized the whole deployment.
 */
import { describe, it, expect } from 'vitest';
import type { RunnerJobLossProbe } from '../finalize/runner-queue.js';
import { spotReclaimDetail } from '../finalize/spot-interruption.js';
import {
  DEFAULT_DEPLOY_RUNNER_LOSS_RETRIES,
  classifyDeployRunnerLoss,
  describeDeployRunnerLoss,
  resolveDeployRunnerLossRetries,
} from './deploy-runner-loss.js';

function probe(overrides: Partial<RunnerJobLossProbe> = {}): RunnerJobLossProbe {
  return {
    state: 'running',
    lost: false,
    leaseExpired: false,
    spotInterrupted: false,
    heartbeatAt: null,
    detail: null,
    ...overrides,
  };
}

describe('classifyDeployRunnerLoss', () => {
  it('never classifies a step that reported an exit code', () => {
    // The runner was alive enough to report a status, so the deploy command
    // failed — re-running it would fail again or half-apply the deploy twice.
    expect(classifyDeployRunnerLoss({ exitCode: 1 })).toBeNull();
    expect(
      classifyDeployRunnerLoss({
        exitCode: 1,
        lossProbe: probe({ lost: true, state: 'lost' }),
      }),
    ).toBeNull();
    expect(classifyDeployRunnerLoss({ exitCode: 0 })).toBeNull();
  });

  it('returns null for a spawn error that is not about the runner', () => {
    expect(
      classifyDeployRunnerLoss({ exitCode: -1, spawnError: 'Error: ENOENT ./ship.sh' }),
    ).toBeNull();
  });

  it('returns null when there is no evidence at all', () => {
    expect(classifyDeployRunnerLoss({ exitCode: -1 })).toBeNull();
    expect(classifyDeployRunnerLoss({ exitCode: -1, lossProbe: probe() })).toBeNull();
  });

  it('classifies a spot interruption ahead of the generic lost flag', () => {
    const loss = classifyDeployRunnerLoss({
      exitCode: -1,
      spawnError: 'runner agent lost — lease expired with no heartbeat',
      lossProbe: probe({
        state: 'lost',
        lost: true,
        leaseExpired: true,
        spotInterrupted: true,
        detail: 'instance reclaimed',
      }),
    });
    expect(loss).toEqual({ kind: 'spot_reclaimed', detail: 'instance reclaimed' });
  });

  it('classifies a reaped lease from the probe', () => {
    expect(
      classifyDeployRunnerLoss({ exitCode: -1, lossProbe: probe({ lost: true, state: 'lost' }) }),
    ).toEqual({ kind: 'agent_lost', detail: 'runner job is lost' });
    expect(
      classifyDeployRunnerLoss({ exitCode: -1, lossProbe: probe({ leaseExpired: true }) }),
    ).toEqual({ kind: 'lease_expired', detail: 'runner lease expired with no heartbeat' });
  });

  it('falls back to the canonical failure messages when no probe is wired', () => {
    // Minted by runner-fleet-scaler.ts (lease reaper) and runner-routes.ts.
    expect(
      classifyDeployRunnerLoss({
        exitCode: -1,
        spawnError:
          'runner agent lost — lease expired with no heartbeat (agent crashed, was killed, or lost contact with the Hub)',
      })?.kind,
    ).toBe('agent_lost');
    expect(
      classifyDeployRunnerLoss({
        exitCode: -1,
        spawnError: spotReclaimDetail('runner agent lost after an EC2 Spot interruption notice'),
      })?.kind,
    ).toBe('spot_reclaimed');
    expect(classifyDeployRunnerLoss({ exitCode: -1, spawnError: 'runner lease lost' })?.kind).toBe(
      'lease_expired',
    );
  });

  it('does not treat a deploy script that merely prints "lost" as runner loss', () => {
    expect(
      classifyDeployRunnerLoss({ exitCode: -1, spawnError: 'connection to registry lost' }),
    ).toBeNull();
  });
});

describe('resolveDeployRunnerLossRetries', () => {
  it('defaults when unset or unparseable', () => {
    expect(resolveDeployRunnerLossRetries({})).toBe(DEFAULT_DEPLOY_RUNNER_LOSS_RETRIES);
    expect(resolveDeployRunnerLossRetries({ DEPLOY_RUNNER_LOSS_MAX_RETRIES: '  ' })).toBe(
      DEFAULT_DEPLOY_RUNNER_LOSS_RETRIES,
    );
    expect(resolveDeployRunnerLossRetries({ DEPLOY_RUNNER_LOSS_MAX_RETRIES: 'nope' })).toBe(
      DEFAULT_DEPLOY_RUNNER_LOSS_RETRIES,
    );
  });

  it('honours an explicit budget and floors it at zero', () => {
    expect(resolveDeployRunnerLossRetries({ DEPLOY_RUNNER_LOSS_MAX_RETRIES: '5' })).toBe(5);
    expect(resolveDeployRunnerLossRetries({ DEPLOY_RUNNER_LOSS_MAX_RETRIES: '0' })).toBe(0);
    expect(resolveDeployRunnerLossRetries({ DEPLOY_RUNNER_LOSS_MAX_RETRIES: '-3' })).toBe(0);
  });
});

describe('describeDeployRunnerLoss', () => {
  it('names the retries that were spent', () => {
    const loss = { kind: 'spot_reclaimed', detail: 'instance reclaimed' } as const;
    expect(describeDeployRunnerLoss(loss, 0)).toContain('no retry budget remained');
    expect(describeDeployRunnerLoss(loss, 1)).toContain('after 1 retry on a fresh runner');
    expect(describeDeployRunnerLoss(loss, 2)).toContain('after 2 retries on a fresh runner');
    expect(describeDeployRunnerLoss(loss, 2)).toContain('instance reclaimed');
  });
});
