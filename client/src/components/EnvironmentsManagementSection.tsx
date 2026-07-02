import { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Layers,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Zap,
} from 'lucide-react';
import { api } from '../utils/api';
import EnvironmentTriggersPanel from './EnvironmentTriggersPanel';
import {
  environmentStatus,
  environmentStatusLabel,
  hasRuntimeConfig,
  sortEnvironmentsForDisplay,
  type EnvironmentStatus,
  type ResolvedEnvironment,
} from '../utils/environments';

function shortRef(ref: unknown): string {
  const s = String(ref || '');
  if (!s) return 'none';
  return s.length > 12 ? s.slice(0, 12) : s;
}

function statusClasses(status: EnvironmentStatus): string {
  if (status === 'deployable') return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300';
  if (status === 'paused') return 'border-amber-500/30 bg-amber-500/10 text-amber-200';
  return 'border-gray-600 bg-gray-700/40 text-gray-300';
}

function StatusBadge({ status }: { status: EnvironmentStatus }) {
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-md border text-[11px] font-medium ${statusClasses(
        status,
      )}`}
    >
      {environmentStatusLabel(status)}
    </span>
  );
}

export default function EnvironmentsManagementSection({
  projectId,
  showToast,
}: {
  projectId?: string | null;
  showToast?: (message: string, type?: string) => void;
}) {
  const [environments, setEnvironments] = useState<ResolvedEnvironment[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionKey, setActionKey] = useState<string | null>(null);
  const [expandedTriggers, setExpandedTriggers] = useState<Record<string, boolean>>({});

  const toggleTriggers = useCallback((name: string) => {
    setExpandedTriggers((prev) => ({ ...prev, [name]: !prev[name] }));
  }, []);

  const notify = useCallback(
    (message: string, type: string = 'info') => showToast?.(message, type),
    [showToast],
  );

  const load = useCallback(async () => {
    if (!projectId) {
      setEnvironments([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await api.getDeployEnvironments(projectId);
      setEnvironments(res?.environments || []);
    } catch (e: any) {
      setError(e?.message || 'Failed to load environments');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    load();
  }, [load]);

  const setEnabled = async (env: ResolvedEnvironment, enabled: boolean) => {
    if (!projectId) return;
    const key = `toggle:${env.name}`;
    setActionKey(key);
    try {
      const res = await api.setDeployEnvironmentEnabled(projectId, env.name, enabled);
      setEnvironments(res?.environments || []);
      notify(`${env.name} ${enabled ? 'resumed' : 'paused'}`, 'success');
    } catch (e: any) {
      notify(e?.message || 'Failed to update environment', 'error');
    } finally {
      setActionKey(null);
    }
  };

  const removeConfig = async (env: ResolvedEnvironment) => {
    if (!projectId) return;
    const resetLabel = env.active
      ? `Reset ${env.name} to the enabled default?`
      : `Remove the stale config for ${env.name}?`;
    if (typeof window !== 'undefined' && !window.confirm(resetLabel)) return;
    const key = `delete:${env.name}`;
    setActionKey(key);
    try {
      const res = await api.deleteDeployEnvironmentConfig(projectId, env.name);
      setEnvironments(res?.environments || []);
      notify(
        res?.removed
          ? env.active
            ? `${env.name} reset to default`
            : `${env.name} config removed`
          : `No config to remove for ${env.name}`,
        'success',
      );
    } catch (e: any) {
      notify(e?.message || 'Failed to remove environment config', 'error');
    } finally {
      setActionKey(null);
    }
  };

  const sorted = sortEnvironmentsForDisplay(environments);

  return (
    <section
      className="rounded-lg border border-gray-800 bg-gray-900/55 p-4"
      data-testid="environments-management-section"
    >
      <div className="mb-3 flex items-center gap-2">
        <Layers size={16} className="text-sky-400" />
        <h2 className="text-sm font-semibold text-gray-100">Manage environments</h2>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-gray-700 px-2.5 py-1.5 text-xs text-gray-300 hover:bg-gray-800 disabled:opacity-60"
          title="Refresh environments"
        >
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      <p className="mb-3 text-xs text-gray-500">
        Pause or resume an environment without editing{' '}
        <span className="font-mono">.agent-hub/deploy.yaml</span>. A paused environment cannot be
        deployed. Environments no longer declared in deploy.yaml are shown as{' '}
        <span className="text-gray-300">orphaned</span> so their stale config can be removed.
      </p>

      {error ? (
        <div className="flex items-center gap-2 rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-300">
          <AlertCircle size={15} />
          {error}
        </div>
      ) : loading && environments.length === 0 ? (
        <div className="p-6 text-center text-sm text-gray-500">Loading environments...</div>
      ) : sorted.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-800 p-8 text-center text-sm text-gray-500">
          No deployment environments found.
        </div>
      ) : (
        <div className="space-y-2">
          {sorted.map((env) => {
            const status = environmentStatus(env);
            const toggleKey = `toggle:${env.name}`;
            const deleteKey = `delete:${env.name}`;
            const canRemove = hasRuntimeConfig(env);
            return (
              <div
                key={env.name}
                data-testid={`manage-env-${env.name}`}
                className="rounded-md border border-gray-800 bg-gray-950/70 p-3"
              >
                <div className="flex flex-wrap items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-medium text-gray-200">{env.name}</span>
                      <StatusBadge status={status} />
                      {env.approval ? (
                        <span className="inline-flex items-center gap-1 rounded border border-fuchsia-500/30 bg-fuchsia-500/10 px-1.5 py-0.5 text-[11px] text-fuchsia-200">
                          <ShieldCheck size={11} />
                          gated
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-gray-500">
                      <span>live {shortRef(env.currentRef)}</span>
                      {env.runsOn ? <span>{env.runsOn}</span> : null}
                      {env.steps ? <span>{env.steps.length} steps</span> : null}
                      {!env.active ? (
                        <span className="text-gray-400">not in deploy.yaml</span>
                      ) : null}
                    </div>
                  </div>
                  <div className="flex flex-shrink-0 items-center gap-2">
                    <button
                      type="button"
                      onClick={() => toggleTriggers(env.name)}
                      aria-expanded={!!expandedTriggers[env.name]}
                      className={`inline-flex min-h-[30px] items-center gap-1.5 rounded-md border px-2.5 text-xs hover:bg-gray-800 ${
                        expandedTriggers[env.name]
                          ? 'border-amber-500/40 bg-amber-500/10 text-amber-200'
                          : 'border-gray-700 text-gray-300'
                      }`}
                      title="Manage deploy triggers"
                    >
                      {expandedTriggers[env.name] ? (
                        <ChevronDown size={12} />
                      ) : (
                        <ChevronRight size={12} />
                      )}
                      <Zap size={12} />
                      Triggers
                    </button>
                    {env.active ? (
                      <button
                        type="button"
                        onClick={() => setEnabled(env, !env.enabled)}
                        disabled={actionKey === toggleKey}
                        className={`inline-flex min-h-[30px] items-center gap-1.5 rounded-md border px-2.5 text-xs disabled:cursor-not-allowed disabled:opacity-50 ${
                          env.enabled
                            ? 'border-amber-500/40 bg-amber-500/10 text-amber-200 hover:bg-amber-500/20'
                            : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/20'
                        }`}
                      >
                        {actionKey === toggleKey ? (
                          <Loader2 size={12} className="animate-spin" />
                        ) : env.enabled ? (
                          <Pause size={12} />
                        ) : (
                          <Play size={12} />
                        )}
                        {env.enabled ? 'Pause' : 'Resume'}
                      </button>
                    ) : null}
                    {canRemove ? (
                      <button
                        type="button"
                        onClick={() => removeConfig(env)}
                        disabled={actionKey === deleteKey}
                        className="inline-flex min-h-[30px] items-center gap-1.5 rounded-md border border-gray-700 px-2.5 text-xs text-gray-300 hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50"
                        title={env.active ? 'Reset to enabled default' : 'Remove stale config'}
                      >
                        {actionKey === deleteKey ? (
                          <Loader2 size={12} className="animate-spin" />
                        ) : (
                          <Trash2 size={12} />
                        )}
                        {env.active ? 'Reset' : 'Remove'}
                      </button>
                    ) : null}
                  </div>
                </div>
                {expandedTriggers[env.name] && projectId ? (
                  <EnvironmentTriggersPanel
                    projectId={projectId}
                    environmentName={env.name}
                    showToast={showToast}
                  />
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
