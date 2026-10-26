import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import EnvironmentsManagementSection from './EnvironmentsManagementSection';
import { api } from '../utils/api';

(vi as any).mock('../utils/api.js', () => ({
  api: {
    getDeployEnvironments: vi.fn(),
    setDeployEnvironmentEnabled: vi.fn(),
    deleteDeployEnvironmentConfig: vi.fn(),
    getDeployEnvironmentSecrets: vi.fn(),
    putDeployEnvironmentSecrets: vi.fn(),
    getProjectSecrets: vi.fn(),
  },
}));

function env(over: any = {}) {
  return {
    name: 'dev',
    active: true,
    enabled: true,
    deployable: true,
    approval: false,
    runsOn: 'ubuntu-24.04',
    timeoutMinutes: 60,
    steps: [{ name: 'deploy', run: './deploy.sh' }],
    currentRef: 'abc123def456',
    currentDeploymentId: 'dep-1',
    lastDeployment: null,
    config: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  (window as any).confirm = vi.fn(() => true);
});

describe('EnvironmentsManagementSection', () => {
  it('lists environments with their status badges', async () => {
    (api.getDeployEnvironments as any).mockResolvedValue({
      environments: [
        env({ name: 'dev', active: true, enabled: true }),
        env({ name: 'prod', active: true, enabled: false, config: { id: 'c1', enabled: false } }),
        env({ name: 'legacy', active: false, enabled: true, config: { id: 'c2', enabled: true } }),
      ],
    });
    render(<EnvironmentsManagementSection projectId="proj-1" />);

    await waitFor(() => expect(screen.getByTestId('manage-env-dev')).toBeTruthy());
    expect(within(screen.getByTestId('manage-env-dev')).getByText('deployable')).toBeTruthy();
    expect(within(screen.getByTestId('manage-env-prod')).getByText('paused')).toBeTruthy();
    expect(within(screen.getByTestId('manage-env-legacy')).getByText('orphaned')).toBeTruthy();
  });

  it('pauses a deployable environment via PATCH', async () => {
    (api.getDeployEnvironments as any).mockResolvedValue({
      environments: [env({ name: 'prod', active: true, enabled: true })],
    });
    (api.setDeployEnvironmentEnabled as any).mockResolvedValue({
      environments: [
        env({ name: 'prod', active: true, enabled: false, config: { id: 'c1', enabled: false } }),
      ],
    });
    const showToast = vi.fn();
    render(<EnvironmentsManagementSection projectId="proj-1" showToast={showToast} />);

    await waitFor(() => expect(screen.getByTestId('manage-env-prod')).toBeTruthy());
    fireEvent.click(within(screen.getByTestId('manage-env-prod')).getByText('Pause'));

    await waitFor(() =>
      expect(api.setDeployEnvironmentEnabled).toHaveBeenCalledWith('proj-1', 'prod', false),
    );
    await waitFor(() =>
      expect(within(screen.getByTestId('manage-env-prod')).getByText('Resume')).toBeTruthy(),
    );
    expect(showToast).toHaveBeenCalledWith('prod paused', 'success');
  });

  it('removes an orphaned config row via DELETE after confirmation', async () => {
    (api.getDeployEnvironments as any).mockResolvedValue({
      environments: [
        env({ name: 'legacy', active: false, enabled: true, config: { id: 'c2', enabled: true } }),
      ],
    });
    (api.deleteDeployEnvironmentConfig as any).mockResolvedValue({
      removed: true,
      environments: [],
    });
    render(<EnvironmentsManagementSection projectId="proj-1" />);

    await waitFor(() => expect(screen.getByTestId('manage-env-legacy')).toBeTruthy());
    fireEvent.click(within(screen.getByTestId('manage-env-legacy')).getByText('Remove'));

    await waitFor(() =>
      expect(api.deleteDeployEnvironmentConfig).toHaveBeenCalledWith('proj-1', 'legacy'),
    );
    await waitFor(() => expect(screen.queryByTestId('manage-env-legacy')).toBeNull());
  });

  it('does not delete when the confirmation is dismissed', async () => {
    (window as any).confirm = vi.fn(() => false);
    (api.getDeployEnvironments as any).mockResolvedValue({
      environments: [
        env({ name: 'legacy', active: false, enabled: true, config: { id: 'c2', enabled: true } }),
      ],
    });
    render(<EnvironmentsManagementSection projectId="proj-1" />);

    await waitFor(() => expect(screen.getByTestId('manage-env-legacy')).toBeTruthy());
    fireEvent.click(within(screen.getByTestId('manage-env-legacy')).getByText('Remove'));

    expect(api.deleteDeployEnvironmentConfig).not.toHaveBeenCalled();
  });

  it('edits secrets scoped to one environment, keeping masked values', async () => {
    (api.getDeployEnvironments as any).mockResolvedValue({
      environments: [env({ name: 'prod' })],
    });
    (api.getDeployEnvironmentSecrets as any).mockResolvedValue({
      secrets: [{ key: 'AWS_SECRET_ACCESS_KEY', kind: 'secret', value: '••••••••' }],
    });
    (api.putDeployEnvironmentSecrets as any).mockResolvedValue({ secrets: [] });
    render(<EnvironmentsManagementSection projectId="proj-1" />);

    await waitFor(() => expect(screen.getByTestId('manage-env-prod')).toBeTruthy());
    fireEvent.click(within(screen.getByTestId('manage-env-prod')).getByText('Secrets'));

    const panel = await screen.findByTestId('deploy-env-secrets-prod');
    expect(api.getDeployEnvironmentSecrets).toHaveBeenCalledWith('proj-1', 'prod');
    expect(api.getProjectSecrets).not.toHaveBeenCalled();
    expect(within(panel).queryByText('Import .env (merge)')).toBeNull();

    fireEvent.click(within(panel).getByText('Save secrets'));
    await waitFor(() =>
      expect(api.putDeployEnvironmentSecrets).toHaveBeenCalledWith('proj-1', 'prod', [
        { key: 'AWS_SECRET_ACCESS_KEY', value: '••••••••', kind: 'secret' },
      ]),
    );
  });

  it('shows an error when the load fails', async () => {
    (api.getDeployEnvironments as any).mockRejectedValue(new Error('boom'));
    render(<EnvironmentsManagementSection projectId="proj-1" />);
    await waitFor(() => expect(screen.getByText('boom')).toBeTruthy());
  });

  it('starts environments named after Object.prototype members collapsed', async () => {
    (api.getDeployEnvironments as any).mockResolvedValue({
      environments: [env({ name: 'constructor' }), env({ name: 'toString' })],
    });
    render(<EnvironmentsManagementSection projectId="proj-1" />);
    await waitFor(() => expect(screen.getByTestId('manage-env-constructor')).toBeTruthy());
    for (const name of ['constructor', 'toString']) {
      const row = within(screen.getByTestId(`manage-env-${name}`));
      for (const title of [
        'Manage deploy triggers',
        'Manage deploy schedules',
        'Manage release gates',
        'Manage notification routing',
      ]) {
        expect(row.getByTitle(title).getAttribute('aria-expanded')).toBe('false');
      }
    }
  });
});
