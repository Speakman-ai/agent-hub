import { describe, expect, it } from 'vitest';
import { AutopilotError } from './errors.js';
import {
  assertLocalTargetContract,
  assertLocalTargetReadyToRun,
  assessStorageRecoverability,
  resolveStorageRecovery,
} from './local-target.js';
import type { AutopilotBaselineSpec } from './orchestrator.js';

const TARGET = {
  targetId: 'local-preview',
  origin: 'http://127.0.0.1:4310',
  readinessProbeUrl: 'http://127.0.0.1:4310/health',
};

const SPEC: AutopilotBaselineSpec = {
  assumptions: ['single-user'],
  acceptanceJourneys: [{ action: 'add a todo', expectedResult: 'it appears' }],
  nonGoals: ['auth'],
  specDecisions: [{ key: 'storage', decision: 'in-memory sqlite' }],
  storageRecovery: 'disposable',
  qualityRubricVersion: 1,
};

describe('assertLocalTargetContract', () => {
  it('accepts a loopback origin and same-origin readiness probe', () => {
    expect(assertLocalTargetContract(TARGET)).toEqual(TARGET);
  });

  it('rejects a missing origin or readiness probe', () => {
    expect(() =>
      assertLocalTargetContract({ ...TARGET, origin: null, readinessProbeUrl: null }),
    ).toThrow(/target.origin is required/);
    expect(() => assertLocalTargetContract({ ...TARGET, readinessProbeUrl: null })).toThrow(
      /readinessProbeUrl is required/,
    );
  });

  it('rejects a public origin', () => {
    expect(() =>
      assertLocalTargetContract({
        ...TARGET,
        origin: 'https://example.com',
        readinessProbeUrl: 'https://example.com/health',
      }),
    ).toThrow(/local loopback origin/);
  });

  it('rejects a readiness probe on a different origin', () => {
    expect(() =>
      assertLocalTargetContract({
        ...TARGET,
        readinessProbeUrl: 'http://127.0.0.1:9999/health',
      }),
    ).toThrow(/same local origin/);
  });
});

describe('assertLocalTargetReadyToRun', () => {
  const matching = {
    origin: TARGET.origin,
    readinessProbeUrl: TARGET.readinessProbeUrl,
    currentRef: null,
    currentDeploymentId: null,
  };

  it('requires the target to be a declared deploy.yaml environment', () => {
    expect(() =>
      assertLocalTargetReadyToRun('demo-app', TARGET, {
        getDeclaredEnvironment: () => null,
      }),
    ).toThrow(AutopilotError);
    expect(
      assertLocalTargetReadyToRun('demo-app', TARGET, {
        getDeclaredEnvironment: () => matching,
      }),
    ).toEqual(TARGET);
  });

  it('rejects a declared environment that points elsewhere', () => {
    expect(() =>
      assertLocalTargetReadyToRun('demo-app', TARGET, {
        getDeclaredEnvironment: () => ({
          origin: 'http://127.0.0.1:9999',
          readinessProbeUrl: 'http://127.0.0.1:9999/health',
          currentRef: 'already-live',
          currentDeploymentId: 'dep-other',
        }),
      }),
    ).toThrow(/points at http:\/\/127\.0\.0\.1:9999/);
  });

  it('rejects a declared environment with no origin or readiness contract', () => {
    expect(() =>
      assertLocalTargetReadyToRun('demo-app', TARGET, {
        getDeclaredEnvironment: () => ({
          origin: null,
          readinessProbeUrl: null,
          currentRef: null,
          currentDeploymentId: null,
        }),
      }),
    ).toThrow(/does not declare origin, readiness, and revision identity/);
  });

  it('accepts a first-cycle bound environment with no live revision yet', () => {
    expect(
      assertLocalTargetReadyToRun('demo-app', TARGET, {
        getDeclaredEnvironment: () => matching,
      }),
    ).toEqual(TARGET);
  });

  it('rejects a live deployment that has no reported revision', () => {
    expect(() =>
      assertLocalTargetReadyToRun('demo-app', TARGET, {
        getDeclaredEnvironment: () => ({
          ...matching,
          currentRef: null,
          currentDeploymentId: 'dep-1',
        }),
      }),
    ).toThrow(/live deployment without a reported revision/);
  });
});

describe('resolveStorageRecovery', () => {
  it('accepts an exact top-level kind', () => {
    expect(resolveStorageRecovery({ storageRecovery: 'disposable' })).toEqual({
      ok: true,
      kind: 'disposable',
    });
    expect(resolveStorageRecovery({ storageRecovery: 'backward-compatible' })).toEqual({
      ok: true,
      kind: 'backward-compatible',
    });
  });

  it('accepts an exact storage-recovery spec decision', () => {
    expect(
      resolveStorageRecovery({
        specDecisions: [{ key: 'storage-recovery', decision: 'disposable' }],
      }),
    ).toEqual({ ok: true, kind: 'disposable' });
  });

  it('rejects mixed prose even when it contains a positive keyword', () => {
    expect(
      resolveStorageRecovery({
        specDecisions: [
          {
            key: 'storage',
            decision: 'persistent PostgreSQL; destructive migration; disposable test fixtures',
          },
        ],
      }),
    ).toEqual({
      ok: false,
      reason: 'data compatibility cannot be established for rollback',
    });
    expect(
      resolveStorageRecovery({
        storageRecovery: 'persistent PostgreSQL; destructive migration; disposable test fixtures',
      }),
    ).toEqual({
      ok: false,
      reason: 'data compatibility cannot be established for rollback',
    });
  });

  it('rejects distant negation that is not an exact kind', () => {
    expect(
      resolveStorageRecovery({
        specDecisions: [
          {
            key: 'storage',
            decision: 'migration is not guaranteed to be backward-compatible',
          },
        ],
      }),
    ).toEqual({
      ok: false,
      reason: 'data compatibility cannot be established for rollback',
    });
    expect(
      resolveStorageRecovery({
        storageRecovery: 'migration is not guaranteed to be backward-compatible',
      }),
    ).toEqual({
      ok: false,
      reason: 'data compatibility cannot be established for rollback',
    });
  });

  it('rejects contradictory structured sources', () => {
    expect(
      resolveStorageRecovery({
        storageRecovery: 'disposable',
        specDecisions: [{ key: 'storage-recovery', decision: 'unsupported' }],
      }),
    ).toEqual({
      ok: false,
      reason: 'contradictory storage recovery contract',
    });
  });
});

describe('assessStorageRecoverability', () => {
  it('allows an explicit disposable recovery contract on a first deploy', () => {
    expect(assessStorageRecoverability(SPEC)).toEqual({
      ok: true,
      kind: 'disposable',
    });
  });

  it('allows an explicit backward-compatible recovery contract', () => {
    expect(
      assessStorageRecoverability({ ...SPEC, storageRecovery: 'backward-compatible' }),
    ).toEqual({ ok: true, kind: 'backward-compatible' });
  });

  it('pauses a first deploy when the contract is unsupported', () => {
    expect(assessStorageRecoverability({ ...SPEC, storageRecovery: 'unsupported' })).toEqual({
      ok: false,
      reason: 'unsupported data migration cannot be rolled back with a code redeploy',
    });
  });

  it('pauses a first deploy when the contract is unknown', () => {
    expect(assessStorageRecoverability({ ...SPEC, storageRecovery: 'unknown' })).toEqual({
      ok: false,
      reason: 'data compatibility cannot be established for rollback',
    });
  });

  it('does not treat a missing spec as recoverable', () => {
    expect(assessStorageRecoverability(null)).toEqual({
      ok: false,
      reason: 'data compatibility cannot be established for rollback',
    });
  });

  it('does not let mixed storage prose authorize deploy', () => {
    const spec = {
      specDecisions: [
        {
          key: 'storage',
          decision: 'persistent PostgreSQL; destructive migration; disposable test fixtures',
        },
      ],
    };
    expect(assessStorageRecoverability(spec)).toEqual({
      ok: false,
      reason: 'data compatibility cannot be established for rollback',
    });
  });

  it('does not treat distant negation as a supported recovery kind', () => {
    const spec = {
      specDecisions: [
        { key: 'storage', decision: 'migration is not guaranteed to be backward-compatible' },
      ],
    };
    expect(assessStorageRecoverability(spec)).toEqual({
      ok: false,
      reason: 'data compatibility cannot be established for rollback',
    });
  });

  it('pauses when structured recovery sources contradict', () => {
    expect(
      assessStorageRecoverability({
        storageRecovery: 'disposable',
        specDecisions: [
          { key: 'storage', decision: 'sqlite' },
          { key: 'storage-recovery', decision: 'unsupported' },
        ],
      }),
    ).toEqual({
      ok: false,
      reason: 'contradictory storage recovery contract',
    });
  });
});
