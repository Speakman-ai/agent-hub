import { useCallback, useEffect, useMemo, useState } from 'react';
import { BarChart3, RefreshCw } from 'lucide-react';
import { api } from '../utils/api';

type Granularity = 'day' | 'week' | 'month';

interface StatBucket {
  start: string;
  label: string;
}
interface ProjectStats {
  granularity: Granularity;
  buckets: StatBucket[];
  series: {
    prs_merged: number[];
    support_tickets_resolved: number[];
    tickets_made: number[];
    tickets_completed: number[];
    epics_completed: number[];
  };
  totals: {
    prs_merged: number;
    support_tickets_resolved: number;
    tickets_made: number;
    tickets_completed: number;
    epics_completed: number;
  };
  model_usage: Array<{ model: string; count: number }>;
  top_model: string | null;
}

const METRICS: Array<{ key: keyof ProjectStats['series']; label: string; color: string }> = [
  { key: 'prs_merged', label: 'PRs merged', color: 'bg-emerald-500' },
  { key: 'support_tickets_resolved', label: 'Support tickets resolved', color: 'bg-sky-500' },
  { key: 'tickets_made', label: 'Tickets made', color: 'bg-indigo-500' },
  { key: 'tickets_completed', label: 'Tickets completed', color: 'bg-violet-500' },
  { key: 'epics_completed', label: 'Epics completed', color: 'bg-amber-500' },
];

const GRANULARITIES: Array<{ value: Granularity; label: string }> = [
  { value: 'day', label: 'Daily' },
  { value: 'week', label: 'Weekly' },
  { value: 'month', label: 'Monthly' },
];

function MiniBarChart({
  buckets,
  values,
  color,
}: {
  buckets: StatBucket[];
  values: number[];
  color: string;
}) {
  const max = Math.max(1, ...values);
  return (
    <div className="flex items-end gap-[2px] h-16" role="img" aria-label="bar chart">
      {values.map((v, i) => (
        <div
          key={buckets[i]?.start ?? i}
          className="flex-1 min-w-[2px] bg-gray-700/40 rounded-sm relative group"
          style={{ height: '100%' }}
          title={`${buckets[i]?.label ?? ''}: ${v}`}
        >
          <div
            className={`absolute bottom-0 left-0 right-0 ${color} rounded-sm`}
            style={{ height: `${(v / max) * 100}%` }}
          />
        </div>
      ))}
    </div>
  );
}

export default function ProjectStatsView({ projects }: { projects: any[] }) {
  const project = projects?.[0] ?? null;
  const projectId = project?.id ?? null;
  const [granularity, setGranularity] = useState<Granularity>('day');
  const [stats, setStats] = useState<ProjectStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    setError(null);
    try {
      const data = (await api.getProjectStats(projectId, { granularity })) as ProjectStats;
      setStats(data);
    } catch (err: any) {
      setError(err?.message || 'Failed to load stats');
      // Clear stale data (matches the mobile StatsScreen): otherwise switching
      // from stats:p1 to stats:p2 and hitting a transient failure would render
      // the p2 header over p1's metrics. Never show one project's numbers under
      // another project's name.
      setStats(null);
    } finally {
      setLoading(false);
    }
  }, [projectId, granularity]);

  useEffect(() => {
    void load();
  }, [load]);

  const totalModelMessages = useMemo(
    () => (stats?.model_usage ?? []).reduce((sum, m) => sum + m.count, 0),
    [stats],
  );

  if (!project) {
    return <div className="text-gray-400">No project selected.</div>;
  }

  return (
    <div className="max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div className="flex items-center gap-2">
          <BarChart3 className="text-indigo-400" size={20} />
          <h2 className="text-xl font-semibold text-gray-100">{project.name} · Stats</h2>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-lg overflow-hidden border border-gray-700">
            {GRANULARITIES.map((g) => (
              <button
                key={g.value}
                type="button"
                onClick={() => setGranularity(g.value)}
                className={`px-3 py-1.5 text-sm ${
                  granularity === g.value
                    ? 'bg-indigo-600 text-white'
                    : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
                }`}
              >
                {g.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="p-2 rounded-lg bg-gray-800 text-gray-300 hover:bg-gray-700 disabled:opacity-50"
            title="Refresh"
          >
            <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-4 p-3 rounded-lg bg-red-900/40 border border-red-800 text-red-200 text-sm">
          {error}
        </div>
      )}

      {!stats && loading && <div className="text-gray-400">Loading stats…</div>}

      {stats && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-6">
            {METRICS.map((m) => (
              <div key={m.key} className="rounded-xl border border-gray-800 bg-gray-900/60 p-4">
                <div className="text-2xl font-semibold text-gray-100">{stats.totals[m.key]}</div>
                <div className="text-xs text-gray-400 mt-0.5">{m.label}</div>
              </div>
            ))}
            <div className="rounded-xl border border-gray-800 bg-gray-900/60 p-4">
              <div
                className="text-lg font-semibold text-gray-100 truncate"
                title={stats.top_model ?? ''}
              >
                {stats.top_model ?? '—'}
              </div>
              <div className="text-xs text-gray-400 mt-0.5">Most-used model</div>
            </div>
          </div>

          <div className="space-y-5">
            {METRICS.map((m) => {
              const values = stats.series[m.key];
              const total = stats.totals[m.key];
              return (
                <div key={m.key} className="rounded-xl border border-gray-800 bg-gray-900/40 p-4">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm text-gray-300">{m.label}</span>
                    <span className="text-xs text-gray-500">{total} total</span>
                  </div>
                  <MiniBarChart buckets={stats.buckets} values={values} color={m.color} />
                  <div className="flex justify-between text-[10px] text-gray-600 mt-1">
                    <span>{stats.buckets[0]?.label}</span>
                    <span>{stats.buckets[stats.buckets.length - 1]?.label}</span>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="mt-6 rounded-xl border border-gray-800 bg-gray-900/40 p-4">
            <div className="text-sm text-gray-300 mb-3">Model usage</div>
            {stats.model_usage.length === 0 ? (
              <div className="text-xs text-gray-500">No model usage in this window.</div>
            ) : (
              <div className="space-y-2">
                {stats.model_usage.map((row) => (
                  <div key={row.model} className="flex items-center gap-3">
                    <span className="text-xs text-gray-300 w-40 truncate" title={row.model}>
                      {row.model}
                    </span>
                    <div className="flex-1 h-2 bg-gray-800 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-indigo-500"
                        style={{
                          width: `${totalModelMessages ? (row.count / totalModelMessages) * 100 : 0}%`,
                        }}
                      />
                    </div>
                    <span className="text-xs text-gray-400 w-12 text-right">{row.count}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
