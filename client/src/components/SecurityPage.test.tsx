import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useState } from 'react';
import { render, screen, waitFor, act, fireEvent, within } from '@testing-library/react';
import SecurityPage, { sortFindings, openCriticalHigh, countBySeverity } from './SecurityPage';
import { api } from '../utils/api';

(vi as any).mock('../utils/api.js', () => ({
  api: {
    getSecurityFindings: vi.fn(),
    dismissSecurityFinding: vi.fn(),
    runSecurityScan: vi.fn(),
    fixSecurityFinding: vi.fn(),
    fixAllSecurityFindings: vi.fn(),
    getProject: vi.fn(),
    updateProject: vi.fn(),
  },
}));

function finding(overrides: any = {}) {
  return {
    id: overrides.id || 'f1',
    project_id: 'proj-1',
    ecosystem: 'npm',
    package_name: 'lodash',
    package_version: '4.17.11',
    advisory_id: 'GHSA-jf85-cpcp-j695',
    severity: 'high',
    summary: 'Prototype pollution in lodash',
    fixed_version: '4.17.12',
    advisory_url: 'https://github.com/advisories/GHSA-jf85-cpcp-j695',
    manifest_path: 'package-lock.json',
    status: 'open',
    first_seen_at: 1700000000000,
    last_seen_at: 1700000000000,
    scan_ref: 'abc123',
    ...overrides,
  };
}

const counts = (o: any = {}) => ({ critical: 0, high: 0, medium: 0, low: 0, unknown: 0, ...o });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('sortFindings', () => {
  it('orders by severity (critical → unknown) then most-recently-seen first', () => {
    const sorted = sortFindings([
      finding({ id: 'low', severity: 'low', last_seen_at: 5 }),
      finding({ id: 'crit', severity: 'critical', last_seen_at: 1 }),
      finding({ id: 'high', severity: 'high', last_seen_at: 2 }),
      finding({ id: 'med-old', severity: 'medium', last_seen_at: 1 }),
      finding({ id: 'med-new', severity: 'medium', last_seen_at: 9 }),
      finding({ id: 'unk', severity: 'unknown', last_seen_at: 3 }),
    ]);
    expect(sorted.map((f: any) => f.id)).toEqual([
      'crit',
      'high',
      'med-new',
      'med-old',
      'low',
      'unk',
    ]);
  });
});

describe('openCriticalHigh', () => {
  it('sums open critical and high counts and tolerates null', () => {
    expect(openCriticalHigh(counts({ critical: 2, high: 3, medium: 9 }))).toBe(5);
    expect(openCriticalHigh(null)).toBe(0);
  });
});

describe('countBySeverity', () => {
  it('tallies each severity category plus an all total, bucketing unknowns', () => {
    const counts = countBySeverity([
      finding({ severity: 'critical' }),
      finding({ severity: 'high' }),
      finding({ severity: 'high' }),
      finding({ severity: 'low' }),
      finding({ severity: 'weird' }),
      finding({ severity: undefined }),
    ]);
    expect(counts).toEqual({ critical: 1, high: 2, medium: 0, low: 1, unknown: 2, all: 6 });
  });

  it('returns a zeroed map for a non-array', () => {
    expect(countBySeverity(null)).toEqual({
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
      unknown: 0,
      all: 0,
    });
  });
});

describe('SecurityPage', () => {
  it('shows a per-severity count on each severity filter chip', async () => {
    (api.getSecurityFindings as any).mockResolvedValue({
      findings: [
        finding({ id: 'c', severity: 'critical' }),
        finding({ id: 'h1', severity: 'high' }),
        finding({ id: 'h2', severity: 'high' }),
        finding({ id: 'l', severity: 'low' }),
      ],
      openCounts: counts({ critical: 1, high: 2, low: 1 }),
    });

    render(<SecurityPage projectId="proj-1" refreshNonce={0} />);
    await waitFor(() => expect(screen.getAllByTestId('security-finding-card')).toHaveLength(4));

    expect(screen.getByTestId('severity-count-all')).toHaveTextContent('4');
    expect(screen.getByTestId('severity-count-critical')).toHaveTextContent('1');
    expect(screen.getByTestId('severity-count-high')).toHaveTextContent('2');
    expect(screen.getByTestId('severity-count-medium')).toHaveTextContent('0');
    expect(screen.getByTestId('severity-count-low')).toHaveTextContent('1');
  });

  it('renders findings severity-first with package@version, advisory link and fix', async () => {
    (api.getSecurityFindings as any).mockResolvedValue({
      findings: [
        finding({
          id: 'crit',
          severity: 'critical',
          package_name: '@scope/pkg',
          package_version: '1.0.0',
          summary: 'Remote code execution',
          fixed_version: '1.0.1',
          last_seen_at: 10,
        }),
        finding({
          id: 'nofix',
          severity: 'low',
          package_name: 'left-pad',
          package_version: '1.1.0',
          fixed_version: null,
          last_seen_at: 20,
        }),
      ],
      openCounts: counts({ critical: 1, low: 1 }),
    });

    render(<SecurityPage projectId="proj-1" refreshNonce={0} />);

    await waitFor(() => expect(screen.getAllByTestId('security-finding-card')).toHaveLength(2));

    const cards = screen.getAllByTestId('security-finding-card');
    // Critical sorts above low regardless of last_seen_at.
    expect(cards[0]).toHaveAttribute('data-severity', 'critical');
    expect(within(cards[0]).getByTestId('finding-package')).toHaveTextContent('@scope/pkg@1.0.0');
    expect(within(cards[0]).getByTestId('finding-fix')).toHaveTextContent('upgrade to 1.0.1');
    expect(within(cards[0]).getByTestId('advisory-link')).toHaveAttribute(
      'href',
      'https://github.com/advisories/GHSA-jf85-cpcp-j695',
    );
    expect(within(cards[1]).getByTestId('finding-fix')).toHaveTextContent('No fix published yet');
  });

  it('lifts openCounts to the parent and shows the critical/high header badge', async () => {
    (api.getSecurityFindings as any).mockResolvedValue({
      findings: [finding({ severity: 'critical' })],
      openCounts: counts({ critical: 1, high: 2 }),
    });
    const onOpenCounts = vi.fn();

    render(<SecurityPage projectId="proj-1" refreshNonce={0} onOpenCounts={onOpenCounts} />);

    await waitFor(() => expect(onOpenCounts!).toHaveBeenCalled());
    expect(onOpenCounts!).toHaveBeenCalledWith(expect.objectContaining({ critical: 1, high: 2 }));
    expect(screen.getByTestId('security-header-badge')).toHaveTextContent('3 open critical/high');
  });

  it('does not refetch in a loop when the parent passes a fresh onOpenCounts identity each render', async () => {
    // Regression: App passes an inline onOpenCounts whose identity changes every
    // render and whose call sets parent state (→ re-render). If `load` depended
    // on that callback identity, the effect would re-fire and refetch forever.
    (api.getSecurityFindings as any).mockResolvedValue({
      findings: [],
      openCounts: counts({ high: 1 }),
    });

    function Parent() {
      const [, setLifted] = useState<any>(null);
      // New inline callback identity on every render, mirroring App.jsx.
      return (
        <SecurityPage projectId="proj-1" refreshNonce={0} onOpenCounts={(c: any) => setLifted(c)} />
      );
    }

    render(<Parent />);
    await waitFor(() => expect(api.getSecurityFindings).toHaveBeenCalled());
    // Give any erroneous refetch loop a chance to fire additional calls.
    await act(async () => {
      await new Promise((r: any) => setTimeout(r, 50));
    });
    expect(api.getSecurityFindings).toHaveBeenCalledTimes(1);
  });

  it('dismisses a finding: two-step confirm, calls the API, and drops the row', async () => {
    (api.getSecurityFindings as any).mockResolvedValue({
      findings: [finding({ id: 'f1' })],
      openCounts: counts({ high: 1 }),
    });
    (api.dismissSecurityFinding as any).mockResolvedValue({
      ...finding({ id: 'f1' }),
      status: 'dismissed',
    });

    render(<SecurityPage projectId="proj-1" refreshNonce={0} />);
    await waitFor(() => expect(screen.getByTestId('security-finding-card')).toBeInTheDocument());

    // Arm, then confirm.
    fireEvent.click(screen.getByText('Dismiss' as any) as any);
    (api.getSecurityFindings as any).mockResolvedValue({ findings: [], openCounts: counts() });
    await act(async () => {
      fireEvent.click(screen.getByText('Confirm' as any) as any);
    });

    expect(api.dismissSecurityFinding).toHaveBeenCalledWith('proj-1', 'f1');
    await waitFor(() =>
      expect(screen.queryByTestId('security-finding-card')).not.toBeInTheDocument(),
    );
  });

  it('queries the server with the selected status filter', async () => {
    (api.getSecurityFindings as any).mockResolvedValue({ findings: [], openCounts: counts() });
    render(<SecurityPage projectId="proj-1" refreshNonce={0} />);
    await waitFor(() => expect(api.getSecurityFindings).toHaveBeenCalledWith('proj-1', 'open'));

    await act(async () => {
      fireEvent.click(screen.getByTestId('status-filter-dismissed' as any) as any);
    });
    await waitFor(() =>
      expect(api.getSecurityFindings).toHaveBeenCalledWith('proj-1', 'dismissed'),
    );

    // "All" sends no status filter.
    await act(async () => {
      fireEvent.click(screen.getByTestId('status-filter-all' as any) as any);
    });
    await waitFor(() => expect(api.getSecurityFindings).toHaveBeenCalledWith('proj-1', undefined));
  });

  it('shows an empty state when there are no findings', async () => {
    (api.getSecurityFindings as any).mockResolvedValue({ findings: [], openCounts: counts() });
    render(<SecurityPage projectId="proj-1" refreshNonce={0} />);
    await waitFor(() => expect(screen.getByText('No security findings')).toBeInTheDocument());
  });

  it('Rescan triggers a plain scan (autoPr:false) and refetches findings', async () => {
    (api.getSecurityFindings as any).mockResolvedValue({ findings: [], openCounts: counts() });
    (api.runSecurityScan as any).mockResolvedValue({ newFindings: 0, reopened: 0, autoPr: null });
    const onNotify = vi.fn();
    render(<SecurityPage projectId="proj-1" refreshNonce={0} onNotify={onNotify} />);
    await waitFor(() => expect(api.getSecurityFindings).toHaveBeenCalledTimes(1));

    await act(async () => {
      fireEvent.click(screen.getByTestId('security-rescan'));
    });

    expect(api.runSecurityScan).toHaveBeenCalledWith('proj-1', { autoPr: false });
    // Refetched after the scan resolved.
    await waitFor(() => expect(api.getSecurityFindings).toHaveBeenCalledTimes(2));
    expect(onNotify).toHaveBeenCalledWith(expect.stringContaining('Rescan complete'), 'success');
  });

  it('Autofix triggers a scan with autoPr:true and reports the dispatched session', async () => {
    (api.getSecurityFindings as any).mockResolvedValue({ findings: [], openCounts: counts() });
    (api.runSecurityScan as any).mockResolvedValue({
      fixSession: { sessionId: 'sess-1', agentId: 'dev-1', findingCount: 2 },
    });
    const onNotify = vi.fn();
    render(<SecurityPage projectId="proj-1" refreshNonce={0} onNotify={onNotify} />);
    await waitFor(() => expect(api.getSecurityFindings).toHaveBeenCalled());

    await act(async () => {
      fireEvent.click(screen.getByTestId('security-autofix'));
    });

    expect(api.runSecurityScan).toHaveBeenCalledWith('proj-1', { autoPr: true });
    expect(onNotify).toHaveBeenCalledWith(
      expect.stringContaining('started a session to resolve 2 dependencies'),
      'success',
    );
  });

  it('Autofix surfaces fixSessionError as an error, not a false no-op', async () => {
    (api.getSecurityFindings as any).mockResolvedValue({ findings: [], openCounts: counts() });
    (api.runSecurityScan as any).mockResolvedValue({
      fixSession: null,
      fixSessionError: 'No agent is available to resolve security findings for this project.',
    });
    const onNotify = vi.fn();
    render(<SecurityPage projectId="proj-1" refreshNonce={0} onNotify={onNotify} />);
    await waitFor(() => expect(api.getSecurityFindings).toHaveBeenCalled());

    await act(async () => {
      fireEvent.click(screen.getByTestId('security-autofix'));
    });

    expect(onNotify).toHaveBeenCalledWith(
      expect.stringContaining('No agent is available'),
      'error',
    );
  });

  it('surfaces a scan failure via onNotify', async () => {
    (api.getSecurityFindings as any).mockResolvedValue({ findings: [], openCounts: counts() });
    (api.runSecurityScan as any).mockRejectedValue(new Error('not hosted'));
    const onNotify = vi.fn();
    render(<SecurityPage projectId="proj-1" refreshNonce={0} onNotify={onNotify} />);
    await waitFor(() => expect(api.getSecurityFindings).toHaveBeenCalled());

    await act(async () => {
      fireEvent.click(screen.getByTestId('security-rescan'));
    });

    expect(onNotify).toHaveBeenCalledWith('not hosted', 'error');
  });

  it('per-finding Fix dispatches a session and reports it via onNotify', async () => {
    (api.getSecurityFindings as any).mockResolvedValue({
      findings: [finding({ id: 'f1' })],
      openCounts: counts({ high: 1 }),
    });
    (api.fixSecurityFinding as any).mockResolvedValue({
      sessionId: 'sess-1',
      agentId: 'dev-1',
      findingCount: 3,
      session: { id: 'sess-1' },
    });
    const onNotify = vi.fn();
    render(<SecurityPage projectId="proj-1" refreshNonce={0} onNotify={onNotify} />);
    await waitFor(() => expect(screen.getByTestId('security-finding-card')).toBeInTheDocument());

    await act(async () => {
      fireEvent.click(screen.getByTestId('finding-fix-button'));
    });

    expect(api.fixSecurityFinding).toHaveBeenCalledWith('proj-1', 'f1');
    expect(onNotify).toHaveBeenCalledWith(
      expect.stringContaining('Started a session to resolve 3 dependencies'),
      'success',
    );
  });

  it('hides the Fix button when the finding has no published fix', async () => {
    (api.getSecurityFindings as any).mockResolvedValue({
      findings: [finding({ id: 'f1', fixed_version: null })],
      openCounts: counts({ high: 1 }),
    });
    render(<SecurityPage projectId="proj-1" refreshNonce={0} />);
    await waitFor(() => expect(screen.getByTestId('security-finding-card')).toBeInTheDocument());
    expect(screen.queryByTestId('finding-fix-button')).not.toBeInTheDocument();
  });

  it('Fix all menu is collapsed until clicked, then shows the severity options', async () => {
    (api.getSecurityFindings as any).mockResolvedValue({ findings: [], openCounts: counts() });
    render(<SecurityPage projectId="proj-1" refreshNonce={0} />);
    await waitFor(() => expect(api.getSecurityFindings).toHaveBeenCalled());

    expect(screen.queryByTestId('security-fixall-menu')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('security-fixall'));
    expect(screen.getByTestId('security-fixall-menu')).toBeInTheDocument();
    expect(screen.getByTestId('security-fixall-critical')).toBeInTheDocument();
    expect(screen.getByTestId('security-fixall-high')).toBeInTheDocument();
    expect(screen.getByTestId('security-fixall-medium')).toBeInTheDocument();
    expect(screen.getByTestId('security-fixall-all')).toBeInTheDocument();
  });

  it('Fix all → Critical & High calls fixAllSecurityFindings with minSeverity:high', async () => {
    (api.getSecurityFindings as any).mockResolvedValue({ findings: [], openCounts: counts() });
    (api.fixAllSecurityFindings as any).mockResolvedValue({
      sessionId: 'sess-1',
      agentId: 'dev-1',
      findingCount: 2,
      session: { id: 'sess-1' },
    });
    const onNotify = vi.fn();
    render(<SecurityPage projectId="proj-1" refreshNonce={0} onNotify={onNotify} />);
    await waitFor(() => expect(api.getSecurityFindings).toHaveBeenCalled());

    fireEvent.click(screen.getByTestId('security-fixall'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('security-fixall-high'));
    });

    expect(api.fixAllSecurityFindings).toHaveBeenCalledWith('proj-1', { minSeverity: 'high' });
    expect(onNotify).toHaveBeenCalledWith(
      expect.stringContaining('Started a session to resolve 2 high+ dependencies'),
      'success',
    );
    // The menu closes after a pick.
    expect(screen.queryByTestId('security-fixall-menu')).not.toBeInTheDocument();
  });

  it('Fix all → All severities calls fixAllSecurityFindings with no minSeverity', async () => {
    (api.getSecurityFindings as any).mockResolvedValue({ findings: [], openCounts: counts() });
    (api.fixAllSecurityFindings as any).mockResolvedValue({
      sessionId: 'sess-1',
      agentId: 'dev-1',
      findingCount: 2,
      session: { id: 'sess-1' },
    });
    const onNotify = vi.fn();
    render(<SecurityPage projectId="proj-1" refreshNonce={0} onNotify={onNotify} />);
    await waitFor(() => expect(api.getSecurityFindings).toHaveBeenCalled());

    fireEvent.click(screen.getByTestId('security-fixall'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('security-fixall-all'));
    });

    expect(api.fixAllSecurityFindings).toHaveBeenCalledWith('proj-1', { minSeverity: null });
    expect(onNotify).toHaveBeenCalledWith(
      expect.stringContaining('Started a session to resolve 2 dependencies'),
      'success',
    );
  });

  it('Fix all reports "no findings" when nothing matched the threshold', async () => {
    (api.getSecurityFindings as any).mockResolvedValue({ findings: [], openCounts: counts() });
    (api.fixAllSecurityFindings as any).mockResolvedValue({
      sessionId: null,
      agentId: null,
      findingCount: 0,
      session: null,
    });
    const onNotify = vi.fn();
    render(<SecurityPage projectId="proj-1" refreshNonce={0} onNotify={onNotify} />);
    await waitFor(() => expect(api.getSecurityFindings).toHaveBeenCalled());

    fireEvent.click(screen.getByTestId('security-fixall'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('security-fixall-critical'));
    });

    expect(api.fixAllSecurityFindings).toHaveBeenCalledWith('proj-1', { minSeverity: 'critical' });
    expect(onNotify).toHaveBeenCalledWith(expect.stringContaining('No critical+ findings'), 'info');
  });
});

describe('ScheduleControl (auto-scan schedule)', () => {
  beforeEach(() => {
    (api.getSecurityFindings as any).mockResolvedValue({ findings: [], openCounts: counts() });
  });

  it('renders the schedule select + on-push toggle for a Hub-hosted project', async () => {
    (api.getProject as any).mockResolvedValue({
      id: 'proj-1',
      gitHost: 'agenthub',
      securityScan: { schedule: 'daily', onPush: false },
    });
    render(<SecurityPage projectId="proj-1" refreshNonce={0} onNotify={vi.fn()} />);

    const select = (await screen.findByTestId('security-schedule-select')) as HTMLSelectElement;
    expect(select.value).toBe('daily');
    // Unset placeholder is absent once an explicit value is set.
    expect(select.querySelector('option[value=""]')).toBeNull();
    expect((screen.getByTestId('security-onpush-toggle') as HTMLInputElement).checked).toBe(false);
  });

  it('hides the control for a non-hosted (GitHub) project', async () => {
    (api.getProject as any).mockResolvedValue({
      id: 'proj-1',
      gitHost: 'github',
      securityScan: {},
    });
    render(<SecurityPage projectId="proj-1" refreshNonce={0} onNotify={vi.fn()} />);
    await waitFor(() => expect(api.getProject).toHaveBeenCalled());
    expect(screen.queryByTestId('security-schedule')).toBeNull();
  });

  it('shows the "Default" placeholder when schedule is unset', async () => {
    (api.getProject as any).mockResolvedValue({ id: 'proj-1', gitHost: 'agenthub' });
    render(<SecurityPage projectId="proj-1" refreshNonce={0} onNotify={vi.fn()} />);
    const select = (await screen.findByTestId('security-schedule-select')) as HTMLSelectElement;
    expect(select.value).toBe('');
    expect(select.querySelector('option[value=""]')).not.toBeNull();
  });

  it('PATCHes the full securityScan state when the cadence changes', async () => {
    (api.getProject as any).mockResolvedValue({
      id: 'proj-1',
      gitHost: 'agenthub',
      securityScan: { schedule: 'weekly', onPush: true },
    });
    (api.updateProject as any).mockResolvedValue({
      id: 'proj-1',
      gitHost: 'agenthub',
      securityScan: { schedule: 'daily', onPush: true },
    });
    render(<SecurityPage projectId="proj-1" refreshNonce={0} onNotify={vi.fn()} />);
    const select = (await screen.findByTestId('security-schedule-select')) as HTMLSelectElement;

    await act(async () => {
      fireEvent.change(select, { target: { value: 'daily' } });
    });

    // Full object (schedule + onPush), not just the changed key — so a
    // wholesale-replace server can't drop the untouched onPush.
    expect(api.updateProject).toHaveBeenCalledWith('proj-1', {
      securityScan: { schedule: 'daily', onPush: true },
    });
  });

  it('omits the placeholder schedule from the patch when it is unset', async () => {
    (api.getProject as any).mockResolvedValue({ id: 'proj-1', gitHost: 'agenthub' });
    (api.updateProject as any).mockResolvedValue({
      id: 'proj-1',
      gitHost: 'agenthub',
      securityScan: { onPush: true },
    });
    render(<SecurityPage projectId="proj-1" refreshNonce={0} onNotify={vi.fn()} />);
    const toggle = (await screen.findByTestId('security-onpush-toggle')) as HTMLInputElement;

    await act(async () => {
      fireEvent.click(toggle);
    });

    // schedule '' would be rejected by the server (off|daily|weekly only).
    expect(api.updateProject).toHaveBeenCalledWith('proj-1', { securityScan: { onPush: true } });
  });

  it('PATCHes securityScan.onPush when the toggle flips', async () => {
    (api.getProject as any).mockResolvedValue({
      id: 'proj-1',
      gitHost: 'agenthub',
      securityScan: { schedule: 'daily', onPush: false },
    });
    (api.updateProject as any).mockResolvedValue({
      id: 'proj-1',
      gitHost: 'agenthub',
      securityScan: { schedule: 'daily', onPush: true },
    });
    render(<SecurityPage projectId="proj-1" refreshNonce={0} onNotify={vi.fn()} />);
    const toggle = (await screen.findByTestId('security-onpush-toggle')) as HTMLInputElement;

    await act(async () => {
      fireEvent.click(toggle);
    });

    expect(api.updateProject).toHaveBeenCalledWith('proj-1', {
      securityScan: { schedule: 'daily', onPush: true },
    });
  });

  it('reverts and notifies when the PATCH fails', async () => {
    (api.getProject as any).mockResolvedValue({
      id: 'proj-1',
      gitHost: 'agenthub',
      securityScan: { schedule: 'weekly', onPush: false },
    });
    (api.updateProject as any).mockRejectedValue(new Error('Forbidden'));
    const onNotify = vi.fn();
    render(<SecurityPage projectId="proj-1" refreshNonce={0} onNotify={onNotify} />);
    const select = (await screen.findByTestId('security-schedule-select')) as HTMLSelectElement;

    await act(async () => {
      fireEvent.change(select, { target: { value: 'off' } });
    });

    expect(onNotify).toHaveBeenCalledWith(expect.stringContaining('Forbidden'), 'error');
    // Reverted to the persisted value after the failure.
    await waitFor(() => expect(select.value).toBe('weekly'));
  });
});
