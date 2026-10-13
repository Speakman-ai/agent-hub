import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, Loader2, RefreshCw, Square } from 'lucide-react';
import { api } from '../utils/api';
import {
  prEnvironmentLimitsNote,
  prEnvironmentRowView,
  type PrEnvironmentLimitsView,
  type PrEnvironmentListItem,
} from '@shared/utils/prEnvironmentSettings';
import { createSerialQueue } from '@shared/utils/serialQueue';

type LimitKey = keyof PrEnvironmentLimitsView;

interface Bound {
  min: number;
  max: number;
}

interface SettingsResponse {
  limits: PrEnvironmentLimitsView;
  overrides: Partial<PrEnvironmentLimitsView>;
  defaults: PrEnvironmentLimitsView;
  enforced?: PrEnvironmentLimitsView;
  wakeOnRequest?: boolean;
  bounds: Record<LimitKey, Bound>;
  environments: PrEnvironmentListItem[];
}

const FIELDS: Array<{ key: LimitKey; label: string; unit: string }> = [
  { key: 'maxConcurrent', label: 'Max running', unit: 'envs' },
  { key: 'idleTtlMinutes', label: 'Sleep when idle after', unit: 'min' },
  { key: 'maxLifetimeDays', label: 'Stop without a push after', unit: 'days' },
];

const TONE_CLASS: Record<string, string> = {
  ok: 'text-emerald-400 border-emerald-900/50 bg-emerald-950/30',
  busy: 'text-sky-300 border-sky-900/50 bg-sky-950/30',
  error: 'text-red-400 border-red-900/50 bg-red-950/30',
  idle: 'text-gray-400 border-gray-700 bg-gray-900/50',
};

/**
 * PR environments of a project: each one with status, age, and last request,
 * a Stop button, and the cost controls (cap, idle TTL, max lifetime).
 */
export default function PrEnvironmentsPanel({ projectId }: { projectId: string }) {
  // Keyed by project: switching projects remounts with empty state, so one
  // project's environments, limits, and in-flight responses can never drive
  // another project's Stop or Save.
  return <ProjectPrEnvironments key={projectId} projectId={projectId} />;
}

function ProjectPrEnvironments({ projectId }: { projectId: string }) {
  // A response that lands after unmount (project switch) is dropped.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [draft, setDraft] = useState<Record<LimitKey, string>>({
    maxConcurrent: '',
    idleTtlMinutes: '',
    maxLifetimeDays: '',
  });
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [stopping, setStopping] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Every request of this panel goes out one at a time, in order: a refresh
  // issued during a save is sent after it and reads the saved state.
  const queue = useRef(createSerialQueue());

  const apply = (res: SettingsResponse | null | undefined) => {
    if (!mounted.current) return;
    if (!res?.limits) {
      setData(null);
      return;
    }
    setData(res);
    setDraft({
      maxConcurrent: String(res.limits.maxConcurrent),
      idleTtlMinutes: String(res.limits.idleTtlMinutes),
      maxLifetimeDays: String(res.limits.maxLifetimeDays),
    });
  };

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      apply(
        (await queue.current.run(() =>
          api.getProjectPrEnvironments(projectId),
        )) as SettingsResponse,
      );
    } catch (err: any) {
      if (mounted.current) setError(err?.message || 'Failed to load PR environments');
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const save = async () => {
    if (!data) return;
    const patch: Partial<Record<LimitKey, number | null>> = {};
    for (const { key } of FIELDS) {
      const raw = draft[key].trim();
      // Empty resets to the default; an unchanged value is not sent.
      if (raw === '') {
        if (data.overrides[key] !== undefined) patch[key] = null;
        continue;
      }
      const n = Number(raw);
      if (!Number.isInteger(n)) {
        setError(`${key} must be a whole number`);
        return;
      }
      if (n !== data.limits[key]) patch[key] = n;
    }
    setSaving(true);
    setError(null);
    try {
      apply(
        (await queue.current.run(() =>
          api.updateProjectPrEnvironmentLimits(projectId, patch),
        )) as SettingsResponse,
      );
    } catch (err: any) {
      if (mounted.current) {
        setError(err?.message || 'Failed to save limits');
      }
    } finally {
      if (mounted.current) setSaving(false);
    }
  };

  const stop = async (prNumber: number) => {
    if (stopping != null) return;
    setStopping(prNumber);
    setError(null);
    try {
      await queue.current.run(() => api.stopNativePrPreview(projectId, prNumber));
      await reload();
    } catch (err: any) {
      if (mounted.current) setError(err?.message || 'Failed to stop the environment');
    } finally {
      if (mounted.current) setStopping(null);
    }
  };

  const envs = data?.environments ?? [];
  const now = Date.now();

  return (
    <section
      className="rounded-lg border border-gray-800 bg-gray-900/50 p-4 space-y-3"
      data-testid="pr-environments-panel"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-sm font-medium text-gray-200">PR environments</h4>
        <button
          type="button"
          onClick={() => void reload()}
          disabled={loading}
          className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-200 disabled:opacity-50"
        >
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>
      {data && (
        <p className="text-xs text-gray-500" data-testid="pr-environments-limits-summary">
          {prEnvironmentLimitsNote(data)}
        </p>
      )}
      {data && (
        <div className="flex flex-wrap items-end gap-3">
          {FIELDS.map(({ key, label, unit }) => (
            <label key={key} className="text-xs text-gray-400 space-y-1">
              <span className="block">{label}</span>
              <span className="flex items-center gap-1">
                <input
                  type="number"
                  min={0}
                  max={data.bounds[key].max}
                  value={draft[key]}
                  placeholder={String(data.defaults[key])}
                  onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
                  className="w-20 bg-gray-950 border border-gray-700 rounded px-2 py-1 text-sm text-gray-200"
                  data-testid={`pr-env-limit-${key}`}
                />
                <span className="text-gray-500">{unit}</span>
              </span>
            </label>
          ))}
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving}
            className="text-xs font-medium px-3 py-1.5 rounded-lg bg-emerald-700 hover:bg-emerald-600 text-white disabled:opacity-50"
            data-testid="pr-env-limits-save"
          >
            {saving ? 'Saving…' : 'Save limits'}
          </button>
          <span className="text-[11px] text-gray-500">
            0 turns a limit off; empty uses the default.
          </span>
        </div>
      )}
      {error && (
        <p className="text-xs text-red-400 flex items-center gap-1">
          <AlertCircle size={12} /> {error}
        </p>
      )}
      {!loading && data && envs.length === 0 && (
        <p className="text-xs text-gray-500" data-testid="pr-environments-empty">
          No PR environments for this project.
        </p>
      )}
      {envs.length > 0 && (
        <ul className="space-y-2">
          {envs.map((env) => {
            const view = prEnvironmentRowView(env, now);
            return (
              <li
                key={env.id}
                className="rounded border border-gray-800/80 bg-gray-950/40 px-3 py-2 flex flex-wrap items-center gap-2"
                data-testid={`pr-env-row-${env.prNumber}`}
              >
                <span
                  className={`text-[10px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded border shrink-0 ${TONE_CLASS[view.tone]}`}
                >
                  {view.statusLabel}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-gray-200 truncate">
                    PR #{env.prNumber}
                    {env.headBranch ? (
                      <span className="text-gray-500 font-mono"> · {env.headBranch}</span>
                    ) : null}
                  </p>
                  <p className="text-[11px] text-gray-500">
                    age {view.age} · last hit {view.lastHit}
                    {env.url && env.status === 'ready' ? ` · ${env.url}` : ''}
                  </p>
                </div>
                {view.canStop && (
                  <button
                    type="button"
                    onClick={() => void stop(env.prNumber)}
                    disabled={stopping != null}
                    className="flex items-center gap-1 text-xs text-gray-300 hover:text-white px-2 py-1 rounded border border-gray-700 disabled:opacity-50"
                    data-testid={`pr-env-stop-${env.prNumber}`}
                  >
                    {stopping === env.prNumber ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : (
                      <Square size={12} />
                    )}
                    Stop
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
