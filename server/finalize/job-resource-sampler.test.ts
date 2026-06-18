import { describe, it, expect } from 'vitest';
import {
  JobResourceSampler,
  startHostSampler,
  type ResourceSample,
} from './job-resource-sampler.js';

const GB = 1024 * 1024 * 1024;

describe('JobResourceSampler', () => {
  it('tracks peak memory across samples', () => {
    const s = new JobResourceSampler(1000);
    s.add(mem(1 * GB));
    s.add(mem(3 * GB));
    s.add(mem(2 * GB));
    s.stop(6000);
    const sum = s.summary();
    expect(sum.peakMemBytes).toBe(3 * GB);
    expect(sum.memTotalBytes).toBe(32 * GB);
    expect(sum.samples).toBe(3);
    expect(sum.durationMs).toBe(5000);
  });

  it('derives CPU% from deltas between cumulative counters (first sample seeds baseline)', () => {
    const s = new JobResourceSampler(0);
    // Interval 1: 50 busy of 100 total → 50%
    s.add({ ...mem(GB), cpuBusy: 0, cpuTotal: 0 });
    s.add({ ...mem(GB), cpuBusy: 50, cpuTotal: 100 });
    // Interval 2: 90 busy of 100 total → 90%
    s.add({ ...mem(GB), cpuBusy: 140, cpuTotal: 200 });
    const sum = s.summary(10);
    expect(sum.peakCpuPercent).toBe(90);
    expect(sum.avgCpuPercent).toBe(70); // (50 + 90) / 2
  });

  it('reports null CPU when no cpu counters are provided', () => {
    const s = new JobResourceSampler(0);
    s.add(mem(GB));
    s.add(mem(2 * GB));
    const sum = s.summary(1);
    expect(sum.peakCpuPercent).toBeNull();
    expect(sum.avgCpuPercent).toBeNull();
  });

  it('ignores counter resets / zero-interval reads without throwing', () => {
    const s = new JobResourceSampler(0);
    s.add({ ...mem(GB), cpuBusy: 100, cpuTotal: 200 });
    s.add({ ...mem(GB), cpuBusy: 50, cpuTotal: 100 }); // reset (dTotal<0) → skipped
    s.add({ ...mem(GB), cpuBusy: 50, cpuTotal: 100 }); // zero interval → skipped
    const sum = s.summary(1);
    expect(sum.peakCpuPercent).toBeNull();
  });

  it('clamps utilization into [0,100]', () => {
    const s = new JobResourceSampler(0);
    s.add({ ...mem(GB), cpuBusy: 0, cpuTotal: 0 });
    // Busy grows more than total (shouldn't happen, but guard anyway)
    s.add({ ...mem(GB), cpuBusy: 150, cpuTotal: 100 });
    expect(s.summary(1).peakCpuPercent).toBe(100);
  });
});

describe('startHostSampler', () => {
  it('returns a null summary when /proc is unavailable', () => {
    const handle = startHostSampler({ read: () => null });
    expect(handle.stop()).toBeNull();
  });

  it('samples on start and returns a summary on stop', () => {
    let t = 0;
    const readings: ResourceSample[] = [mem(2 * GB), mem(5 * GB)];
    let i = 0;
    const handle = startHostSampler({
      intervalMs: 1_000_000, // timer won't fire during the test
      now: () => (t += 1000),
      read: () => readings[Math.min(i++, readings.length - 1)],
    });
    const sum = handle.stop();
    expect(sum).not.toBeNull();
    expect(sum!.peakMemBytes).toBe(2 * GB); // only the start sample was taken
    expect(sum!.samples).toBe(1);
  });
});

function mem(usedBytes: number): ResourceSample {
  return { memUsedBytes: usedBytes, memTotalBytes: 32 * GB };
}
