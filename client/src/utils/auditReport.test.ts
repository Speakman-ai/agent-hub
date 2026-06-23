import { describe, it, expect } from 'vitest';
import {
  DEFAULT_CATEGORIES,
  computeReadinessScore,
  scoreBand,
  normalizeReport,
  findingsByCategory,
  maxSeverity,
} from './auditReport';

describe('auditReport — DEFAULT_CATEGORIES', () => {
  it('exposes the expected five categories in storyboard order', () => {
    expect(DEFAULT_CATEGORIES.map((c: any) => c.id)).toEqual([
      'lint',
      'tests',
      'deps',
      'auth',
      'aws',
    ]);
  });

  it('weights sum to 100', () => {
    const sum = DEFAULT_CATEGORIES.reduce((n: any, c: any) => n + c.weight, 0);
    expect(sum!).toBe(100);
  });
});

describe('auditReport — computeReadinessScore', () => {
  it('returns 100 when every weighted category is ok', () => {
    const cats = DEFAULT_CATEGORIES.map((c: any) => ({ ...c, status: 'ok' }));
    expect(computeReadinessScore(cats)).toBe(100);
  });

  it('returns 0 when every weighted category is fail', () => {
    const cats = DEFAULT_CATEGORIES.map((c: any) => ({ ...c, status: 'fail' }));
    expect(computeReadinessScore(cats)).toBe(0);
  });

  it('excludes na from the denominator so mandatory passes score 100', () => {
    const cats = [
      { id: 'lint', weight: 10, status: 'ok' },
      { id: 'tests', weight: 30, status: 'ok' },
      { id: 'aws', weight: 20, status: 'na' },
    ];
    expect(computeReadinessScore(cats)).toBe(100);
  });

  it('gives warn half credit', () => {
    const cats = [
      { id: 'a', weight: 50, status: 'warn' },
      { id: 'b', weight: 50, status: 'ok' },
    ];
    // 50*0.5 + 50*1 = 75 / 100 = 75
    expect(computeReadinessScore(cats)).toBe(75);
  });

  it('returns null when every category is na', () => {
    const cats = DEFAULT_CATEGORIES.map((c: any) => ({ ...c, status: 'na' }));
    expect(computeReadinessScore(cats)).toBeNull();
  });

  it('returns null on an empty list', () => {
    expect(computeReadinessScore([])).toBeNull();
    expect(computeReadinessScore()).toBeNull();
  });

  it('falls back to a default weight for unknown ids', () => {
    const cats = [{ id: 'custom', status: 'ok' }];
    expect(computeReadinessScore(cats)).toBe(100);
  });
});

describe('auditReport — scoreBand', () => {
  it('buckets 80+ as green', () => {
    expect(scoreBand(80)).toBe('green');
    expect(scoreBand(100)).toBe('green');
  });

  it('buckets 50..79 as amber', () => {
    expect(scoreBand(50)).toBe('amber');
    expect(scoreBand(79)).toBe('amber');
  });

  it('buckets <50 as red', () => {
    expect(scoreBand(0)).toBe('red');
    expect(scoreBand(49)).toBe('red');
  });

  it('returns unknown for null/undefined', () => {
    expect(scoreBand(null)).toBe('unknown');
    expect(scoreBand(undefined)).toBe('unknown');
  });
});

describe('auditReport — normalizeReport', () => {
  it('returns null for non-object inputs', () => {
    expect(normalizeReport(null)).toBeNull();
    expect(normalizeReport(undefined)).toBeNull();
    expect(normalizeReport('foo')).toBeNull();
  });

  it('fills defaults for missing fields', () => {
    const report = normalizeReport({});
    expect(report!.projectId).toBeNull();
    expect(report!.categories).toEqual([]);
    expect(report!.findings).toEqual([]);
    expect(report!.gaps).toEqual([]);
    expect(report!.score).toBeNull();
  });

  it('derives score from categories when not supplied', () => {
    const report = normalizeReport({
      categories: [{ id: 'lint', status: 'ok' }],
    });
    expect(report!.score).toBe(100);
  });

  it('prefers the server-supplied score when present', () => {
    const report = normalizeReport({
      score: 42,
      categories: [{ id: 'lint', status: 'ok' }],
    });
    expect(report!.score).toBe(42);
  });

  it('clamps bad scores to 0..100', () => {
    expect((normalizeReport({ score: -5, categories: [] }) as any).score).toBe(0);
    expect((normalizeReport({ score: 500, categories: [] }) as any).score).toBe(100);
  });

  it('normalizes unknown category status to na', () => {
    const report = normalizeReport({
      categories: [{ id: 'lint', status: 'something-weird' }],
    });
    expect(report!.categories[0].status).toBe('na');
  });

  it('normalizes unknown severity to info', () => {
    const report = normalizeReport({
      findings: [{ message: 'x', severity: 'oops' }],
    });
    expect(report!.findings[0].severity).toBe('info');
  });

  it('generates stable ids for findings/gaps without one', () => {
    const report = normalizeReport({
      findings: [{ message: 'a' }, { message: 'b' }],
      gaps: [{ label: 'g1' }, { label: 'g2' }],
    });
    expect(report!.findings.map((f: any) => f.id)).toEqual(['f-0', 'f-1']);
    expect(report!.gaps.map((g: any) => g.id)).toEqual(['g-0', 'g-1']);
  });
});

describe('auditReport — findingsByCategory + maxSeverity', () => {
  it('groups findings by category id', () => {
    const grouped = findingsByCategory([
      { id: '1', severity: 'error', category: 'lint', message: 'a' },
      { id: '2', severity: 'warn', category: 'tests', message: 'b' },
      { id: '3', severity: 'info', category: 'lint', message: 'c' },
    ]);
    expect(grouped.get('lint')).toHaveLength(2);
    expect(grouped.get('tests')).toHaveLength(1);
  });

  it('falls back to _ bucket when category is absent', () => {
    const grouped = findingsByCategory([{ id: '1', severity: 'info', message: 'a' }]);
    expect(grouped.get('_')).toHaveLength(1);
  });

  it('maxSeverity returns error when any is error', () => {
    expect(maxSeverity([{ severity: 'info' }, { severity: 'error' }, { severity: 'warn' }])).toBe(
      'error',
    );
  });

  it('maxSeverity returns warn when info+warn only', () => {
    expect(maxSeverity([{ severity: 'info' }, { severity: 'warn' }])).toBe('warn');
  });

  it('maxSeverity returns info for only info', () => {
    expect(maxSeverity([{ severity: 'info' }])).toBe('info');
  });

  it('maxSeverity returns null for empty', () => {
    expect(maxSeverity([])).toBeNull();
    expect(maxSeverity()).toBeNull();
  });
});
