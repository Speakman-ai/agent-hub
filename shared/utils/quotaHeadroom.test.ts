import { describe, it, expect } from 'vitest';

import {
  formatQuotaHeadroom,
  formatQuotaUtilization,
  quotaBandLabel,
  quotaBandTone,
  quotaBarPercent,
  quotaSummaryLine,
  quotaRefreshFailureNote,
  quotaUnknownReason,
  type QuotaHeadroomWire,
} from './quotaHeadroom.js';

function quota(overrides: Partial<QuotaHeadroomWire> = {}): QuotaHeadroomWire {
  return {
    resourceKey: 'k',
    accountId: '123456789012',
    region: 'us-east-1',
    serviceCode: 'ec2',
    quotaCode: 'L-1216C47A',
    quotaName: 'Running On-Demand Standard instances',
    limit: 640,
    unit: 'None',
    adjustable: true,
    usage: 512,
    usageAtMs: 1_700_000_000_000,
    metricName: 'ResourceCount',
    utilizationPercent: 80,
    headroom: 128,
    band: 'ok',
    ...overrides,
  };
}

describe('formatQuotaUtilization', () => {
  it('renders an unmeasured quota as a dash, never as zero percent', () => {
    // "0%" reads as full headroom, which is the single most dangerous
    // misrendering this panel could produce.
    expect(formatQuotaUtilization(null)).toBe('—');
    expect(formatQuotaUtilization(Number.NaN)).toBe('—');
    expect(formatQuotaUtilization(0)).toBe('0%');
  });

  it('keeps a decimal only where it carries information', () => {
    // 4.2 vs 4.9 percent of a quota is noise; 94 vs 95 is not.
    expect(formatQuotaUtilization(4.23)).toBe('4.2%');
    expect(formatQuotaUtilization(9.99)).toBe('10%');
    expect(formatQuotaUtilization(94.4)).toBe('94%');
  });

  it('renders an over-quota reading rather than capping at 100', () => {
    expect(formatQuotaUtilization(140)).toBe('140%');
  });
});

describe('formatQuotaHeadroom', () => {
  it('suppresses the placeholder units Service Quotas reports', () => {
    // "512 None" is noise; the unit means "a plain count".
    expect(formatQuotaHeadroom(512, 'None')).toBe('512');
    expect(formatQuotaHeadroom(512, 'Count')).toBe('512');
    expect(formatQuotaHeadroom(512, null)).toBe('512');
  });

  it('keeps a real unit', () => {
    expect(formatQuotaHeadroom(20, 'Gigabytes')).toBe('20 Gigabytes');
  });

  it('separates thousands and renders an unknown as a dash', () => {
    expect(formatQuotaHeadroom(12500, 'None')).toBe('12,500');
    expect(formatQuotaHeadroom(null, 'None')).toBe('—');
  });
});

describe('quotaBandTone and label', () => {
  it('maps each band to a distinct tone', () => {
    expect(quotaBandTone('critical')).toBe('danger');
    expect(quotaBandTone('warning')).toBe('warn');
    expect(quotaBandTone('ok')).toBe('good');
    expect(quotaBandTone('unknown')).toBe('muted');
  });

  it('says "not measured" rather than "no data" for unknown', () => {
    // The distinction the null-vs-zero discipline exists to preserve: we did
    // not look, rather than looked and found nothing.
    expect(quotaBandLabel('unknown')).toBe('Not measured');
  });
});

describe('quotaSummaryLine', () => {
  it('leads with what needs action', () => {
    expect(quotaSummaryLine({ critical: 1, warning: 2, ok: 5, unknown: 0, total: 8 })).toBe(
      '1 at or over quota, 2 near quota of 8 watched',
    );
  });

  it('does not claim "all healthy" when nothing has been measured', () => {
    // An operator who has not noticed only three quotas are in scope would read
    // "all healthy" as a far stronger statement than it is.
    expect(quotaSummaryLine({ critical: 0, warning: 0, ok: 0, unknown: 3, total: 3 })).toBe(
      '3 watched, none measured yet',
    );
  });

  it('counts only measured quotas when reporting all healthy', () => {
    expect(quotaSummaryLine({ critical: 0, warning: 0, ok: 4, unknown: 2, total: 6 })).toBe(
      '4 of 6 watched, all healthy',
    );
  });

  it('says nothing is collected for an empty project', () => {
    expect(quotaSummaryLine({ critical: 0, warning: 0, ok: 0, unknown: 0, total: 0 })).toBe(
      'No quotas collected yet',
    );
  });
});

describe('quotaUnknownReason', () => {
  it('is silent for a measured quota', () => {
    expect(quotaUnknownReason(quota())).toBeNull();
  });

  it('distinguishes an AWS-side missing limit from a missing reading', () => {
    // Different causes needing different actions: one is a fact nothing can
    // change, the other means the collector has stopped and is worth chasing.
    expect(quotaUnknownReason(quota({ limit: null, utilizationPercent: null }))).toMatch(
      /no applied value/i,
    );
    expect(quotaUnknownReason(quota({ usage: null, utilizationPercent: null }))).toMatch(
      /No recent usage reading/i,
    );
  });
});

describe('quotaBarPercent', () => {
  it('clamps the bar for layout while the number stays unclamped', () => {
    expect(quotaBarPercent(140)).toBe(100);
    // The caller renders formatQuotaUtilization(140) = "140%" beside it.
    expect(formatQuotaUtilization(140)).toBe('140%');
  });

  it('draws nothing for an unmeasured or zero quota', () => {
    expect(quotaBarPercent(null)).toBe(0);
    expect(quotaBarPercent(0)).toBe(0);
    expect(quotaBarPercent(-5)).toBe(0);
  });

  it('passes an ordinary reading through', () => {
    expect(quotaBarPercent(80)).toBe(80);
  });
});

describe('quotaRefreshFailureNote', () => {
  const NOW = 1_700_000_000_000;

  it('is silent when nothing has failed', () => {
    // The banner must appear only when it means something, or it becomes
    // furniture the operator stops reading.
    expect(quotaRefreshFailureNote(null, NOW, NOW)).toBeNull();
    expect(quotaRefreshFailureNote(undefined, NOW, NOW)).toBeNull();
    expect(quotaRefreshFailureNote('', NOW, NOW)).toBeNull();
  });

  it('names the failure and dates the readings still on screen', () => {
    // This is the regression: a failed poll used to leave the previous readings
    // rendered identically to fresh ones, so during an outage the panel showed
    // reassuring capacity figures with no hint they had stopped moving.
    const note = quotaRefreshFailureNote('network down', NOW - 3 * 60_000, NOW)!;
    expect(note).toContain('Refresh failed: network down');
    expect(note).toContain('last updated 3m ago');
    expect(note).toMatch(/may have changed since/);
  });

  it('still warns when the fetch time is unknown', () => {
    // Losing the timestamp must not lose the warning — that would be the
    // silent-stale bug again, just via a different path.
    const note = quotaRefreshFailureNote('boom', null, NOW)!;
    expect(note).toContain('Refresh failed: boom');
    expect(note).toMatch(/may be out of date/);
  });

  it('reports a sub-minute age as "just now" rather than counting seconds', () => {
    // The panel polls once a minute; second-level precision would be a claim it
    // cannot support.
    expect(quotaRefreshFailureNote('boom', NOW - 5_000, NOW)).toContain('just now');
  });

  it('does not render a negative age when the device clock is behind', () => {
    expect(quotaRefreshFailureNote('boom', NOW + 60_000, NOW)).toContain('just now');
  });
});
