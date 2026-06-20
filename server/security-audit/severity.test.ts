import { describe, it, expect } from 'vitest';
import {
  cvssV3BaseScore,
  resolveSeverity,
  severityFromCvssScore,
  severityFromCvssVector,
  severityFromLabel,
  severityRank,
} from './severity.js';

describe('cvssV3BaseScore', () => {
  it('computes the canonical 9.8 critical vector', () => {
    expect(cvssV3BaseScore('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H')).toBe(9.8);
  });

  it('computes a 7.5 high vector (availability only)', () => {
    expect(cvssV3BaseScore('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H')).toBe(7.5);
  });

  it('computes a scope-changed 6.1 medium vector (reflected XSS)', () => {
    expect(cvssV3BaseScore('CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N')).toBe(6.1);
  });

  it('accepts a vector without the CVSS:3.x prefix', () => {
    expect(cvssV3BaseScore('AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H')).toBe(9.8);
  });

  it('returns null for an unparseable / incomplete vector', () => {
    expect(cvssV3BaseScore('')).toBeNull();
    expect(cvssV3BaseScore('not-a-vector')).toBeNull();
    expect(cvssV3BaseScore('CVSS:3.1/AV:N/AC:L')).toBeNull(); // missing metrics
  });
});

describe('severityFromCvssScore', () => {
  it('buckets per the FIRST qualitative table', () => {
    expect(severityFromCvssScore(9.8)).toBe('critical');
    expect(severityFromCvssScore(9.0)).toBe('critical');
    expect(severityFromCvssScore(7.5)).toBe('high');
    expect(severityFromCvssScore(4.0)).toBe('medium');
    expect(severityFromCvssScore(3.9)).toBe('low');
    expect(severityFromCvssScore(0)).toBe('unknown');
  });
});

describe('severityFromLabel', () => {
  it('maps GitHub Advisory DB labels', () => {
    expect(severityFromLabel('CRITICAL')).toBe('critical');
    expect(severityFromLabel('High')).toBe('high');
    expect(severityFromLabel('MODERATE')).toBe('medium');
    expect(severityFromLabel('medium')).toBe('medium');
    expect(severityFromLabel('low')).toBe('low');
    expect(severityFromLabel('weird')).toBe('unknown');
    expect(severityFromLabel(null)).toBe('unknown');
  });
});

describe('severityFromCvssVector', () => {
  it('returns unknown for an unparseable vector', () => {
    expect(severityFromCvssVector('garbage')).toBe('unknown');
    expect(severityFromCvssVector('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H')).toBe('critical');
  });
});

describe('resolveSeverity', () => {
  it('prefers a non-unknown database label over the CVSS vector', () => {
    expect(
      resolveSeverity({
        label: 'CRITICAL',
        cvssVector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:N/A:N', // would be low
      }),
    ).toBe('critical');
  });

  it('falls back to the CVSS vector when the label is missing/unknown', () => {
    expect(
      resolveSeverity({
        label: null,
        cvssVector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H',
      }),
    ).toBe('high');
  });

  it('returns unknown when neither input resolves', () => {
    expect(resolveSeverity({ label: null, cvssVector: null })).toBe('unknown');
  });
});

describe('severityRank', () => {
  it('orders critical > high > medium > low > unknown', () => {
    const order = ['critical', 'high', 'medium', 'low', 'unknown'] as const;
    const ranks = order.map(severityRank);
    expect(ranks).toEqual([...ranks].sort((a, b) => b - a));
  });
});
