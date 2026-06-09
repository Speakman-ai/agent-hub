import { describe, it, expect } from 'vitest';
import {
  applyQuarantineToGate,
  clampQuarantineDays,
  computeExpiry,
  DAY_MS,
  daysUntilExpiry,
  describeExcused,
  findActiveQuarantineForInstance,
  isInstanceQuarantined,
  isQuarantineActive,
  partitionQuarantine,
  QUARANTINE_DEFAULT_DAYS,
  QUARANTINE_MAX_DAYS,
  quarantineStatus,
  type QuarantineEntry,
} from './quarantine.js';
import type { FlakeGateResult, JobFlakeVerdict } from './flake-recovery.js';

const NOW = 1_000_000_000_000;

function entry(over: Partial<QuarantineEntry> = {}): QuarantineEntry {
  return {
    id: over.id ?? 'q1',
    projectId: over.projectId ?? 'proj',
    jobId: over.jobId ?? 'e2e',
    matrixKey: over.matrixKey ?? '',
    owner: over.owner ?? 'alice',
    reason: over.reason ?? 'flaky cypress login',
    quarantinedAt: over.quarantinedAt ?? NOW,
    expiresAt: over.expiresAt ?? NOW + 10 * DAY_MS,
    createdBy: over.createdBy ?? null,
  };
}

describe('clampQuarantineDays', () => {
  it('defaults when missing/invalid/non-positive', () => {
    expect(clampQuarantineDays()).toBe(QUARANTINE_DEFAULT_DAYS);
    expect(clampQuarantineDays(null)).toBe(QUARANTINE_DEFAULT_DAYS);
    expect(clampQuarantineDays(0)).toBe(QUARANTINE_DEFAULT_DAYS);
    expect(clampQuarantineDays(-5)).toBe(QUARANTINE_DEFAULT_DAYS);
    expect(clampQuarantineDays(NaN)).toBe(QUARANTINE_DEFAULT_DAYS);
    expect(clampQuarantineDays(Infinity)).toBe(QUARANTINE_DEFAULT_DAYS);
  });

  it('caps at the 30-day maximum', () => {
    expect(clampQuarantineDays(45)).toBe(QUARANTINE_MAX_DAYS);
    expect(clampQuarantineDays(31)).toBe(QUARANTINE_MAX_DAYS);
    expect(QUARANTINE_MAX_DAYS).toBe(30);
  });

  it('floors fractional days and passes through valid values', () => {
    expect(clampQuarantineDays(7)).toBe(7);
    expect(clampQuarantineDays(7.9)).toBe(7);
    expect(clampQuarantineDays(30)).toBe(30);
  });
});

describe('computeExpiry', () => {
  it('adds clamped days to the start time', () => {
    expect(computeExpiry(NOW, 5)).toBe(NOW + 5 * DAY_MS);
  });

  it('honours the 30-day cap even when days exceeds it', () => {
    expect(computeExpiry(NOW, 9999)).toBe(NOW + QUARANTINE_MAX_DAYS * DAY_MS);
  });
});

describe('quarantineStatus / isQuarantineActive', () => {
  it('is active before expiry', () => {
    const e = entry({ expiresAt: NOW + DAY_MS });
    expect(quarantineStatus(e, NOW)).toBe('active');
    expect(isQuarantineActive(e, NOW)).toBe(true);
  });

  it('is overdue at/after expiry', () => {
    const e = entry({ expiresAt: NOW });
    expect(quarantineStatus(e, NOW)).toBe('overdue');
    expect(quarantineStatus(e, NOW + 1)).toBe('overdue');
    expect(isQuarantineActive(e, NOW)).toBe(false);
  });

  it('daysUntilExpiry can go negative for overdue entries', () => {
    expect(daysUntilExpiry(entry({ expiresAt: NOW + 3 * DAY_MS }), NOW)).toBe(3);
    expect(daysUntilExpiry(entry({ expiresAt: NOW - 2 * DAY_MS }), NOW)).toBe(-2);
  });
});

describe('partitionQuarantine', () => {
  it('splits active vs overdue', () => {
    const active = entry({ id: 'a', expiresAt: NOW + DAY_MS });
    const overdue = entry({ id: 'b', expiresAt: NOW - DAY_MS });
    const { active: a, overdue: o } = partitionQuarantine([active, overdue], NOW);
    expect(a.map((e) => e.id)).toEqual(['a']);
    expect(o.map((e) => e.id)).toEqual(['b']);
  });
});

describe('findActiveQuarantineForInstance / isInstanceQuarantined', () => {
  const entries = [
    entry({ id: 'a', jobId: 'e2e', matrixKey: '', expiresAt: NOW + DAY_MS }),
    entry({ id: 'b', jobId: 'e2e', matrixKey: 'shard-2', expiresAt: NOW + DAY_MS }),
    entry({ id: 'c', jobId: 'backend', matrixKey: '', expiresAt: NOW - DAY_MS }), // overdue
  ];

  it('matches an active entry by job + matrix key', () => {
    expect(findActiveQuarantineForInstance(entries, 'e2e', '', NOW)?.id).toBe('a');
    expect(findActiveQuarantineForInstance(entries, 'e2e', 'shard-2', NOW)?.id).toBe('b');
    expect(isInstanceQuarantined(entries, 'e2e', '', NOW)).toBe(true);
  });

  it('does not match a different matrix shard', () => {
    expect(findActiveQuarantineForInstance(entries, 'e2e', 'shard-9', NOW)).toBeNull();
  });

  it('does not match an overdue (expired) entry', () => {
    expect(findActiveQuarantineForInstance(entries, 'backend', '', NOW)).toBeNull();
    expect(isInstanceQuarantined(entries, 'backend', '', NOW)).toBe(false);
  });
});

describe('applyQuarantineToGate', () => {
  const verdict = (jobId: string, matrixKey = ''): JobFlakeVerdict => ({
    jobId,
    matrixKey,
    classification: 'flake_recovered',
    failedRounds: [1],
    passedRound: 2,
    failureCount: 1,
  });

  it('leaves a clean gate untouched', () => {
    const gate: FlakeGateResult = { status: 'clean', jobs: [] };
    const out = applyQuarantineToGate(gate, [entry()], NOW);
    expect(out.gate).toEqual(gate);
    expect(out.excused).toEqual([]);
  });

  it('never downgrades a blocked gate (fail-closed)', () => {
    const gate: FlakeGateResult = { status: 'blocked', jobs: [], reason: 'history missing' };
    const out = applyQuarantineToGate(gate, [entry()], NOW);
    expect(out.gate.status).toBe('blocked');
    expect(out.excused).toEqual([]);
  });

  it('downgrades to clean when every flagged instance is quarantined', () => {
    const gate: FlakeGateResult = { status: 'flake_recovered', jobs: [verdict('e2e')] };
    const out = applyQuarantineToGate(gate, [entry({ jobId: 'e2e' })], NOW);
    expect(out.gate.status).toBe('clean');
    expect(out.gate.jobs).toEqual([]);
    expect(out.excused.map((v) => v.jobId)).toEqual(['e2e']);
  });

  it('keeps non-quarantined offenders blocking', () => {
    const gate: FlakeGateResult = {
      status: 'flake_recovered',
      jobs: [verdict('e2e'), verdict('backend')],
    };
    const out = applyQuarantineToGate(gate, [entry({ jobId: 'e2e' })], NOW);
    expect(out.gate.status).toBe('flake_recovered');
    expect(out.gate.jobs.map((v) => v.jobId)).toEqual(['backend']);
    expect(out.excused.map((v) => v.jobId)).toEqual(['e2e']);
  });

  it('does NOT excuse an instance whose quarantine has expired', () => {
    const gate: FlakeGateResult = { status: 'flake_recovered', jobs: [verdict('e2e')] };
    const out = applyQuarantineToGate(
      gate,
      [entry({ jobId: 'e2e', expiresAt: NOW - DAY_MS })],
      NOW,
    );
    expect(out.gate.status).toBe('flake_recovered');
    expect(out.excused).toEqual([]);
  });

  it('matches matrix shards precisely', () => {
    const gate: FlakeGateResult = {
      status: 'flake_recovered',
      jobs: [verdict('e2e', 'shard-1'), verdict('e2e', 'shard-2')],
    };
    const out = applyQuarantineToGate(gate, [entry({ jobId: 'e2e', matrixKey: 'shard-1' })], NOW);
    expect(out.gate.jobs.map((v) => v.matrixKey)).toEqual(['shard-2']);
  });
});

describe('describeExcused', () => {
  it('summarizes empty and populated excusals', () => {
    expect(describeExcused([])).toBe('no quarantined jobs excused');
    expect(
      describeExcused([
        {
          jobId: 'e2e',
          matrixKey: 'shard-1',
          classification: 'flake_recovered',
          failedRounds: [],
          passedRound: 2,
          failureCount: 0,
        },
        {
          jobId: 'backend',
          matrixKey: '',
          classification: 'flake_recovered',
          failedRounds: [],
          passedRound: 2,
          failureCount: 0,
        },
      ]),
    ).toBe('e2e [shard-1], backend');
  });
});
