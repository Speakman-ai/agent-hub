import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  authenticateFleetToken,
  isRunnerFleetEnabled,
  signAgentToken,
  verifyAgentToken,
} from './runner-auth.js';

describe('agent token runnerClass', () => {
  const prev = process.env.FINALIZE_RUNNER_TOKEN_SECRET;
  beforeEach(() => {
    process.env.FINALIZE_RUNNER_TOKEN_SECRET = 'test-secret';
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.FINALIZE_RUNNER_TOKEN_SECRET;
    else process.env.FINALIZE_RUNNER_TOKEN_SECRET = prev;
  });

  it('round-trips a macos runner class baked into the token', () => {
    const token = signAgentToken({ agentId: 'a1', orgScope: 'shared', runnerClass: 'macos' });
    const payload = verifyAgentToken(token);
    expect(payload).not.toBeNull();
    expect(payload!.agentId).toBe('a1');
    expect(payload!.runnerClass).toBe('macos');
  });

  it('omits runnerClass when unset (legacy default agents)', () => {
    const token = signAgentToken({ agentId: 'a2', orgScope: 'shared' });
    const payload = verifyAgentToken(token);
    expect(payload).not.toBeNull();
    expect(payload!.runnerClass).toBeUndefined();
  });
});

describe('authenticateFleetToken', () => {
  it('accepts the global token with no forced scope', () => {
    const env = { FINALIZE_RUNNER_FLEET_TOKEN: 'global-secret' } as NodeJS.ProcessEnv;
    expect(authenticateFleetToken('global-secret', env)).toEqual({ ok: true });
    expect(authenticateFleetToken('wrong', env)).toEqual({ ok: false });
    expect(authenticateFleetToken(undefined, env)).toEqual({ ok: false });
  });

  it('accepts an org-scoped token and pins it to its org', () => {
    const env = {
      FINALIZE_RUNNER_FLEET_TOKEN: 'global-secret',
      FINALIZE_RUNNER_ORG_FLEET_TOKENS: JSON.stringify({
        acme: 'acme-secret',
        beta: 'beta-secret',
      }),
    } as NodeJS.ProcessEnv;
    expect(authenticateFleetToken('acme-secret', env)).toEqual({
      ok: true,
      forcedOrgScope: 'acme',
    });
    expect(authenticateFleetToken('beta-secret', env)).toEqual({
      ok: true,
      forcedOrgScope: 'beta',
    });
    // Global token still works without a forced scope.
    expect(authenticateFleetToken('global-secret', env)).toEqual({ ok: true });
    expect(authenticateFleetToken('nope', env)).toEqual({ ok: false });
  });

  it('isRunnerFleetEnabled is true when only org-scoped tokens are configured', () => {
    expect(
      isRunnerFleetEnabled({
        FINALIZE_RUNNER_ORG_FLEET_TOKENS: JSON.stringify({ acme: 's' }),
      } as NodeJS.ProcessEnv),
    ).toBe(true);
    expect(isRunnerFleetEnabled({} as NodeJS.ProcessEnv)).toBe(false);
  });

  it('ignores malformed org-token JSON rather than throwing', () => {
    const env = { FINALIZE_RUNNER_ORG_FLEET_TOKENS: 'not json' } as NodeJS.ProcessEnv;
    expect(authenticateFleetToken('anything', env)).toEqual({ ok: false });
    expect(isRunnerFleetEnabled(env)).toBe(false);
  });
});
