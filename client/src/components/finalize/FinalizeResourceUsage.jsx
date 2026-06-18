/**
 * FinalizeResourceUsage — per-run "Resource usage" panel.
 *
 * Fetches the per-CI-job resource high-water marks (peak host memory + peak
 * CPU, reported by the runner at job end) for one finalize run and renders an
 * aggregate line plus a per-job breakdown. Renders nothing when no runner
 * reported a summary (Hub-local runs, older runs) so it's safe to always mount.
 */
import { useEffect, useState } from 'react';
import { MemoryStick, Cpu } from 'lucide-react';
import { api } from '../../utils/api.js';
import {
  formatGiB,
  formatCpuPct,
  resourceBadgeText,
  aggregateRunResources,
} from '../../utils/formatResources.js';

export default function FinalizeResourceUsage({ projectId, runId }) {
  const [jobs, setJobs] = useState(null);

  useEffect(() => {
    if (!projectId || !runId) return undefined;
    const ctrl = new AbortController();
    let live = true;
    api
      .getFinalizeRunResources(projectId, runId, { signal: ctrl.signal })
      .then((d) => {
        if (live) setJobs(Array.isArray(d?.jobs) ? d.jobs : []);
      })
      .catch(() => {
        if (live) setJobs([]);
      });
    return () => {
      live = false;
      ctrl.abort();
    };
  }, [projectId, runId]);

  if (!jobs || jobs.length === 0) return null;
  const agg = aggregateRunResources(jobs);
  if (!agg) return null;

  const peakMem = formatGiB(agg.peakMemBytes);
  const memTotal = formatGiB(agg.memTotalBytes);
  const peakCpu = formatCpuPct(agg.peakCpuPercent);

  return (
    <div data-testid="finalize-resource-usage" className="border-t border-slate-700/60 px-3 py-2">
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-[11px] font-medium uppercase tracking-wide text-slate-400">
          Resource usage
        </span>
        <span className="ml-auto flex items-center gap-3 text-xs text-slate-300 tabular-nums">
          {peakMem && (
            <span
              className="flex items-center gap-1"
              title="Peak host memory used (one job per host)"
            >
              <MemoryStick size={12} className="text-slate-500" />
              {memTotal ? `${peakMem.replace(' GB', '')} / ${memTotal}` : peakMem}
            </span>
          )}
          {peakCpu && (
            <span className="flex items-center gap-1" title="Peak host CPU utilization">
              <Cpu size={12} className="text-slate-500" />
              {peakCpu}
            </span>
          )}
        </span>
      </div>
      {jobs.length > 1 && (
        <div className="space-y-0.5">
          {jobs.map((j) => {
            const badge = resourceBadgeText(j);
            return (
              <div
                key={`${j.job_name}-${j.matrix_key}`}
                className="flex items-center gap-2 text-[11px] text-slate-400"
              >
                <code className="font-mono text-slate-300">{j.job_name}</code>
                {j.matrix_key && j.matrix_key !== 'default' && (
                  <span className="text-slate-500 truncate">{j.matrix_key}</span>
                )}
                <span className="ml-auto tabular-nums text-slate-400">{badge || '—'}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
