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
 *     room web has. Mobile shows what is configured and what it costs. The one
 *     billed setting the phone can change is the Cost Explorer switch, because
 *     that is a single toggle whose entire price fits in a confirm dialog, and
 *     stopping a recurring charge should not require a desktop.
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
  formatQuotaHeadroom,
  formatQuotaUtilization,
  quotaBandTone,
  quotaBarPercent,
  quotaRefreshFailureNote,
  quotaSummaryLine,
  quotaUnknownReason,
  type QuotaBandTone,
  type QuotaHeadroomResponse,
} from '@shared/utils/quotaHeadroom';
import { copyToClipboard } from '../utils/clipboard';
import { getServerBaseUrl } from '../utils/config';
import {
  HEALTH_EVENT_LIMIT,
  HEALTH_VISIBLE_ROWS,
  INGEST_SETUP_NOTE,
  TOKEN_ONCE_WARNING,
  formatEventPattern,
  formatHealthStatus,
  healthEmptyState,
  healthEventMetaLine,
  healthEventService,
  healthEventTypeCode,
  healthIngestUrl,
  healthSeverityLabel,
  healthTruncationNote,
  ingestActionLabel,
  ingestTokenSummary,
  isHealthDescriptionClampable,
  isIngestTokenLive,
  normalizeHealthSeverity,
  sortHealthEvents,
  truncateHealthDescription,
  type InfraHealthEventWire,
  type InfraHealthEventsResponse,
  type InfraHealthIngestResponse,
  type InfraHealthSeverity,
} from '../utils/infraHealth';
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
import {
  COST_EXPLORER_OPT_IN_COPY,
  buildSpendBars,
  formatMoney,
  formatUsd,
  spendFailureHint,
  spendStalenessLabel,
  spendTrendSummary,
  type InfraSpendTrendWire,
} from '@shared/utils/infraSpend';

// Re-exported so this module stays the import site callers and tests already
// use. The formatter itself moved to shared/ when the web scope editor became a
// second consumer of the same rounding rule.
export { formatUsd };

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
 * The operator-facing meaning of one setup-draft blocker code.
 *
 * Duplicated from the web `describeInfraBlocker` rather than shared: it is
 * copy, and the two surfaces are free to word the same code differently for a
 * phone. The unknown-code fallback returns the raw code instead of a generic
 * "unknown problem", because a server that grows a blocker mobile has not
 * learned yet should still name it — a code the operator can search beats a
 * sentence that says nothing.
 */
export function describeInfraBlocker(blocker: string): string {
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

/**
 * Empty-state copy for the spend section, chosen by cause rather than count.
 *
 * "Nothing has been cached yet" and "AWS says you were charged nothing" look
 * identical on screen and mean opposite things, and only the first one is worth
 * waiting out. The sync runs a few times a day at most, so a freshly enabled
 * project sits in the first state for hours by design.
 */
export function spendEmptyCopy(trend: { fetchedAt?: number | null } | null | undefined): string {
  if (!trend || trend.fetchedAt === null || trend.fetchedAt === undefined) {
    return 'No spend cached yet. The sync runs a few times a day, and an account that just enabled Cost Explorer can take up to 24 hours to report anything.';
  }
  return 'AWS reported no charges in this window.';
}

/**
 * The ranked service list, with the truncated tail as its own row.
 *
 * The server returns the top N services and a window total that includes
 * everything else, so a list rendered from `topServices` alone sums to less
 * than the bill printed above it. Building the rows here rather than in the
 * view keeps that arithmetic testable without a native runtime, which is the
 * point: a ranked list that silently understates a bill is the failure this
 * section most has to avoid.
 */
export function spendServiceRows(
  trend: InfraSpendTrendWire | null | undefined,
): Array<{ key: string; label: string; amountUsd: number }> {
  const services = Array.isArray(trend?.topServices) ? trend.topServices : [];
  const rows = services.map((service) => ({
    key: service.service,
    label: service.service,
    amountUsd: service.amountUsd,
  }));
  const { otherUsd } = spendTrendSummary(trend);
  if (otherUsd > 0) {
    rows.push({ key: '__other__', label: 'Other services', amountUsd: otherUsd });
  }
  return rows;
}

/**
 * Confirmation dialog for the Cost Explorer opt-in.
 *
 * Enabling starts a recurring charge against someone's AWS account, so the
 * price is in the dialog rather than only in the panel copy the operator may
 * have scrolled past. Disabling needs no such warning: stopping a billed poll
 * is never the surprising direction.
 *
 * Pure for the same reason `buildAlertActionConfirm` is: the contract that
 * nothing bills without an explicit confirm tap has to be testable without a
 * native Alert runtime.
 */
export function buildSpendOptInConfirm(opts: {
  enabling: boolean;
  onConfirm: () => void;
}): { title: string; message: string; buttons: any[] } {
  return {
    title: opts.enabling ? 'Turn on Cost Explorer polling?' : 'Turn off Cost Explorer polling?',
    message: opts.enabling
      ? `${COST_EXPLORER_OPT_IN_COPY.price} ${COST_EXPLORER_OPT_IN_COPY.cadence}`
      : 'Spend charts stop updating. Cached figures stay until they age out.',
    buttons: [
      { text: 'Cancel', style: 'cancel' },
      { text: opts.enabling ? 'Turn on' : 'Turn off', onPress: opts.onConfirm },
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

/**
 * The "Set up with AI" entry point, peer of the web header button.
 *
 * Renders nothing without `onOpenSession`: the wizard's whole product is a
 * session the operator then talks to, so spawning one the host cannot navigate
 * to would strand a worktree-backed session nobody ever sees. The failure is
 * shown inline rather than through `Alert.alert` because it is a state of this
 * panel, not an interruption — the operator can read it while deciding whether
 * to retry, and a modal that has been dismissed leaves no trace of why nothing
 * happened.
 */
export function InfraSetupWizardButton({
  projectId,
  onOpenSession,
}: {
  projectId: string | null | undefined;
  onOpenSession?: (target: { sessionId: string; agentId: string }) => void;
}) {
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Guards a stale response from committing to the project the operator just
  // left — without it, switching mid-request navigates to a session belonging
  // to the previous project.
  const activePidRef = useRef(projectId);
  useEffect(() => {
    activePidRef.current = projectId;
    setError(null);
    // Reset the pending flag too: an in-flight start from the previous project
    // keeps its pid-guarded `finally` from clearing it (the check skips), so
    // without this the new project inherits a permanently disabled button.
    setStarting(false);
  }, [projectId]);

  const handleStart = useCallback(async () => {
    if (!projectId || starting) return;
    const pid = projectId;
    setStarting(true);
    setError(null);
    try {
      const res: any = await api.startInfraWizard(pid);
      if (activePidRef.current !== pid) return; // switched projects — drop it
      if (!res?.sessionId) {
        setError('Server did not return a wizard session id');
        return;
      }
      onOpenSession?.({ sessionId: res.sessionId, agentId: res.agentId });
    } catch (err: any) {
      if (activePidRef.current !== pid) return;
      setError(err?.message || 'Failed to start the infrastructure setup wizard');
    } finally {
      if (activePidRef.current === pid) setStarting(false);
    }
  }, [projectId, starting, onOpenSession]);

  if (!onOpenSession) return null;

  return (
    <View style={styles.wizardRow}>
      <TouchableOpacity
        onPress={handleStart}
        disabled={!projectId || starting}
        style={[styles.wizardBtn, (!projectId || starting) && styles.disabled]}
        testID="infra-setup-wizard-button"
      >
        <Text style={styles.wizardBtnText}>{starting ? 'Starting…' : 'Set up with AI'}</Text>
      </TouchableOpacity>
      {error ? (
        <Text style={styles.error} testID="infra-setup-wizard-error">
          {error}
        </Text>
      ) : null}
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

/** Columns in the spend plot. A 30 day window draws one bar per day inside this. */
const SPEND_BAR_COUNT = 30;

/** Trend window and ranked-list depth, matching the web panel. */
const SPEND_DAYS = 30;
const SPEND_TOP_SERVICES = 5;

/**
 * What AWS actually billed, beside what collection is projected to cost.
 *
 * Unlike the scope editor above it, this one *is* editable on the phone. The
 * scope stays web-only because committing an allowlist is a multi-field form
 * whose projected cost needs room to be read; this is a single switch whose
 * whole price fits in a confirmation dialog, and an operator who wants to stop
 * a billed poll from a phone should be able to.
 *
 * The read itself is free: `GET /infra/spend` serves a cache a cron fills at
 * most three times a day and never calls AWS, so polling it on the ordinary
 * interval costs nothing.
 */
/**
 * A monotonic request counter: `begin()` starts a request and invalidates every
 * earlier one, `isCurrent(token)` says whether a settled response may still be
 * applied.
 *
 * `ResourcesTab` and `MetricsTab` below carry the same guard written inline as
 * `++generation.current`. This one is extracted because it is the only one with
 * a regression test behind it, and the race it prevents cannot be reached from
 * a test any other way: this suite runs in a node environment with no renderer,
 * so the component's own async settle order is not observable. Hoisting the
 * decision out is the same move the rest of this file already makes for exactly
 * that reason. The two older tabs could adopt it; that is not this card's scope.
 *
 * The guard is required even though the state carries a project stamp. Two
 * requests can settle out of order, and a slow read for the previous project
 * landing after the new project's would stamp the state with the old id, which
 * `stampMatchesProject` then treats as "not mine" and renders as a spinner.
 * Nothing retriggers a fetch at that point, so the section stays stuck until
 * the next poll happens to fix it, or forever if the screen went to the
 * background and paused the interval.
 */
export function createRequestGeneration(): {
  begin: () => number;
  isCurrent: (token: number) => boolean;
} {
  let current = 0;
  return {
    begin: () => (current += 1),
    isCurrent: (token: number) => current === token,
  };
}

export interface SpendToggleDeps {
  /** Writes the new opt-in value and returns the refreshed spend body. */
  save: () => Promise<any>;
  /**
   * May this response still write spend state? False once the section moved on,
   * which for this screen means a project switch or a newer read.
   */
  isCurrent: () => boolean;
  /**
   * May this response release the saving flag, and speak to the operator? True
   * while this is the newest toggle; false once a project change or a later
   * toggle has taken the flag over.
   */
  ownsSaving: () => boolean;
  applyResponse: (response: any) => void;
  notifyError: (message: string) => void;
  setSaving: (value: boolean) => void;
}

/**
 * Write the Cost Explorer opt-in and settle the section around it.
 *
 * Two guards, for the same reason {@link runLoadMorePage} needs two: "may I
 * write state?" and "may I release the flag?" are different questions with
 * different owners, and collapsing them breaks whichever case the single
 * predicate does not describe.
 *
 *   - Releasing on the request generation would strand the toggle disabled,
 *     because the generation also advances on every 60-second poll: a refresh
 *     landing mid-save would take the save's token away and nothing would ever
 *     clear `saving`.
 *   - Releasing unconditionally lets a superseded save clear a *newer* one's
 *     flag. Switch project while a save is pending, toggle on the new project,
 *     and the old response re-enables the switch under an in-flight write, so a
 *     second tap fires a duplicate concurrent request.
 *
 * Ownership is therefore tracked per toggle, not per request generation, and
 * the project-change effect hands it off so a save that never settles cannot
 * strand the next project's switch.
 *
 * The error alert is on the ownership guard rather than the state guard on
 * purpose: a modal about a project the operator has already left is noise about
 * a decision they have moved on from.
 */
export async function runSpendToggle(deps: SpendToggleDeps): Promise<void> {
  const { save, isCurrent, ownsSaving, applyResponse, notifyError, setSaving } = deps;
  try {
    const response = await save();
    if (isCurrent()) applyResponse(response);
  } catch (err: any) {
    if (ownsSaving()) {
      notifyError(err?.message || 'The Cost Explorer setting could not be saved.');
    }
  } finally {
    if (ownsSaving()) setSaving(false);
  }
}

export interface SpendSectionState {
  projectId: string;
  data: InfraSpendTrendWire | null;
  error: string | null;
}


/**
 * How many quotas the phone lists. Lower than web's 8: the rows are taller and
 * the list is sorted tightest-first, so a shorter cut still shows everything
 * that needs action. What is dropped is stated rather than silently truncated.
 */
export const QUOTA_VISIBLE_ROWS = 5;

/** Web parity: `client/src/components/infra/InfraQuotaHeadroomPanel.tsx`. */
interface QuotaSectionState {
  projectId: string;
  data: QuotaHeadroomResponse | null;
  error: string | null;
  /** When `data` was fetched, so a failed refresh can say how old it is. */
  loadedAtMs: number | null;
}

/** Bar/text colour per band, the RN peer of the web panel's Tailwind tokens. */
export const QUOTA_TONE_COLOR: Record<QuotaBandTone, string> = {
  danger: colors.red400,
  warn: colors.amber400,
  good: colors.gray300,
  muted: colors.gray500,
};

/**
 * What the phone says about the quotas it did not draw, or null when it drew
 * them all.
 *
 * Extracted so the sentence is testable without a native renderer, and because
 * a silent cut is the failure being avoided: the list is sorted tightest-first,
 * so an operator who cannot see it was truncated would reasonably read the last
 * visible row as the healthiest quota in the account.
 */
export function quotaTruncationNote(total: number): string | null {
  const hidden = total - QUOTA_VISIBLE_ROWS;
  if (hidden <= 0) return null;
  return `${hidden} more quota${hidden === 1 ? '' : 's'} not shown. The list is sorted tightest-first, so the hidden rows have the most headroom.`;
}

/**
 * Service quota headroom.
 *
 * Read-only on both platforms, so unlike `SpendSection` there is no `saving`
 * flag to own or hand off across a project switch — the whole class of bug that
 * `savingOwner` exists for cannot arise here.
 */
function QuotaSection({ projectId }: { projectId: string }) {
  const [state, setState] = useState<QuotaSectionState | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const forProject = stampMatchesProject(state, projectId) ? state : null;
  const data = forProject?.data ?? null;
  const error = forProject?.error ?? null;
  const staleNote = quotaRefreshFailureNote(error, forProject?.loadedAtMs ?? null, nowMs);

  const generation = useRef(createRequestGeneration()).current;

  const load = useCallback(() => {
    if (!projectId) return;
    const token = generation.begin();
    api
      .getInfraQuotas(projectId)
      .then((response: any) => {
        if (!generation.isCurrent(token)) return;
        setState({
          projectId,
          data: response ?? null,
          error: null,
          loadedAtMs: Date.now(),
        });
        setNowMs(Date.now());
      })
      .catch((err: any) => {
        if (!generation.isCurrent(token)) return;
        // Web parity: the readings are kept and labelled stale rather than
        // cleared. Blanking on a transient blip throws away a still-useful
        // last-known value, and silently keeping them would be worse than
        // either — this feature never shows a number it did not measure.
        setState((prev) => ({
          projectId,
          data: stampMatchesProject(prev, projectId) ? (prev?.data ?? null) : null,
          error: err?.message ?? 'Failed to load quota headroom',
          loadedAtMs: stampMatchesProject(prev, projectId) ? (prev?.loadedAtMs ?? null) : null,
        }));
        setNowMs(Date.now());
      });
  }, [projectId, generation]);

  useEffect(() => {
    load();
  }, [load]);

  useVisibleIntervalRefresh(load, POLL_MS);

  return (
    <>
      <Text style={styles.sectionTitle}>Service quota headroom</Text>
      {error && !data ? (
        <Text style={styles.error} testID="infra-quota-error">
          {error}
        </Text>
      ) : null}
      {staleNote && data ? (
        <Text style={styles.staleBanner} testID="infra-quota-stale">
          {staleNote}
        </Text>
      ) : null}
      {!data && !error ? <Text style={styles.hint}>Loading quota headroom…</Text> : null}
      {data ? (
        <>
          <Text style={styles.hint} testID="infra-quota-summary">
            {quotaSummaryLine(data.summary)}
          </Text>
          {data.quotas.length === 0 ? (
            <Empty
              text="No service quotas are being watched yet. Add a quota scope on the web Infrastructure module. Only quotas AWS publishes a usage metric for can be measured, which is a minority of them."
              testID="infra-quota-empty"
            />
          ) : (
            data.quotas.slice(0, QUOTA_VISIBLE_ROWS).map((quota) => (
              <View key={quota.resourceKey} style={styles.card} testID="infra-quota-row">
                <View style={styles.rowHead}>
                  <Text style={styles.rowTitle} numberOfLines={1}>
                    {quota.quotaName}
                  </Text>
                  <Text
                    style={[styles.quotaPercent, { color: QUOTA_TONE_COLOR[quotaBandTone(quota.band)] }]}
                    testID="infra-quota-utilization"
                  >
                    {formatQuotaUtilization(quota.utilizationPercent)}
                  </Text>
                </View>
                <View style={styles.quotaTrack}>
                  <View
                    style={[
                      styles.quotaFill,
                      {
                        width: `${quotaBarPercent(quota.utilizationPercent)}%`,
                        backgroundColor: QUOTA_TONE_COLOR[quotaBandTone(quota.band)],
                      },
                    ]}
                  />
                </View>
                <Text style={styles.rowMeta}>
                  {quota.serviceCode} · {quota.region}
                  {quota.adjustable ? '' : ' · not adjustable'}
                </Text>
                {quotaUnknownReason(quota) ? (
                  <Text style={styles.rowMeta} testID="infra-quota-unknown-reason">
                    {quotaUnknownReason(quota)}
                  </Text>
                ) : (
                  <Text style={styles.rowMeta} testID="infra-quota-remaining">
                    {formatQuotaHeadroom(quota.headroom, quota.unit)} left
                  </Text>
                )}
              </View>
            ))
          )}
          {quotaTruncationNote(data.quotas.length) ? (
            <Text style={styles.hint} testID="infra-quota-truncated">
              {quotaTruncationNote(data.quotas.length)}
            </Text>
          ) : null}
        </>
      ) : null}
    </>
  );
}

/**
 * The state a failed spend refresh should leave behind.
 *
 * It keeps the last confirmed figures rather than blanking them. This is a
 * cache the server fills at most three times a day, so what is already on
 * screen is hours old by design and is exactly as true after a dropped request
 * as it was before one. Discarding it turns a moment of bad signal into a lost
 * answer, on the one surface most likely to have bad signal, and it also makes
 * the section's own "showing the last confirmed figures" banner unreachable.
 *
 * Figures are carried forward only within the same project. Another project's
 * bill is not a stale version of this one, it is the wrong number.
 */
export function spendStateAfterFailure(
  previous: SpendSectionState | null | undefined,
  projectId: string,
  message?: string | null,
): SpendSectionState {
  return {
    projectId,
    data: stampMatchesProject(previous, projectId) ? (previous?.data ?? null) : null,
    error: message || 'Spend could not be loaded.',
  };
}

function SpendSection({ projectId }: { projectId: string }) {
  const [state, setState] = useState<SpendSectionState | null>(null);
  const [saving, setSaving] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const forProject = stampMatchesProject(state, projectId) ? state : null;
  const trend = forProject?.data ?? null;
  const error = forProject?.error ?? null;
  const loading = !!projectId && forProject === null;

  // Advancing inside `load` rather than in the project-change effect also
  // covers two polls of the *same* project overlapping on a slow connection.
  const generation = useRef(createRequestGeneration()).current;
  // Who currently owns `saving`. Tracked separately from `generation` because
  // that counter advances on every poll, and a poll must not be able to take a
  // save's flag away. Same split, and the same reason, as `loadMoreToken`.
  const savingOwner = useRef(0);

  const load = useCallback(() => {
    if (!projectId) return;
    const token = generation.begin();
    api
      .getInfraSpend(projectId, { days: SPEND_DAYS, topServices: SPEND_TOP_SERVICES })
      .then((response: any) => {
        if (!generation.isCurrent(token)) return;
        setState({ projectId, data: response ?? null, error: null });
        setNowMs(Date.now());
      })
      .catch((err: any) => {
        if (!generation.isCurrent(token)) return;
        setState((prev) => spendStateAfterFailure(prev, projectId, err?.message));
      });
  }, [projectId, generation]);

  useEffect(() => {
    // The switch starts clean rather than inheriting the previous project's
    // pending save. Handing ownership off in the same step is what stops that
    // save, whenever it settles, from clearing a flag it no longer owns; a save
    // that never settles at all can then no longer strand this project's toggle.
    savingOwner.current += 1;
    setSaving(false);
    load();
  }, [load]);

  useVisibleIntervalRefresh(load, POLL_MS);

  const setEnabled = useCallback(
    (enabled: boolean) => {
      if (!projectId || saving) return;
      setSaving(true);
      // The save advances the read generation so an older in-flight poll cannot
      // repaint the section with the value it just replaced.
      const token = generation.begin();
      const owner = ++savingOwner.current;
      void runSpendToggle({
        save: () => api.updateInfraSpendConfig(projectId, { enabled }),
        isCurrent: () => generation.isCurrent(token),
        ownsSaving: () => savingOwner.current === owner,
        // The endpoint answers with the same spend body, so the section
        // repaints from the response rather than issuing a second read.
        applyResponse: (response: any) => {
          setState({ projectId, data: response ?? null, error: null });
          setNowMs(Date.now());
        },
        notifyError: (message: string) => Alert.alert('AWS spend', message),
        setSaving,
      });
    },
    [projectId, saving, generation],
  );

  const confirmToggle = (enabling: boolean) => {
    const { title, message, buttons } = buildSpendOptInConfirm({
      enabling,
      onConfirm: () => setEnabled(enabling),
    });
    Alert.alert(title, message, buttons);
  };

  if (loading && !trend) {
    return (
      <>
        <Text style={styles.sectionTitle}>AWS spend</Text>
        <ActivityIndicator color={colors.gray400} />
      </>
    );
  }

  if (error && !trend) {
    return (
      <>
        <Text style={styles.sectionTitle}>AWS spend</Text>
        <Text style={styles.error} testID="infra-spend-error">
          {error}
        </Text>
      </>
    );
  }

  if (!trend || !trend.enabled) {
    return (
      <>
        <Text style={styles.sectionTitle}>AWS spend</Text>
        <View style={styles.card} testID="infra-spend-optin">
          <Text style={styles.rowMeta}>
            Chart what AWS actually billed this account, per day and per service.
          </Text>
          <Text style={styles.staleBanner}>{COST_EXPLORER_OPT_IN_COPY.price}</Text>
          <Text style={styles.hint}>{COST_EXPLORER_OPT_IN_COPY.cadence}</Text>
          <Text style={styles.hint}>{COST_EXPLORER_OPT_IN_COPY.estimates}</Text>
          <TouchableOpacity
            style={[styles.secondaryButton, saving && styles.disabled]}
            disabled={saving}
            onPress={() => confirmToggle(true)}
            testID="infra-spend-enable"
          >
            <Text style={styles.secondaryButtonText}>Turn on Cost Explorer polling</Text>
          </TouchableOpacity>
        </View>
      </>
    );
  }

  const summary = spendTrendSummary(trend);
  const plot = buildSpendBars(trend.days, SPEND_BAR_COUNT);
  const rows = spendServiceRows(trend);
  const money = (value: number | null | undefined) => formatMoney(value, trend.unit);
  const failed = trend.lastRun?.status === 'failed';
  const hint = failed ? spendFailureHint(trend.lastRun?.errorMessage) : null;

  return (
    <>
      <Text style={styles.sectionTitle}>AWS spend</Text>
      <View style={styles.card} testID="infra-spend-summary">
        <Text style={styles.bigNumber} testID="infra-spend-total">
          {money(summary.totalUsd)}
        </Text>
        <Text style={styles.rowMeta}>
          {trend.windowStartDay} to {trend.windowEndDay}
        </Text>
        <Text style={styles.hint} testID="infra-spend-staleness">
          {spendStalenessLabel(trend.syncedAt, trend.fetchedAt, nowMs)}
        </Text>
      </View>

      {error ? (
        <Text style={styles.staleBanner} testID="infra-spend-stale">
          ⚠ Showing the last confirmed figures; the newest refresh failed.
        </Text>
      ) : null}

      {failed ? (
        <View style={styles.warnBox} testID="infra-spend-failed">
          <Text style={styles.warnTitle}>The last Cost Explorer sync failed</Text>
          <Text style={styles.warnBody}>
            {trend.lastRun?.errorMessage || 'AWS returned no reason.'}
          </Text>
          {hint ? (
            <Text style={styles.warnBody} testID="infra-spend-data-unavailable">
              {hint}
            </Text>
          ) : null}
        </View>
      ) : null}

      {plot.hasData ? (
        <View style={styles.chartCard} testID="infra-spend-chart">
          <View style={styles.chartPlot}>
            {plot.bars.map((bar, index) => (
              <View key={`${bar.day}-${index}`} style={styles.barTrack}>
                <View
                  style={[
                    styles.bar,
                    bar.estimated && styles.barEstimated,
                    // Floored above zero so a day with a real but tiny charge
                    // still draws: a zero-height bar is indistinguishable from a
                    // day that was never billed.
                    { height: `${Math.max(bar.amountUsd > 0 ? 2 : 0, bar.height * 100)}%` },
                  ]}
                  testID={bar.estimated ? 'infra-spend-bar-estimated' : 'infra-spend-bar'}
                />
              </View>
            ))}
          </View>
          <View style={styles.chartAxis}>
            <Text style={styles.axisLabel}>{plot.bars[0]?.day}</Text>
            <Text style={styles.axisLabel}>{plot.bars[plot.bars.length - 1]?.day}</Text>
          </View>
          <Text style={styles.hint} testID="infra-spend-legend">
            Peak day {money(plot.maxUsd)}. Paler columns are AWS estimates rather than settled
            charges and will still move.
            {summary.latestEstimated ? ' The most recent day is always an estimate.' : ''}
          </Text>
        </View>
      ) : (
        <Empty testID="infra-spend-empty" text={spendEmptyCopy(trend)} />
      )}

      {rows.length > 0 ? (
        <View style={styles.card} testID="infra-spend-services">
          <Text style={styles.notesLabel}>Top services</Text>
          {rows.map((row) => (
            <View key={row.key} style={styles.rowHead} testID={`infra-spend-row-${row.key}`}>
              <Text style={styles.rowMeta} numberOfLines={1}>
                {row.label}
              </Text>
              <Text style={[styles.rowMeta, styles.rowAmount]}>{money(row.amountUsd)}</Text>
            </View>
          ))}
        </View>
      ) : null}

      <TouchableOpacity
        style={[styles.secondaryButton, saving && styles.disabled]}
        disabled={saving}
        onPress={() => confirmToggle(false)}
        testID="infra-spend-disable"
      >
        <Text style={styles.secondaryButtonText}>Turn off Cost Explorer polling</Text>
      </TouchableOpacity>
    </>
  );
}

// ── AWS Health ──────────────────────────────────────────────────────────────

/**
 * Dot and label colour per severity — the RN peer of the web panel's Tailwind
 * tokens (`bg-red-500` / `bg-amber-500` / `bg-sky-500`).
 */
export const HEALTH_SEVERITY_COLOR: Record<InfraHealthSeverity, string> = {
  critical: colors.red400,
  warning: colors.amber400,
  info: colors.sky400,
};

/** Status-pill colours. Unknown statuses fall back to the neutral `closed` look. */
export const HEALTH_STATUS_STYLE: Record<string, { color: string; backgroundColor: string }> = {
  OPEN: { color: colors.red400, backgroundColor: colors.red900_50 },
  UPCOMING: { color: colors.sky300, backgroundColor: colors.sky500_15 },
  CLOSED: { color: colors.gray400, backgroundColor: colors.gray800 },
};

interface HealthSectionState {
  projectId: string;
  data: InfraHealthEventsResponse | null;
  error: string | null;
}

interface HealthIngestState {
  projectId: string;
  data: InfraHealthIngestResponse | null;
  error: string | null;
}

/**
 * A freshly minted plaintext credential.
 *
 * Stamped with its project for the same reason every other piece of state on
 * this screen is, but with more at stake: this one cannot be re-fetched to
 * correct itself, so a token rendered under the wrong project header is a
 * secret the operator may well paste into the wrong AWS account.
 */
interface MintedTokenState {
  projectId: string;
  token: string;
}

/** Label + monospace value + a Copy button. Used for the URL and the pattern. */
function HealthCopyField({
  label,
  value,
  testID,
  copied,
  onCopy,
}: {
  label: string;
  value: string;
  testID: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <View style={styles.healthField}>
      <View style={styles.rowHead}>
        <Text style={styles.healthFieldLabel}>{label}</Text>
        <TouchableOpacity onPress={onCopy} style={styles.healthCopyBtn} testID={`${testID}-copy`}>
          <Text style={styles.healthCopyBtnText}>{copied ? 'Copied' : 'Copy'}</Text>
        </TouchableOpacity>
      </View>
      {/* `selectable` as well as the button: long-press-to-copy is the gesture
          phone users reach for first, and it also survives a clipboard module
          that failed to link. */}
      <Text style={styles.healthCode} selectable testID={testID}>
        {value}
      </Text>
    </View>
  );
}

/**
 * AWS Health events.
 *
 * The only infra surface that reports news the Hub did not go looking for.
 * Everything else on this tab polls AWS and reports what it measured; this
 * reports what AWS knows and we cannot — a degraded control plane in the
 * Region, an EBS volume flagged for retirement — which is why it sits above the
 * spend and quota sections. Money can wait; an incident in flight cannot.
 *
 * Ingest-only by design: the Hub never calls the AWS Health API (that needs a
 * Business/Enterprise support plan). An operator-owned EventBridge rule pushes
 * events at the ingest route instead, which is why this section carries a whole
 * credential-management affordance that no other infra section needs.
 */
function HealthSection({ projectId }: { projectId: string }) {
  const { lastInfraHealthEvent } = useApp() as { lastInfraHealthEvent?: any };
  const [state, setState] = useState<HealthSectionState | null>(null);
  const [ingest, setIngest] = useState<HealthIngestState | null>(null);
  const [minted, setMinted] = useState<MintedTokenState | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  /**
   * Tri-state so the default can follow the data without fighting the operator.
   * `null` means nobody has tapped: the setup block then opens itself exactly
   * when ingest is unconfigured, which is the only time it is the next action.
   * A tap pins it either way.
   */
  const [setupOverride, setSetupOverride] = useState<boolean | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const forProject = stampMatchesProject(state, projectId) ? state : null;
  const data = forProject?.data ?? null;
  const error = forProject?.error ?? null;
  const ingestForProject = stampMatchesProject(ingest, projectId) ? ingest : null;
  const mintedToken = stampMatchesProject(minted, projectId) ? minted!.token : null;

  const generation = useRef(createRequestGeneration()).current;
  const ingestGeneration = useRef(createRequestGeneration()).current;
  // Who owns `busy`. Separate from the read generation for the same reason
  // `savingOwner` is in SpendSection: that counter advances on every 60s poll,
  // and a poll must not be able to take a mint's flag away.
  const busyOwner = useRef(0);

  const load = useCallback(() => {
    if (!projectId) return;
    const token = generation.begin();
    api
      .getInfraHealthEvents(projectId, { limit: HEALTH_EVENT_LIMIT })
      .then((response: any) => {
        if (!generation.isCurrent(token)) return;
        setState({ projectId, data: response ?? null, error: null });
        setNowMs(Date.now());
      })
      .catch((err: any) => {
        if (!generation.isCurrent(token)) return;
        // The events already on screen are deliberately kept. A transient blip
        // must not blank an outage the operator is in the middle of reading —
        // and, unlike a metric, a past health event does not go stale.
        setState((prev) => ({
          projectId,
          data: stampMatchesProject(prev, projectId) ? (prev?.data ?? null) : null,
          error: err?.message || 'Failed to load AWS Health events',
        }));
      });
  }, [projectId, generation]);

  useEffect(() => {
    // Everything project-scoped resets together. The minted token especially:
    // it belongs to one project, cannot be re-read, and has no business
    // surviving a navigation.
    busyOwner.current += 1;
    setBusy(false);
    setMinted(null);
    setIngest(null);
    setSetupOverride(null);
    setExpanded({});
    setCopied(null);
    load();
  }, [load]);

  useVisibleIntervalRefresh(load, POLL_MS);

  useEffect(() => {
    // Live parity with web, which listens for the `infra_health_event` window
    // CustomEvent. Refetching rather than splicing the broadcast in: the
    // broadcast is a summary, and only a re-read keeps `total` and
    // `ingestConfigured` honest.
    if (!isInfraAlertEventForProject(lastInfraHealthEvent, projectId)) return;
    load();
  }, [lastInfraHealthEvent, projectId, load]);

  const setupOpen = setupOverride ?? (data ? !data.ingestConfigured : false);

  useEffect(() => {
    // Fetched lazily: an operator whose rule already works should never pay a
    // round-trip for a block they will not open.
    if (!projectId || !setupOpen || ingestForProject) return;
    const token = ingestGeneration.begin();
    api
      .getInfraHealthIngest(projectId)
      .then((response: any) => {
        if (!ingestGeneration.isCurrent(token)) return;
        setIngest({ projectId, data: response ?? null, error: null });
      })
      .catch((err: any) => {
        if (!ingestGeneration.isCurrent(token)) return;
        setIngest({
          projectId,
          data: null,
          error: err?.message || 'Failed to load ingest settings',
        });
      });
  }, [projectId, setupOpen, ingestForProject, ingestGeneration]);

  const copy = useCallback((value: string, key: string, label: string) => {
    void copyToClipboard(value).then((ok: boolean) => {
      if (ok) setCopied(key);
      else Alert.alert('AWS Health', `${label} could not be copied.`);
    });
  }, []);

  const mint = useCallback(() => {
    if (!projectId || busy) return;
    setBusy(true);
    const owner = ++busyOwner.current;
    api
      .createInfraHealthIngestToken(projectId)
      .then((response: any) => {
        if (busyOwner.current !== owner) return;
        setMinted({ projectId, token: response?.token || '' });
        setIngest({
          projectId,
          data: {
            token: response?.info ?? null,
            ingestPath: response?.ingestPath ?? '',
            eventPattern: response?.eventPattern ?? {},
          },
          error: null,
        });
        setCopied(null);
        // `ingestConfigured` just flipped; re-read so the empty state stops
        // claiming the rule was never wired up.
        load();
      })
      .catch((err: any) => {
        if (busyOwner.current !== owner) return;
        const message = err?.message || 'The ingest token could not be created.';
        setIngest((prev) => ({
          projectId,
          data: stampMatchesProject(prev, projectId) ? (prev?.data ?? null) : null,
          error: message,
        }));
        Alert.alert('AWS Health', message);
      })
      .finally(() => {
        if (busyOwner.current === owner) setBusy(false);
      });
  }, [projectId, busy, load]);

  const revoke = useCallback(() => {
    if (!projectId || busy) return;
    setBusy(true);
    const owner = ++busyOwner.current;
    api
      .revokeInfraHealthIngestToken(projectId)
      .then((response: any) => {
        if (busyOwner.current !== owner) return;
        setMinted(null);
        setIngest((prev) =>
          stampMatchesProject(prev, projectId) && prev?.data
            ? { projectId, data: { ...prev.data, token: response?.token ?? null }, error: null }
            : prev,
        );
        load();
      })
      .catch((err: any) => {
        if (busyOwner.current !== owner) return;
        const message = err?.message || 'The ingest token could not be revoked.';
        Alert.alert('AWS Health', message);
      })
      .finally(() => {
        if (busyOwner.current === owner) setBusy(false);
      });
  }, [projectId, busy, load]);

  const confirmRevoke = () => {
    Alert.alert(
      'Revoke ingest token?',
      'AWS Health deliveries using this token start failing immediately. Events already received are kept.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Revoke', style: 'destructive', onPress: revoke },
      ],
    );
  };

  const events = useMemo(() => sortHealthEvents(data?.events), [data]);
  const visible = events.slice(0, HEALTH_VISIBLE_ROWS);
  const truncation = healthTruncationNote(visible.length, data?.total ?? events.length);

  const ingestData = ingestForProject?.data ?? null;
  const ingestError = ingestForProject?.error ?? null;
  const tokenInfo = ingestData?.token ?? null;
  const ingestUrl = ingestData ? healthIngestUrl(getServerBaseUrl(), ingestData.ingestPath) : '';
  const patternJson = formatEventPattern(ingestData?.eventPattern);
  const emptyState = healthEmptyState(Boolean(data?.ingestConfigured));

  return (
    <>
      <Text style={styles.sectionTitle}>AWS Health</Text>

      {error ? (
        <Text style={styles.error} testID="infra-health-error">
          {error}
        </Text>
      ) : null}
      {!data && !error ? <Text style={styles.hint}>Loading AWS Health events…</Text> : null}

      {data && events.length === 0 ? (
        <View style={styles.emptyCard} testID={emptyState.testID}>
          <Text style={styles.healthEmptyTitle}>{emptyState.title}</Text>
          <Text style={styles.emptyText}>{emptyState.body}</Text>
        </View>
      ) : null}

      {visible.map((event) => (
        <HealthRow
          key={event.id}
          event={event}
          nowMs={nowMs}
          expanded={Boolean(expanded[event.id])}
          onToggle={() =>
            setExpanded((prev) => ({ ...prev, [event.id]: !prev[event.id] }))
          }
        />
      ))}
      {truncation ? (
        <Text style={styles.hint} testID="infra-health-truncated">
          {truncation}
        </Text>
      ) : null}

      <TouchableOpacity
        onPress={() => setSetupOverride(!setupOpen)}
        style={styles.healthSetupToggle}
        testID="infra-health-setup-toggle"
      >
        <Text style={styles.healthLink}>{setupOpen ? '▾ Ingest setup' : '▸ Ingest setup'}</Text>
      </TouchableOpacity>

      {setupOpen ? (
        <View testID="infra-health-setup">
          {ingestError ? (
            <Text style={styles.error} testID="infra-health-setup-error">
              {ingestError}
            </Text>
          ) : null}

          <Text style={styles.hint} testID="infra-health-setup-note">
            {INGEST_SETUP_NOTE}
          </Text>

          {ingestData ? (
            <>
              <HealthCopyField
                label="Ingest URL"
                value={ingestUrl}
                testID="infra-health-ingest-url"
                copied={copied === 'url'}
                onCopy={() => copy(ingestUrl, 'url', 'Ingest URL')}
              />
              <HealthCopyField
                label="Event pattern"
                value={patternJson}
                testID="infra-health-event-pattern"
                copied={copied === 'pattern'}
                onCopy={() => copy(patternJson, 'pattern', 'Event pattern')}
              />
            </>
          ) : !ingestError ? (
            <Text style={styles.hint}>Loading ingest settings…</Text>
          ) : null}

          {mintedToken ? (
            <View style={styles.healthTokenBox} testID="infra-health-token-reveal">
              <Text style={styles.healthTokenWarning} testID="infra-health-token-warning">
                {TOKEN_ONCE_WARNING}
              </Text>
              <Text style={styles.healthCode} selectable testID="infra-health-token-plaintext">
                {mintedToken}
              </Text>
              <TouchableOpacity
                onPress={() => copy(mintedToken, 'token', 'Ingest token')}
                style={styles.healthCopyBtn}
                testID="infra-health-copy-token"
              >
                <Text style={styles.healthCopyBtnText}>
                  {copied === 'token' ? 'Copied' : 'Copy token'}
                </Text>
              </TouchableOpacity>
            </View>
          ) : null}

          <TouchableOpacity
            style={[styles.secondaryButton, busy && styles.disabled]}
            disabled={busy}
            onPress={mint}
            testID="infra-health-mint"
          >
            <Text style={styles.secondaryButtonText}>
              {busy ? '…' : ingestActionLabel(tokenInfo)}
            </Text>
          </TouchableOpacity>
          {isIngestTokenLive(tokenInfo) ? (
            <TouchableOpacity
              style={[styles.secondaryButton, busy && styles.disabled]}
              disabled={busy}
              onPress={confirmRevoke}
              testID="infra-health-revoke"
            >
              <Text style={styles.secondaryButtonText}>Revoke</Text>
            </TouchableOpacity>
          ) : null}
          {ingestTokenSummary(tokenInfo, nowMs) ? (
            <Text style={styles.hint} testID="infra-health-token-info">
              {ingestTokenSummary(tokenInfo, nowMs)}
            </Text>
          ) : null}
        </View>
      ) : null}
    </>
  );
}

function HealthRow({
  event,
  nowMs,
  expanded,
  onToggle,
}: {
  event: InfraHealthEventWire;
  nowMs: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  const severity = normalizeHealthSeverity(event.severity);
  const status = formatHealthStatus(event.statusCode);
  const description = truncateHealthDescription(event.description, expanded);
  const clampable = isHealthDescriptionClampable(event.description);

  return (
    <View
      style={[styles.card, styles.healthRow, { borderLeftColor: HEALTH_SEVERITY_COLOR[severity] }]}
      testID="infra-health-event"
    >
      <View style={styles.rowHead}>
        <View
          style={[styles.healthDot, { backgroundColor: HEALTH_SEVERITY_COLOR[severity] }]}
          testID="infra-health-severity-dot"
        />
        <Text
          style={[styles.healthSeverity, { color: HEALTH_SEVERITY_COLOR[severity] }]}
          testID="infra-health-severity"
        >
          {healthSeverityLabel(severity)}
        </Text>
        <Text style={styles.rowTitle} numberOfLines={1} testID="infra-health-service">
          {healthEventService(event)}
        </Text>
        {status ? (
          <Text
            style={[styles.statePill, HEALTH_STATUS_STYLE[status] ?? HEALTH_STATUS_STYLE.CLOSED]}
            testID="infra-health-status"
          >
            {status}
          </Text>
        ) : null}
      </View>
      <Text style={styles.mono} numberOfLines={2} testID="infra-health-type-code">
        {healthEventTypeCode(event)}
      </Text>
      <Text style={styles.rowMeta} testID="infra-health-meta">
        {healthEventMetaLine(event, nowMs)}
      </Text>
      {description.text ? (
        <Text style={styles.healthDescription} testID="infra-health-description">
          {description.text}
        </Text>
      ) : null}
      {clampable ? (
        <TouchableOpacity onPress={onToggle} testID="infra-health-expand">
          <Text style={styles.healthLink}>{expanded ? 'Show less' : 'Show more'}</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

function OverviewTab({
  projectId,
  project,
  monitoringStatus,
  scopes,
  loading,
  error,
  openAlertCount,
  blockers,
  notes,
}: any) {
  const monitoringState = monitoringCardState(project, monitoringStatus);
  const projection = scopes?.projection ?? null;
  const rows: any[] = Array.isArray(scopes?.scopes) ? scopes.scopes : [];
  const blockerCodes: string[] = Array.isArray(blockers) ? blockers : [];
  const draftNotes: string[] = Array.isArray(notes) ? notes : [];

  return (
    <ScrollView contentContainerStyle={styles.content}>
      {/* First on the tab, mirroring web: every panel below reports on a
          collection pipeline that is not running yet, and this is the only one
          that says why. The draft calls AWS zero times, so an unconfigured
          project reads the specific reason rather than a wall of generic empty
          states. */}
      {blockerCodes.length > 0 ? (
        <View style={[styles.warnBox, styles.blockerBox]} testID="infra-setup-blockers">
          <Text style={styles.warnTitle}>Infrastructure monitoring is not collecting yet</Text>
          {blockerCodes.map((blocker) => (
            <Text key={blocker} style={styles.warnBody} testID={`infra-blocker-${blocker}`}>
              {describeInfraBlocker(blocker)}
            </Text>
          ))}
          {/* The server's notes carry detail no enum can — which designation
              stopped resolving, which profiles are eligible — so they render
              verbatim beneath the codes rather than being restated here. */}
          {draftNotes.map((note, i) => (
            <Text key={i} style={styles.hint}>
              {note}
            </Text>
          ))}
          <Text style={styles.hint}>
            Use Set up with AI above to walk through this with an agent: it probes the account
            read-only, prices the scope, and saves the allowlist.
          </Text>
        </View>
      ) : null}

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

      {/* Above the spend section, mirroring web: this is operational news AWS
          pushed at us — a degraded control plane, a retiring volume — and the
          only thing on this tab that can be happening right now. The money
          below it is never that urgent. */}
      {projectId ? <HealthSection projectId={projectId} /> : null}
      {/* Below the scope, mirroring web: that block prices a decision the
          operator is about to make, this one reports the bill it lands on. */}
      {projectId ? <SpendSection projectId={projectId} /> : null}
      {/* Last, mirroring web: the panels above are about money, this one about
          capacity — nothing is down and you still cannot launch. */}
      {projectId ? <QuotaSection projectId={projectId} /> : null}
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
  const { projects, lastInfraAlertEvent, setActiveAgentId, setActiveSessionId } = useApp();
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

  // The setup draft: Hub-side readiness only, zero AWS calls (decision
  // INFRA-WIZARD), so it is free to fetch on open even for a project whose only
  // credentials are interactive SSO — which is exactly the project that most
  // needs to be told why nothing is collecting. Stamped like everything else
  // here so one project's blockers never render under another's header.
  const [draftState, setDraftState] = useState<{ projectId: string; draft: any } | null>(null);
  const draft = stampMatchesProject(draftState, projectId) ? draftState!.draft : null;

  const openSession = useCallback(
    ({ sessionId, agentId }: { sessionId: string; agentId: string }) => {
      setActiveAgentId(agentId);
      setActiveSessionId(sessionId);
      navigation.navigate('Chat');
    },
    [navigation, setActiveAgentId, setActiveSessionId],
  );

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    api
      .getInfraSetupDraft(projectId)
      .then((response: any) => {
        if (!cancelled && response?.draft) setDraftState({ projectId, draft: response.draft });
      })
      // A readiness report the operator cannot see is a worse empty state, not
      // a broken module: the tabs below stand on their own data.
      .catch(() => {
        if (!cancelled) setDraftState(null);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

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

      {/* Above the tabs, mirroring web: the wizard is how an unconfigured
          project gets configured, so it must not be reachable only from the tab
          whose emptiness is the reason to press it. */}
      <InfraSetupWizardButton projectId={projectId} onOpenSession={openSession} />

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
          projectId={projectId}
          project={project}
          monitoringStatus={monitoringStatus}
          scopes={scopes}
          loading={scopesLoading}
          error={scopesError}
          openAlertCount={openAlertCount}
          blockers={draft?.blockers}
          notes={draft?.notes}
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
  quotaPercent: { fontSize: 14, fontWeight: '600', marginLeft: 'auto' },
  quotaTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.gray800,
    overflow: 'hidden',
    marginTop: 6,
  },
  quotaFill: { height: '100%', borderRadius: 3 },
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
  healthEmptyTitle: { fontSize: 13, color: colors.gray300, fontWeight: '600', marginBottom: 4 },
  // The severity colour lives on the row's left edge rather than only in a dot:
  // a phone is read at arm's length in bad light, and an 8px dot is not a
  // signal at that distance.
  healthRow: { borderLeftWidth: 3 },
  healthDot: { width: 8, height: 8, borderRadius: 4 },
  healthSeverity: { fontSize: 11, fontWeight: '600', textTransform: 'uppercase' },
  healthDescription: { fontSize: 12, color: colors.gray400, marginTop: 6, lineHeight: 18 },
  healthLink: { fontSize: 12, color: colors.sky400, marginTop: 4 },
  healthSetupToggle: { marginTop: 10 },
  healthField: { marginTop: 10 },
  healthFieldLabel: { fontSize: 12, color: colors.gray400, fontWeight: '600' },
  healthCode: {
    fontFamily: 'monospace',
    fontSize: 11,
    color: colors.gray300,
    backgroundColor: colors.gray950,
    borderWidth: 1,
    borderColor: colors.gray800,
    borderRadius: 6,
    padding: 8,
    marginTop: 4,
  },
  healthCopyBtn: {
    marginLeft: 'auto',
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  healthCopyBtnText: { fontSize: 11, color: colors.gray300 },
  healthTokenBox: {
    marginTop: 10,
    padding: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.amber900_40,
    backgroundColor: colors.yellow900_50,
  },
  healthTokenWarning: { fontSize: 12, color: colors.amber400, lineHeight: 17 },
  warnBox: {
    backgroundColor: colors.yellow900_50,
    borderRadius: 8,
    padding: 12,
    borderWidth: 1,
    borderColor: colors.amber900_40,
  },
  blockerBox: { marginBottom: 12 },
  warnTitle: { fontSize: 13, color: colors.amber400, fontWeight: '600', marginBottom: 4 },
  wizardRow: {
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  wizardBtn: {
    backgroundColor: colors.blue600,
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
  },
  wizardBtnText: { fontSize: 13, fontWeight: '600', color: colors.white },
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
  // An estimated day is drawn paler, and the caption under the plot says so in
  // words: colour alone cannot carry "this number will still move", and a phone
  // is exactly where it gets read in bad light.
  barEstimated: { opacity: 0.45 },
  rowAmount: { marginLeft: 'auto' },
  chartAxis: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 },
  axisLabel: { fontSize: 10, color: colors.gray500 },
});
