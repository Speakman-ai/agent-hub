import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity,
  AlertCircle,
  BellRing,
  Boxes,
  Cloud,
  Gauge,
  Loader2,
  Server,
  Sparkles,
} from 'lucide-react';
import InfraScopeEditor from './InfraScopeEditor';
import InfraHealthTimeline from './InfraHealthTimeline';
import InfraSpendPanel from './InfraSpendPanel';
import InfraQuotaHeadroomPanel from './InfraQuotaHeadroomPanel';
import InfraResourceBrowser, { type InfraResourceWire } from './InfraResourceBrowser';
import InfraMetricChart from './InfraMetricChart';
import InfraServiceNotes from './InfraServiceNotes';
import { notesPackFor, type InfraServicePackWire } from '@shared/utils/infraPacks';
import { api, type InfraSetupBlockerWire, type InfraSetupDraftWire } from '../../utils/api';

export interface InfraMonitoringStatus {
  profile?: string | null;
  region?: string | null;
  reachable?: boolean;
  code?: string;
  reason?: 'not_designated' | 'interactive_sso';
  error?: string;
}

export interface InfrastructurePageProps {
  projectId: string;
  projectName?: string;
  /** Project metadata is used for local setup hints. */
  project?: Record<string, any> | null;
  /** Optional status supplied by a future monitoring data surface. */
  monitoringStatus?: InfraMonitoringStatus | null;
  /** Scope data is supplied by the scope editor once that surface is available. */
  scopeConfigured?: boolean;
  showToast?: (message: string, type?: string) => void;
  /**
   * Focus a chat session. Supplied by the host app; when it is absent the
   * "Set up with AI" button is not rendered at all, because starting a wizard
   * session the user is then never navigated to would strand it.
   */
  onOpenSession?: (target: { sessionId: string; agentId: string }) => void;
}

/**
 * The operator-facing meaning of one draft blocker.
 *
 * Server-side these are codes, and the draft's `notes[]` carry the prose —
 * including detail no enum can, like the name of a designation that no longer
 * resolves. So the codes get a short title here and the notes render beneath
 * them verbatim, rather than this table trying to restate the server.
 */
export function describeInfraBlocker(blocker: InfraSetupBlockerWire): string {
  switch (blocker) {
    case 'infra-disabled':
      return 'The Infrastructure module is off for this project.';
    case 'no-profiles':
      return 'No AWS profiles are configured for this project.';
    case 'only-sso-profiles':
      return 'Every configured profile is interactive SSO, which cannot run unattended.';
    case 'no-monitoring-profile':
      return 'No usable monitoring profile is designated.';
    case 'storage-unavailable':
      return 'The infrastructure database is not open, so stored scopes could not be read.';
    case 'no-scope':
      return 'No collection scope is enabled, so nothing is polled.';
    default:
      return blocker;
  }
}

type InfrastructureTab = 'overview' | 'resources' | 'metrics' | 'alerts';

const TABS: ReadonlyArray<{
  key: InfrastructureTab;
  label: string;
  icon: React.ReactNode;
}> = [
  { key: 'overview', label: 'Overview', icon: <Gauge size={14} /> },
  { key: 'resources', label: 'Resources', icon: <Boxes size={14} /> },
  { key: 'metrics', label: 'Metrics', icon: <Activity size={14} /> },
  { key: 'alerts', label: 'Alerts', icon: <BellRing size={14} /> },
];

function EmptyState({ testId, title, children }: any) {
  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-5" data-testid={testId}>
      <h3 className="text-sm font-medium text-gray-200">{title}</h3>
      <p className="mt-1 text-xs leading-5 text-gray-500">{children}</p>
    </div>
  );
}

function MonitoringStatusCard({
  status,
  missing,
}: {
  status: InfraMonitoringStatus | null;
  missing: boolean;
}) {
  if (missing) {
    return (
      <EmptyState testId="infra-empty-monitoring-profile" title="no monitoring profile designated">
        Designate a static or assume-role AWS profile before Agent Hub can collect infrastructure
        telemetry unattended.
      </EmptyState>
    );
  }

  if (status && status.reachable === false) {
    return (
      <EmptyState testId="infra-monitoring-unreachable" title="monitoring profile unavailable">
        {status.error ||
          'The designated AWS profile could not be reached. Check its credentials and region.'}
      </EmptyState>
    );
  }

  return (
    <div className="rounded-xl border border-emerald-900/60 bg-emerald-950/20 p-5">
      <div className="flex items-center gap-2 text-sm font-medium text-emerald-300">
        <Cloud size={15} />
        Monitoring profile ready
      </div>
      <p className="mt-1 text-xs text-gray-500">
        {status?.profile
          ? `Using ${status.profile}${status.region ? ` in ${status.region}` : ''}.`
          : 'AWS monitoring is ready.'}
      </p>
    </div>
  );
}

export default function InfrastructurePage({
  projectId,
  projectName,
  project,
  monitoringStatus,
  scopeConfigured,
  showToast,
  onOpenSession,
}: InfrastructurePageProps): React.ReactElement {
  const [tab, setTab] = useState<InfrastructureTab>('overview');
  const status = monitoringStatus ?? null;

  // AI setup wizard: spawns a worktree-backed `[Infra Setup]` session that
  // probes the account read-only and proposes an allowlist, then focuses it.
  //
  // The draft is stamped with the project it describes, for the same reason
  // `liveScope` and `selected` are below: clearing it in an effect leaves one
  // render in which the previous project's blockers are on screen under this
  // project's header. Stamping makes it self-invalidating on the same render.
  const [draftState, setDraftState] = useState<{
    projectId: string;
    draft: InfraSetupDraftWire;
  } | null>(null);
  const draft = draftState && draftState.projectId === projectId ? draftState.draft : null;
  const blockers = draft?.blockers ?? [];
  const [wizardStarting, setWizardStarting] = useState(false);
  const [wizardError, setWizardError] = useState<string | null>(null);

  // Guard against a stale async response committing to the wrong project.
  // Without it, starting the wizard and switching projects mid-request would
  // navigate to a session belonging to the project the user just left. Set
  // synchronously before any load starts.
  const activePidRef = useRef('');

  const inferredScopeConfigured = Array.isArray(project?.infraScopes)
    ? project.infraScopes.length > 0
    : Number(project?.infraScopeCount) > 0;
  // The editor is authoritative once it has spoken to the server: it reports
  // what is actually stored, where the props are a caller's guess from project
  // metadata. Until then the guess drives the other tabs' empty states.
  //
  // Stamped with the project it describes rather than reset by an effect. The
  // answer is only meaningful for one project, so binding it to that project
  // makes it self-invalidating: on a switch the stamp stops matching and the
  // value is ignored on the very same render, leaving no window in which the
  // previous project's scope state decides whether this project's Resources,
  // Metrics and Alerts tabs are shown.
  const [liveScope, setLiveScope] = useState<{ projectId: string; configured: boolean } | null>(
    null,
  );
  const liveScopeConfigured =
    liveScope && liveScope.projectId === projectId ? liveScope.configured : null;
  const hasScope = liveScopeConfigured ?? scopeConfigured ?? inferredScopeConfigured;

  // The resource the Metrics tab charts. Stamped with its project for the same
  // reason `liveScope` is: a selection only means something for one project, so
  // binding it makes the value self-invalidating on a switch rather than
  // charting the previous project's resource under this project's header.
  const [selected, setSelected] = useState<{
    projectId: string;
    resource: InfraResourceWire;
  } | null>(null);
  const selectedResource = selected && selected.projectId === projectId ? selected.resource : null;

  useEffect(() => {
    setSelected(null);
  }, [projectId]);

  useEffect(() => {
    if (!projectId) return;
    activePidRef.current = projectId;
    const pid = projectId;
    setWizardError(null);
    // Reset the pending flag too: a still-in-flight start from the previous
    // project keeps its guarded `finally` from clearing it (the pid check
    // skips), so without this the new project would inherit a permanently
    // disabled "Set up with AI" button.
    setWizardStarting(false);
    api
      .getInfraSetupDraft(pid)
      .then((body) => {
        if (activePidRef.current !== pid) return; // stale — project changed
        if (body?.draft) setDraftState({ projectId: pid, draft: body.draft });
      })
      .catch(() => {
        // A readiness report the operator cannot see is a worse empty state,
        // not a broken module. The tabs below stand on their own data.
        if (activePidRef.current === pid) setDraftState(null);
      });
  }, [projectId]);

  const handleStartWizard = useCallback(async () => {
    if (!projectId || wizardStarting) return;
    const pid = projectId;
    setWizardStarting(true);
    setWizardError(null);
    try {
      const res = await api.startInfraWizard(pid);
      if (activePidRef.current !== pid) return; // switched projects
      if (!res?.sessionId) {
        setWizardError('Server did not return a wizard session id');
        return;
      }
      if (onOpenSession) onOpenSession({ sessionId: res.sessionId, agentId: res.agentId });
    } catch (err) {
      if (activePidRef.current !== pid) return;
      setWizardError((err as Error)?.message || 'Failed to start the infrastructure setup wizard');
    } finally {
      if (activePidRef.current === pid) setWizardStarting(false);
    }
  }, [projectId, wizardStarting, onOpenSession]);

  // The pack catalog is static declarations — no per-project state, no AWS
  // call — so it is fetched once per project rather than per tab switch, and a
  // failure is silent: a missing caveat is a worse chart, not a broken one.
  const [packs, setPacks] = useState<InfraServicePackWire[]>([]);
  useEffect(() => {
    let cancelled = false;
    setPacks([]);
    api
      .getInfraMetricPacks(projectId)
      .then((body) => {
        if (!cancelled) setPacks(Array.isArray(body?.packs) ? body.packs : []);
      })
      .catch(() => {
        if (!cancelled) setPacks([]);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const notesPack = notesPackFor(packs, selectedResource);

  const handleSelectResource = useCallback(
    (resource: InfraResourceWire) => {
      setSelected({ projectId, resource });
      setTab('metrics');
    },
    [projectId],
  );

  const handleScopesChange = useCallback(
    (response: Record<string, any>) => {
      setLiveScope({
        projectId,
        configured: Array.isArray(response?.scopes)
          ? response.scopes.some((s: any) => s?.enabled !== false)
          : !!response?.configured,
      });
    },
    [projectId],
  );
  const monitoringProfile = project?.awsMonitoringProfile;
  const monitoringMissing =
    (!status?.profile && !monitoringProfile) ||
    status?.reason === 'not_designated' ||
    status?.code === 'monitoring_profile_required';

  return (
    <div className="flex h-full flex-col" data-testid="infrastructure-page">
      <header className="mb-3 flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <Server size={18} className="text-gray-400" />
          <div>
            <h2 className="text-lg font-semibold text-gray-100">Infrastructure</h2>
            <p className="text-xs text-gray-500">
              AWS resource health, metrics, and alerts{projectName ? ` for ${projectName}` : ''}.
            </p>
          </div>
        </div>
        {onOpenSession && (
          <button
            type="button"
            onClick={handleStartWizard}
            disabled={!projectId || wizardStarting}
            data-testid="infra-setup-wizard-button"
            title="Let an AI agent probe this AWS account read-only and propose a collection scope"
            className="inline-flex flex-shrink-0 items-center gap-2 rounded-lg bg-sky-600 px-3 py-2 text-xs font-medium text-white hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {wizardStarting ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Sparkles size={14} />
            )}
            {wizardStarting ? 'Starting…' : 'Set up with AI'}
          </button>
        )}
      </header>

      {wizardError && (
        <div
          className="mb-3 flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 p-2 text-xs text-red-300"
          data-testid="infra-setup-wizard-error"
        >
          <AlertCircle size={14} className="flex-shrink-0" />
          <span>{wizardError}</span>
        </div>
      )}

      <nav className="mb-3 flex items-center gap-1 border-b border-gray-800" role="tablist">
        {TABS.map((item) => (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={tab === item.key}
            aria-controls={`infra-panel-${item.key}`}
            onClick={() => setTab(item.key)}
            className={`-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm ${
              tab === item.key
                ? 'border-sky-500 text-white'
                : 'border-transparent text-gray-400 hover:text-gray-200'
            }`}
          >
            {item.icon}
            {item.label}
          </button>
        ))}
      </nav>

      <div className="min-h-0 flex-1 overflow-y-auto" role="tabpanel" id={`infra-panel-${tab}`}>
        {tab === 'overview' ? (
          <div className="space-y-3">
            {/* First on the tab on purpose: every panel below reports on a
                collection pipeline that is not running yet, and this is the
                only one that says why. The draft costs nothing to fetch —
                it calls AWS zero times — so an unconfigured project reads the
                specific reason rather than a wall of generic empty states. */}
            {blockers.length > 0 && (
              <div
                className="rounded-xl border border-amber-900/60 bg-amber-950/20 p-5"
                data-testid="infra-setup-blockers"
              >
                <h3 className="text-sm font-medium text-amber-200">
                  Infrastructure monitoring is not collecting yet
                </h3>
                <ul className="mt-2 space-y-1 text-xs leading-5 text-amber-100/80">
                  {blockers.map((blocker) => (
                    <li key={blocker} data-testid={`infra-blocker-${blocker}`}>
                      {describeInfraBlocker(blocker)}
                    </li>
                  ))}
                </ul>
                {draft?.notes?.length ? (
                  <ul className="mt-3 space-y-1 border-t border-amber-900/60 pt-3 text-xs leading-5 text-gray-400">
                    {draft.notes.map((note, i) => (
                      <li key={i}>{note}</li>
                    ))}
                  </ul>
                ) : null}
                {onOpenSession && (
                  <p className="mt-3 text-xs text-gray-500">
                    Use <span className="text-gray-300">Set up with AI</span> above to walk through
                    this with an agent: it probes the account read-only, prices the scope, and saves
                    the allowlist.
                  </p>
                )}
              </div>
            )}
            <MonitoringStatusCard status={status} missing={monitoringMissing} />
            {!hasScope && (
              <EmptyState testId="infra-empty-scope" title="no scope configured">
                Add an explicit account, region, and service scope before Agent Hub polls AWS.
                Nothing is collected automatically.
              </EmptyState>
            )}
            <InfraScopeEditor
              projectId={projectId}
              showToast={showToast}
              onScopesChange={handleScopesChange}
            />
            {/* Above the spend panels on purpose: this is operational news AWS
                pushed at us — a degraded control plane, a retiring volume —
                which is the only thing on this tab that can be happening right
                now. The money below it is never that urgent. */}
            <InfraHealthTimeline projectId={projectId} showToast={showToast} />
            {/* Below the scope editor on purpose: that panel prices a decision
                the operator is about to make, this one reports the bill that
                decision lands on. */}
            <InfraSpendPanel projectId={projectId} showToast={showToast} />
            {/* Last on the tab on purpose: the panels above price and report the
            money a scope costs, while this one answers a capacity question
            those cannot — nothing is down and you still cannot launch. */}
            <InfraQuotaHeadroomPanel projectId={projectId} />
          </div>
        ) : tab === 'resources' ? (
          hasScope ? (
            <InfraResourceBrowser
              projectId={projectId}
              onSelectResource={handleSelectResource}
              selectedResourceKey={selectedResource?.resourceKey ?? null}
            />
          ) : (
            <EmptyState testId="infra-empty-scope" title="no scope configured">
              Add an explicit account, region, and service scope before Agent Hub discovers
              resources.
            </EmptyState>
          )
        ) : tab === 'metrics' ? (
          <div className="space-y-3">
            {!hasScope ? (
              <EmptyState testId="infra-empty-scope" title="no scope configured">
                Configure a collection scope before viewing infrastructure metrics.
              </EmptyState>
            ) : selectedResource ? (
              <>
                <div className="text-xs text-gray-400">
                  <span className="font-mono text-gray-200">{selectedResource.resourceId}</span>
                  {selectedResource.name ? ` · ${selectedResource.name}` : ''} ·{' '}
                  {selectedResource.service} · {selectedResource.region}
                </div>
                <InfraMetricChart
                  projectId={projectId}
                  resourceKey={selectedResource.resourceKey}
                  resourceLabel={selectedResource.name || selectedResource.resourceId}
                  pack={notesPack}
                  dimensionNames={Object.keys(selectedResource.metricDimensions ?? {})}
                />
                <InfraServiceNotes
                  pack={notesPack}
                  service={selectedResource.service}
                  resource={selectedResource}
                />
              </>
            ) : (
              <EmptyState testId="infra-metrics-no-resource" title="no resource selected">
                Pick a resource on the Resources tab to chart what has been collected for it.
              </EmptyState>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            {!hasScope && (
              <EmptyState testId="infra-empty-scope" title="no scope configured">
                Configure a collection scope before creating infrastructure alerts.
              </EmptyState>
            )}
            {hasScope && (
              <>
                <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-5 text-sm text-gray-400">
                  No infrastructure alert rules configured yet.
                </div>
                <InfraServiceNotes pack={notesPack} showDefaultRules />
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
