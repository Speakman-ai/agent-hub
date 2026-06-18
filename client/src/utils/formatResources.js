/**
 * Formatting helpers for Finalize per-job resource usage (peak memory / CPU).
 * Shared by the run-view aggregate panel and the CI-history per-job badges.
 */

/**
 * Stable lookup key for one job-resource entry, shared by the writer (which
 * indexes the resources endpoint's `job_name` + `matrix_key`) and the reader
 * (which looks up by a CI run job's `job_id` + `matrix_key`). `job_name` and
 * `job_id` carry the same ci.yaml v2 job identifier, so both sides resolve to
 * the same key. `'default'`/empty matrix both normalize to "no matrix"; the
 * `␟` (UNIT SEPARATOR symbol) delimiter is a printable character, so it
 * keeps the source file text (not binary) and won't collide with real job
 * names or matrix values.
 */
export function jobResourceKey(name, matrixKey) {
  const m = matrixKey && matrixKey !== 'default' ? matrixKey : '';
  return `${name ?? ''}␟${m}`;
}

/** Bytes → "1.7 GB" (1 decimal, GiB base). Returns null for null/invalid input. */
export function formatGiB(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return null;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

/** Peak CPU number → "72%" or null. */
export function formatCpuPct(pct) {
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return null;
  return `${Math.round(pct)}%`;
}

/**
 * Compact "1.7 GB · 72%" badge text for one job-resource entry. Memory of
 * total when known: "1.7 / 32 GB". Returns null when neither value is present.
 */
export function resourceBadgeText(job) {
  if (!job) return null;
  const mem = formatGiB(job.peak_mem_bytes);
  const total = formatGiB(job.mem_total_bytes);
  const cpu = formatCpuPct(job.peak_cpu_percent);
  const parts = [];
  if (mem) parts.push(total ? `${mem.replace(' GB', '')} / ${total}` : mem);
  if (cpu) parts.push(cpu);
  return parts.length ? parts.join(' · ') : null;
}

/**
 * Aggregate a run's job-resource entries into a single high-water mark:
 * the max peak memory and max peak CPU across all jobs. Returns null when the
 * list is empty / has no numeric samples.
 */
export function aggregateRunResources(jobs) {
  if (!Array.isArray(jobs) || jobs.length === 0) return null;
  let peakMem = null;
  let memTotal = null;
  let peakCpu = null;
  for (const j of jobs) {
    if (typeof j.peak_mem_bytes === 'number' && (peakMem === null || j.peak_mem_bytes > peakMem)) {
      peakMem = j.peak_mem_bytes;
      memTotal = typeof j.mem_total_bytes === 'number' ? j.mem_total_bytes : memTotal;
    }
    if (
      typeof j.peak_cpu_percent === 'number' &&
      (peakCpu === null || j.peak_cpu_percent > peakCpu)
    ) {
      peakCpu = j.peak_cpu_percent;
    }
  }
  if (peakMem === null && peakCpu === null) return null;
  return { peakMemBytes: peakMem, memTotalBytes: memTotal, peakCpuPercent: peakCpu };
}
