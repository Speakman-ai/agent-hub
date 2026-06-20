import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useState } from 'react';
import { render, screen, waitFor, act, fireEvent, within } from '@testing-library/react';
import SecurityPage, { sortFindings, openCriticalHigh } from './SecurityPage.jsx';
import { api } from '../utils/api.js';

vi.mock('../utils/api.js', () => ({
  api: {
    getSecurityFindings: vi.fn(),
    dismissSecurityFinding: vi.fn(),
  },
}));

function finding(overrides = {}) {
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

const counts = (o = {}) => ({ critical: 0, high: 0, medium: 0, low: 0, unknown: 0, ...o });

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
    expect(sorted.map((f) => f.id)).toEqual(['crit', 'high', 'med-new', 'med-old', 'low', 'unk']);
  });
});

describe('openCriticalHigh', () => {
  it('sums open critical and high counts and tolerates null', () => {
    expect(openCriticalHigh(counts({ critical: 2, high: 3, medium: 9 }))).toBe(5);
    expect(openCriticalHigh(null)).toBe(0);
  });
});

describe('SecurityPage', () => {
  it('renders findings severity-first with package@version, advisory link and fix', async () => {
    api.getSecurityFindings.mockResolvedValue({
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
    api.getSecurityFindings.mockResolvedValue({
      findings: [finding({ severity: 'critical' })],
      openCounts: counts({ critical: 1, high: 2 }),
    });
    const onOpenCounts = vi.fn();

    render(<SecurityPage projectId="proj-1" refreshNonce={0} onOpenCounts={onOpenCounts} />);

    await waitFor(() => expect(onOpenCounts).toHaveBeenCalled());
    expect(onOpenCounts).toHaveBeenCalledWith(expect.objectContaining({ critical: 1, high: 2 }));
    expect(screen.getByTestId('security-header-badge')).toHaveTextContent('3 open critical/high');
  });

  it('does not refetch in a loop when the parent passes a fresh onOpenCounts identity each render', async () => {
    // Regression: App passes an inline onOpenCounts whose identity changes every
    // render and whose call sets parent state (→ re-render). If `load` depended
    // on that callback identity, the effect would re-fire and refetch forever.
    api.getSecurityFindings.mockResolvedValue({
      findings: [],
      openCounts: counts({ high: 1 }),
    });

    function Parent() {
      const [, setLifted] = useState(null);
      // New inline callback identity on every render, mirroring App.jsx.
      return (
        <SecurityPage projectId="proj-1" refreshNonce={0} onOpenCounts={(c) => setLifted(c)} />
      );
    }

    render(<Parent />);
    await waitFor(() => expect(api.getSecurityFindings).toHaveBeenCalled());
    // Give any erroneous refetch loop a chance to fire additional calls.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(api.getSecurityFindings).toHaveBeenCalledTimes(1);
  });

  it('dismisses a finding: two-step confirm, calls the API, and drops the row', async () => {
    api.getSecurityFindings.mockResolvedValue({
      findings: [finding({ id: 'f1' })],
      openCounts: counts({ high: 1 }),
    });
    api.dismissSecurityFinding.mockResolvedValue({ ...finding({ id: 'f1' }), status: 'dismissed' });

    render(<SecurityPage projectId="proj-1" refreshNonce={0} />);
    await waitFor(() => expect(screen.getByTestId('security-finding-card')).toBeInTheDocument());

    // Arm, then confirm.
    fireEvent.click(screen.getByText('Dismiss'));
    api.getSecurityFindings.mockResolvedValue({ findings: [], openCounts: counts() });
    await act(async () => {
      fireEvent.click(screen.getByText('Confirm'));
    });

    expect(api.dismissSecurityFinding).toHaveBeenCalledWith('proj-1', 'f1');
    await waitFor(() =>
      expect(screen.queryByTestId('security-finding-card')).not.toBeInTheDocument(),
    );
  });

  it('queries the server with the selected status filter', async () => {
    api.getSecurityFindings.mockResolvedValue({ findings: [], openCounts: counts() });
    render(<SecurityPage projectId="proj-1" refreshNonce={0} />);
    await waitFor(() => expect(api.getSecurityFindings).toHaveBeenCalledWith('proj-1', 'open'));

    await act(async () => {
      fireEvent.click(screen.getByTestId('status-filter-dismissed'));
    });
    await waitFor(() =>
      expect(api.getSecurityFindings).toHaveBeenCalledWith('proj-1', 'dismissed'),
    );

    // "All" sends no status filter.
    await act(async () => {
      fireEvent.click(screen.getByTestId('status-filter-all'));
    });
    await waitFor(() => expect(api.getSecurityFindings).toHaveBeenCalledWith('proj-1', undefined));
  });

  it('shows an empty state when there are no findings', async () => {
    api.getSecurityFindings.mockResolvedValue({ findings: [], openCounts: counts() });
    render(<SecurityPage projectId="proj-1" refreshNonce={0} />);
    await waitFor(() => expect(screen.getByText('No security findings')).toBeInTheDocument());
  });
});
