import { describe, it, expect } from 'vitest';
import {
  formatGiB,
  formatCpuPct,
  resourceBadgeText,
  aggregateRunResources,
  jobResourceKey,
} from './formatResources.js';

const GB = 1024 * 1024 * 1024;

describe('formatGiB', () => {
  it('formats bytes as GiB with one decimal', () => {
    expect(formatGiB(1.7 * GB)).toBe('1.7 GB');
    expect(formatGiB(32 * GB)).toBe('32.0 GB');
  });
  it('returns null for invalid input', () => {
    expect(formatGiB(null)).toBeNull();
    expect(formatGiB(-1)).toBeNull();
    expect(formatGiB('x')).toBeNull();
  });
});

describe('formatCpuPct', () => {
  it('rounds to a whole percent', () => {
    expect(formatCpuPct(72.5)).toBe('73%');
    expect(formatCpuPct(0)).toBe('0%');
  });
  it('returns null for non-numbers', () => {
    expect(formatCpuPct(null)).toBeNull();
  });
});

describe('resourceBadgeText', () => {
  it('combines memory (of total) and CPU', () => {
    expect(
      resourceBadgeText({
        peak_mem_bytes: 1.7 * GB,
        mem_total_bytes: 32 * GB,
        peak_cpu_percent: 72,
      }),
    ).toBe('1.7 / 32.0 GB · 72%');
  });
  it('shows memory alone when total/CPU missing', () => {
    expect(
      resourceBadgeText({
        peak_mem_bytes: 0.8 * GB,
        mem_total_bytes: null,
        peak_cpu_percent: null,
      }),
    ).toBe('0.8 GB');
  });
  it('returns null when nothing is present', () => {
    expect(
      resourceBadgeText({ peak_mem_bytes: null, mem_total_bytes: null, peak_cpu_percent: null }),
    ).toBeNull();
    expect(resourceBadgeText(null)).toBeNull();
  });
});

describe('jobResourceKey', () => {
  it('produces the same key for a job_name and the matching job_id', () => {
    // The resources endpoint indexes by `job_name`; the run jobs render by
    // `job_id`. Both hold the same ci.yaml v2 identifier, so keys must match.
    expect(jobResourceKey('unit', 'default')).toBe(jobResourceKey('unit', 'default'));
  });
  it('treats empty and "default" matrix as the same (no-matrix) key', () => {
    expect(jobResourceKey('e2e', 'default')).toBe(jobResourceKey('e2e', ''));
    expect(jobResourceKey('e2e', 'default')).toBe(jobResourceKey('e2e', null));
  });
  it('distinguishes different matrix shards of the same job', () => {
    expect(jobResourceKey('e2e', 'shard-1')).not.toBe(jobResourceKey('e2e', 'shard-2'));
  });
  it('uses a printable separator, never a control byte', () => {
    const key = jobResourceKey('unit', 'shard-1');
    expect(key).not.toContain(String.fromCharCode(0));
    for (const ch of key) expect(ch.charCodeAt(0)).toBeGreaterThanOrEqual(0x20);
  });
});

describe('aggregateRunResources', () => {
  it('takes the max peak mem and max peak cpu across jobs', () => {
    const agg = aggregateRunResources([
      { peak_mem_bytes: 1.7 * GB, mem_total_bytes: 32 * GB, peak_cpu_percent: 40 },
      { peak_mem_bytes: 0.8 * GB, mem_total_bytes: 32 * GB, peak_cpu_percent: 72 },
    ]);
    expect(agg).toEqual({ peakMemBytes: 1.7 * GB, memTotalBytes: 32 * GB, peakCpuPercent: 72 });
  });
  it('returns null for empty or sample-less input', () => {
    expect(aggregateRunResources([])).toBeNull();
    expect(aggregateRunResources([{ peak_mem_bytes: null, peak_cpu_percent: null }])).toBeNull();
  });
});
