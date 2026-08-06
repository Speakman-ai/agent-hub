import { useCallback, useEffect, useState } from 'react';
import { Activity, BellRing, Boxes, Cloud, Gauge, Server } from 'lucide-react';
import InfraScopeEditor from './InfraScopeEditor';
import InfraResourceBrowser, { type InfraResourceWire } from './InfraResourceBrowser';
import InfraMetricChart from './InfraMetricChart';

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
  /** True when the selected AWS metric requires a paid feature that is disabled. */
  paidFeatureOff?: boolean;
  showToast?: (message: string, type?: string) => void;
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
  paidFeatureOff,
  showToast,
}: InfrastructurePageProps): React.ReactElement {
  const [tab, setTab] = useState<InfrastructureTab>('overview');
  const status = monitoringStatus ?? null;

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
  // Off by default now that the Metrics tab draws real collected data: an
  // unconditional warning in front of a working chart would train the operator
  // to ignore it, and the notice has to stay meaningful for the panels that
  // genuinely are empty because a paid AWS feature is disabled (INFRA-COST).
  const selectedPaidFeatureOff = paidFeatureOff ?? project?.infraPaidFeatureOff ?? false;
  const monitoringProfile = project?.awsMonitoringProfile;
  const monitoringMissing =
    (!status?.profile && !monitoringProfile) ||
    status?.reason === 'not_designated' ||
    status?.code === 'monitoring_profile_required';

  return (
    <div className="flex h-full flex-col" data-testid="infrastructure-page">
      <header className="mb-3 flex items-center gap-2">
        <Server size={18} className="text-gray-400" />
        <div>
          <h2 className="text-lg font-semibold text-gray-100">Infrastructure</h2>
          <p className="text-xs text-gray-500">
            AWS resource health, metrics, and alerts{projectName ? ` for ${projectName}` : ''}.
          </p>
        </div>
      </header>

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
            {selectedPaidFeatureOff && (
              <EmptyState testId="infra-empty-paid-feature" title="this AWS paid feature is off">
                Some metrics are published only when their AWS paid feature is enabled. Those panels
                stay empty until the feature is turned on and the next collection run completes.
              </EmptyState>
            )}
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
              <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-5 text-sm text-gray-400">
                No infrastructure alert rules configured yet.
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
