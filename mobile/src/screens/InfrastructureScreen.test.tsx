import { describe, expect, it, vi } from 'vitest';

// RN primitives as host string tags so the module imports under the node test
// environment. Matches the LogsScreen / LogSourcesScreen pattern.
vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Alert: { alert: vi.fn() },
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
  ScrollView: 'ScrollView',
  StyleSheet: { create: (styles: any) => styles },
  Text: 'Text',
  TextInput: 'TextInput',
  TouchableOpacity: 'TouchableOpacity',
  View: 'View',
}));
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }));
vi.mock('../components/ProjectScreenHeader', () => ({ default: 'ProjectScreenHeader' }));
vi.mock('../context/AppContext', () => ({ useApp: () => ({}) }));
// `utils/config` pulls in AsyncStorage at module load, which has no node build.
// The screen only needs the server base to render the AWS Health ingest URL.
vi.mock('../utils/config', () => ({ getServerBaseUrl: () => 'https://hub.example.com' }));
vi.mock('../utils/api', () => ({
  api: {
    getInfraScopes: vi.fn(() => Promise.resolve({ scopes: [] })),
    getInfraMonitoringStatus: vi.fn(() => Promise.resolve({ reachable: true })),
    getInfraAlert: vi.fn(() => Promise.resolve(null)),
    listInfraResources: vi.fn(() => Promise.resolve({ resources: [] })),
    listInfraMetricSeries: vi.fn(() => Promise.resolve({ series: [] })),
    getInfraMetricRange: vi.fn(() => Promise.resolve({ points: [] })),
    listInfraAlerts: vi.fn(() => Promise.resolve({ alerts: [] })),
    listInfraAlertRules: vi.fn(() => Promise.resolve({ rules: [] })),
    setInfraAlertStatus: vi.fn(() => Promise.resolve({})),
    getInfraMetricPacks: vi.fn(() => Promise.resolve({ packs: [] })),
    getInfraSpend: vi.fn(() => Promise.resolve({ enabled: false, days: [] })),
    getInfraQuotas: vi.fn(() =>
      Promise.resolve({
        quotas: [],
        summary: { critical: 0, warning: 0, ok: 0, unknown: 0, total: 0 },
        thresholds: { warning: 80, critical: 100 },
        expression: 'm1/SERVICE_QUOTA(m1)*100',
        staleAfterMs: 0,
      }),
    ),
    updateInfraSpendConfig: vi.fn(() => Promise.resolve({ enabled: false, days: [] })),
    getInfraHealthEvents: vi.fn(() =>
      Promise.resolve({ events: [], total: 0, ingestConfigured: false }),
    ),
    getInfraHealthIngest: vi.fn(() =>
      Promise.resolve({ token: null, ingestPath: '/api/infra/health/ingest', eventPattern: {} }),
    ),
    createInfraHealthIngestToken: vi.fn(() => Promise.resolve({ token: 'ahhealth_x' })),
    revokeInfraHealthIngestToken: vi.fn(() => Promise.resolve({ revoked: true, token: null })),
  },
}));

import {
  ServiceNotes,
  TABS,
  alertsEmptyCopy,
  buildAlertActionConfirm,
  buildSpendOptInConfirm,
  describeInfraBlocker,
  formatUsd,
  hasConfiguredScope,
  initialAlertStatusFilter,
  isMonitoringMissing,
  mergeFocusedAlert,
  monitoringCardDetail,
  monitoringCardState,
  openAlertCountFrom,
  resourcesEmptyCopy,
  runLoadMorePage,
  spendEmptyCopy,
  spendServiceRows,
  spendStateAfterFailure,
  createRequestGeneration,
  runSpendToggle,
  stampMatchesProject,
  QUOTA_VISIBLE_ROWS,
  QUOTA_TONE_COLOR,
  quotaTruncationNote,
  HEALTH_SEVERITY_COLOR,
  HEALTH_STATUS_STYLE,
} from './InfrastructureScreen';
import {
  formatHealthStatus,
  healthEmptyState,
  normalizeHealthSeverity,
} from '../utils/infraHealth';
import { quotaRefreshFailureNote } from '@shared/utils/quotaHeadroom';
import { EMPTY_FILTERS } from '../utils/infraResources';
import type { InfraServicePackWire } from '@shared/utils/infraPacks';
import { joinAlertsToRules } from '@shared/utils/infraAlerts';

describe('TABS', () => {
  it('matches the web module tab set and order', () => {
    expect(TABS.map((t) => t.key)).toEqual(['overview', 'resources', 'metrics', 'alerts']);
  });
});

describe('describeInfraBlocker', () => {
  it('names every blocker code the setup draft can emit', () => {
    const codes = [
      'infra-disabled',
      'no-profiles',
      'only-sso-profiles',
      'no-monitoring-profile',
      'storage-unavailable',
      'no-scope',
    ];
    for (const code of codes) {
      const copy = describeInfraBlocker(code);
      expect(copy).not.toBe(code);
      expect(copy.length).toBeGreaterThan(20);
    }
  });

  it('falls back to the raw code so a newer server blocker is still searchable', () => {
    expect(describeInfraBlocker('some-future-blocker')).toBe('some-future-blocker');
  });
});

describe('isMonitoringMissing', () => {
  it('is missing when no profile is designated anywhere', () => {
    expect(isMonitoringMissing(null, null)).toBe(true);
    expect(isMonitoringMissing({}, null)).toBe(true);
  });

  it('is satisfied by the project-level designated profile', () => {
    expect(isMonitoringMissing({ awsMonitoringProfile: 'monitoring' }, null)).toBe(false);
  });

  it('trusts an explicit not_designated reason over a stale project field', () => {
    // An SSO-only project cannot collect unattended (INFRA-CRED); the server
    // saying so must win over project metadata that still names a profile.
    expect(
      isMonitoringMissing({ awsMonitoringProfile: 'sso-dev' }, { reason: 'not_designated' }),
    ).toBe(true);
  });

  it('trusts the monitoring_profile_required code the same way', () => {
    expect(
      isMonitoringMissing(
        { awsMonitoringProfile: 'sso-dev' },
        { code: 'monitoring_profile_required' },
      ),
    ).toBe(true);
  });

  it('is satisfied by a profile the status reports', () => {
    expect(isMonitoringMissing(null, { profile: 'monitoring' })).toBe(false);
  });
});

describe('monitoringCardState', () => {
  it('reports unreachable when the probe says so, despite named project metadata', () => {
    // Regression: the card was derived from project metadata alone, so a project
    // naming an unusable SSO profile rendered "Monitoring profile ready" over a
    // module that was silently collecting nothing.
    expect(
      monitoringCardState(
        { awsMonitoringProfile: 'sso-dev' },
        { profile: 'sso-dev', reachable: false, error: 'ExpiredToken' },
      ),
    ).toBe('unreachable');
  });

  it('reports missing when the probe names the profile as undesignated', () => {
    expect(
      monitoringCardState({ awsMonitoringProfile: 'sso-dev' }, { reason: 'not_designated' }),
    ).toBe('missing');
    expect(
      monitoringCardState(
        { awsMonitoringProfile: 'sso-dev' },
        { code: 'monitoring_profile_required' },
      ),
    ).toBe('missing');
  });

  it('reports ready on a reachable probe', () => {
    expect(
      monitoringCardState({ awsMonitoringProfile: 'mon' }, { profile: 'mon', reachable: true }),
    ).toBe('ready');
  });

  it('does not accuse a project of being unreachable before the probe answers', () => {
    // A probe that has not returned is not evidence of a fault.
    expect(monitoringCardState({ awsMonitoringProfile: 'mon' }, null)).toBe('ready');
    expect(monitoringCardState(null, null)).toBe('missing');
  });

  it('surfaces the probe error as the detail line', () => {
    expect(
      monitoringCardDetail(
        { awsMonitoringProfile: 'mon' },
        { profile: 'mon', reachable: false, error: 'AccessDenied on cloudwatch:DescribeAlarms' },
      ),
    ).toContain('AccessDenied');
  });

  it('names the profile and region when monitoring is healthy', () => {
    expect(
      monitoringCardDetail(null, { profile: 'mon', region: 'eu-west-1', reachable: true }),
    ).toBe('Using mon in eu-west-1.');
  });

  it('falls back to a generic unreachable message when the probe gave no detail', () => {
    expect(
      monitoringCardDetail({ awsMonitoringProfile: 'mon' }, { profile: 'mon', reachable: false }),
    ).toContain('could not be reached');
  });
});

describe('openAlertCountFrom', () => {
  it('uses the total, not the page length', () => {
    // Regression: the badge was `alerts.length`, which is a page size (50 by
    // default, 200 max). A project with 300 open alerts reported "50".
    expect(openAlertCountFrom({ alerts: new Array(50).fill({}), total: 300 } as any)).toBe(300);
  });

  it('reports zero only when the server actually counted zero', () => {
    expect(openAlertCountFrom({ alerts: [], total: 0 } as any)).toBe(0);
  });

  it('returns null rather than 0 when no usable total came back', () => {
    // "Nothing is breaching" must be backed by a count, not by its absence.
    expect(openAlertCountFrom({ alerts: [] } as any)).toBeNull();
    expect(openAlertCountFrom({ total: 'lots' } as any)).toBeNull();
    expect(openAlertCountFrom(null)).toBeNull();
  });
});

describe('runLoadMorePage', () => {
  function harness({ isCurrent = true, ownsInFlight = true } = {}) {
    const calls = {
      appended: [] as any[][],
      cursors: [] as (string | null)[],
      errors: [] as string[],
      loadingMore: [] as boolean[],
    };
    return {
      calls,
      deps: {
        isCurrent: () => isCurrent,
        ownsInFlight: () => ownsInFlight,
        appendResources: (r: any[]) => calls.appended.push(r),
        setNextCursor: (c: string | null) => calls.cursors.push(c),
        setError: (m: string) => calls.errors.push(m),
        setLoadingMore: (v: boolean) => calls.loadingMore.push(v),
      },
    };
  }

  it('still releases the flag when only the list moved on', async () => {
    // Regression 1: guarding the release on the list generation left
    // `loadingMore` stuck true after a filter change landed mid-flight. Nothing
    // else resets it — a refresh sets `loading`, never `loadingMore` — so Load
    // more stayed disabled for the life of the screen. This request was never
    // taken over, so it is still the one that owns the flag.
    const { calls, deps } = harness({ isCurrent: false, ownsInFlight: true });
    await runLoadMorePage({ ...deps, fetchPage: () => Promise.resolve({ resources: [{ a: 1 }] }) });
    expect(calls.loadingMore).toEqual([false]);
  });

  it('releases the flag when a request the list moved past rejects', async () => {
    const { calls, deps } = harness({ isCurrent: false, ownsInFlight: true });
    await runLoadMorePage({ ...deps, fetchPage: () => Promise.reject(new Error('boom')) });
    expect(calls.loadingMore).toEqual([false]);
  });

  it('does not clear a newer page request\'s in-flight flag', async () => {
    // Regression 2: releasing unconditionally let a superseded request clear the
    // flag out from under the request that had taken over — re-enabling Load
    // more mid-load, so a second tap fired a duplicate concurrent request and
    // the spinner vanished while still loading.
    const { calls, deps } = harness({ isCurrent: true, ownsInFlight: false });
    await runLoadMorePage({ ...deps, fetchPage: () => Promise.resolve({ resources: [{ a: 1 }] }) });
    expect(calls.loadingMore).toEqual([]);
  });

  it('does not clear a newer request\'s flag when the taken-over request rejects', async () => {
    const { calls, deps } = harness({ isCurrent: false, ownsInFlight: false });
    await runLoadMorePage({ ...deps, fetchPage: () => Promise.reject(new Error('boom')) });
    expect(calls.loadingMore).toEqual([]);
  });

  it('does not write rows or an error once the list has moved on', async () => {
    const { calls, deps } = harness({ isCurrent: false });
    await runLoadMorePage({ ...deps, fetchPage: () => Promise.resolve({ resources: [{ a: 1 }] }) });
    expect(calls.appended).toEqual([]);
    expect(calls.cursors).toEqual([]);
    const failed = harness({ isCurrent: false });
    await runLoadMorePage({
      ...failed.deps,
      fetchPage: () => Promise.reject(new Error('boom')),
    });
    expect(failed.calls.errors).toEqual([]);
  });

  it('appends the page and advances the cursor when still current', async () => {
    const { calls, deps } = harness();
    await runLoadMorePage({
      ...deps,
      fetchPage: () => Promise.resolve({ resources: [{ a: 1 }], nextCursor: 'c2' }),
    });
    expect(calls.appended).toEqual([[{ a: 1 }]]);
    expect(calls.cursors).toEqual(['c2']);
    expect(calls.loadingMore).toEqual([false]);
  });

  it('surfaces a failure and stops paging when still current', async () => {
    const { calls, deps } = harness();
    await runLoadMorePage({ ...deps, fetchPage: () => Promise.reject(new Error('network down')) });
    expect(calls.errors).toEqual(['network down']);
    expect(calls.loadingMore).toEqual([false]);
  });

  it('treats a malformed page as empty rather than throwing', async () => {
    const { calls, deps } = harness();
    await runLoadMorePage({ ...deps, fetchPage: () => Promise.resolve({}) });
    expect(calls.appended).toEqual([[]]);
    expect(calls.cursors).toEqual([null]);
  });
});

describe('stampMatchesProject', () => {
  it('rejects a response stamped with a different project', () => {
    // Regression: scope/count state used to be unstamped, so between a project
    // switch and the new request settling, the previous project's response was
    // still authoritative. For the scope response that decides whether the
    // Resources / Metrics / Alerts tabs render at all, so the new project could
    // briefly expose the old project's monitoring.
    expect(stampMatchesProject({ projectId: 'p1' }, 'p2')).toBe(false);
  });

  it('accepts a response for the project on screen', () => {
    expect(stampMatchesProject({ projectId: 'p1' }, 'p1')).toBe(true);
  });

  it('rejects an absent stamp or an unresolved project', () => {
    expect(stampMatchesProject(null, 'p1')).toBe(false);
    expect(stampMatchesProject(undefined, 'p1')).toBe(false);
    expect(stampMatchesProject({ projectId: 'p1' }, null)).toBe(false);
    expect(stampMatchesProject({ projectId: 'p1' }, undefined)).toBe(false);
    expect(stampMatchesProject({}, 'p1')).toBe(false);
  });

  it('gates hasScope so a stale scope cannot authorise the new project', () => {
    // End to end: the stale response is rejected by the stamp, so `hasScope`
    // falls back to this project's own metadata rather than the other's scopes.
    const stale = { projectId: 'p1', data: { scopes: [{ enabled: true }] }, error: null };
    const scopeForProject = stampMatchesProject(stale, 'p2') ? stale : null;
    expect(hasConfiguredScope(scopeForProject?.data ?? null, null)).toBe(false);
  });
});

describe('hasConfiguredScope', () => {
  it('prefers the server response over the project metadata guess', () => {
    // The response is authoritative: it reports what is actually stored, where
    // the project field is a caller's guess that can lag a scope deletion.
    expect(hasConfiguredScope({ scopes: [] }, { infraScopeCount: 5 })).toBe(false);
  });

  it('counts only enabled scopes as configured', () => {
    expect(hasConfiguredScope({ scopes: [{ enabled: false }] }, null)).toBe(false);
    expect(hasConfiguredScope({ scopes: [{ enabled: false }, { enabled: true }] }, null)).toBe(true);
  });

  it('treats a scope with no enabled field as enabled', () => {
    expect(hasConfiguredScope({ scopes: [{ service: 'ec2' }] }, null)).toBe(true);
  });

  it('falls back to the configured flag when no scope array came back', () => {
    expect(hasConfiguredScope({ configured: true }, null)).toBe(true);
  });

  it('falls back to project metadata before the response arrives', () => {
    expect(hasConfiguredScope(null, { infraScopeCount: 2 })).toBe(true);
    expect(hasConfiguredScope(null, { infraScopes: [{}] })).toBe(true);
    expect(hasConfiguredScope(null, null)).toBe(false);
  });
});

describe('formatUsd', () => {
  it('never rounds a real cost down to free', () => {
    // A sub-cent projection that renders as "$0.00" reads as "this is free",
    // which is the one thing the cost guardrail must not imply (INFRA-COST).
    expect(formatUsd(0.004)).toBe('<$0.01');
  });

  it('formats ordinary amounts to cents', () => {
    expect(formatUsd(12.5)).toBe('$12.50');
    expect(formatUsd(0)).toBe('$0.00');
  });

  it('renders an absent projection as a dash, not as zero', () => {
    expect(formatUsd(null)).toBe('—');
    expect(formatUsd(undefined)).toBe('—');
    expect(formatUsd(Number.NaN)).toBe('—');
  });
});

describe('spendEmptyCopy', () => {
  it('distinguishes a cache that has never been filled from a genuinely free window', () => {
    // These look identical on screen and mean opposite things: only the first
    // one is worth waiting out.
    expect(spendEmptyCopy(null)).toContain('No spend cached yet');
    expect(spendEmptyCopy({ fetchedAt: null })).toContain('No spend cached yet');
    expect(spendEmptyCopy({ fetchedAt: 1 })).toBe('AWS reported no charges in this window.');
  });

  it('says how long the first sync can take, because it is hours not seconds', () => {
    expect(spendEmptyCopy(null)).toContain('24 hours');
  });
});

describe('spendServiceRows', () => {
  const trend = {
    topServices: [
      { service: 'AmazonEC2', amountUsd: 18 },
      { service: 'AmazonRDS', amountUsd: 9 },
    ],
    totalUsd: 30,
  } as any;

  it('appends the truncated tail so the list cannot understate the bill', () => {
    const rows = spendServiceRows(trend);
    expect(rows.map((r) => r.label)).toEqual(['AmazonEC2', 'AmazonRDS', 'Other services']);
    expect(rows[2].amountUsd).toBeCloseTo(3);
  });

  it('omits the tail when the ranked list is the whole bill', () => {
    expect(spendServiceRows({ ...trend, totalUsd: 27 }).map((r) => r.key)).toEqual([
      'AmazonEC2',
      'AmazonRDS',
    ]);
  });

  it('never invents a tail from float drift', () => {
    const drifting = {
      topServices: [
        { service: 'a', amountUsd: 0.1 },
        { service: 'b', amountUsd: 0.2 },
      ],
      totalUsd: 0.3,
    } as any;
    expect(spendServiceRows(drifting)).toHaveLength(2);
  });

  it('returns nothing for an absent or empty response', () => {
    expect(spendServiceRows(null)).toEqual([]);
    expect(spendServiceRows({ topServices: [], totalUsd: 0 } as any)).toEqual([]);
  });
});

describe('buildSpendOptInConfirm', () => {
  it('puts the price in the dialog, not only in the copy behind it', () => {
    const confirm = buildSpendOptInConfirm({ enabling: true, onConfirm: () => {} });
    expect(confirm.title).toContain('Turn on');
    expect(confirm.message).toContain('$0.01 per paginated request');
    expect(confirm.message).toContain('no free tier');
    expect(confirm.message).toContain('at most 3 times a day');
  });

  it('does not warn about cost when the operator is stopping the spend', () => {
    const confirm = buildSpendOptInConfirm({ enabling: false, onConfirm: () => {} });
    expect(confirm.title).toContain('Turn off');
    expect(confirm.message).not.toContain('$0.01');
    expect(confirm.message).toContain('Cached figures stay');
  });

  it('bills nothing without an explicit confirm tap', () => {
    const onConfirm = vi.fn();
    const confirm = buildSpendOptInConfirm({ enabling: true, onConfirm });
    expect(onConfirm).not.toHaveBeenCalled();
    expect(confirm.buttons[0]).toMatchObject({ text: 'Cancel', style: 'cancel' });
    confirm.buttons[1].onPress();
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});

describe('empty-state copy', () => {
  it('blames the filters only when a narrowing filter is set', () => {
    expect(resourcesEmptyCopy(EMPTY_FILTERS)).toContain('Inventory sync');
    expect(resourcesEmptyCopy({ ...EMPTY_FILTERS, service: 'ec2' })).toContain('filters');
  });

  it('names the status filter in force so an empty list is explicable', () => {
    expect(alertsEmptyCopy('open')).toBe('No open alerts.');
    expect(alertsEmptyCopy('resolved')).toBe('No resolved alerts.');
    expect(alertsEmptyCopy('ignored')).toBe('No ignored alerts.');
    expect(alertsEmptyCopy('all')).toBe('No alerts recorded yet.');
  });
});

describe('notification-tap alert targeting', () => {
  it('opens on the unfiltered list when arriving from a notification', () => {
    // Regression: the tap used to land on the default `open` filter. An alert
    // resolved or ignored between the push being sent and the banner being
    // tapped is excluded from that list, so the user could not find the alert
    // they had just tapped.
    expect(initialAlertStatusFilter('alert-1')).toBe('all');
  });

  it('keeps the open filter for ordinary browsing', () => {
    expect(initialAlertStatusFilter(null)).toBe('open');
    expect(initialAlertStatusFilter(undefined)).toBe('open');
    expect(initialAlertStatusFilter('')).toBe('open');
  });

  const rows = (...ids: string[]) =>
    joinAlertsToRules(
      ids.map((id) => ({ id, ruleId: 'r1', status: 'open', state: 'ALARM', lastSeen: 0 }) as any),
      [{ id: 'r1', name: 'rule', severity: 'warning' }],
    );

  it('pins a focused alert that is missing from the page', () => {
    // The status filter is only half the fix: the list is a bounded page, so an
    // older alert can be absent even under `all`.
    const merged = mergeFocusedAlert(rows('a', 'b'), rows('z')[0]);
    expect(merged.map((r) => r.alert.id)).toEqual(['z', 'a', 'b']);
  });

  it('does not duplicate a focused alert already in the page', () => {
    const listed = rows('a', 'b');
    const merged = mergeFocusedAlert(listed, listed[1]);
    expect(merged.map((r) => r.alert.id)).toEqual(['a', 'b']);
  });

  it('is a no-op when nothing is focused', () => {
    expect(mergeFocusedAlert(rows('a'), null).map((r) => r.alert.id)).toEqual(['a']);
  });

  it('does not mutate the list it was given', () => {
    const listed = rows('a');
    mergeFocusedAlert(listed, rows('z')[0]);
    expect(listed.map((r) => r.alert.id)).toEqual(['a']);
  });
});

describe('buildAlertActionConfirm', () => {
  it('does not run the action until the confirm button is pressed', () => {
    const onConfirm = vi.fn();
    const { buttons } = buildAlertActionConfirm({ label: 'Resolve', ruleName: 'CPU', onConfirm });
    expect(onConfirm).not.toHaveBeenCalled();
    expect(buttons[0]).toMatchObject({ text: 'Cancel', style: 'cancel' });
    buttons[1].onPress();
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('spells out that ignore survives recurrence', () => {
    const { message } = buildAlertActionConfirm({
      label: 'Ignore',
      ruleName: 'CPU',
      onConfirm: () => {},
    });
    expect(message).toContain('recurs');
  });

  it('names the rule in the prompt so the wrong alert is not confirmed', () => {
    const { title, message } = buildAlertActionConfirm({
      label: 'Resolve',
      ruleName: 'NAT port allocation',
      onConfirm: () => {},
    });
    expect(title).toBe('Resolve alert?');
    expect(message).toContain('NAT port allocation');
  });
});

describe('ServiceNotes', () => {
  const emptyPack: InfraServicePackWire = {
    service: 'ec2',
    label: 'EC2',
    metrics: [],
    dimensions: [],
    absentMetrics: [],
    features: [],
    defaultAlertRules: [],
  };

  const ec2Pack: InfraServicePackWire = {
    ...emptyPack,
    metrics: [
      {
        namespace: 'AWS/EC2',
        metricName: 'CPUCreditBalance',
        dimensions: ['InstanceId'],
        metricType: 'balance',
        stat: 'Minimum',
        validStatistics: ['Sum', 'Average', 'Minimum', 'Maximum'],
        minPeriodSeconds: 300,
        availability: 'either',
        appliesTo: { universal: false, condition: 'Burstable (T-family) instances only.' },
        requiresFeature: null,
        description: 'CPU credits accrued and unspent.',
      },
    ],
    absentMetrics: [
      {
        label: 'Memory utilization',
        reason: 'EC2 has no memory metric. The hypervisor cannot see inside the guest.',
        remedy: 'Install the CloudWatch agent; it publishes memory to the CWAgent namespace.',
      },
    ],
    defaultAlertRules: [
      {
        name: 'EC2 status check failed',
        description: 'Two consecutive failed minutes.',
        namespace: 'AWS/EC2',
        metricName: 'StatusCheckFailed',
        stat: 'Maximum',
        dimensions: ['InstanceId'],
        periodS: 60,
        threshold: 1,
        comparisonOperator: 'GreaterThanOrEqualToThreshold',
        evaluationPeriods: 2,
        datapointsToAlarm: 2,
        treatMissingData: 'missing',
        severity: 'critical',
        rationale: 'AWS best-practice alarm.',
      },
    ],
  };

  it('renders nothing without a pack', () => {
    expect(ServiceNotes({ pack: null })).toBeNull();
  });

  it('renders nothing for a pack with no caveats and no rules to show', () => {
    // A bare card of headings with no content under them is noise.
    expect(ServiceNotes({ pack: emptyPack })).toBeNull();
  });

  it('renders the panel once the pack has something to say', () => {
    expect(ServiceNotes({ pack: ec2Pack })).not.toBeNull();
  });

  it('renders the panel for the recommended rules even when nothing else applies', () => {
    const rulesOnly = { ...emptyPack, defaultAlertRules: ec2Pack.defaultAlertRules };
    expect(ServiceNotes({ pack: rulesOnly, showDefaultRules: true })).not.toBeNull();
    // …but the Metrics tab, which does not show rules, still gets nothing.
    expect(ServiceNotes({ pack: rulesOnly })).toBeNull();
  });

  describe('paid feature notices — parity with the web panel', () => {
    const ecsPack: InfraServicePackWire = {
      service: 'ecs',
      label: 'ECS',
      metrics: [
        {
          namespace: 'ECS/ContainerInsights',
          metricName: 'RunningTaskCount',
          dimensions: ['ClusterName', 'ServiceName'],
          metricType: 'gauge',
          stat: 'Minimum',
          validStatistics: ['Average', 'Minimum', 'Maximum'],
          minPeriodSeconds: 60,
          availability: 'either',
          appliesTo: { universal: true, condition: '' },
          requiresFeature: 'containerInsights',
          description: 'Tasks running.',
        },
      ],
      dimensions: [],
      absentMetrics: [],
      features: [
        {
          key: 'containerInsights',
          label: 'Container Insights',
          whenOff: 'The ECS/ContainerInsights metrics are not published for this cluster.',
          costNote: 'AWS charges Container Insights metrics as CloudWatch custom metrics.',
          docsUrl: 'https://docs.aws.amazon.com/AmazonECS/latest/developerguide/x.html',
        },
      ],
      defaultAlertRules: [],
    };

    /**
     * Every string the rendered tree puts on screen, flattened.
     *
     * Children are concatenated with nothing between them, which is what React
     * itself does: `{feature.label} is off for this resource` compiles to two
     * adjacent children, and joining them with a space would invent a double
     * space that is nowhere in the rendered output. Whitespace is then
     * collapsed, so an assertion is about the words on screen rather than about
     * how the markup happens to be split across interpolations.
     */
    function textOf(node: unknown): string {
      if (node === null || node === undefined || typeof node === 'boolean') return '';
      if (typeof node === 'string' || typeof node === 'number') return String(node);
      if (Array.isArray(node)) return node.map(textOf).join('');
      const props = (node as { props?: { children?: unknown } }).props;
      return props ? textOf(props.children) : '';
    }

    /** {@link textOf} with runs of whitespace collapsed to single spaces. */
    const rendered = (node: unknown): string => textOf(node).replace(/\s+/g, ' ').trim();

    it('names the feature, what it hides, and what it costs', () => {
      // The web panel says exactly this; an operator must not read one story on
      // the desktop and a different one on the phone.
      const text = rendered(
        ServiceNotes({ pack: ecsPack, resource: { features: { containerInsights: false } } }),
      );
      expect(text).toContain('Container Insights is off for this resource');
      expect(text).toContain('not published for this cluster');
      expect(text).toContain('custom metrics');
      expect(text).toContain('RunningTaskCount');
    });

    it('says nothing once the feature is on', () => {
      const text = rendered(
        ServiceNotes({ pack: ecsPack, resource: { features: { containerInsights: true } } }),
      );
      expect(text).not.toContain('Container Insights is off');
      // Nothing else in this pack has anything to say, so the card collapses.
      expect(
        ServiceNotes({ pack: ecsPack, resource: { features: { containerInsights: true } } }),
      ).toBeNull();
    });

    it('treats an unrecorded feature as off, matching the collector', () => {
      const text = rendered(ServiceNotes({ pack: ecsPack, resource: { service: 'ecs' } }));
      expect(text).toContain('Container Insights is off for this resource');
    });

    it('claims nothing with no resource selected', () => {
      expect(ServiceNotes({ pack: ecsPack })).toBeNull();
    });
  });
});

describe('spendStateAfterFailure', () => {
  const trend = {
    enabled: true,
    syncedAt: 1,
    windowStartDay: '2026-07-09',
    windowEndDay: '2026-08-08',
    days: [{ day: '2026-08-01', amountUsd: 4, estimated: false }],
    topServices: [{ service: 'Amazon EC2', amountUsd: 4 }],
    accounts: [],
    totalUsd: 4,
    unit: 'USD',
    fetchedAt: 2,
    lastRun: null,
  };

  it('keeps the last confirmed figures when a refresh fails', () => {
    // The regression this pins. The section polls every 60s over a mobile
    // connection, and the numbers are a cache the server refreshes at most
    // three times a day: one dropped request must not blank a bill that is
    // still exactly as true as it was a second earlier.
    const next = spendStateAfterFailure({ projectId: 'p1', data: trend, error: null }, 'p1', 'off');
    expect(next.data).toBe(trend);
    expect(next.error).toBe('off');
  });

  it('leaves the stale banner reachable, which blanking the data would not', () => {
    // The section renders "showing the last confirmed figures" only when an
    // error and data coexist. Nulling the data made that branch dead code.
    const next = spendStateAfterFailure({ projectId: 'p1', data: trend, error: null }, 'p1', 'off');
    expect(next.data && next.error).toBeTruthy();
  });

  it('does not carry another project’s bill forward as if it were stale', () => {
    const next = spendStateAfterFailure({ projectId: 'other', data: trend, error: null }, 'p1', 'x');
    expect(next.data).toBeNull();
    expect(next.projectId).toBe('p1');
  });

  it('reports the error alone when nothing was ever loaded', () => {
    expect(spendStateAfterFailure(null, 'p1', 'boom')).toEqual({
      projectId: 'p1',
      data: null,
      error: 'boom',
    });
  });

  it('falls back to a readable message when the error carries none', () => {
    expect(spendStateAfterFailure(null, 'p1', undefined).error).toBe('Spend could not be loaded.');
    expect(spendStateAfterFailure(null, 'p1', '').error).toBe('Spend could not be loaded.');
  });

  it('keeps figures across repeated failures rather than losing them on the second', () => {
    let state = spendStateAfterFailure({ projectId: 'p1', data: trend, error: null }, 'p1', 'a');
    state = spendStateAfterFailure(state, 'p1', 'b');
    state = spendStateAfterFailure(state, 'p1', 'c');
    expect(state.data).toBe(trend);
    expect(state.error).toBe('c');
  });
});

describe('createRequestGeneration', () => {
  it('applies a response when nothing newer has started', () => {
    const gen = createRequestGeneration();
    const token = gen.begin();
    expect(gen.isCurrent(token)).toBe(true);
  });

  it('discards a response that a later request has superseded', () => {
    // The regression this pins. Two reads settle out of order across a project
    // switch: without the guard the slow first response stamps the state with
    // the previous project's id, `stampMatchesProject` reads it as "not mine",
    // and the section renders a spinner that nothing retriggers a fetch to
    // clear.
    const gen = createRequestGeneration();
    const first = gen.begin();
    const second = gen.begin();

    // The newer request settles first, then the older one.
    expect(gen.isCurrent(second)).toBe(true);
    expect(gen.isCurrent(first)).toBe(false);
  });

  it('keeps only the newest of several overlapping requests', () => {
    const gen = createRequestGeneration();
    const tokens = [gen.begin(), gen.begin(), gen.begin(), gen.begin()];
    expect(tokens.filter((t) => gen.isCurrent(t))).toEqual([tokens[tokens.length - 1]]);
  });

  it('never treats a token it did not issue as current', () => {
    const gen = createRequestGeneration();
    gen.begin();
    expect(gen.isCurrent(0)).toBe(false);
    expect(gen.isCurrent(99)).toBe(false);
  });

  it('gives two sections independent counters', () => {
    // Each SpendSection instance owns its own, so one project's poll cannot
    // invalidate another mounted section's in-flight read.
    const a = createRequestGeneration();
    const b = createRequestGeneration();
    const tokenA = a.begin();
    b.begin();
    expect(a.isCurrent(tokenA)).toBe(true);
  });

  it('composes with spendStateAfterFailure to keep the old project out of the state', () => {
    // The two halves of the same invariant: the guard drops a superseded
    // response, and the failure merge refuses to carry another project's
    // figures forward. Neither alone keeps the section honest across a switch.
    const gen = createRequestGeneration();
    const stale = gen.begin();
    gen.begin();

    expect(gen.isCurrent(stale)).toBe(false);
    const merged = spendStateAfterFailure({ projectId: 'p1', data: null, error: null }, 'p2', 'x');
    expect(merged.projectId).toBe('p2');
    expect(merged.data).toBeNull();
  });
});

describe('runSpendToggle', () => {
  /** A toggle harness with both guards wired to mutable owners, like the component. */
  function harness() {
    const calls = { applied: [] as any[], errors: [] as string[], saving: [] as boolean[] };
    let current = true;
    let owns = true;
    return {
      calls,
      supersedeState: () => {
        current = false;
      },
      takeOverSaving: () => {
        owns = false;
      },
      run: (save: () => Promise<any>) =>
        runSpendToggle({
          save,
          isCurrent: () => current,
          ownsSaving: () => owns,
          applyResponse: (r) => calls.applied.push(r),
          notifyError: (m) => calls.errors.push(m),
          setSaving: (v) => calls.saving.push(v),
        }),
    };
  }

  it('applies the response and releases the flag on a clean save', async () => {
    const h = harness();
    await h.run(() => Promise.resolve({ enabled: true }));
    expect(h.calls.applied).toEqual([{ enabled: true }]);
    expect(h.calls.saving).toEqual([false]);
  });

  it('releases the flag even when a poll superseded the state write', async () => {
    // The stranding case. The read generation advances on every 60s poll, so
    // guarding the release on it would leave the switch disabled for the life
    // of the screen whenever a refresh landed mid-save.
    const h = harness();
    h.supersedeState();
    await h.run(() => Promise.resolve({ enabled: true }));
    expect(h.calls.applied).toEqual([]);
    expect(h.calls.saving).toEqual([false]);
  });

  it('does not clear a flag another toggle has taken over', async () => {
    // The clobber case. Switch project mid-save, toggle on the new project, and
    // an unconditional release re-enables the switch under an in-flight write,
    // so a second tap fires a duplicate concurrent request.
    const h = harness();
    h.takeOverSaving();
    await h.run(() => Promise.resolve({ enabled: true }));
    expect(h.calls.saving).toEqual([]);
  });

  it('releases the flag when the save fails', async () => {
    const h = harness();
    await h.run(() => Promise.reject(new Error('nope')));
    expect(h.calls.errors).toEqual(['nope']);
    expect(h.calls.saving).toEqual([false]);
  });

  it('stays silent about a failure on a project the operator already left', async () => {
    // A modal about a decision they have moved on from is noise.
    const h = harness();
    h.takeOverSaving();
    await h.run(() => Promise.reject(new Error('nope')));
    expect(h.calls.errors).toEqual([]);
    expect(h.calls.saving).toEqual([]);
  });

  it('falls back to a readable message when the failure carries none', async () => {
    const h = harness();
    await h.run(() => Promise.reject(new Error('')));
    expect(h.calls.errors).toEqual(['The Cost Explorer setting could not be saved.']);
  });

  it('never rejects, so no caller needs its own catch', async () => {
    const h = harness();
    await expect(h.run(() => Promise.reject(new Error('boom')))).resolves.toBeUndefined();
  });

  it('lets a superseded save settle without disturbing the newer one', async () => {
    // The full sequence the reviewer described: A pending, switch to B, B saves,
    // then A settles. B must still be saving afterwards.
    const stale = harness();
    stale.supersedeState();
    stale.takeOverSaving();
    const fresh = harness();

    const freshDone = fresh.run(() => Promise.resolve({ enabled: true }));
    await stale.run(() => Promise.resolve({ enabled: false }));
    expect(stale.calls.saving).toEqual([]);
    expect(stale.calls.applied).toEqual([]);

    await freshDone;
    expect(fresh.calls.saving).toEqual([false]);
  });
});

describe('quota headroom section', () => {
  it('says what it hid rather than truncating silently', () => {
    // The list is sorted tightest-first, so an operator who cannot see it was
    // cut would read the last visible row as the healthiest in the account.
    expect(quotaTruncationNote(QUOTA_VISIBLE_ROWS)).toBeNull();
    expect(quotaTruncationNote(QUOTA_VISIBLE_ROWS - 1)).toBeNull();
    expect(quotaTruncationNote(QUOTA_VISIBLE_ROWS + 1)).toMatch(/^1 more quota not shown\./);
    expect(quotaTruncationNote(QUOTA_VISIBLE_ROWS + 3)).toMatch(/^3 more quotas not shown\./);
  });

  it('explains that the hidden rows are the healthy ones', () => {
    expect(quotaTruncationNote(QUOTA_VISIBLE_ROWS + 2)).toMatch(/tightest-first/);
    expect(quotaTruncationNote(QUOTA_VISIBLE_ROWS + 2)).toMatch(/most headroom/);
  });

  it('shows fewer rows than web, because the phone rows are taller', () => {
    // Web shows 8. Both cut the same sorted list, so the shorter phone cut
    // still shows everything that needs action.
    expect(QUOTA_VISIBLE_ROWS).toBeLessThan(8);
    expect(QUOTA_VISIBLE_ROWS).toBeGreaterThan(0);
  });

  it('gives each band a distinct colour, with unknown visibly muted', () => {
    // An unmeasured quota must not look like a healthy one.
    const tones = Object.values(QUOTA_TONE_COLOR);
    expect(new Set(tones).size).toBe(tones.length);
    expect(QUOTA_TONE_COLOR.muted).not.toBe(QUOTA_TONE_COLOR.good);
  });
});

describe('quota refresh failures on mobile', () => {
  const NOW = 1_700_000_000_000;

  it('labels retained readings as stale rather than dropping or silently keeping them', () => {
    // Mobile previously cleared `data` on any failed poll, blanking the panel
    // on a transient blip; web previously kept it with no indication at all.
    // Both are wrong in opposite directions, and both platforms now use this
    // one helper so they cannot diverge again.
    const note = quotaRefreshFailureNote('timeout', NOW - 5 * 60_000, NOW)!;
    expect(note).toContain('Refresh failed: timeout');
    expect(note).toContain('5m ago');
  });

  it('says nothing when the last poll succeeded', () => {
    expect(quotaRefreshFailureNote(null, NOW, NOW)).toBeNull();
  });
});

describe('AWS Health severity and status styling', () => {
  it('gives each severity a distinct colour', () => {
    const values = Object.values(HEALTH_SEVERITY_COLOR);
    expect(new Set(values).size).toBe(values.length);
  });

  it('has a colour for every severity the normalizer can produce', () => {
    for (const raw of ['critical', 'warning', 'info', 'not-a-severity', null, undefined]) {
      expect(HEALTH_SEVERITY_COLOR[normalizeHealthSeverity(raw)]).toBeTruthy();
    }
  });

  it('has a pill style for every status the formatter can produce', () => {
    for (const raw of ['open', 'closed', 'upcoming']) {
      expect(HEALTH_STATUS_STYLE[formatHealthStatus(raw)!]).toBeTruthy();
    }
  });

  it('falls back to the neutral pill for a status AWS invents later', () => {
    const unknown = formatHealthStatus('some-new-status')!;
    expect(HEALTH_STATUS_STYLE[unknown] ?? HEALTH_STATUS_STYLE.CLOSED).toBe(
      HEALTH_STATUS_STYLE.CLOSED,
    );
  });

  it('draws an open event apart from a closed one', () => {
    expect(HEALTH_STATUS_STYLE.OPEN.color).not.toBe(HEALTH_STATUS_STYLE.CLOSED.color);
  });
});

describe('AWS Health empty states on the Overview tab', () => {
  // The section renders one of these two whenever `events` is empty, and which
  // one it is decides whether the operator goes and creates an EventBridge rule
  // or does nothing at all.
  it('distinguishes an unwired ingest from a quiet account', () => {
    expect(healthEmptyState(false).testID).toBe('infra-health-not-configured');
    expect(healthEmptyState(true).testID).toBe('infra-health-empty');
  });
});
