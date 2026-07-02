import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Circle,
  Clock,
  Layers,
  Loader2,
  Mail,
  Play,
  RefreshCw,
  Rocket,
  RotateCcw,
  Settings,
  ShieldCheck,
  Terminal,
  Users,
  Wrench,
  XCircle,
} from 'lucide-react';
import { api } from '../utils/api';
import { hasRole } from '../utils/auth';
import {
  recipientStatusLabel,
  recipientTypeLabel,
  summarizeRecipientCounts,
} from '../utils/deployRecipients';
import { buildNavigationHash } from '../utils/navigation';
import EnvironmentsManagementSection from './EnvironmentsManagementSection';
import ReleaseNotificationSettingsSection from './ReleaseNotificationSettingsSection';

const DEPLOYMENT_WS = 'agenthub-deployment-ws';
const TERMINAL_STATUSES = new Set(['success', 'error', 'cancelled']);
const CUSTOM_REF_VALUE = '__custom__';

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

function releaseItemClasses(item: any): string {
  return item?.inclusion_status === 'excluded'
    ? 'border-amber-500/30 bg-amber-500/10 text-amber-200'
    : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200';
}

function releaseItemLabel(item: any): string {
  return item?.inclusion_status === 'excluded' ? 'excluded' : 'included';
}

function releaseItemCardTitle(item: any): string {
  const title = item?.card?.title || item?.card_title || item?.card_id || 'Card';
  const shortId = item?.card?.shortId ?? item?.card_short_id ?? null;
  return shortId ? `#${shortId} ${title}` : String(title);
}

function releaseVersionDeployments(deployments: any[]): any[] {
  return (deployments || []).filter((deployment) => deployment?.status === 'success');
}

function releaseVersionLabel(deployment: any): string {
  const ref = String(deployment?.ref || deployment?.id || 'release');
  const displayRef = ref.startsWith('refs/tags/') ? ref.slice('refs/tags/'.length) : ref;
  return `${displayRef} / ${deployment?.environment || 'environment'} / ${formatDate(
    deployment?.completed_at || deployment?.updated_at || deployment?.created_at,
  )}`;
}

function notificationRecipientLabel(notification: any): string {
  if (notification?.recipient_type === 'reporter') return 'Reporter';
  if (notification?.recipient_type === 'release_digest') return 'Release digest';
  return String(notification?.recipient_type || notification?.notification_type || 'Recipient');
}

function notificationStatusLabel(notification: any): string {
  return String(notification?.status || 'pending').replaceAll('_', ' ');
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

function branchNames(branchData: any): string[] {
  return Array.isArray(branchData?.branches)
    ? branchData.branches.map((branch: any) => branch?.name).filter(Boolean)
    : [];
}

function defaultDeployRef(env: any, branchData: any): string {
  const defaultBranch =
    branchData?.defaultBranch ||
    branchData?.branches?.find((branch: any) => branch?.isDefault)?.name ||
    null;
  return defaultBranch || env.currentRef || 'HEAD';
}

function loadDeployBranches(projectId: string): Promise<any> {
  return api
    .getProjectBranches(projectId)
    .catch(() => api.getGitHostBranches(projectId).catch(() => null));
}

function loadReleaseVersionDeployments(projectId: string): Promise<any[]> {
  return api
    .listDeployments(projectId, { limit: 100 })
    .then((history: any) => releaseVersionDeployments(history?.deployments || []))
    .catch(() => []);
}

export default function DeploymentsPage({ projectId, onNotify, onOpenSession }: any) {
  const [config, setConfig] = useState<any>(null);
  const [branchData, setBranchData] = useState<any>(null);
  const [releaseDeployments, setReleaseDeployments] = useState<any[]>([]);
  const [selected, setSelected] = useState<any>(null);
  const [refByEnv, setRefByEnv] = useState<Record<string, string>>({});
  const [events, setEvents] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [missingConfig, setMissingConfig] = useState(false);
  const [actionKey, setActionKey] = useState<string | null>(null);
  const [setupStarting, setSetupStarting] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showManage, setShowManage] = useState(false);
  const [recipients, setRecipients] = useState<any[] | null>(null);
  const [recipientsLoading, setRecipientsLoading] = useState(false);
  const [recipientsError, setRecipientsError] = useState<string | null>(null);
  const selectedIdRef = useRef<string | null>(null);

  const isAdmin = hasRole('Admin');

  useEffect(() => {
    selectedIdRef.current = selected?.deployment?.id ?? null;
  }, [selected]);

  // Recipient emails are PII loaded on demand — clear the audit list whenever
  // the operator switches to a different deployment.
  useEffect(() => {
    setRecipients(null);
    setRecipientsError(null);
  }, [selected?.deployment?.id]);

  const notify = useCallback(
    (message: string, type: string = 'info') => onNotify?.(message, type),
    [onNotify],
  );

  const selectDeployment = useCallback(
    async (deployment: any) => {
      if (!deployment?.id) return;
      selectedIdRef.current = deployment.id;
      setSelected({ deployment, steps: [], approvals: [], releaseItems: [] });
      try {
        const detail = await api.getDeployment(projectId, deployment.id);
        if (selectedIdRef.current === deployment.id) setSelected(detail);
      } catch {
        if (selectedIdRef.current === deployment.id) {
          setSelected({ deployment, steps: [], approvals: [], releaseItems: [] });
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
        const [res, branches, releaseHistory] = await Promise.all([
          api.getDeployConfig(projectId),
          loadDeployBranches(projectId),
          loadReleaseVersionDeployments(projectId),
        ]);
        setConfig(res);
        setBranchData(branches);
        setReleaseDeployments(releaseHistory);
        setMissingConfig(false);
        setRefByEnv((prev) => {
          const next = { ...prev };
          for (const env of res.environments || []) {
            if (!next[env.name]) next[env.name] = defaultDeployRef(env, branches);
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
          setBranchData(null);
          setReleaseDeployments([]);
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
    setRefByEnv({});
    setBranchData(null);
    setEvents([]);
    load();
  }, [load]);

  const applySnapshot = useCallback((snapshot: any) => {
    const deployment = snapshot?.deployment;
    if (!deployment) return;
    setConfig((prev: any) => mergeConfigWithSnapshot(prev, snapshot));
    setReleaseDeployments((prev) => {
      const withoutCurrent = prev.filter((item) => item?.id !== deployment.id);
      return deployment.status === 'success' ? [deployment, ...withoutCurrent] : withoutCurrent;
    });
    if (!selectedIdRef.current || selectedIdRef.current === deployment.id) {
      selectedIdRef.current = deployment.id;
      setSelected((prev: any) => ({
        deployment,
        steps: snapshot.steps || [],
        approvals: snapshot.approvals || prev?.approvals || [],
        releaseItems: snapshot.releaseItems || prev?.releaseItems || [],
        releaseNotifications: snapshot.releaseNotifications || prev?.releaseNotifications || [],
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
  const selectedReleaseItems = selected?.releaseItems || [];
  const selectedReleaseNotifications = selected?.releaseNotifications || [];
  const releaseOptions =
    releaseDeployments.length > 0 && selectedDeployment?.status === 'success'
      ? [
          selectedDeployment,
          ...releaseDeployments.filter((deployment) => deployment.id !== selectedDeployment.id),
        ]
      : releaseDeployments;
  const selectedReleaseDeploymentId =
    selectedDeployment?.status === 'success' ? selectedDeployment.id : '';

  const adjustReleaseItem = async (item: any, inclusionStatus: 'included' | 'excluded') => {
    if (!selectedDeployment?.id || !item?.card_id) return;
    const reason =
      typeof window === 'undefined'
        ? ''
        : window.prompt(
            `${inclusionStatus === 'included' ? 'Include' : 'Exclude'} ${releaseItemCardTitle(
              item,
            )}. Enter a reason:`,
          );
    if (!reason || !reason.trim()) return;
    const key = `release:${item.card_id}:${inclusionStatus}`;
    setActionKey(key);
    try {
      const res = await api.adjustDeploymentReleaseItem(
        projectId,
        selectedDeployment.id,
        item.card_id,
        {
          inclusionStatus,
          reason: reason.trim(),
        },
      );
      setSelected((prev: any) =>
        prev
          ? {
              ...prev,
              releaseItems: res.releaseItems || prev.releaseItems || [],
            }
          : prev,
      );
      notify(
        `${releaseItemCardTitle(item)} ${inclusionStatus === 'included' ? 'included' : 'excluded'}`,
        'success',
      );
    } catch (e: any) {
      notify(e?.message || 'Failed to update release item', 'error');
    } finally {
      setActionKey(null);
    }
  };

  const retryNotification = async (notification: any) => {
    if (!selectedDeployment?.id || !notification?.id) return;
    const key = `notification:${notification.id}:retry`;
    setActionKey(key);
    try {
      const res = await api.retryReleaseNotification(
        projectId,
        selectedDeployment.id,
        notification.id,
      );
      setSelected((prev: any) =>
        prev
          ? {
              ...prev,
              releaseNotifications: res.releaseNotifications || prev.releaseNotifications || [],
            }
          : prev,
      );
      notify('Release notification queued for retry', 'success');
    } catch (e: any) {
      notify(e?.message || 'Failed to retry release notification', 'error');
    } finally {
      setActionKey(null);
    }
  };

  const loadRecipients = async () => {
    if (!selectedDeployment?.id) return;
    setRecipientsLoading(true);
    setRecipientsError(null);
    try {
      const res = await api.getDeploymentNotificationRecipients(projectId, selectedDeployment.id);
      setRecipients(res?.recipients || []);
    } catch (e: any) {
      setRecipientsError(e?.message || 'Failed to load recipients');
    } finally {
      setRecipientsLoading(false);
    }
  };

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
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={() => setShowManage((prev) => !prev)}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs border disabled:opacity-60 ${
                showManage
                  ? 'border-sky-500/40 bg-sky-500/15 text-sky-100'
                  : 'border-gray-700 text-gray-300 hover:bg-gray-800'
              }`}
              title="Manage environments"
              aria-pressed={showManage}
              aria-expanded={showManage}
            >
              <Layers size={13} />
              Environments
            </button>
            <button
              type="button"
              onClick={() => setShowSettings((prev) => !prev)}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs border disabled:opacity-60 ${
                showSettings
                  ? 'border-sky-500/40 bg-sky-500/15 text-sky-100'
                  : 'border-gray-700 text-gray-300 hover:bg-gray-800'
              }`}
              title="Release digest settings"
              aria-pressed={showSettings}
              aria-expanded={showSettings}
            >
              <Settings size={13} />
              Settings
            </button>
            <button
              type="button"
              onClick={() => load({ silent: true })}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs text-gray-300 border border-gray-700 hover:bg-gray-800 disabled:opacity-60"
              disabled={refreshing}
              title="Refresh"
            >
              <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} />
              Refresh
            </button>
          </div>
        </div>

        {showManage && (
          <div className="mb-4" data-testid="deployments-manage-panel">
            <EnvironmentsManagementSection projectId={projectId} showToast={onNotify} />
          </div>
        )}

        {showSettings && (
          <div className="mb-4" data-testid="deployments-settings-panel">
            <ReleaseNotificationSettingsSection projectId={projectId} showToast={onNotify} />
          </div>
        )}

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
                const refValue = refByEnv[env.name] ?? defaultDeployRef(env, branchData);
                const branches = branchNames(branchData);
                const hasBranches = branches.length > 0;
                const selectedBranchValue = branches.includes(refValue)
                  ? refValue
                  : CUSTOM_REF_VALUE;
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
                      <div className="grid grid-cols-1 md:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] gap-2">
                        {hasBranches ? (
                          <select
                            aria-label={`Ref for ${env.name}`}
                            value={selectedBranchValue}
                            onChange={(e) => {
                              if (e.target.value === CUSTOM_REF_VALUE) return;
                              setRefByEnv((prev) => ({ ...prev, [env.name]: e.target.value }));
                            }}
                            className="min-h-[34px] rounded-md border border-gray-700 bg-gray-950 px-2 text-sm text-gray-200 outline-none focus:border-sky-500"
                            disabled={busy}
                          >
                            {branches.map((branch) => (
                              <option key={branch} value={branch}>
                                {branch}
                                {branch === defaultDeployRef({ currentRef: null }, branchData)
                                  ? ' (default)'
                                  : ''}
                              </option>
                            ))}
                            <option value={CUSTOM_REF_VALUE}>Custom ref</option>
                          </select>
                        ) : null}
                        <input
                          aria-label={
                            hasBranches ? `Manual ref for ${env.name}` : `Ref for ${env.name}`
                          }
                          value={refValue}
                          onChange={(e) =>
                            setRefByEnv((prev) => ({ ...prev, [env.name]: e.target.value }))
                          }
                          placeholder="Branch, tag, or SHA"
                          className="min-h-[34px] rounded-md border border-gray-700 bg-gray-950 px-2 text-sm text-gray-200 outline-none focus:border-sky-500"
                          disabled={busy}
                        />
                      </div>
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

                {releaseOptions.length > 0 && (
                  <div className="mb-4 rounded-md border border-gray-800 bg-gray-950/70 p-3">
                    <label
                      htmlFor="deployment-release-version"
                      className="mb-1 block text-xs font-semibold uppercase text-gray-400"
                    >
                      Release version
                    </label>
                    <select
                      id="deployment-release-version"
                      aria-label="Release version"
                      value={selectedReleaseDeploymentId}
                      onChange={(event) => {
                        const deployment = releaseOptions.find(
                          (candidate) => candidate.id === event.target.value,
                        );
                        if (deployment) selectDeployment(deployment);
                      }}
                      className="min-h-[34px] w-full rounded-md border border-gray-700 bg-gray-950 px-2 text-sm text-gray-200 outline-none focus:border-sky-500"
                    >
                      <option value="">Select a released version</option>
                      {releaseOptions.map((deployment) => (
                        <option key={deployment.id} value={deployment.id}>
                          {releaseVersionLabel(deployment)}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

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
                              {step.github_conclusion && (
                                <span>
                                  workflow {String(step.github_conclusion).replaceAll('_', ' ')}
                                </span>
                              )}
                            </div>
                            {step.github_run_url && (
                              <a
                                href={step.github_run_url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="mt-1 inline-flex max-w-full items-center gap-1 truncate text-xs text-sky-300 hover:text-sky-200"
                              >
                                <Rocket size={11} />
                                View GitHub Actions run
                                {step.github_run_id ? ` #${step.github_run_id}` : ''}
                              </a>
                            )}
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

                {selectedDeployment && (
                  <div className="mt-4 border-t border-gray-800 pt-4">
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <h3 className="text-xs font-semibold uppercase text-gray-400">
                        Release changes
                      </h3>
                      <span className="text-xs text-gray-500">
                        {
                          selectedReleaseItems.filter(
                            (item: any) => item.inclusion_status !== 'excluded',
                          ).length
                        }{' '}
                        included
                      </span>
                    </div>
                    {selectedReleaseItems.length === 0 ? (
                      <div className="rounded-md border border-dashed border-gray-800 p-4 text-center text-sm text-gray-500">
                        No release items recorded for this deployment.
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {selectedReleaseItems.map((item: any) => {
                          const nextStatus =
                            item.inclusion_status === 'excluded' ? 'included' : 'excluded';
                          const actionLabel = nextStatus === 'included' ? 'Include' : 'Exclude';
                          const actionKeyForItem = `release:${item.card_id}:${nextStatus}`;
                          return (
                            <div
                              key={item.id}
                              className="rounded-md border border-gray-800 bg-gray-950/70 p-3"
                            >
                              <div className="flex flex-wrap items-start gap-2">
                                <div className="min-w-0 flex-1">
                                  <div className="flex flex-wrap items-center gap-2">
                                    <span className="truncate text-sm font-medium text-gray-200">
                                      {releaseItemCardTitle(item)}
                                    </span>
                                    <span
                                      className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-medium ${releaseItemClasses(
                                        item,
                                      )}`}
                                    >
                                      {releaseItemLabel(item)}
                                    </span>
                                  </div>
                                  {item.supportTicket ? (
                                    <a
                                      className="mt-1 inline-flex max-w-full truncate text-xs text-sky-300 hover:text-sky-200"
                                      href={buildNavigationHash({
                                        view: 'support',
                                        projectId,
                                        ticketId: item.supportTicket.id,
                                      })}
                                    >
                                      {item.supportTicket.subject || 'Support ticket'} (
                                      {item.supportTicket.id})
                                    </a>
                                  ) : (
                                    <div className="mt-1 text-xs text-gray-500">
                                      No linked support ticket
                                    </div>
                                  )}
                                  {item.operator_adjustment_note ? (
                                    <div className="mt-2 text-xs text-gray-500">
                                      Last reason: {item.operator_adjustment_note}
                                    </div>
                                  ) : null}
                                </div>
                                <button
                                  type="button"
                                  onClick={() => adjustReleaseItem(item, nextStatus)}
                                  disabled={actionKey === actionKeyForItem}
                                  className="inline-flex min-h-[30px] items-center gap-1.5 rounded-md border border-gray-700 px-2.5 text-xs text-gray-300 hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                  {actionKey === actionKeyForItem ? (
                                    <Loader2 size={12} className="animate-spin" />
                                  ) : nextStatus === 'included' ? (
                                    <CheckCircle2 size={12} />
                                  ) : (
                                    <XCircle size={12} />
                                  )}
                                  {actionLabel}
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}

                {selectedDeployment && (
                  <div className="mt-4 border-t border-gray-800 pt-4">
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <h3 className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase text-gray-400">
                        <Mail size={13} />
                        Notifications
                      </h3>
                      <span className="text-xs text-gray-500">
                        {selectedReleaseNotifications.length} recorded
                      </span>
                    </div>
                    {selectedReleaseNotifications.length === 0 ? (
                      <div className="rounded-md border border-dashed border-gray-800 p-4 text-center text-sm text-gray-500">
                        No release notifications recorded for this deployment.
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {selectedReleaseNotifications.map((notification: any) => {
                          const retryKey = `notification:${notification.id}:retry`;
                          return (
                            <div
                              key={notification.id}
                              className="rounded-md border border-gray-800 bg-gray-950/70 p-3"
                            >
                              <div className="flex flex-wrap items-start gap-2">
                                <div className="min-w-0 flex-1">
                                  <div className="flex flex-wrap items-center gap-2">
                                    <span className="text-sm font-medium text-gray-200">
                                      {notificationRecipientLabel(notification)}
                                    </span>
                                    <StatusBadge status={notification.status} />
                                    <span className="text-xs text-gray-500">
                                      {notification.attempts || 0} attempts
                                    </span>
                                  </div>
                                  <div className="mt-1 truncate text-xs text-gray-400">
                                    {notification.subject || 'Release notification'}
                                  </div>
                                  <div className="mt-1 flex flex-wrap gap-2 text-xs text-gray-500">
                                    {notification.sent_at ? (
                                      <span>sent {formatDate(notification.sent_at)}</span>
                                    ) : (
                                      <span>{notificationStatusLabel(notification)}</span>
                                    )}
                                    {notification.next_attempt_at ? (
                                      <span>next {formatDate(notification.next_attempt_at)}</span>
                                    ) : null}
                                  </div>
                                  {notification.error_summary ? (
                                    <div className="mt-2 rounded border border-red-500/20 bg-red-500/10 px-2 py-1 text-xs text-red-200">
                                      {notification.error_summary}
                                    </div>
                                  ) : null}
                                </div>
                                {notification.can_retry ? (
                                  <button
                                    type="button"
                                    onClick={() => retryNotification(notification)}
                                    disabled={actionKey === retryKey}
                                    className="inline-flex min-h-[30px] items-center gap-1.5 rounded-md border border-gray-700 px-2.5 text-xs text-gray-300 hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50"
                                  >
                                    {actionKey === retryKey ? (
                                      <Loader2 size={12} className="animate-spin" />
                                    ) : (
                                      <RefreshCw size={12} />
                                    )}
                                    Retry
                                  </button>
                                ) : null}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {isAdmin ? (
                      <div className="mt-4 border-t border-gray-800 pt-3">
                        <div className="mb-2 flex items-center justify-between gap-2">
                          <div className="flex items-center gap-1.5">
                            <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                              Recipients
                            </span>
                            <span className="rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-amber-300">
                              Admin
                            </span>
                          </div>
                          {recipients ? (
                            <span className="text-[11px] text-gray-500">
                              {summarizeRecipientCounts(recipients)}
                            </span>
                          ) : null}
                        </div>
                        <p className="mb-2 text-[11px] leading-relaxed text-gray-500">
                          Who these notifications were addressed to, including recipient email.
                          Loaded on demand — Admin only.
                        </p>

                        {recipientsError ? (
                          <div className="mb-2 rounded border border-red-500/30 bg-red-500/10 px-2 py-1 text-xs text-red-300">
                            {recipientsError}
                          </div>
                        ) : null}

                        {recipients === null ? (
                          <button
                            type="button"
                            onClick={loadRecipients}
                            disabled={recipientsLoading}
                            data-testid="show-recipients"
                            className="inline-flex min-h-[30px] items-center gap-1.5 rounded-md border border-gray-700 px-2.5 text-xs text-gray-300 hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            {recipientsLoading ? (
                              <Loader2 size={12} className="animate-spin" />
                            ) : (
                              <Users size={12} />
                            )}
                            Show recipients
                          </button>
                        ) : recipients.length === 0 ? (
                          <div className="rounded-md border border-dashed border-gray-800 p-3 text-center text-xs text-gray-500">
                            No recipients recorded for this deployment.
                          </div>
                        ) : (
                          <div className="space-y-1.5" data-testid="recipients-list">
                            {recipients.map((recipient: any) => (
                              <div
                                key={recipient.id}
                                className="rounded-md border border-gray-800 bg-gray-950/70 p-2.5"
                              >
                                <div className="flex flex-wrap items-center gap-2">
                                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-gray-200">
                                    {recipient.recipient_email}
                                  </span>
                                  <StatusBadge status={recipient.status} />
                                </div>
                                <div className="mt-1 flex flex-wrap gap-2 text-[11px] text-gray-500">
                                  <span>{recipientTypeLabel(recipient)}</span>
                                  <span>{recipient.attempts || 0} attempts</span>
                                  {recipient.sent_at ? (
                                    <span>sent {formatDate(recipient.sent_at)}</span>
                                  ) : (
                                    <span>{recipientStatusLabel(recipient)}</span>
                                  )}
                                </div>
                                {recipient.error_summary ? (
                                  <div className="mt-1.5 rounded border border-red-500/20 bg-red-500/10 px-2 py-1 text-[11px] text-red-200">
                                    {recipient.error_summary}
                                  </div>
                                ) : null}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    ) : null}
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
