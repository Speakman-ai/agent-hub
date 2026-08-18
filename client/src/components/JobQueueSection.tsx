import { useCallback, useEffect, useState } from 'react';
import { Activity, Loader2, RotateCcw, Trash2, RefreshCw } from 'lucide-react';
import { api } from '../utils/api';

/**
 * Admin observability pane for the host-wide background job queue
 * (crons and future autonomous tasks all drain it).
 *
 * Lists jobs with a status + type filter, requeues a dead-lettered job,
 * and deletes a row. Backed by GET/POST/DELETE /api/jobs (Admin-gated).
 */

export interface JobRow {
  id: string;
  type: string;
  payload: string;
  status: 'queued' | 'running' | 'done' | 'dead_letter';
  priority: number;
  attempts: number;
  max_attempts: number;
  run_at: number;
  claimed_by: string | null;
  claimed_at: number | null;
  lease_id: string | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

interface JobCounts {
  queued: number;
  running: number;
  done: number;
  dead_letter: number;
  total: number;
}

interface JobsResponse {
  jobs: JobRow[];
  counts: JobCounts;
  types: string[];
  limit: number;
  offset: number;
}

const STATUS_OPTIONS = [
  { value: '', label: 'All statuses' },
  { value: 'queued', label: 'Queued' },
  { value: 'running', label: 'Running' },
  { value: 'done', label: 'Done' },
  { value: 'dead_letter', label: 'Dead-letter' },
];

const STATUS_STYLES: Record<JobRow['status'], string> = {
  queued: 'bg-blue-500/15 text-blue-300 border-blue-500/25',
  running: 'bg-amber-500/15 text-amber-300 border-amber-500/25',
  done: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/25',
  dead_letter: 'bg-red-500/15 text-red-300 border-red-500/25',
};

function fmtTime(ms: number): string {
  if (!ms) return '—';
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return String(ms);
  }
}

export default function JobQueueSection() {
  const [data, setData] = useState<JobsResponse | null>(null);
  const [statusFilter, setStatusFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .getJobs({ status: statusFilter || undefined, type: typeFilter || undefined, limit: 200 })
      .then((res: JobsResponse) => {
        if (!cancelled) setData(res);
      })
      .catch((err: any) => {
        if (!cancelled) setError(err?.message || 'Failed to load jobs');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [statusFilter, typeFilter]);

  useEffect(() => load(), [load]);

  const handleRetry = async (id: string) => {
    setBusyId(id);
    setError(null);
    try {
      await api.retryJob(id);
      load();
    } catch (err: any) {
      setError(err?.message || 'Failed to retry job');
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (id: string) => {
    setBusyId(id);
    setError(null);
    try {
      await api.deleteJob(id);
      load();
    } catch (err: any) {
      setError(err?.message || 'Failed to delete job');
    } finally {
      setBusyId(null);
    }
  };

  const counts = data?.counts;
  const jobs = data?.jobs ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold mb-1 flex items-center gap-2">
          <Activity size={18} className="text-indigo-400" />
          Background Jobs
        </h3>
        <p className="text-xs text-gray-500 mb-4">
          The host-wide job queue that crons and autonomous background tasks drain. Requeue a
          dead-lettered job to retry it, or delete a stale row.
        </p>

        {counts && (
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
            {(['total', 'queued', 'running', 'done', 'dead_letter'] as const).map((k) => (
              <div key={k} className="bg-gray-800 rounded-xl p-3">
                <p className="text-[11px] text-gray-500 uppercase tracking-wider">
                  {k === 'dead_letter' ? 'Dead-letter' : k}
                </p>
                <p
                  className={`text-2xl font-bold mt-1 ${
                    k === 'dead_letter' && counts.dead_letter > 0 ? 'text-red-400' : 'text-gray-100'
                  }`}
                >
                  {counts[k]}
                </p>
              </div>
            ))}
          </div>
        )}

        <div className="flex flex-wrap gap-3 mb-4 items-center">
          <label className="flex items-center gap-2 text-sm">
            <span className="text-gray-400">Status:</span>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm"
            >
              {STATUS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <span className="text-gray-400">Type:</span>
            <select
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
              className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm"
            >
              <option value="">All types</option>
              {(data?.types ?? []).map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={() => load()}
            className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-200"
          >
            <RefreshCw size={14} />
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-3 text-sm text-red-400">
          {error}
        </div>
      )}

      {loading && !data && (
        <p className="text-sm text-gray-500 flex items-center gap-2">
          <Loader2 size={14} className="animate-spin" />
          Loading…
        </p>
      )}

      {data && jobs.length === 0 && !loading && (
        <p className="text-sm text-gray-500">No jobs match this filter.</p>
      )}

      {jobs.length > 0 && (
        <div className="overflow-x-auto border border-gray-800 rounded-xl">
          <table className="w-full text-sm">
            <thead className="bg-gray-900/60 text-gray-400 text-xs uppercase tracking-wider">
              <tr>
                <th className="text-left px-3 py-2 font-medium">Type</th>
                <th className="text-left px-3 py-2 font-medium">Status</th>
                <th className="text-left px-3 py-2 font-medium">Attempts</th>
                <th className="text-left px-3 py-2 font-medium">Created</th>
                <th className="text-left px-3 py-2 font-medium">Last error</th>
                <th className="text-right px-3 py-2 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => (
                <tr key={job.id} className="border-t border-gray-800 align-top">
                  <td className="px-3 py-2 font-mono text-xs text-gray-200">{job.type}</td>
                  <td className="px-3 py-2">
                    <span
                      className={`inline-block px-2 py-0.5 rounded-full border text-[11px] ${STATUS_STYLES[job.status]}`}
                    >
                      {job.status === 'dead_letter' ? 'dead-letter' : job.status}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-gray-400 text-xs">
                    {job.attempts}/{job.max_attempts}
                  </td>
                  <td className="px-3 py-2 text-gray-400 text-xs whitespace-nowrap">
                    {fmtTime(job.created_at)}
                  </td>
                  <td
                    className="px-3 py-2 text-gray-400 text-xs max-w-xs truncate"
                    title={job.last_error ?? ''}
                  >
                    {job.last_error ?? '—'}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center justify-end gap-1.5">
                      {job.status === 'dead_letter' && (
                        <button
                          type="button"
                          onClick={() => handleRetry(job.id)}
                          disabled={busyId === job.id}
                          className="flex items-center gap-1 text-xs px-2 py-1 rounded-lg bg-indigo-500/15 hover:bg-indigo-500/25 text-indigo-300 disabled:opacity-50"
                          title="Requeue this job"
                        >
                          <RotateCcw size={13} />
                          Retry
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => handleDelete(job.id)}
                        disabled={busyId === job.id}
                        className="flex items-center gap-1 text-xs px-2 py-1 rounded-lg bg-gray-800 hover:bg-red-500/20 text-gray-400 hover:text-red-300 disabled:opacity-50"
                        title="Delete this job"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
