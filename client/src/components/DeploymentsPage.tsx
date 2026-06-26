import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Circle,
  Clock,
  Loader2,
  Play,
  RefreshCw,
  Rocket,
  RotateCcw,
  ShieldCheck,
  Terminal,
  Wrench,
  XCircle,
} from 'lucide-react';
import { api } from '../utils/api';

const DEPLOYMENT_WS = 'agenthub-deployment-ws';
const TERMINAL_STATUSES = new Set(['success', 'error', 'cancelled']);

function shortRef(ref: any): string {
  const s = String(ref || '');
  if (!s) return '-';
  return s.length > 12 ? s.slice(0, 12) : s;
}

function parseDate(value: any): Date | null {
  if (!value) return null;
  const d = new Date(String(value).includes('T') ? value : `${value}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatDate(value: any): string {
  const d = parseDate(value);
  if (!d) return '-';
  return d.toLocaleString();
}

function isTerminalStatus(status: any): boolean {
  return TERMINAL_STATUSES.has(String(status || ''));
}

function statusClasses(status: any): string {
  const s = String(status || '').toLowerCase();
  if (s === 'success') return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300';
  if (s === 'error') return 'border-red-500/30 bg-red-500/10 text-red-300';
  if (s === 'cancelled') return 'border-amber-500/30 bg-amber-500/10 text-amber-200';
  if (s === 'running') return 'border-blue-500/30 bg-blue-500/10 text-blue-200';
  if (s === 'awaiting_approval') return 'border-fuchsia-500/30 bg-fuchsia-500/10 text-fuchsia-200';
  return 'border-gray-700 bg-gray-800/70 text-gray-300';
}

function StatusBadge({ status }: any) {
  const s = String(status || 'none');
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-md border text-[11px] font-medium ${statusClasses(
        s,
      )}`}
    >
      {s.replaceAll('_', ' ')}
    </span>
  );
}

function StepIcon({ status }: any) {
  const common = 'flex-shrink-0';
  if (status === 'success')
    return <CheckCircle2 size={15} className={`${common} text-emerald-400`} />;
  if (status === 'error') return <XCircle size={15} className={`${common} text-red-400`} />;
  if (status === 'cancelled') return <XCircle size={15} className={`${common} text-amber-400`} />;
  if (status === 'skipped') return <Circle size={15} className={`${common} text-gray-600`} />;
  if (status === 'running')
    return <Loader2 size={15} className={`${common} animate-spin text-blue-400`} />;
  return <Clock size={15} className={`${common} text-gray-500`} />;
}

function mergeConfigWithSnapshot(config: any, snapshot: any) {
  const deployment = snapshot?.deployment;
  if (!config || !deployment) return config;
  const terminal = isTerminalStatus(deployment.status);
  return {
    ...config,
    environments: (config.environments || []).map((env: any) => {
      if (env.name !== deployment.environment) return env;
      const currentDeployment =
        deployment.status === 'success' ? deployment : (env.currentDeployment ?? null);
      return {
        ...env,
        activeDeploymentId: terminal ? null : deployment.id,
        activeDeployment: terminal ? null : deployment,
        currentRef: deployment.status === 'success' ? deployment.ref : env.currentRef,
        currentDeploymentId:
          deployment.status === 'success' ? deployment.id : env.currentDeploymentId,
        currentDeployment,
        lastDeployment: deployment,
        rollbackTarget:
          deployment.status === 'success' && env.currentDeployment?.id !== deployment.id
            ? env.currentDeployment
            : env.rollbackTarget,
      };
    }),
  };
}

function preferredDeploymentFromConfig(config: any) {
  for (const env of config?.environments || []) {
    if (env.activeDeployment) return env.activeDeployment;
  }
  for (const env of config?.environments || []) {
    if (env.lastDeployment) return env.lastDeployment;
  }
  return null;
}

function isMissingDeployConfigError(err: any): boolean {
  const message = String(err?.message || err || '').toLowerCase();
  return message.includes('deploy.yaml not found');
}

export default function DeploymentsPage({ projectId, onNotify, onOpenSession }: any) {
  const [config, setConfig] = useState<any>(null);
  const [selected, setSelected] = useState<any>(null);
  const [refByEnv, setRefByEnv] = useState<Record<string, string>>({});
  const [events, setEvents] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [missingConfig, setMissingConfig] = useState(false);
  const [actionKey, setActionKey] = useState<string | null>(null);
  const [setupStarting, setSetupStarting] = useState(false);
  const selectedIdRef = useRef<string | null>(null);

  useEffect(() => {
    selectedIdRef.current = selected?.deployment?.id ?? null;
  }, [selected]);

  const notify = useCallback(
    (message: string, type: string = 'info') => onNotify?.(message, type),
    [onNotify],
  );

  const selectDeployment = useCallback(
    async (deployment: any) => {
      if (!deployment?.id) return;
      selectedIdRef.current = deployment.id;
      setSelected({ deployment, steps: [], approvals: [] });
      try {
        const detail = await api.getDeployment(projectId, deployment.id);
        if (selectedIdRef.current === deployment.id) setSelected(detail);
      } catch {
        if (selectedIdRef.current === deployment.id) {
          setSelected({ deployment, steps: [], approvals: [] });
        }
      }
    },
    [projectId],
  );

  const load = useCallback(
    async ({ silent = false }: any = {}) => {
      if (silent) setRefreshing(true);
      else {
        setLoading(true);
        setError(null);
      }
      try {
        const res = await api.getDeployConfig(projectId);
        setConfig(res);
        setMissingConfig(false);
        setRefByEnv((prev) => {
          const next = { ...prev };
          for (const env of res.environments || []) {
            if (!next[env.name]) next[env.name] = env.currentRef || 'HEAD';
          }
          return next;
        });
        const preferred = preferredDeploymentFromConfig(res);
        if (preferred && !selectedIdRef.current) {
          selectDeployment(preferred);
        }
      } catch (e: any) {
        if (isMissingDeployConfigError(e)) {
          setConfig(null);
          setMissingConfig(true);
          setError(null);
        } else {
          setMissingConfig(false);
          setError(e?.message || 'Failed to load deployments');
        }
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [projectId, selectDeployment],
  );

  const startSetup = useCallback(async () => {
    if (setupStarting) return;
    setSetupStarting(true);
    try {
      const res = await api.startDeployWizard(projectId);
      if (!res?.sessionId) {
        notify('Server did not return a setup session id', 'error');
        return;
      }
      notify('Deploy setup walkthrough started', 'success');
      if (typeof onOpenSession === 'function') {
        onOpenSession({ sessionId: res.sessionId, agentId: res.agentId });
      }
    } catch (e: any) {
      notify(e?.message || 'Failed to start deploy setup', 'error');
    } finally {
      setSetupStarting(false);
    }
  }, [notify, onOpenSession, projectId, setupStarting]);

  useEffect(() => {
    selectedIdRef.current = null;
    setSelected(null);
    setEvents([]);
    load();
  }, [load]);

  const applySnapshot = useCallback((snapshot: any) => {
    const deployment = snapshot?.deployment;
    if (!deployment) return;
    setConfig((prev: any) => mergeConfigWithSnapshot(prev, snapshot));
    if (!selectedIdRef.current || selectedIdRef.current === deployment.id) {
      selectedIdRef.current = deployment.id;
      setSelected((prev: any) => ({
        deployment,
        steps: snapshot.steps || [],
        approvals: snapshot.approvals || prev?.approvals || [],
      }));
    }
    setEvents((prev) =>
      [
        {
          id: `${deployment.id}-${deployment.status}-${Date.now()}`,
          deploymentId: deployment.id,
          environment: deployment.environment,
          status: deployment.status,
          ref: deployment.ref,
          at: new Date().toISOString(),
        },
        ...prev,
      ].slice(0, 20),
    );
  }, []);

  useEffect(() => {
    const onWs = (event: Event) => {
      const detail = (event as CustomEvent).detail || {};
      if (detail.projectId !== projectId) return;
      applySnapshot({
        deployment: detail.deployment,
        steps: detail.steps || [],
        approvals: detail.approvals || [],
      });
    };
    window.addEventListener(DEPLOYMENT_WS, onWs);
    return () => window.removeEventListener(DEPLOYMENT_WS, onWs);
  }, [applySnapshot, projectId]);

  const runAction = async (key: string, fn: () => Promise<any>, message: string) => {
    setActionKey(key);
    try {
      const snapshot = await fn();
      applySnapshot(snapshot);
      notify(message, 'success');
      load({ silent: true });
    } catch (e: any) {
      notify(e?.message || 'Deployment action failed', 'error');
    } finally {
      setActionKey(null);
    }
  };

  const environments = config?.environments || [];
  const selectedDeployment = selected?.deployment;
  const selectedSteps = selected?.steps || [];

  if (loading && !config) {
    return (
      <div className="h-full overflow-y-auto bg-gray-950 p-6">
        <div className="max-w-6xl mx-auto text-sm text-gray-500">Loading deployments...</div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto bg-gray-950">
      <div className="max-w-6xl mx-auto p-4">
        <div className="flex items-center gap-3 mb-4">
          <Rocket size={22} className="text-sky-400" />
          <h1 className="text-xl font-semibold text-gray-100">Deployments</h1>
          <button
            type="button"
            onClick={() => load({ silent: true })}
            className="ml-auto inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs text-gray-300 border border-gray-700 hover:bg-gray-800 disabled:opacity-60"
            disabled={refreshing}
            title="Refresh"
          >
            <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} />
            Refresh
          </button>
        </div>

        {error ? (
          <div className="flex items-center gap-2 p-4 rounded-lg border border-red-500/40 bg-red-500/10 text-red-300 text-sm">
            <AlertCircle size={16} />
            {error}
          </div>
        ) : missingConfig ? (
          <section className="rounded-lg border border-gray-800 bg-gray-900/55 p-6">
            <div className="flex items-start gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-sky-500/30 bg-sky-500/10 text-sky-200">
                <Wrench size={17} />
              </div>
              <div className="min-w-0 flex-1">
                <h2 className="text-base font-semibold text-gray-100">
                  Set up deployment environments
                </h2>
                <p className="mt-1 max-w-2xl text-sm text-gray-400">
                  This project does not have{' '}
                  <span className="font-mono">.agent-hub/deploy.yaml</span> yet. Start an AI setup
                  session to inspect the repo, choose environments, and author the config on a
                  reviewable branch.
                </p>
                <button
                  type="button"
                  onClick={startSetup}
                  disabled={setupStarting}
                  className="mt-4 inline-flex min-h-[34px] items-center justify-center gap-1.5 rounded-md border border-sky-500/40 bg-sky-500/15 px-3 text-sm text-sky-100 hover:bg-sky-500/25 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {setupStarting ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <Wrench size={14} />
                  )}
                  Start AI setup
                </button>
              </div>
            </div>
          </section>
        ) : environments.length === 0 ? (
          <div className="p-12 text-center text-gray-500 text-sm border border-dashed border-gray-800 rounded-lg">
            No deployment environments found.
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
              {environments.map((env: any) => {
                const active = env.activeDeployment;
                const last = env.lastDeployment;
                const busy = Boolean(active && !isTerminalStatus(active.status));
                const awaitingApproval = active?.status === 'awaiting_approval';
                const refValue = refByEnv[env.name] ?? env.currentRef ?? 'HEAD';
                const rollbackTargetId = env.rollbackTarget?.id;
                return (
                  <section
                    key={env.name}
                    data-testid={`deploy-env-${env.name}`}
                    className="rounded-lg border border-gray-800 bg-gray-900/55 p-4"
                  >
                    <div className="flex items-start gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <h2 className="text-base font-semibold text-gray-100 truncate">
                            {env.name}
                          </h2>
                          {env.approval && (
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-fuchsia-500/30 bg-fuchsia-500/10 text-[11px] text-fuchsia-200">
                              <ShieldCheck size={11} />
                              gated
                            </span>
                          )}
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-gray-500">
                          <span>live {env.currentRef ? shortRef(env.currentRef) : 'none'}</span>
                          <span>{env.runsOn}</span>
                          <span>{env.timeoutMinutes}m</span>
                          <span>{env.steps?.length || 0} steps</span>
                        </div>
                      </div>
                      <div className="ml-auto flex-shrink-0">
                        <StatusBadge status={active?.status || last?.status || 'idle'} />
                      </div>
                    </div>

                    <div className="mt-4 grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-2">
                      <input
                        aria-label={`Ref for ${env.name}`}
                        value={refValue}
                        onChange={(e) =>
                          setRefByEnv((prev) => ({ ...prev, [env.name]: e.target.value }))
                        }
                        className="min-h-[34px] rounded-md border border-gray-700 bg-gray-950 px-2 text-sm text-gray-200 outline-none focus:border-sky-500"
                        disabled={busy}
                      />
                      <button
                        type="button"
                        onClick={() =>
                          runAction(
                            `deploy:${env.name}`,
                            () =>
                              api.triggerDeployment(projectId, env.name, {
                                ref: refValue.trim() || 'HEAD',
                              }),
                            `Deploy started for ${env.name}`,
                          )
                        }
                        disabled={busy || actionKey === `deploy:${env.name}`}
                        className="inline-flex min-h-[34px] items-center justify-center gap-1.5 rounded-md border border-sky-500/40 bg-sky-500/15 px-3 text-sm text-sky-100 hover:bg-sky-500/25 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {actionKey === `deploy:${env.name}` ? (
                          <Loader2 size={14} className="animate-spin" />
                        ) : (
                          <Play size={14} />
                        )}
                        Deploy
                      </button>
                    </div>

                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() =>
                          runAction(
                            `rollback:${env.name}`,
                            () => api.rollbackDeployment(projectId, rollbackTargetId, {}),
                            `Rollback started for ${env.name}`,
                          )
                        }
                        disabled={busy || !rollbackTargetId || actionKey === `rollback:${env.name}`}
                        className="inline-flex min-h-[32px] items-center gap-1.5 rounded-md border border-gray-700 px-2.5 text-xs text-gray-300 hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50"
                        title={
                          env.rollbackTarget
                            ? `Rollback to ${shortRef(env.rollbackTarget.ref)}`
                            : 'No previous successful deployment'
                        }
                      >
                        <RotateCcw size={13} />
                        Rollback
                      </button>

                      {awaitingApproval && (
                        <button
                          type="button"
                          onClick={() =>
                            runAction(
                              `approve:${active.id}`,
                              () => api.approveDeployment(projectId, active.id, {}),
                              `Deployment approved for ${env.name}`,
                            )
                          }
                          disabled={actionKey === `approve:${active.id}`}
                          className="inline-flex min-h-[32px] items-center gap-1.5 rounded-md border border-fuchsia-500/40 bg-fuchsia-500/15 px-2.5 text-xs text-fuchsia-100 hover:bg-fuchsia-500/25 disabled:opacity-50"
                        >
                          {actionKey === `approve:${active.id}` ? (
                            <Loader2 size={13} className="animate-spin" />
                          ) : (
                            <ShieldCheck size={13} />
                          )}
                          Approve
                        </button>
                      )}

                      {(active || last) && (
                        <button
                          type="button"
                          onClick={() => selectDeployment(active || last)}
                          className="inline-flex min-h-[32px] items-center gap-1.5 rounded-md border border-gray-700 px-2.5 text-xs text-gray-300 hover:bg-gray-800"
                        >
                          <Terminal size={13} />
                          View
                        </button>
                      )}

                      <span className="ml-auto text-xs text-gray-500">
                        {last
                          ? `${shortRef(last.ref)} / ${formatDate(last.updated_at)}`
                          : 'No runs'}
                      </span>
                    </div>
                  </section>
                );
              })}
            </div>

            <div className="mt-4 grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_360px] gap-3">
              <section className="rounded-lg border border-gray-800 bg-gray-900/55 p-4">
                <div className="flex items-center gap-2 mb-3">
                  <Terminal size={16} className="text-gray-400" />
                  <h2 className="text-sm font-semibold text-gray-100">Selected Run</h2>
                  {selectedDeployment && (
                    <>
                      <StatusBadge status={selectedDeployment.status} />
                      <span className="ml-auto text-xs text-gray-500">
                        {selectedDeployment.environment} / {shortRef(selectedDeployment.ref)}
                      </span>
                    </>
                  )}
                </div>

                {!selectedDeployment ? (
                  <div className="p-8 text-center text-gray-500 text-sm border border-dashed border-gray-800 rounded-lg">
                    No deployment selected.
                  </div>
                ) : selectedSteps.length === 0 ? (
                  <div className="p-8 text-center text-gray-500 text-sm border border-dashed border-gray-800 rounded-lg">
                    No steps recorded yet.
                  </div>
                ) : (
                  <div className="space-y-2">
                    {selectedSteps.map((step: any) => (
                      <div
                        key={step.id}
                        className="rounded-md border border-gray-800 bg-gray-950/70 p-3"
                      >
                        <div className="flex items-start gap-2">
                          <StepIcon status={step.status} />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium text-gray-200 truncate">
                                {step.step_order}. {step.name}
                              </span>
                              <StatusBadge status={step.status} />
                            </div>
                            <div className="mt-1 flex flex-wrap gap-2 text-xs text-gray-500">
                              {step.started_at && (
                                <span>started {formatDate(step.started_at)}</span>
                              )}
                              {step.completed_at && (
                                <span>completed {formatDate(step.completed_at)}</span>
                              )}
                              {step.exit_code != null && <span>exit {step.exit_code}</span>}
                            </div>
                            {step.error && (
                              <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap rounded-md bg-black/35 p-2 text-xs text-red-200">
                                {step.error}
                              </pre>
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              <aside className="rounded-lg border border-gray-800 bg-gray-900/55 p-4">
                <div className="flex items-center gap-2 mb-3">
                  <RefreshCw size={15} className="text-gray-400" />
                  <h2 className="text-sm font-semibold text-gray-100">Live Stream</h2>
                </div>
                {events.length === 0 ? (
                  <div className="p-6 text-center text-gray-500 text-sm border border-dashed border-gray-800 rounded-lg">
                    Waiting for deployment updates.
                  </div>
                ) : (
                  <div className="space-y-2">
                    {events.map((event) => (
                      <div
                        key={event.id}
                        className="rounded-md border border-gray-800 bg-gray-950/70 p-2"
                      >
                        <div className="flex items-center gap-2">
                          <StatusBadge status={event.status} />
                          <span className="min-w-0 truncate text-xs text-gray-300">
                            {event.environment} / {shortRef(event.ref)}
                          </span>
                        </div>
                        <div className="mt-1 text-[11px] text-gray-600">{formatDate(event.at)}</div>
                      </div>
                    ))}
                  </div>
                )}
              </aside>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
