/**
 * The mobile Infrastructure module (decision INFRA-UI) — the peer of the web
 * `client/src/components/infra/InfrastructurePage.tsx`.
 *
 * Tabs, gating and empty states mirror web. Three things differ on purpose:
 *
 *   - **The chart is a bar plot, not a line.** Web hands geometry to an SVG
 *     viewbox; here the series is bucketed into fixed columns of plain `View`s
 *     (`buildMetricBars`). React Native's SVG renderer is not reliably linked in
 *     every client this app runs in (see `utils/hubIconNative.ts`), and a chart
 *     that silently fails to draw is worse than a coarser one that always does.
 *     The scale arithmetic is shared, so the two agree on what the data says.
 *   - **Scope is read-only.** The web Overview embeds the full scope editor;
 *     committing an allowlist that bills against someone's AWS account is not a
 *     thing to do on a phone by accident, and the projected cost that is
 *     supposed to change the operator's mind (decision INFRA-COST) needs the
 *     room web has. Mobile shows what is configured and what it costs.
 *   - **Alerts are live.** The list refetches on the `infra_alert_transition`
 *     broadcast rather than only on the poll, because this is the surface a push
 *     notification drops the operator onto.
 *
 * Everything else is REST polling on a 60s interval, paused in the background
 * (`useVisibleIntervalRefresh`). There is no metric socket — that is the
 * deliberate divergence from the logs module recorded in INFRA-UI.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api } from '../utils/api';
import { colors } from '../theme/colors';
import ProjectScreenHeader from '../components/ProjectScreenHeader';
import { useApp } from '../context/AppContext';
import { useVisibleIntervalRefresh } from '../hooks/useVisibleIntervalRefresh';
import {
  EMPTY_FILTERS,
  formatAge,
  hasActiveFilters,
  isStaleResource,
  resourceStateTone,
  resourceSubtitle,
  toResourceQuery,
  type InfraResourceWire,
  type ResourceFilterState,
} from '../utils/infraResources';
import {
  RANGE_OPTIONS,
  buildMetricBars,
  formatAxisTime,
  formatPeriod,
  formatValue,
  seriesKey,
  type InfraAlarmSegment,
  type InfraMetricPoint,
  type InfraSeriesWire,
} from '@shared/utils/infraMetrics';
import {
  formatAlarmState,
  formatAlertStatus,
  infraAlertActions,
  isInfraAlertEventForProject,
  joinAlertsToRules,
  sortAlertRows,
  type InfraAlertRow,
  type InfraAlertStatus,
} from '@shared/utils/infraAlerts';
import {
  featureNotices,
  findPackMetric,
  metricCaveats,
  notesPackFor,
  summarizeDefaultRule,
  type InfraPackResource,
  type InfraServicePackWire,
} from '@shared/utils/infraPacks';

export type InfrastructureTab = 'overview' | 'resources' | 'metrics' | 'alerts';

export const TABS: ReadonlyArray<{ key: InfrastructureTab; label: string }> = [
  { key: 'overview', label: 'Overview' },
  { key: 'resources', label: 'Resources' },
  { key: 'metrics', label: 'Metrics' },
  { key: 'alerts', label: 'Alerts' },
];

/** Poll interval. The collector ticks every 5 minutes; this is comfortably under. */
const POLL_MS = 60_000;

/** Columns in the bar plot. Sized for the narrowest phone this ships to. */
const BAR_COUNT = 40;

/**
 * Whether a stamped piece of state describes the project currently on screen.
 *
 * Project-scoped responses are stored `{ projectId, ... }` and read back through
 * this, rather than being cleared by an effect on `projectId`. An effect runs
 * *after* the render that already switched projects, so there is a window in
 * which the previous project's response is still authoritative — and for the
 * scope response that window decides whether this project's Resources, Metrics
 * and Alerts tabs are shown at all. A stamp closes the window because a
 * mismatch is ignored on the very same render.
 */
export function stampMatchesProject(
  stamped: { projectId?: string } | null | undefined,
  projectId: string | null | undefined,
): boolean {
  return Boolean(stamped && projectId && stamped.projectId === projectId);
}

/**
 * Whether the project has a designated monitoring profile.
 *
 * Mirrors `monitoringMissing` on web. An SSO-only project cannot collect
 * anything unattended (decision INFRA-CRED), and the module has to say *that*
 * rather than render a generic failure — "no data" and "you never designated a
 * profile" are different problems with different fixes.
 */
export function isMonitoringMissing(
  project: { awsMonitoringProfile?: string | null } | null | undefined,
  status: { profile?: string | null; reason?: string; code?: string } | null | undefined,
): boolean {
  if (status?.reason === 'not_designated') return true;
  if (status?.code === 'monitoring_profile_required') return true;
  return !status?.profile && !project?.awsMonitoringProfile;
}

export interface InfraMonitoringStatus {
  profile?: string | null;
  region?: string | null;
  reachable?: boolean;
  code?: string;
  reason?: string;
  error?: string;
}

export type MonitoringCardState = 'missing' | 'unreachable' | 'ready';

/**
 * Which of the three monitoring states the Overview card should show.
 *
 * The distinction is the whole point of the card, and project metadata alone
 * cannot make it. A project whose metadata names a profile looks configured,
 * but if that profile is interactive SSO — or its credentials have expired —
 * unattended collection is not actually running (decision INFRA-CRED), and the
 * server's probe is the only thing that knows. Deriving this from the project
 * field alone reports "Monitoring profile ready" over a module that is silently
 * collecting nothing.
 *
 * `unreachable` is only claimed on a settled probe. A probe that has not
 * answered yet is not evidence of a fault, so it falls through to the
 * metadata-based reading rather than accusing a healthy project.
 */
export function monitoringCardState(
  project: { awsMonitoringProfile?: string | null } | null | undefined,
  status: InfraMonitoringStatus | null | undefined,
): MonitoringCardState {
  if (isMonitoringMissing(project, status)) return 'missing';
  if (status && status.reachable === false) return 'unreachable';
  return 'ready';
}

/** The detail line under the monitoring card, naming profile and region. */
export function monitoringCardDetail(
  project: { awsMonitoringProfile?: string | null } | null | undefined,
  status: InfraMonitoringStatus | null | undefined,
): string {
  const state = monitoringCardState(project, status);
  if (state === 'missing') {
    return 'Designate a static or assume-role AWS profile before Agent Hub can collect infrastructure telemetry unattended. Interactive SSO profiles cannot be used for background collection.';
  }
  if (state === 'unreachable') {
    return (
      status?.error ||
      'The designated AWS profile could not be reached. Check its credentials and region.'
    );
  }
  const profile = status?.profile || project?.awsMonitoringProfile;
  if (!profile) return 'AWS monitoring is ready.';
  return `Using ${profile}${status?.region ? ` in ${status.region}` : ''}.`;
}

/**
 * Whether a collection scope exists, from whichever source has spoken.
 *
 * The scopes response is authoritative once it arrives; before that the project
 * metadata is the only hint. Web derives the same value from
 * `liveScope ?? scopeConfigured ?? inferredScopeConfigured`.
 */
export function hasConfiguredScope(
  scopesResponse: { scopes?: any[]; configured?: boolean } | null | undefined,
  project: { infraScopes?: any[]; infraScopeCount?: number } | null | undefined,
): boolean {
  if (scopesResponse) {
    if (Array.isArray(scopesResponse.scopes)) {
      return scopesResponse.scopes.some((scope: any) => scope?.enabled !== false);
    }
    return !!scopesResponse.configured;
  }
  if (Array.isArray(project?.infraScopes)) return project.infraScopes.length > 0;
  return Number(project?.infraScopeCount) > 0;
}

/**
 * The open-alert count from a `GET /infra/alerts` response.
 *
 * Reads `total`, never `alerts.length`. The list is a bounded page (50 by
 * default, 200 max), so a badge derived from the array length silently reports
 * the page size once a project exceeds it — a project with 300 open alerts
 * would show "50", which reads as a far quieter system than the operator has.
 *
 * Returns null rather than 0 when the response carries no usable total, because
 * "nothing is breaching" is a claim that must be backed by an actual count.
 */
export function openAlertCountFrom(
  response: { total?: unknown } | null | undefined,
): number | null {
  const total = response?.total;
  return typeof total === 'number' && Number.isFinite(total) ? total : null;
}

export interface LoadMorePageDeps {
  /** Fetches the next page. */
  fetchPage: () => Promise<any>;
  /**
   * May this response still write rows? False once the *list* moved on — a
   * filter change, a project switch, or a refresh.
   */
  isCurrent: () => boolean;
  /**
   * May this response release the in-flight flag? True while this is the newest
   * page request; false once another `loadMore` has taken the flag over.
   */
  ownsInFlight: () => boolean;
  appendResources: (resources: any[]) => void;
  setNextCursor: (cursor: string | null) => void;
  setError: (message: string) => void;
  setLoadingMore: (value: boolean) => void;
}

/**
 * Fetch and apply one more page of resources.
 *
 * Extracted from the component so the settle rules are unit-testable without a
 * native runtime — the same reason `runLogClear` is extracted in LogsScreen.
 *
 * Two guards, because "may I write rows?" and "may I release the flag?" are
 * different questions with different owners, and collapsing them into one
 * breaks whichever case the single predicate does not describe:
 *
 *   - Guarding the release on `isCurrent()` (the list generation) left
 *     `loadingMore` stuck on whenever a filter change landed mid-flight. Nothing
 *     else resets it — a refresh sets `loading`, never `loadingMore` — so Load
 *     more stayed disabled for the life of the screen.
 *   - Releasing unconditionally then let a superseded request clear a *newer*
 *     request's flag: change filters, page again, and the old response re-enables
 *     the button under an in-flight load, so a second tap runs a duplicate
 *     concurrent request and the spinner vanishes while still loading.
 *
 * Ownership is therefore tracked per page request rather than per list
 * generation. The newest `loadMore` always owns the flag and always releases it,
 * so it cannot stick; a request that has been taken over never touches it, so it
 * cannot clobber. A request superseded only by a *list* refresh still owns the
 * flag — nothing took it over — and so still cleans up after itself.
 */
export async function runLoadMorePage(deps: LoadMorePageDeps): Promise<void> {
  const { fetchPage, isCurrent, ownsInFlight, appendResources } = deps;
  const { setNextCursor, setError, setLoadingMore } = deps;
  try {
    const response = await fetchPage();
    if (isCurrent()) {
      appendResources(Array.isArray(response?.resources) ? response.resources : []);
      setNextCursor(response?.nextCursor ?? null);
    }
  } catch (err: any) {
    if (isCurrent()) setError(err?.message || 'Could not load more resources.');
  } finally {
    if (ownsInFlight()) setLoadingMore(false);
  }
}

/** Money, never rounded down to "free". Mirrors the web scope editor's rule. */
export function formatUsd(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  if (value > 0 && value < 0.01) return '<$0.01';
  return `$${value.toFixed(2)}`;
}

/** Empty-state copy for the resource list, chosen by cause rather than count. */
export function resourcesEmptyCopy(filters: ResourceFilterState): string {
  return hasActiveFilters(filters)
    ? 'No resources match the current filters.'
    : 'No resources discovered yet. Inventory sync runs hourly.';
}

/** Empty-state copy for the alert list, chosen by the status filter in force. */
export function alertsEmptyCopy(statusFilter: InfraAlertStatus | 'all'): string {
  if (statusFilter === 'open') return 'No open alerts.';
  if (statusFilter === 'resolved') return 'No resolved alerts.';
  if (statusFilter === 'ignored') return 'No ignored alerts.';
  return 'No alerts recorded yet.';
}

/**
 * Confirmation dialog for a lifecycle action.
 *
 * Pure so the contract (nothing fires without an explicit confirm tap) is
 * testable without a native Alert runtime — the same reason `buildClearConfirm`
 * exists in LogsScreen.
 */
export function buildAlertActionConfirm(opts: {
  label: string;
  ruleName: string;
  onConfirm: () => void;
}): { title: string; message: string; buttons: any[] } {
  return {
    title: `${opts.label} alert?`,
    message:
      opts.label === 'Ignore'
        ? `“${opts.ruleName}” stays muted even if it recurs.`
        : `“${opts.ruleName}” will be marked ${opts.label.toLowerCase()}d.`,
    buttons: [
      { text: 'Cancel', style: 'cancel' },
      { text: opts.label, onPress: opts.onConfirm },
    ],
  };
}

function Empty({ text, testID }: { text: string; testID?: string }) {
  return (
    <View style={styles.emptyCard} testID={testID}>
      <Text style={styles.emptyText}>{text}</Text>
    </View>
  );
}

function Chip({
  label,
  active,
  onPress,
  testID,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  testID?: string;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      style={[styles.chip, active && styles.chipActive]}
      testID={testID}
    >
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
    </TouchableOpacity>
  );
}

// ── Overview ────────────────────────────────────────────────────────────────

function OverviewTab({ project, monitoringStatus, scopes, loading, error, openAlertCount }: any) {
  const monitoringState = monitoringCardState(project, monitoringStatus);
  const projection = scopes?.projection ?? null;
  const rows: any[] = Array.isArray(scopes?.scopes) ? scopes.scopes : [];

  return (
    <ScrollView contentContainerStyle={styles.content}>
      {monitoringState === 'missing' ? (
        <View style={styles.warnBox} testID="infra-empty-monitoring-profile">
          <Text style={styles.warnTitle}>No monitoring profile designated</Text>
          <Text style={styles.warnBody}>{monitoringCardDetail(project, monitoringStatus)}</Text>
        </View>
      ) : monitoringState === 'unreachable' ? (
        <View style={styles.warnBox} testID="infra-monitoring-unreachable">
          <Text style={styles.warnTitle}>Monitoring profile unavailable</Text>
          <Text style={styles.warnBody}>{monitoringCardDetail(project, monitoringStatus)}</Text>
        </View>
      ) : (
        <View style={styles.okBox} testID="infra-monitoring-ready">
          <Text style={styles.okTitle}>Monitoring profile ready</Text>
          <Text style={styles.warnBody}>{monitoringCardDetail(project, monitoringStatus)}</Text>
        </View>
      )}

      <Text style={styles.sectionTitle}>Open alerts</Text>
      <View style={styles.card} testID="infra-open-alert-count">
        <Text style={styles.bigNumber}>{openAlertCount == null ? '—' : openAlertCount}</Text>
        <Text style={styles.hint}>
          {openAlertCount === 0 ? 'Nothing is breaching right now.' : 'Open on the Alerts tab.'}
        </Text>
      </View>

      <Text style={styles.sectionTitle}>Collection scope</Text>
      {loading && !scopes ? <ActivityIndicator color={colors.gray400} /> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {!loading && !error && rows.length === 0 ? (
        <Empty
          testID="infra-empty-scope"
          text="No scope configured. Nothing is polled until an account, region and service are explicitly allowlisted."
        />
      ) : null}
      {rows.map((scope: any) => (
        <View key={scope.id || `${scope.profileName}-${scope.region}-${scope.service}`} style={styles.card}>
          <Text style={styles.rowTitle}>
            {scope.service} · {scope.region}
          </Text>
          <Text style={styles.rowMeta}>
            {scope.profileName}
            {scope.enabled === false ? ' · disabled' : ''}
            {typeof scope.resourceCount === 'number' ? ` · ${scope.resourceCount} resources` : ''}
          </Text>
        </View>
      ))}
      {projection ? (
        <Text style={styles.hint} testID="infra-cost-projection">
          Projected AWS API cost: {formatUsd(projection.estimatedMonthlyCostUsd)}/month
          {scopes?.degradation && scopes.degradation !== 'normal'
            ? ` · collection ${scopes.degradation}`
            : ''}
        </Text>
      ) : null}
      <Text style={styles.hint}>Scope is edited on the web Infrastructure module.</Text>
    </ScrollView>
  );
}

// ── Resources ───────────────────────────────────────────────────────────────

function ResourcesTab({ projectId, onSelectResource, selectedResourceKey }: any) {
  const [filters, setFilters] = useState<ResourceFilterState>(EMPTY_FILTERS);
  const [resources, setResources] = useState<InfraResourceWire[]>([]);
  const [facets, setFacets] = useState<any>({ services: [], regions: [] });
  const [staleAfterMs, setStaleAfterMs] = useState(24 * 60 * 60 * 1000);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  // Guards every settle against a project switch or a newer filter set, so a
  // slow response never repaints a list it no longer describes.
  const generation = useRef(0);
  // Who currently owns `loadingMore`. Tracked separately from `generation`
  // because the list moving on and the page request being taken over are
  // different events — see `runLoadMorePage`.
  const loadMoreToken = useRef(0);
  const queryKey = useMemo(() => JSON.stringify(toResourceQuery(filters)), [filters]);

  const load = useCallback(() => {
    const gen = ++generation.current;
    setLoading(true);
    api
      .listInfraResources(projectId, JSON.parse(queryKey))
      .then((response: any) => {
        if (generation.current !== gen) return;
        setResources(Array.isArray(response?.resources) ? response.resources : []);
        setFacets(response?.facets ?? { services: [], regions: [] });
        setNextCursor(response?.nextCursor ?? null);
        if (Number.isFinite(response?.staleAfterMs)) setStaleAfterMs(response.staleAfterMs);
        setNowMs(Date.now());
        setError(null);
      })
      .catch((err: any) => {
        if (generation.current !== gen) return;
        setError(err?.message || 'The resource inventory could not be loaded.');
      })
      .finally(() => {
        if (generation.current === gen) setLoading(false);
      });
  }, [projectId, queryKey]);

  useEffect(() => {
    // Cleared before the request rather than only overwritten on success: a
    // failed load would otherwise leave the previous filter set's rows on
    // screen. The error goes too — it describes the question that was just
    // replaced, and leaving it up makes the pending load read as broken.
    setResources([]);
    setNextCursor(null);
    setError(null);
    // A new filter set has no page-two request outstanding that anyone still
    // wants, so the flag starts clean rather than inheriting the old list's.
    setLoadingMore(false);
    load();
  }, [load]);

  useVisibleIntervalRefresh(load, POLL_MS);

  const loadMore = useCallback(() => {
    if (!nextCursor) return;
    const gen = generation.current;
    const token = ++loadMoreToken.current;
    setLoadingMore(true);
    void runLoadMorePage({
      fetchPage: () =>
        api.listInfraResources(projectId, { ...JSON.parse(queryKey), cursor: nextCursor }),
      isCurrent: () => generation.current === gen,
      ownsInFlight: () => loadMoreToken.current === token,
      appendResources: (next) => setResources((prev) => [...prev, ...next]),
      setNextCursor,
      setError,
      setLoadingMore,
    });
  }, [projectId, queryKey, nextCursor]);

  const setFilter = (key: keyof ResourceFilterState, value: any) =>
    setFilters((prev) => ({ ...prev, [key]: value }));

  // Rows are on screen but the last refresh failed, so they describe an older
  // snapshot than the operator is looking at. Marked rather than cleared —
  // blanking on every failed poll would train them to ignore an empty list.
  const showingStale = error !== null && resources.length > 0;

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <TextInput
        style={styles.input}
        placeholder="Search id or name"
        placeholderTextColor={colors.gray500}
        value={filters.search}
        onChangeText={(text) => setFilter('search', text)}
        autoCapitalize="none"
        autoCorrect={false}
        testID="infra-resource-search"
      />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipRow}>
        <Chip label="All services" active={filters.service === ''} onPress={() => setFilter('service', '')} />
        {(facets.services || []).map((service: string) => (
          <Chip
            key={service}
            label={service}
            active={filters.service === service}
            onPress={() => setFilter('service', service)}
          />
        ))}
      </ScrollView>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipRow}>
        <Chip label="All regions" active={filters.region === ''} onPress={() => setFilter('region', '')} />
        {(facets.regions || []).map((region: string) => (
          <Chip
            key={region}
            label={region}
            active={filters.region === region}
            onPress={() => setFilter('region', region)}
          />
        ))}
        <Chip
          label="Include stale"
          active={filters.includeStale}
          onPress={() => setFilter('includeStale', !filters.includeStale)}
          testID="infra-include-stale"
        />
      </ScrollView>

      {loading && resources.length === 0 ? <ActivityIndicator color={colors.gray400} /> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {showingStale ? (
        <Text style={styles.staleBanner} testID="infra-resources-stale">
          ⚠ Showing the last confirmed inventory; the newest refresh failed.
        </Text>
      ) : null}
      {!loading && !error && resources.length === 0 ? (
        <Empty testID="infra-resources-empty" text={resourcesEmptyCopy(filters)} />
      ) : null}

      {resources.map((resource) => {
        const stale = isStaleResource(resource, staleAfterMs, nowMs);
        const tone = resourceStateTone(resource.state);
        return (
          <TouchableOpacity
            key={resource.resourceKey}
            style={[
              styles.card,
              stale && styles.cardStale,
              selectedResourceKey === resource.resourceKey && styles.cardSelected,
            ]}
            onPress={() => onSelectResource(resource)}
            testID={`infra-resource-${resource.resourceId}`}
          >
            <View style={styles.rowHead}>
              <Text style={styles.mono} numberOfLines={1}>
                {resource.resourceId}
              </Text>
              <Text style={[styles.statePill, styles[`state_${tone}` as keyof typeof styles] as any]}>
                {resource.state || 'unknown'}
              </Text>
            </View>
            <Text style={styles.rowMeta} numberOfLines={1}>
              {resourceSubtitle(resource)}
            </Text>
            <Text style={styles.rowMeta}>seen {formatAge(resource.lastSeen, nowMs)}</Text>
          </TouchableOpacity>
        );
      })}

      {nextCursor ? (
        <TouchableOpacity
          style={styles.secondaryButton}
          onPress={loadMore}
          disabled={loadingMore}
          testID="infra-resources-load-more"
        >
          <Text style={styles.secondaryButtonText}>
            {loadingMore ? 'Loading…' : 'Load more resources'}
          </Text>
        </TouchableOpacity>
      ) : null}
    </ScrollView>
  );
}

// ── Metrics ─────────────────────────────────────────────────────────────────

/**
 * What the service pack says that a chart cannot.
 *
 * Parity with the web `InfraServiceNotes` panel, and the copy is shared rather
 * than retyped: an operator who reads "memory does not exist from the
 * hypervisor" on the desktop must not read something subtly different on the
 * phone.
 */
export function ServiceNotes({
  pack,
  resource = null,
  showDefaultRules = false,
}: {
  pack: InfraServicePackWire | null;
  /** The resource in view; a paid feature belongs to one resource, not a project. */
  resource?: InfraPackResource | null;
  showDefaultRules?: boolean;
}) {
  if (!pack) return null;
  const conditional = pack.metrics.filter((m) => metricCaveats(m).length > 0);
  const offFeatures = featureNotices(pack, resource);
  if (
    pack.absentMetrics.length === 0 &&
    conditional.length === 0 &&
    offFeatures.length === 0 &&
    !showDefaultRules
  ) {
    return null;
  }

  return (
    <View style={styles.notesCard} testID="infra-service-notes">
      {offFeatures.map(({ feature, gatedMetricNames }) => (
        <View key={feature.key} testID={`infra-feature-off-${feature.key}`}>
          <Text style={styles.notesTitle}>{feature.label} is off for this resource</Text>
          <Text style={styles.hint}>{feature.whenOff}</Text>
          <Text style={styles.hint}>What it costs: {feature.costNote}</Text>
          <Text style={styles.hint}>Not collected: {gatedMetricNames.join(', ')}</Text>
        </View>
      ))}

      {pack.absentMetrics.length > 0 ? (
        <>
          <Text style={styles.notesTitle}>What {pack.label} does not publish</Text>
          {pack.absentMetrics.map((absent) => (
            <View key={absent.label} style={styles.notesRow}>
              <Text style={styles.notesLabel}>{absent.label}</Text>
              <Text style={styles.hint}>
                {absent.reason}
                {absent.remedy ? ` ${absent.remedy}` : ''}
              </Text>
            </View>
          ))}
        </>
      ) : null}

      {conditional.length > 0 ? (
        <View testID="infra-service-notes-conditional">
          <Text style={styles.notesTitle}>Metrics only some resources publish</Text>
          {conditional.map((metric) => (
            <Text key={`${metric.metricName}-${metric.stat}`} style={styles.hint}>
              {metric.metricName} — {metricCaveats(metric).join(' ')}
            </Text>
          ))}
        </View>
      ) : null}

      {showDefaultRules && pack.defaultAlertRules.length > 0 ? (
        <View testID="infra-service-default-rules">
          <Text style={styles.notesTitle}>Recommended {pack.label} alert rules</Text>
          <Text style={styles.hint}>
            AWS&rsquo;s own published alarm guidance. Nothing here is active until you create it as a
            rule on the web Infrastructure module.
          </Text>
          {pack.defaultAlertRules.map((rule) => (
            <View key={rule.name} style={styles.notesRow}>
              <Text style={styles.notesLabel}>
                {rule.name} · {rule.severity}
              </Text>
              <Text style={styles.hint}>
                {rule.metricName} {summarizeDefaultRule(rule)}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

function MetricsTab({ projectId, resource, pack }: any) {
  const [series, setSeries] = useState<InfraSeriesWire[]>([]);
  const [selectedKey, setSelectedKey] = useState('');
  const [spanMs, setSpanMs] = useState(RANGE_OPTIONS[0].spanMs);
  const [range, setRange] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const generation = useRef(0);
  const resourceKey = resource?.resourceKey;

  useEffect(() => {
    const gen = ++generation.current;
    setSeries([]);
    setSelectedKey('');
    setRange(null);
    setError(null);
    if (!projectId || !resourceKey) return;
    setLoading(true);
    api
      .listInfraMetricSeries(projectId, resourceKey)
      .then((response: any) => {
        if (generation.current !== gen) return;
        const list: InfraSeriesWire[] = Array.isArray(response?.series) ? response.series : [];
        setSeries(list);
        setSelectedKey(list.length > 0 ? seriesKey(list[0]) : '');
      })
      .catch((err: any) => {
        if (generation.current !== gen) return;
        setError(err?.message || 'The metric list could not be loaded.');
      })
      .finally(() => {
        if (generation.current === gen) setLoading(false);
      });
  }, [projectId, resourceKey]);

  const selected = useMemo(
    () => series.find((s) => seriesKey(s) === selectedKey) ?? null,
    [series, selectedKey],
  );

  const loadRange = useCallback(() => {
    if (!projectId || !resourceKey || !selected) return;
    const gen = generation.current;
    const toMs = Date.now();
    api
      .getInfraMetricRange(projectId, {
        resource: resourceKey,
        metric: selected.metricName,
        namespace: selected.namespace,
        stat: selected.stat,
        dimensionsHash: selected.dimensionsHash,
        period: selected.periodSeconds,
        from: toMs - spanMs,
        to: toMs,
      })
      .then((response: any) => {
        if (generation.current !== gen) return;
        setRange({
          points: (Array.isArray(response?.points) ? response.points : []) as InfraMetricPoint[],
          alarmSegments: (Array.isArray(response?.alarmSegments)
            ? response.alarmSegments
            : []) as InfraAlarmSegment[],
          fromMs: response?.fromMs ?? toMs - spanMs,
          toMs: response?.toMs ?? toMs,
          // The server owns the period; a client computing its own would be a
          // second implementation of the collector's retention rule.
          periodSeconds: response?.periodSeconds ?? 0,
          aggregation: response?.aggregation ?? 'avg',
          truncated: !!response?.truncated,
        });
        setError(null);
      })
      .catch((err: any) => {
        if (generation.current !== gen) return;
        setError(err?.message || 'The metric range could not be loaded.');
      });
  }, [projectId, resourceKey, selected, spanMs]);

  useEffect(() => {
    loadRange();
  }, [loadRange]);

  useVisibleIntervalRefresh(loadRange, POLL_MS, { enabled: !!selected });

  const plot = useMemo(
    () =>
      range
        ? buildMetricBars(range.points, range.alarmSegments, range.fromMs, range.toMs, BAR_COUNT)
        : null,
    [range],
  );

  // Dimension names from the resource, so a pack that declares the same metric
  // at two dimension sets annotates the chart with the right one.
  const packMetric = findPackMetric(
    pack ?? null,
    selected,
    Object.keys(resource?.metricDimensions ?? {}),
  );
  const caveats = metricCaveats(packMetric);

  if (!resource) {
    return (
      <ScrollView contentContainerStyle={styles.content}>
        <Empty
          testID="infra-metrics-no-resource"
          text="Pick a resource on the Resources tab to chart what has been collected for it."
        />
      </ScrollView>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Text style={styles.mono} numberOfLines={1}>
        {resource.resourceId}
      </Text>
      <Text style={styles.rowMeta}>{resourceSubtitle(resource)}</Text>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipRow}>
        {series.map((s) => (
          <Chip
            key={seriesKey(s)}
            label={`${s.metricName} · ${s.stat}`}
            active={selectedKey === seriesKey(s)}
            onPress={() => setSelectedKey(seriesKey(s))}
          />
        ))}
      </ScrollView>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipRow}>
        {RANGE_OPTIONS.map((option) => (
          <Chip
            key={option.label}
            label={option.label}
            active={spanMs === option.spanMs}
            onPress={() => setSpanMs(option.spanMs)}
            testID={`infra-range-${option.label}`}
          />
        ))}
      </ScrollView>

      {packMetric ? (
        <Text style={styles.hint} testID="infra-metric-description">
          {packMetric.description}
          {caveats.length > 0 ? ` ${caveats.join(' ')}` : ''}
        </Text>
      ) : null}

      {loading ? <ActivityIndicator color={colors.gray400} /> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {range?.truncated ? (
        <Text style={styles.staleBanner}>
          ⚠ This range holds more buckets than one response carries; the newest are not shown.
        </Text>
      ) : null}

      {!error && series.length === 0 && !loading ? (
        <Empty
          testID="infra-metric-no-series"
          text="Nothing has been collected for this resource yet. Metrics appear after the next collection run."
        />
      ) : !error && plot && !plot.hasData ? (
        <Empty
          testID="infra-metric-empty-series"
          text="No datapoints in this window. Widen the range, or wait for the next collection run."
        />
      ) : plot && range ? (
        <View style={styles.chartCard} testID="infra-metric-chart">
          <View style={styles.chartPlot}>
            {plot.bars.map((bar, index) => (
              <View key={`${bar.tsMs}-${index}`} style={styles.barTrack}>
                {bar.state ? (
                  <View
                    style={[
                      styles.barBand,
                      bar.state === 'ALARM' ? styles.barBandAlarm : styles.barBandUnknown,
                    ]}
                    testID={`infra-alarm-band-${bar.state}`}
                  />
                ) : null}
                <View
                  style={[
                    styles.bar,
                    // Floored above zero so a real datapoint at the range minimum
                    // still draws — a bar of height 0 is indistinguishable from a
                    // bucket that collected nothing.
                    { height: `${Math.max(bar.value === null ? 0 : 2, bar.height * 100)}%` },
                  ]}
                />
              </View>
            ))}
          </View>
          <View style={styles.chartAxis}>
            <Text style={styles.axisLabel}>{formatAxisTime(range.fromMs, spanMs)}</Text>
            <Text style={styles.axisLabel}>{formatAxisTime(range.toMs, spanMs)}</Text>
          </View>
          <Text style={styles.hint} testID="infra-metric-period">
            {formatValue(plot.minValue)} – {formatValue(plot.maxValue)} ·{' '}
            {formatPeriod(range.periodSeconds)} buckets · {range.aggregation}
          </Text>
          {range.alarmSegments.length > 0 ? (
            <Text style={styles.hint}>
              Shaded columns are alert state on this resource over the same window.
            </Text>
          ) : null}
        </View>
      ) : null}

      <ServiceNotes pack={pack ?? null} resource={resource ?? null} />
    </ScrollView>
  );
}

// ── Alerts ──────────────────────────────────────────────────────────────────

const STATUS_FILTERS: ReadonlyArray<{ key: InfraAlertStatus | 'all'; label: string }> = [
  { key: 'open', label: 'Open' },
  { key: 'resolved', label: 'Resolved' },
  { key: 'ignored', label: 'Ignored' },
  { key: 'all', label: 'All' },
];

/**
 * The status filter to open the tab on.
 *
 * `open` is the right default for someone browsing, but the wrong one for
 * someone who just tapped a notification: an alert that was resolved or ignored
 * between the push being sent and the banner being tapped is excluded from the
 * `open` list, so the tap would land on a screen that does not contain the
 * alert it was about. Arriving with a focused alert therefore starts on `all`.
 */
export function initialAlertStatusFilter(focusAlertId: string | null | undefined) {
  return focusAlertId ? 'all' : 'open';
}

/**
 * Ensure the focused alert is present in the list, prepending it when it is not.
 *
 * The status filter is only half the problem the notification tap has. The list
 * is a bounded page ordered by state and recency, so an older alert can be
 * absent from page one even under `all`. Fetching it directly and pinning it to
 * the top is what actually guarantees the tap lands on something.
 *
 * Pure so both halves of that guarantee are testable without a screen.
 */
export function mergeFocusedAlert(
  rows: readonly InfraAlertRow[],
  focused: InfraAlertRow | null,
): InfraAlertRow[] {
  if (!focused) return [...rows];
  if (rows.some((row) => row.alert.id === focused.alert.id)) return [...rows];
  return [focused, ...rows];
}

function AlertsTab({ projectId, focusAlertId, pack }: any) {
  const { lastInfraAlertEvent } = useApp();
  const [statusFilter, setStatusFilter] = useState<InfraAlertStatus | 'all'>(
    () => initialAlertStatusFilter(focusAlertId) as InfraAlertStatus | 'all',
  );
  const [rows, setRows] = useState<InfraAlertRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const generation = useRef(0);

  const load = useCallback(() => {
    const gen = ++generation.current;
    setLoading(true);
    Promise.all([
      api.listInfraAlerts(projectId, statusFilter === 'all' ? {} : { status: statusFilter }),
      api.listInfraAlertRules(projectId),
      // A 404 here is ordinary — the alert may have been reaped, or the push
      // may name an alert this project no longer has. The list still renders.
      focusAlertId
        ? api.getInfraAlert(projectId, focusAlertId).catch(() => null)
        : Promise.resolve(null),
    ])
      .then(([alertsResponse, rulesResponse, focusedAlert]: any[]) => {
        if (generation.current !== gen) return;
        const alerts = Array.isArray(alertsResponse?.alerts) ? alertsResponse.alerts : [];
        const rules = Array.isArray(rulesResponse?.rules) ? rulesResponse.rules : [];
        const listed = sortAlertRows(joinAlertsToRules(alerts, rules));
        // Joined through the same path as the list so a pinned alert carries its
        // rule name and severity rather than rendering as a bare id.
        const [focusedRow] = focusedAlert?.id
          ? joinAlertsToRules([focusedAlert], rules)
          : [null as InfraAlertRow | null];
        setRows(mergeFocusedAlert(listed, focusedRow ?? null));
        setError(null);
      })
      .catch((err: any) => {
        if (generation.current !== gen) return;
        setError(err?.message || 'Alerts could not be loaded.');
      })
      .finally(() => {
        if (generation.current === gen) setLoading(false);
      });
  }, [projectId, statusFilter, focusAlertId]);

  useEffect(() => {
    setRows([]);
    setError(null);
    load();
  }, [load]);

  useVisibleIntervalRefresh(load, POLL_MS);

  // A transition on this project changed the list; anything else is another
  // project's traffic on a socket that fans out to every client.
  useEffect(() => {
    if (!isInfraAlertEventForProject(lastInfraAlertEvent, projectId)) return;
    load();
  }, [lastInfraAlertEvent, projectId, load]);

  const applyStatus = useCallback(
    (alertId: string, status: InfraAlertStatus) => {
      setBusyId(alertId);
      api
        .setInfraAlertStatus(projectId, alertId, status)
        .then(() => load())
        .catch((err: any) => Alert.alert('Alerts', err?.message || 'The alert could not be updated.'))
        .finally(() => setBusyId(null));
    },
    [projectId, load],
  );

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipRow}>
        {STATUS_FILTERS.map((option) => (
          <Chip
            key={option.key}
            label={option.label}
            active={statusFilter === option.key}
            onPress={() => setStatusFilter(option.key)}
            testID={`infra-alert-filter-${option.key}`}
          />
        ))}
      </ScrollView>

      {loading && rows.length === 0 ? <ActivityIndicator color={colors.gray400} /> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {!loading && !error && rows.length === 0 ? (
        <Empty testID="infra-alerts-empty" text={alertsEmptyCopy(statusFilter)} />
      ) : null}

      {rows.map((row) => {
        const { alert: alertRow } = row;
        const focused = focusAlertId === alertRow.id;
        const label = row.ruleName || alertRow.ruleId;
        return (
          <View
            key={alertRow.id}
            style={[styles.card, focused && styles.cardSelected]}
            testID={`infra-alert-${alertRow.id}`}
          >
            <View style={styles.rowHead}>
              <Text style={styles.rowTitle} numberOfLines={1}>
                {label}
              </Text>
              <Text
                style={[
                  styles.statePill,
                  alertRow.state === 'ALARM' ? styles.state_bad : styles.state_neutral,
                ]}
              >
                {formatAlarmState(alertRow.state)}
              </Text>
            </View>
            <Text style={styles.mono} numberOfLines={1}>
              {alertRow.resourceKey}
            </Text>
            <Text style={styles.rowMeta}>
              {formatAlertStatus(alertRow.status)}
              {row.severity ? ` · ${row.severity}` : ''} · seen {formatAge(alertRow.lastSeen, Date.now())}
              {alertRow.occurrenceCount > 1 ? ` · ×${alertRow.occurrenceCount}` : ''}
            </Text>
            {alertRow.reason ? <Text style={styles.rowMeta}>{alertRow.reason}</Text> : null}
            <View style={styles.actionRow}>
              {infraAlertActions(alertRow.status).map((action) => (
                <TouchableOpacity
                  key={action.status}
                  style={[styles.secondaryButton, busyId === alertRow.id && styles.disabled]}
                  disabled={busyId === alertRow.id}
                  onPress={() => {
                    const { title, message, buttons } = buildAlertActionConfirm({
                      label: action.label,
                      ruleName: label,
                      onConfirm: () => applyStatus(alertRow.id, action.status),
                    });
                    Alert.alert(title, message, buttons);
                  }}
                  testID={`infra-alert-action-${action.status}-${alertRow.id}`}
                >
                  <Text style={styles.secondaryButtonText}>{action.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        );
      })}

      <ServiceNotes pack={pack ?? null} showDefaultRules />
    </ScrollView>
  );
}

// ── Screen ──────────────────────────────────────────────────────────────────

export default function InfrastructureScreen({ route, navigation }: any) {
  const { projects, lastInfraAlertEvent } = useApp();
  const projectId = route?.params?.projectId || projects?.[0]?.id;
  const project =
    route?.params?.project || projects?.find((p: any) => p.id === projectId) || null;
  const focusAlertId = route?.params?.alertId || null;

  const [tab, setTab] = useState<InfrastructureTab>(
    (route?.params?.initialTab as InfrastructureTab) || 'overview',
  );
  // Every piece of project-scoped state here is stamped with the project it
  // describes rather than reset by an effect. On a switch the stamp stops
  // matching and the value is ignored on the very same render, leaving no
  // window in which the previous project's data decides this project's view.
  //
  // That window is not hypothetical for `scopeState`: `hasScope` gates the
  // Resources, Metrics and Alerts tabs, so an unstamped response would let the
  // previous project's scope authorise this project's tabs until the new
  // request settled — showing one project's monitoring under another's header.
  const [selected, setSelected] = useState<{ projectId: string; resource: InfraResourceWire } | null>(
    null,
  );
  const selectedResource = stampMatchesProject(selected, projectId)
    ? (selected as { resource: InfraResourceWire }).resource
    : null;

  const [scopeState, setScopeState] = useState<{
    projectId: string;
    data: any | null;
    error: string | null;
  } | null>(null);
  const scopeForProject = stampMatchesProject(scopeState, projectId) ? scopeState : null;
  const scopes = scopeForProject?.data ?? null;
  const scopesError = scopeForProject?.error ?? null;
  // Derived rather than its own flag: "no settled answer for this project yet"
  // is exactly what a missing stamp means, and a separate boolean could
  // disagree with it after a switch. Guarded on `projectId` because with no
  // project resolved no request is ever issued, and an unguarded derivation
  // would leave the spinner up forever instead of showing the empty state.
  const scopesLoading = !!projectId && scopeForProject === null;

  // The live reachability probe. Stamped like everything else here, and fetched
  // exactly once per project rather than on the poll: it issues a real
  // `DescribeAlarms` against AWS, which is billable beyond the free tier, and
  // the server helper's own contract is "poll it when a view opens, not on a
  // tight timer".
  const [monitoringState, setMonitoringState] = useState<{
    projectId: string;
    status: InfraMonitoringStatus | null;
  } | null>(null);
  const monitoringStatus = stampMatchesProject(monitoringState, projectId)
    ? monitoringState!.status
    : null;

  const [openAlerts, setOpenAlerts] = useState<{ projectId: string; count: number | null } | null>(
    null,
  );
  const openAlertCount = stampMatchesProject(openAlerts, projectId) ? openAlerts!.count : null;
  // Guards the count against a slow response superseded by a newer one.
  const countGeneration = useRef(0);

  // The pack catalog: static declarations, no AWS call, no per-project state.
  // Stamped like everything else here so one project's caveats never annotate
  // another's chart. A failure is silent — a missing caveat is a worse chart,
  // not a broken one.
  const [packState, setPackState] = useState<{
    projectId: string;
    packs: InfraServicePackWire[];
  } | null>(null);
  const packs = stampMatchesProject(packState, projectId) ? packState!.packs : [];

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    api
      .getInfraMetricPacks(projectId)
      .then((response: any) => {
        if (cancelled) return;
        setPackState({
          projectId,
          packs: Array.isArray(response?.packs) ? response.packs : [],
        });
      })
      .catch(() => {
        if (!cancelled) setPackState({ projectId, packs: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    api
      .getInfraScopes(projectId)
      .then((response: any) => {
        if (!cancelled) setScopeState({ projectId, data: response, error: null });
      })
      .catch((err: any) => {
        if (!cancelled) {
          setScopeState({
            projectId,
            data: null,
            error: err?.message || 'The collection scope could not be loaded.',
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    api
      .getInfraMonitoringStatus(projectId)
      .then((response: any) => {
        if (!cancelled) setMonitoringState({ projectId, status: response ?? null });
      })
      // A probe that could not run is not evidence the profile is broken, so the
      // card falls back to the metadata reading rather than accusing a healthy
      // project of being unreachable.
      .catch(() => {
        if (!cancelled) setMonitoringState({ projectId, status: null });
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const handleSelectResource = useCallback(
    (resource: InfraResourceWire) => {
      setSelected({ projectId, resource });
      setTab('metrics');
    },
    [projectId],
  );

  /**
   * The Overview count, read independently of the Alerts tab.
   *
   * Deliberately its own request rather than a tally of whatever the Alerts tab
   * happens to be showing: that list is filtered, so counting `open` rows in a
   * "Resolved" view would report zero open alerts on a project that has plenty,
   * and the count would stay blank until the operator visited the tab at all.
   */
  const loadOpenAlertCount = useCallback(() => {
    if (!projectId) return;
    const gen = ++countGeneration.current;
    api
      .listInfraAlerts(projectId, { status: 'open' })
      .then((response: any) => {
        // Two guards, because they catch different races. The generation guard
        // drops a slow response superseded by a newer request for the *same*
        // project (a WebSocket transition arriving mid-flight); the stamp keeps
        // a response for a project the operator has since navigated away from
        // out of the current project's count.
        if (countGeneration.current !== gen) return;
        setOpenAlerts({ projectId, count: openAlertCountFrom(response) });
      })
      // Left as null (renders "—") rather than 0: "no open alerts" is a claim
      // this screen has no basis to make when the read failed.
      .catch(() => {
        if (countGeneration.current !== gen) return;
        setOpenAlerts({ projectId, count: null });
      });
  }, [projectId]);

  useEffect(() => {
    loadOpenAlertCount();
  }, [loadOpenAlertCount]);

  useEffect(() => {
    if (!isInfraAlertEventForProject(lastInfraAlertEvent, projectId)) return;
    loadOpenAlertCount();
  }, [lastInfraAlertEvent, projectId, loadOpenAlertCount]);

  const hasScope = hasConfiguredScope(scopes, project);

  const notesPack = notesPackFor(packs, selectedResource);

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <ProjectScreenHeader
        title="Infrastructure"
        project={project}
        onBack={() => navigation.goBack()}
        testID="infrastructure-screen"
      />

      <View style={styles.tabBar} testID="infra-tab-bar">
        {TABS.map((item) => (
          <TouchableOpacity
            key={item.key}
            onPress={() => setTab(item.key)}
            style={[styles.tabBtn, tab === item.key && styles.tabBtnActive]}
            testID={`infra-tab-${item.key}`}
          >
            <Text style={[styles.tabText, tab === item.key && styles.tabTextActive]}>
              {item.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {tab === 'overview' ? (
        <OverviewTab
          project={project}
          monitoringStatus={monitoringStatus}
          scopes={scopes}
          loading={scopesLoading}
          error={scopesError}
          openAlertCount={openAlertCount}
        />
      ) : !hasScope ? (
        <ScrollView contentContainerStyle={styles.content}>
          <Empty
            testID="infra-empty-scope"
            text="No scope configured. Add an explicit account, region and service scope on the web Infrastructure module before Agent Hub polls AWS."
          />
        </ScrollView>
      ) : tab === 'resources' ? (
        <ResourcesTab
          projectId={projectId}
          onSelectResource={handleSelectResource}
          selectedResourceKey={selectedResource?.resourceKey ?? null}
        />
      ) : tab === 'metrics' ? (
        <MetricsTab projectId={projectId} resource={selectedResource} pack={notesPack} />
      ) : (
        <AlertsTab projectId={projectId} focusAlertId={focusAlertId} pack={notesPack} />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.gray950 },
  content: { padding: 16, paddingBottom: 32 },
  tabBar: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: colors.gray800 },
  tabBtn: { flex: 1, paddingVertical: 10, alignItems: 'center', borderBottomWidth: 2, borderBottomColor: 'transparent' },
  tabBtnActive: { borderBottomColor: colors.blue500 },
  tabText: { fontSize: 13, color: colors.gray400 },
  tabTextActive: { color: colors.white, fontWeight: '600' },
  sectionTitle: { fontSize: 15, fontWeight: '600', color: colors.white, marginTop: 16, marginBottom: 6 },
  hint: { fontSize: 12, color: colors.gray500, marginTop: 6 },
  notesCard: {
    marginTop: 16,
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.gray800,
    backgroundColor: colors.gray900,
  },
  notesTitle: { fontSize: 13, fontWeight: '600', color: colors.gray200, marginTop: 8 },
  notesRow: { marginTop: 8 },
  notesLabel: { fontSize: 12, fontWeight: '600', color: colors.gray300 },
  card: {
    backgroundColor: colors.gray900,
    borderRadius: 8,
    padding: 12,
    borderWidth: 1,
    borderColor: colors.gray800,
    marginBottom: 8,
  },
  cardStale: { opacity: 0.55 },
  cardSelected: { borderColor: colors.blue500 },
  rowHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  rowTitle: { fontSize: 14, color: colors.gray200, fontWeight: '600', flexShrink: 1 },
  rowMeta: { fontSize: 12, color: colors.gray500, marginTop: 2 },
  mono: { fontFamily: 'monospace', fontSize: 12, color: colors.gray300, flexShrink: 1 },
  bigNumber: { fontSize: 28, fontWeight: '700', color: colors.white },
  error: { fontSize: 13, color: colors.red400, marginTop: 6 },
  staleBanner: { fontSize: 12, color: colors.amber400, marginTop: 6 },
  emptyCard: {
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.gray800,
    borderRadius: 8,
    padding: 16,
    marginTop: 8,
  },
  emptyText: { fontSize: 13, color: colors.gray400 },
  warnBox: {
    backgroundColor: colors.yellow900_50,
    borderRadius: 8,
    padding: 12,
    borderWidth: 1,
    borderColor: colors.amber900_40,
  },
  warnTitle: { fontSize: 13, color: colors.amber400, fontWeight: '600', marginBottom: 4 },
  warnBody: { fontSize: 12, color: colors.gray300 },
  okBox: {
    backgroundColor: colors.emerald900_50,
    borderRadius: 8,
    padding: 12,
    borderWidth: 1,
    borderColor: colors.emerald800,
  },
  okTitle: { fontSize: 13, color: colors.emerald300, fontWeight: '600', marginBottom: 4 },
  input: {
    backgroundColor: colors.gray900,
    borderWidth: 1,
    borderColor: colors.gray800,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    color: colors.gray200,
    fontSize: 13,
  },
  chipRow: { flexDirection: 'row', marginTop: 8 },
  chip: {
    borderWidth: 1,
    borderColor: colors.gray800,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
    marginRight: 6,
  },
  chipActive: { borderColor: colors.blue500, backgroundColor: colors.sky500_15 },
  chipText: { fontSize: 12, color: colors.gray400 },
  chipTextActive: { color: colors.white },
  statePill: {
    marginLeft: 'auto',
    fontSize: 11,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    overflow: 'hidden',
  },
  state_good: { color: colors.emerald300, backgroundColor: colors.emerald900_50 },
  state_bad: { color: colors.red400, backgroundColor: colors.red900_50 },
  state_neutral: { color: colors.gray400, backgroundColor: colors.gray800 },
  actionRow: { flexDirection: 'row', gap: 8, marginTop: 10 },
  secondaryButton: {
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 6,
    paddingHorizontal: 12,
    paddingVertical: 7,
    marginTop: 8,
    alignItems: 'center',
  },
  secondaryButtonText: { fontSize: 13, color: colors.gray200 },
  disabled: { opacity: 0.5 },
  chartCard: {
    backgroundColor: colors.gray900,
    borderRadius: 8,
    padding: 12,
    borderWidth: 1,
    borderColor: colors.gray800,
    marginTop: 10,
  },
  chartPlot: { flexDirection: 'row', alignItems: 'flex-end', height: 140, gap: 1 },
  barTrack: { flex: 1, height: '100%', justifyContent: 'flex-end' },
  barBand: { position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, borderRadius: 1 },
  barBandAlarm: { backgroundColor: 'rgba(239,68,68,0.18)' },
  barBandUnknown: { backgroundColor: 'rgba(234,179,8,0.14)' },
  bar: { width: '100%', backgroundColor: colors.sky400, borderRadius: 1 },
  chartAxis: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 },
  axisLabel: { fontSize: 10, color: colors.gray500 },
});
