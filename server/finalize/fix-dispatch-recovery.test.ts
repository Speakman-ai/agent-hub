import { describe, expect, it, vi } from 'vitest';
import {
  buildFixRedispatchBody,
  dispatchFixWithRecovery,
  isRecoverableFixTurnFailure,
  resolveMaxFixRedispatches,
  type FixDispatchDeps,
  type FixDispatchOptions,
  type FixDispatchResult,
} from './fix-dispatch.js';

const OPTS: FixDispatchOptions = {
  runId: 'run-1',
  sessionId: 'sess-1',
  projectId: 'proj-1',
  cardId: 'card-1',
  triggerSource: 'agent_block',
  trigger: {
    failedStep: { phase: 'tasks', name: 'unit-tests', exitCode: 1, outputTail: ['boom'] },
  },
};
const DEPS = {} as FixDispatchDeps;

const killed = (reason?: FixDispatchResult['terminationReason']): FixDispatchResult => ({
  outcome: 'spawn_failed',
  messageId: 'm',
  activeSecondsBilled: 1,
  ...(reason ? { terminationReason: reason } : {}),
});
const ENDED: FixDispatchResult = { outcome: 'turn_ended', messageId: 'm2', activeSecondsBilled: 0 };

describe('dispatchFixWithRecovery', () => {
  it('hands a killed fix turn back to the session with the failure and the original notes', async () => {
    const dispatch = vi
      .fn()
      .mockResolvedValueOnce(killed('chat_wall_timeout'))
      .mockResolvedValueOnce(ENDED);
    const result = await dispatchFixWithRecovery(dispatch, DEPS, OPTS, {
      maxRedispatches: 2,
      log: () => {},
    });
    expect(result).toEqual(ENDED);
    expect(dispatch).toHaveBeenCalledTimes(2);
    const retry = dispatch.mock.calls[1][1] as FixDispatchOptions;
    expect(retry.bodyOverride).toContain('chat wall timeout');
    expect(retry.bodyOverride).toContain('Retry 1 of 2');
    expect(retry.bodyOverride).toContain('step "unit-tests" failed');
    expect(retry.skipActiveSecondsCharge).toBe(true);
  });

  it('stops after the redispatch budget and returns the last failure', async () => {
    const dispatch = vi.fn().mockResolvedValue(killed());
    const result = await dispatchFixWithRecovery(dispatch, DEPS, OPTS, {
      maxRedispatches: 2,
      log: () => {},
    });
    expect(result.outcome).toBe('spawn_failed');
    expect(dispatch).toHaveBeenCalledTimes(3);
  });

  it('does not retry a human Stop, a clean turn end, or an aborted run', async () => {
    const stopped = vi.fn().mockResolvedValue(killed('user_cancel'));
    await dispatchFixWithRecovery(stopped, DEPS, OPTS, { maxRedispatches: 2, log: () => {} });
    expect(stopped).toHaveBeenCalledTimes(1);

    const clean = vi.fn().mockResolvedValue(ENDED);
    await dispatchFixWithRecovery(clean, DEPS, OPTS, { maxRedispatches: 2, log: () => {} });
    expect(clean).toHaveBeenCalledTimes(1);

    const aborted = vi.fn().mockResolvedValue(killed());
    await dispatchFixWithRecovery(
      aborted,
      DEPS,
      { ...OPTS, signal: { aborted: true, onAbort: () => () => {} } },
      { maxRedispatches: 2, log: () => {} },
    );
    expect(aborted).toHaveBeenCalledTimes(1);
  });

  it('keeps a no-progress nudge body when re-dispatching it', async () => {
    const dispatch = vi.fn().mockResolvedValueOnce(killed()).mockResolvedValueOnce(ENDED);
    await dispatchFixWithRecovery(
      dispatch,
      DEPS,
      { ...OPTS, bodyOverride: 'commit your uncommitted changes' },
      { maxRedispatches: 1, log: () => {} },
    );
    const retry = dispatch.mock.calls[1][1] as FixDispatchOptions;
    expect(retry.bodyOverride).toContain('failed to start or exited with an error');
    expect(retry.bodyOverride).toContain('commit your uncommitted changes');
  });
});

describe('fix redispatch helpers', () => {
  it('classifies only non-human kills as recoverable', () => {
    expect(isRecoverableFixTurnFailure(killed())).toBe(true);
    expect(isRecoverableFixTurnFailure(killed('autopilot_unstick'))).toBe(true);
    expect(isRecoverableFixTurnFailure(killed('user_cancel'))).toBe(false);
    expect(isRecoverableFixTurnFailure(ENDED)).toBe(false);
  });

  it('reads the redispatch cap from env with a safe default', () => {
    expect(resolveMaxFixRedispatches({})).toBe(2);
    expect(resolveMaxFixRedispatches({ FINALIZE_MAX_FIX_REDISPATCHES: '0' })).toBe(0);
    expect(resolveMaxFixRedispatches({ FINALIZE_MAX_FIX_REDISPATCHES: 'nope' })).toBe(2);
    expect(resolveMaxFixRedispatches({ FINALIZE_MAX_FIX_REDISPATCHES: '99' })).toBe(10);
  });

  it('builds a body that leads with the failure', () => {
    const body = buildFixRedispatchBody({
      originalBody: 'NOTES',
      reason: undefined,
      attempt: 2,
      maxAttempts: 2,
    });
    expect(body.split('\n')[0]).toMatch(/^Finalize Code Changes: your previous fix turn/);
    expect(body.endsWith('NOTES')).toBe(true);
  });
});
