import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import InfrastructurePage from './InfrastructurePage';
import { api } from '../../utils/api';

// The Overview tab embeds the scope editor, which loads from the API on mount.
(vi as any).mock('../../utils/api.js', () => ({
  api: {
    getInfraScopes: vi.fn(),
    updateInfraScopes: vi.fn(),
    projectInfraCost: vi.fn(),
  },
}));

const getInfraScopes = vi.mocked(api.getInfraScopes);

const emptyScopes = {
  scopes: [],
  projection: { metricsRequestedPerMonth: 0, estimatedMonthlyCostUsd: 0, perScope: [] },
  collectableServices: ['ec2'],
  uncollectableServices: [],
  monthlyCeilingUsd: null,
  degradation: 'normal',
  maxScopes: 200,
  configured: false,
};

describe('InfrastructurePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getInfraScopes.mockResolvedValue(emptyScopes as any);
  });
  const readyStatus = { profile: 'monitoring', region: 'us-east-1', reachable: true };

  it('switches between Overview, Resources, Metrics, and Alerts tabs', () => {
    render(
      <InfrastructurePage
        projectId="project-1"
        projectName="Demo"
        monitoringStatus={readyStatus}
        scopeConfigured
        paidFeatureOff={false}
      />,
    );

    expect(screen.getByRole('tabpanel')).toHaveTextContent('Monitoring profile ready');
    fireEvent.click(screen.getByRole('tab', { name: 'Resources' }));
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Resource inventory');
    fireEvent.click(screen.getByRole('tab', { name: 'Metrics' }));
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Metric charts');
    fireEvent.click(screen.getByRole('tab', { name: 'Alerts' }));
    expect(screen.getByRole('tabpanel')).toHaveTextContent('No infrastructure alert rules');
  });

  it('renders the no monitoring profile state distinctly', () => {
    render(
      <InfrastructurePage
        projectId="project-1"
        monitoringStatus={{
          reachable: false,
          code: 'monitoring_profile_required',
          reason: 'not_designated',
        }}
      />,
    );
    expect(screen.getByTestId('infra-empty-monitoring-profile')).toHaveTextContent(
      'no monitoring profile designated',
    );
  });

  it('renders the no scope state distinctly', () => {
    render(
      <InfrastructurePage
        projectId="project-1"
        monitoringStatus={readyStatus}
        scopeConfigured={false}
        paidFeatureOff={false}
      />,
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Resources' }));
    expect(screen.getByTestId('infra-empty-scope')).toHaveTextContent('no scope configured');
  });

  it('does not carry one project’s live scope state into the next project', async () => {
    // Regression: liveScopeConfigured survived a project switch, so project-b's
    // Resources/Metrics/Alerts tabs were gated on project-a's answer until the
    // new request settled.
    const scoped = {
      ...emptyScopes,
      scopes: [{ id: 's1', enabled: true, profileName: 'm', region: 'us-east-2', service: 'ec2' }],
      configured: true,
    };
    getInfraScopes.mockResolvedValueOnce(scoped as any).mockImplementationOnce(
      () => new Promise(() => {}), // project-b's load never settles
    );

    const { rerender } = render(
      <InfrastructurePage projectId="project-a" monitoringStatus={readyStatus} />,
    );
    // project-a has a scope, so the Resources tab shows inventory, not the
    // empty state.
    fireEvent.click(screen.getByRole('tab', { name: 'Resources' }));
    await waitFor(() =>
      expect(screen.getByRole('tabpanel')).toHaveTextContent('Resource inventory'),
    );

    rerender(
      <InfrastructurePage
        projectId="project-b"
        monitoringStatus={readyStatus}
        scopeConfigured={false}
      />,
    );

    // While project-b is still unknown, its own props decide — not project-a's
    // stale answer.
    expect(screen.getByTestId('infra-empty-scope')).toHaveTextContent('no scope configured');
  });

  it('renders the paid-feature state distinctly', () => {
    render(
      <InfrastructurePage
        projectId="project-1"
        monitoringStatus={readyStatus}
        scopeConfigured
        paidFeatureOff
      />,
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Metrics' }));
    expect(screen.getByTestId('infra-empty-paid-feature')).toHaveTextContent(
      'this AWS paid feature is off',
    );
  });
});
