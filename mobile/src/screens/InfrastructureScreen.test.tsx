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
  },
}));

import {
  ServiceNotes,
  TABS,
  alertsEmptyCopy,
  buildAlertActionConfirm,
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
  stampMatchesProject,
} from './InfrastructureScreen';
import { EMPTY_FILTERS } from '../utils/infraResources';
import type { InfraServicePackWire } from '@shared/utils/infraPacks';
import { joinAlertsToRules } from '@shared/utils/infraAlerts';

describe('TABS', () => {
  it('matches the web module tab set and order', () => {
    expect(TABS.map((t) => t.key)).toEqual(['overview', 'resources', 'metrics', 'alerts']);
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
