/**
 * job-resource-sampler.ts — per-CI-job host resource sampler.
 *
 * Why host-level, not the job container's cgroup
 * ──────────────────────────────────────────────
 * A Finalize CI job runs as a privileged DinD container; the real workload
 * (compose stacks, Cypress, the inner dockerd) runs in *nested* containers
 * that escape the job container's own cgroup accounting — which is exactly why
 * ECS task `MemoryUtilization` reads ~0 for these hosts. But the runner fleet
 * reserves ~the whole box per task (one job per host), so **host memory is job
 * memory**. We therefore sample the host (`/proc/meminfo` + `/proc/stat`) and
 * report a high-water-mark summary when the job ends.
 *
 * The sampler is split into a pure accumulator (`JobResourceSampler`) that is
 * fed `ResourceSample`s — trivially unit-testable — and a real reader
 * (`readHostSample`) that does the `/proc` I/O. `startHostSampler()` wires them
 * together on a timer for the agent.
 */
import { readFileSync } from 'fs';

/** A single point-in-time reading. */
export interface ResourceSample {
  /** Bytes of RAM in use (MemTotal - MemAvailable). */
  memUsedBytes: number;
  /** Total RAM on the host, bytes. Constant across samples. */
  memTotalBytes: number;
  /**
   * Cumulative busy CPU-time and total CPU-time (jiffies or any consistent
   * unit) read from `/proc/stat`. The accumulator turns successive readings
   * into a per-interval utilization %, so absolute units don't matter as long
   * as they're consistent. Omit on platforms without `/proc/stat`.
   */
  cpuBusy?: number;
  cpuTotal?: number;
}

/** The end-of-job summary reported to the Hub. */
export interface JobResourceSummary {
  /** Peak RAM used over the job, bytes. */
  peakMemBytes: number;
  /** Host total RAM, bytes (so the Hub/UI can render a %). */
  memTotalBytes: number;
  /** Peak whole-host CPU utilization over any interval, 0..100. null if unknown. */
  peakCpuPercent: number | null;
  /** Mean whole-host CPU utilization across the job, 0..100. null if unknown. */
  avgCpuPercent: number | null;
  /** Number of samples taken. */
  samples: number;
  /** Wall-clock duration the sampler ran, ms. */
  durationMs: number;
}

/**
 * Pure high-water-mark accumulator. Feed it samples via {@link add}; read the
 * summary via {@link summary}. No timers, no I/O — the unit of test.
 *
 * CPU utilization is derived from the *delta* between consecutive samples'
 * cumulative counters, so the first sample only seeds the baseline (it produces
 * no CPU interval). Memory is taken directly from each sample.
 */
export class JobResourceSampler {
  private peakMem = 0;
  private memTotal = 0;
  private peakCpu: number | null = null;
  private cpuPctSum = 0;
  private cpuIntervals = 0;
  private count = 0;
  private prevBusy: number | null = null;
  private prevTotal: number | null = null;
  private readonly startedAt: number;
  private endedAt: number | null = null;

  constructor(now: number) {
    this.startedAt = now;
  }

  add(sample: ResourceSample): void {
    this.count += 1;
    if (sample.memUsedBytes > this.peakMem) this.peakMem = sample.memUsedBytes;
    if (sample.memTotalBytes > 0) this.memTotal = sample.memTotalBytes;
    if (typeof sample.cpuBusy === 'number' && typeof sample.cpuTotal === 'number') {
      if (this.prevBusy !== null && this.prevTotal !== null) {
        const dBusy = sample.cpuBusy - this.prevBusy;
        const dTotal = sample.cpuTotal - this.prevTotal;
        // Guard against counter resets / zero-interval reads.
        if (dTotal > 0 && dBusy >= 0) {
          const pct = Math.min(100, Math.max(0, (dBusy / dTotal) * 100));
          if (this.peakCpu === null || pct > this.peakCpu) this.peakCpu = pct;
          this.cpuPctSum += pct;
          this.cpuIntervals += 1;
        }
      }
      this.prevBusy = sample.cpuBusy;
      this.prevTotal = sample.cpuTotal;
    }
  }

  /** Mark the sampler stopped (sets duration). Idempotent. */
  stop(now: number): void {
    if (this.endedAt === null) this.endedAt = now;
  }

  summary(now?: number): JobResourceSummary {
    const end = this.endedAt ?? now ?? this.startedAt;
    return {
      peakMemBytes: this.peakMem,
      memTotalBytes: this.memTotal,
      peakCpuPercent: this.peakCpu === null ? null : round1(this.peakCpu),
      avgCpuPercent: this.cpuIntervals > 0 ? round1(this.cpuPctSum / this.cpuIntervals) : null,
      samples: this.count,
      durationMs: Math.max(0, end - this.startedAt),
    };
  }
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

// ─── Real host reader ─────────────────────────────────────────────────

/**
 * Read one host sample from `/proc`. Returns null if `/proc/meminfo` is
 * unreadable (non-Linux dev box) so the caller can skip sampling cleanly.
 */
export function readHostSample(): ResourceSample | null {
  let meminfo: string;
  try {
    meminfo = readFileSync('/proc/meminfo', 'utf8');
  } catch {
    return null;
  }
  const totalKb = matchKb(meminfo, 'MemTotal');
  const availKb = matchKb(meminfo, 'MemAvailable');
  if (totalKb === null || availKb === null) return null;
  const memTotalBytes = totalKb * 1024;
  const memUsedBytes = Math.max(0, (totalKb - availKb) * 1024);
  const cpu = readCpuTotals();
  return {
    memUsedBytes,
    memTotalBytes,
    cpuBusy: cpu?.busy,
    cpuTotal: cpu?.total,
  };
}

function matchKb(meminfo: string, key: string): number | null {
  const m = meminfo.match(new RegExp(`^${key}:\\s+(\\d+)\\s+kB`, 'm'));
  return m ? Number.parseInt(m[1], 10) : null;
}

/** Parse the aggregate `cpu` line of `/proc/stat` into busy/total jiffies. */
function readCpuTotals(): { busy: number; total: number } | null {
  let stat: string;
  try {
    stat = readFileSync('/proc/stat', 'utf8');
  } catch {
    return null;
  }
  const line = stat.match(/^cpu\s+(.+)$/m);
  if (!line) return null;
  const parts = line[1].trim().split(/\s+/).map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return null;
  // Fields: user nice system idle iowait irq softirq steal guest guest_nice
  const total = parts.reduce((a, b) => a + b, 0);
  const idle = (parts[3] ?? 0) + (parts[4] ?? 0); // idle + iowait
  const busy = total - idle;
  return { busy, total };
}

// ─── Timer wiring (for the agent) ─────────────────────────────────────

export interface RunningSampler {
  /** Stop the timer and return the summary. */
  stop: () => JobResourceSummary | null;
}

/**
 * Start a host sampler on a timer. Returns a handle whose `stop()` clears the
 * timer and returns the summary — or null if the platform has no `/proc`
 * (so the agent simply reports no resource summary, never crashing).
 *
 * Injectable `read`/`now`/`setIntervalFn` keep this testable without real time.
 */
export function startHostSampler(opts?: {
  intervalMs?: number;
  read?: () => ResourceSample | null;
  now?: () => number;
}): RunningSampler {
  const read = opts?.read ?? readHostSample;
  const now = opts?.now ?? Date.now;
  const intervalMs = opts?.intervalMs ?? 5_000;

  const first = read();
  if (first === null) {
    return { stop: () => null };
  }
  const sampler = new JobResourceSampler(now());
  sampler.add(first);
  const timer = setInterval(() => {
    const s = read();
    if (s) sampler.add(s);
  }, intervalMs);
  if (typeof (timer as { unref?: () => void }).unref === 'function') {
    (timer as { unref: () => void }).unref();
  }
  return {
    stop: () => {
      clearInterval(timer);
      sampler.stop(now());
      return sampler.summary(now());
    },
  };
}
