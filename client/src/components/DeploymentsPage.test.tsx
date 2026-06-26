import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DeploymentsPage from './DeploymentsPage';
import { api } from '../utils/api';

(vi as any).mock('../utils/api.js', () => ({
  api: {
    getDeployConfig: vi.fn(),
    getProjectBranches: vi.fn(),
    getGitHostBranches: vi.fn(),
    getDeployment: vi.fn(),
    startDeployWizard: vi.fn(),
    triggerDeployment: vi.fn(),
    rollbackDeployment: vi.fn(),
    approveDeployment: vi.fn(),
  },
}));

function deployment(over: any = {}) {
  return {
    id: 'dep-1',
    project_id: 'proj-1',
    environment: 'dev',
    ref: 'sha-live',
    status: 'success',
    trigger: 'manual',
    triggered_by: 'u1',
    source_deployment_id: null,
    runner_job_id: null,
    error: null,
    meta: null,
    created_at: '2026-06-25 12:00:00',
    started_at: '2026-06-25 12:00:01',
    completed_at: '2026-06-25 12:00:02',
    updated_at: '2026-06-25 12:00:02',
    ...over,
  };
}

function step(over: any = {}) {
  return {
    id: 'step-1',
    deployment_id: 'dep-1',
    name: 'build',
    step_order: 1,
    status: 'success',
    exit_code: 0,
    error: null,
    started_at: '2026-06-25 12:00:01',
    completed_at: '2026-06-25 12:00:02',
    created_at: '2026-06-25 12:00:00',
    ...over,
  };
}

function snapshot(dep = deployment(), steps = [step()]) {
  return { deployment: dep, steps, approvals: [] };
}

function env(over: any = {}) {
  const last = deployment();
  return {
    name: 'dev',
    approval: false,
    runsOn: 'ubuntu-24.04',
    timeoutMinutes: 60,
    steps: [
      { name: 'build', run: 'npm run build' },
      { name: 'ship', run: './deploy.sh' },
    ],
    currentRef: 'sha-live',
    currentDeploymentId: last.id,
    activeDeploymentId: null,
    activeDeployment: null,
    currentDeployment: last,
    lastDeployment: last,
    rollbackTarget: deployment({ id: 'dep-prev', ref: 'sha-prev' }),
    ...over,
  };
}

function config(environments: any[] = [env()]) {
  return {
    projectId: 'proj-1',
    configPath: '.agent-hub/deploy.yaml',
    environments,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  (api.getDeployConfig as any).mockResolvedValue(config());
  (api.getProjectBranches as any).mockResolvedValue({
    defaultBranch: 'main',
    branches: [
      { name: 'main', isDefault: true },
      { name: 'release-1', isDefault: false },
    ],
  });
  (api.getGitHostBranches as any).mockRejectedValue(new Error('not hosted'));
  (api.getDeployment as any).mockResolvedValue(snapshot());
  (api.startDeployWizard as any).mockResolvedValue({
    sessionId: 'setup-session-1',
    agentId: 'agent-1',
  });
  (api.triggerDeployment as any).mockResolvedValue(
    snapshot(deployment({ id: 'dep-new', ref: 'release-1' })),
  );
  (api.rollbackDeployment as any).mockResolvedValue(
    snapshot(deployment({ id: 'dep-rollback', ref: 'sha-prev', trigger: 'rollback' })),
  );
  (api.approveDeployment as any).mockResolvedValue(
    snapshot(deployment({ id: 'dep-prod', environment: 'prod', status: 'running' })),
  );
});

describe('DeploymentsPage', () => {
  it('renders environment cards with live ref and last deploy state', async () => {
    render(<DeploymentsPage projectId="proj-1" onNotify={() => {}} />);

    const card = await screen.findByTestId('deploy-env-dev');
    expect(within(card).getByText('dev')).toBeInTheDocument();
    expect(within(card).getByText(/live sha-live/)).toBeInTheDocument();
    expect(within(card).getByText('success')).toBeInTheDocument();
    expect(within(card).getByLabelText('Ref for dev')).toHaveValue('main');
    expect(within(card).getByLabelText('Manual ref for dev')).toHaveValue('main');
    expect(await screen.findByText('1. build')).toBeInTheDocument();
  });

  it('defaults deployment targets to the repo default branch instead of the live SHA', async () => {
    (api.getDeployConfig as any).mockResolvedValue(
      config([env({ currentRef: 'abcdef1234567890' })]),
    );

    render(<DeploymentsPage projectId="proj-1" onNotify={() => {}} />);

    const card = await screen.findByTestId('deploy-env-dev');
    expect(within(card).getByText(/live abcdef123456/)).toBeInTheDocument();
    expect(within(card).getByLabelText('Ref for dev')).toHaveValue('main');
    fireEvent.click(within(card).getByRole('button', { name: 'Deploy' }));

    await waitFor(() =>
      expect(api.triggerDeployment).toHaveBeenCalledWith('proj-1', 'dev', { ref: 'main' }),
    );
  });

  it('triggers a deployment with the typed ref', async () => {
    const onNotify = vi.fn();
    render(<DeploymentsPage projectId="proj-1" onNotify={onNotify} />);

    const card = await screen.findByTestId('deploy-env-dev');
    fireEvent.change(within(card).getByLabelText('Ref for dev'), {
      target: { value: 'release-1' },
    });
    fireEvent.click(within(card).getByRole('button', { name: 'Deploy' }));

    await waitFor(() =>
      expect(api.triggerDeployment).toHaveBeenCalledWith('proj-1', 'dev', { ref: 'release-1' }),
    );
    expect(onNotify).toHaveBeenCalledWith('Deploy started for dev', 'success');
  });

  it('keeps a manual ref input when branch lookup fails', async () => {
    (api.getProjectBranches as any).mockRejectedValue(new Error('branch lookup failed'));
    const onNotify = vi.fn();
    render(<DeploymentsPage projectId="proj-1" onNotify={onNotify} />);

    const card = await screen.findByTestId('deploy-env-dev');
    const refInput = within(card).getByLabelText('Ref for dev');
    expect(refInput).toHaveValue('sha-live');
    fireEvent.change(refInput, { target: { value: 'v2.0.0' } });
    fireEvent.click(within(card).getByRole('button', { name: 'Deploy' }));

    await waitFor(() =>
      expect(api.triggerDeployment).toHaveBeenCalledWith('proj-1', 'dev', { ref: 'v2.0.0' }),
    );
  });

  it('falls back to hosted git branches when generic branch lookup fails', async () => {
    (api.getProjectBranches as any).mockRejectedValue(new Error('no origin'));
    (api.getGitHostBranches as any).mockResolvedValue({
      defaultBranch: 'trunk',
      branches: [
        { name: 'trunk', isDefault: true },
        { name: 'release-hosted', isDefault: false },
      ],
    });

    render(<DeploymentsPage projectId="proj-1" onNotify={() => {}} />);

    const card = await screen.findByTestId('deploy-env-dev');
    expect(within(card).getByLabelText('Ref for dev')).toHaveValue('trunk');
    fireEvent.change(within(card).getByLabelText('Ref for dev'), {
      target: { value: 'release-hosted' },
    });
    fireEvent.click(within(card).getByRole('button', { name: 'Deploy' }));

    await waitFor(() =>
      expect(api.triggerDeployment).toHaveBeenCalledWith('proj-1', 'dev', {
        ref: 'release-hosted',
      }),
    );
  });

  it('shows deploy.yaml setup when the config is missing', async () => {
    const onNotify = vi.fn();
    const onOpenSession = vi.fn();
    (api.getDeployConfig as any).mockRejectedValue(
      new Error('404: deploy.yaml not found at /repo/.agent-hub/deploy.yaml.'),
    );

    render(
      <DeploymentsPage projectId="proj-1" onNotify={onNotify} onOpenSession={onOpenSession} />,
    );

    expect(await screen.findByText('Set up deployment environments')).toBeInTheDocument();
    expect(screen.queryByText(/404:/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Start AI setup' }));

    await waitFor(() => expect(api.startDeployWizard).toHaveBeenCalledWith('proj-1'));
    expect(onNotify).toHaveBeenCalledWith('Deploy setup walkthrough started', 'success');
    expect(onOpenSession).toHaveBeenCalledWith({
      sessionId: 'setup-session-1',
      agentId: 'agent-1',
    });
  });

  it('does not lock actions when activeDeploymentId is stale without an active deployment', async () => {
    (api.getDeployConfig as any).mockResolvedValue(
      config([env({ activeDeploymentId: 'missing-deployment', activeDeployment: null })]),
    );
    render(<DeploymentsPage projectId="proj-1" onNotify={() => {}} />);

    const card = await screen.findByTestId('deploy-env-dev');
    const refInput = within(card).getByLabelText('Manual ref for dev');
    const deployButton = within(card).getByRole('button', { name: 'Deploy' });
    const rollbackButton = within(card).getByRole('button', { name: 'Rollback' });
    expect(refInput).not.toBeDisabled();
    expect(deployButton).not.toBeDisabled();
    expect(rollbackButton).not.toBeDisabled();

    fireEvent.change(refInput, { target: { value: 'release-after-stale-lock' } });
    fireEvent.click(deployButton);

    await waitFor(() =>
      expect(api.triggerDeployment).toHaveBeenCalledWith('proj-1', 'dev', {
        ref: 'release-after-stale-lock',
      }),
    );
  });

  it('rolls back when a prior successful deployment exists', async () => {
    render(<DeploymentsPage projectId="proj-1" onNotify={() => {}} />);

    const card = await screen.findByTestId('deploy-env-dev');
    fireEvent.click(within(card).getByRole('button', { name: 'Rollback' }));

    await waitFor(() =>
      expect(api.rollbackDeployment).toHaveBeenCalledWith('proj-1', 'dep-prev', {}),
    );
  });

  it('approves a gated deployment awaiting approval', async () => {
    const prodActive = deployment({
      id: 'dep-prod',
      environment: 'prod',
      ref: 'sha-prod',
      status: 'awaiting_approval',
    });
    (api.getDeployConfig as any).mockResolvedValue(
      config([
        env({
          name: 'prod',
          approval: true,
          currentRef: null,
          activeDeploymentId: prodActive.id,
          activeDeployment: prodActive,
          currentDeployment: null,
          currentDeploymentId: null,
          lastDeployment: prodActive,
          rollbackTarget: null,
        }),
      ]),
    );
    (api.getDeployment as any).mockResolvedValue(
      snapshot(prodActive, [step({ deployment_id: prodActive.id })]),
    );

    render(<DeploymentsPage projectId="proj-1" onNotify={() => {}} />);

    const card = await screen.findByTestId('deploy-env-prod');
    fireEvent.click(within(card).getByRole('button', { name: 'Approve' }));

    await waitFor(() =>
      expect(api.approveDeployment).toHaveBeenCalledWith('proj-1', 'dep-prod', {}),
    );
  });

  it('applies deployment_update WebSocket events to the selected run and live stream', async () => {
    (api.getDeployConfig as any).mockResolvedValue(config([env({ lastDeployment: null })]));
    (api.getDeployment as any).mockResolvedValue(snapshot());
    render(<DeploymentsPage projectId="proj-1" onNotify={() => {}} />);

    await screen.findByTestId('deploy-env-dev');
    const running = deployment({ id: 'dep-ws', status: 'running', ref: 'sha-ws' });
    act(() => {
      window.dispatchEvent(
        new CustomEvent('agenthub-deployment-ws', {
          detail: {
            projectId: 'proj-1',
            deployment: running,
            steps: [step({ id: 'step-ws', deployment_id: 'dep-ws', status: 'running' })],
          },
        }),
      );
    });

    expect((await screen.findAllByText(/dev \/ sha-ws/)).length).toBeGreaterThan(0);
    expect(screen.getAllByText('running').length).toBeGreaterThan(0);
    expect(screen.getByText('1. build')).toBeInTheDocument();
  });
});
