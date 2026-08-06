import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import InfrastructurePage from './InfrastructurePage';

describe('InfrastructurePage', () => {
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
