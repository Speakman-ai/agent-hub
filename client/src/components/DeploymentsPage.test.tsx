import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DeploymentsPage from './DeploymentsPage';
import { api } from '../utils/api';
import { hasRole } from '../utils/auth';

(vi as any).mock('../utils/auth', async (importOriginal: any) => {
  const actual = await importOriginal();
  return { ...actual, hasRole: vi.fn(() => false) };
});

(vi as any).mock('../utils/api.js', () => ({
  api: {
    getDeployConfig: vi.fn(),
    getProjectBranches: vi.fn(),
    getGitHostBranches: vi.fn(),
    listDeployments: vi.fn(),
    getDeployment: vi.fn(),
    getDeploymentNotificationRecipients: vi.fn(),
    retryReleaseNotification: vi.fn(),
    adjustDeploymentReleaseItem: vi.fn(),
    startDeployWizard: vi.fn(),
    triggerDeployment: vi.fn(),
    rollbackDeployment: vi.fn(),
    approveDeployment: vi.fn(),
    getReleaseNotificationSettings: vi.fn(),
    updateReleaseNotificationSettings: vi.fn(),
    resetReleaseNotificationSettings: vi.fn(),
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

function releaseItem(over: any = {}) {
  return {
    id: 'ri-1',
    deployment_id: 'dep-1',
    card_id: 'card-1',
    support_ticket_id: 'ticket-1',
    source: 'derived',
    inclusion_status: 'included',
    operator_adjusted_by: null,
    operator_adjustment_note: null,
    operator_adjustment_meta: null,
    operator_adjusted_at: null,
    created_at: '2026-06-25 12:00:00',
    updated_at: '2026-06-25 12:00:00',
    card: {
      id: 'card-1',
      title: 'Fix export crash',
      shortId: 1227,
      priority: 'medium',
      columnName: 'Done',
    },
    supportTicket: {
      id: 'ticket-1',
      subject: 'Export fails',
      status: 'new',
      type: 'bug',
      releaseState: null,
    },
    ...over,
  };
}

function releaseNotification(over: any = {}) {
  return {
    id: 'note-1',
    deployment_id: 'dep-1',
    release_item_id: null,
    support_ticket_id: null,
    notification_type: 'release_digest',
    recipient_type: 'release_digest',
    subject: 'Release digest',
    status: 'error',
    attempts: 2,
    sent_at: null,
    next_attempt_at: '2026-06-25 12:15:00',
    error_summary: 'SMTP is not configured.',
    can_retry: true,
    created_at: '2026-06-25 12:00:00',
    updated_at: '2026-06-25 12:00:00',
    ...over,
  };
}

function snapshot(
  dep = deployment(),
  steps = [step()],
  releaseItems = [releaseItem()],
  releaseNotifications: any[] = [],
) {
  return { deployment: dep, steps, approvals: [], releaseItems, releaseNotifications };
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
  (hasRole as any).mockReturnValue(false);
  (api.getDeploymentNotificationRecipients as any).mockResolvedValue({ recipients: [] });
  (api.getDeployConfig as any).mockResolvedValue(config());
  (api.getProjectBranches as any).mockResolvedValue({
    defaultBranch: 'main',
    branches: [
      { name: 'main', isDefault: true },
      { name: 'release-1', isDefault: false },
    ],
  });
  (api.getGitHostBranches as any).mockRejectedValue(new Error('not hosted'));
  (api.listDeployments as any).mockResolvedValue({
    deployments: [deployment()],
    limit: 100,
    offset: 0,
  });
  (api.getDeployment as any).mockResolvedValue(snapshot());
  (api.adjustDeploymentReleaseItem as any).mockResolvedValue({
    releaseItem: releaseItem({ inclusion_status: 'excluded' }),
    releaseItems: [releaseItem({ inclusion_status: 'excluded' })],
  });
  (api.retryReleaseNotification as any).mockResolvedValue({
    notification: releaseNotification({ status: 'pending', can_retry: false, error_summary: null }),
    releaseNotifications: [
      releaseNotification({ status: 'pending', can_retry: false, error_summary: null }),
    ],
  });
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
  (api.getReleaseNotificationSettings as any).mockResolvedValue({
    projectId: 'proj-1',
    releaseDigestPrompt: 'Write a concise customer-facing release digest.',
    defaultReleaseDigestPrompt: 'Write a concise customer-facing release digest.',
    isDefault: true,
    promptMaxLength: 4000,
    factBoundedSystemTemplate: '',
    updatedBy: null,
    updatedAt: null,
    releaseDigestRecipients: [],
  });
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
    expect(await screen.findByText('#1227 Fix export crash')).toBeInTheDocument();
    expect(screen.getByText(/Export fails/)).toBeInTheDocument();
    expect(screen.getByText('included')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Exclude' })).toBeInTheDocument();
  });

  it('selects a release version and lists that deployment changes', async () => {
    const release = deployment({
      id: 'dep-release',
      environment: 'prod',
      ref: 'refs/tags/v1.8.0',
      completed_at: '2026-06-26 09:30:00',
      updated_at: '2026-06-26 09:30:00',
    });
    (api.listDeployments as any).mockResolvedValue({
      deployments: [release, deployment()],
      limit: 100,
      offset: 0,
    });
    (api.getDeployment as any).mockImplementation((_projectId: string, deploymentId: string) =>
      deploymentId === 'dep-release'
        ? Promise.resolve(
            snapshot(
              release,
              [step({ deployment_id: release.id })],
              [
                releaseItem({
                  id: 'ri-release',
                  deployment_id: release.id,
                  card: {
                    id: 'card-release',
                    title: 'Add release dropdown',
                    shortId: 1284,
                    priority: 'medium',
                    columnName: 'Done',
                  },
                  supportTicket: null,
                }),
              ],
            ),
          )
        : Promise.resolve(snapshot()),
    );

    render(<DeploymentsPage projectId="proj-1" onNotify={() => {}} />);

    const releaseSelect = await screen.findByLabelText('Release version');
    expect(
      within(releaseSelect).getByRole('option', { name: /v1\.8\.0 \/ prod/ }),
    ).toBeInTheDocument();

    fireEvent.change(releaseSelect, { target: { value: 'dep-release' } });

    await waitFor(() => expect(api.getDeployment).toHaveBeenCalledWith('proj-1', 'dep-release'));
    expect(await screen.findByText('#1284 Add release dropdown')).toBeInTheDocument();
    expect(screen.getByText('No linked support ticket')).toBeInTheDocument();
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

  it('keeps deployment controls available when release history fails', async () => {
    (api.listDeployments as any).mockRejectedValue(new Error('history unavailable'));

    render(<DeploymentsPage projectId="proj-1" onNotify={() => {}} />);

    const card = await screen.findByTestId('deploy-env-dev');
    expect(within(card).getByRole('button', { name: 'Deploy' })).toBeInTheDocument();
    expect(within(card).getByLabelText('Ref for dev')).toHaveValue('main');
    expect(await screen.findByText('1. build')).toBeInTheDocument();
    expect(screen.queryByLabelText('Release version')).toBeNull();
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

  it('shows release notification history and retries failed notifications', async () => {
    (api.getDeployment as any).mockResolvedValue(
      snapshot(deployment(), [step()], [releaseItem()], [releaseNotification()]),
    );
    const onNotify = vi.fn();
    render(<DeploymentsPage projectId="proj-1" onNotify={onNotify} />);

    expect(await screen.findByText('Notifications')).toBeInTheDocument();
    expect(screen.getAllByText('Release digest').length).toBeGreaterThan(0);
    expect(screen.getByText('SMTP is not configured.')).toBeInTheDocument();
    expect(screen.getByText(/2 attempts/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() =>
      expect(api.retryReleaseNotification).toHaveBeenCalledWith('proj-1', 'dep-1', 'note-1'),
    );
    expect(onNotify).toHaveBeenCalledWith('Release notification queued for retry', 'success');
    await waitFor(() => expect(screen.queryByText('SMTP is not configured.')).toBeNull());
  });

  it('links a release item support ticket to the in-app support hash route (not an absolute path)', async () => {
    // Regression: the link used an absolute `/projects/<id>/support?ticketId=...`
    // href. In the hash-router SPA that triggers a full browser navigation to a
    // path the app does not serve, so the page "opens then immediately goes
    // away" (it bounces back to the default route). The href must stay inside
    // the hash router.
    render(<DeploymentsPage projectId="proj-1" onNotify={() => {}} />);

    const link = await screen.findByRole('link', { name: /Export fails \(ticket-1\)/ });
    const href = link.getAttribute('href') || '';
    // In-app hash route that focuses the exact ticket (parity with mobile).
    expect(href).toBe('#/support/proj-1?ticket=ticket-1');
    // Never an absolute non-hash path (the bug) — that escapes the SPA.
    expect(href.startsWith('/projects/')).toBe(false);
  });

  it('reveals the release digest prompt from a Settings toggle, hidden by default', async () => {
    render(<DeploymentsPage projectId="proj-1" onNotify={() => {}} />);

    await screen.findByTestId('deploy-env-dev');
    expect(screen.queryByTestId('deployments-settings-panel')).toBeNull();
    expect(api.getReleaseNotificationSettings).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));

    expect(await screen.findByTestId('deployments-settings-panel')).toBeInTheDocument();
    expect(await screen.findByText('Release digest prompt')).toBeInTheDocument();
    expect(screen.getByLabelText('Release digest prompt')).toHaveValue(
      'Write a concise customer-facing release digest.',
    );
    await waitFor(() => expect(api.getReleaseNotificationSettings).toHaveBeenCalledWith('proj-1'));

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(screen.queryByTestId('deployments-settings-panel')).toBeNull();
  });

  it('links the dispatched GitHub Actions run and shows its conclusion on a workflow step', async () => {
    (api.getDeployment as any).mockResolvedValue(
      snapshot(deployment(), [
        step({
          name: 'Release',
          github_run_id: '4242',
          github_run_url: 'https://github.com/o/r/actions/runs/4242',
          github_conclusion: 'success',
        }),
      ]),
    );

    render(<DeploymentsPage projectId="proj-1" onNotify={() => {}} />);

    const link = await screen.findByRole('link', { name: /View GitHub Actions run #4242/ });
    expect(link).toHaveAttribute('href', 'https://github.com/o/r/actions/runs/4242');
    expect(screen.getByText(/workflow success/)).toBeInTheDocument();
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

  it('hides the recipients audit affordance for non-admin callers', async () => {
    (hasRole as any).mockReturnValue(false);
    render(<DeploymentsPage projectId="proj-1" onNotify={() => {}} />);

    await screen.findByText('#1227 Fix export crash');
    expect(screen.queryByTestId('show-recipients')).not.toBeInTheDocument();
    expect(api.getDeploymentNotificationRecipients).not.toHaveBeenCalled();
  });

  it('lets an admin load recipient emails on demand', async () => {
    (hasRole as any).mockReturnValue(true);
    (api.getDeploymentNotificationRecipients as any).mockResolvedValue({
      recipients: [
        {
          id: 'rcpt-1',
          deployment_id: 'dep-1',
          release_item_id: null,
          support_ticket_id: 'ticket-1',
          notification_type: 'ticket_release',
          recipient_type: 'reporter',
          recipient_email: 'reporter@example.com',
          subject: 'Your fix shipped',
          status: 'sent',
          attempts: 1,
          sent_at: '2026-06-25 12:05:00',
          next_attempt_at: null,
          error_summary: null,
        },
      ],
    });
    render(<DeploymentsPage projectId="proj-1" onNotify={() => {}} />);

    const showBtn = await screen.findByTestId('show-recipients');
    expect(api.getDeploymentNotificationRecipients).not.toHaveBeenCalled();
    fireEvent.click(showBtn);

    expect(await screen.findByText('reporter@example.com')).toBeInTheDocument();
    expect(api.getDeploymentNotificationRecipients).toHaveBeenCalledWith('proj-1', 'dep-1');
    expect(screen.getByText('1 recipient (1 sent)')).toBeInTheDocument();
  });

  it('live-updates notification history from a release_notification_update WS event', async () => {
    (api.getDeployment as any).mockResolvedValue(
      snapshot(
        deployment(),
        [step()],
        [releaseItem()],
        [releaseNotification({ id: 'note-1', subject: 'Release digest', status: 'error' })],
      ),
    );
    render(<DeploymentsPage projectId="proj-1" onNotify={() => {}} />);

    expect(await screen.findByText('1 recorded')).toBeInTheDocument();

    act(() => {
      window.dispatchEvent(
        new CustomEvent('agenthub-release-notification-ws', {
          detail: {
            type: 'release_notification_update',
            projectId: 'proj-1',
            deploymentId: 'dep-1',
            releaseNotifications: [
              releaseNotification({ id: 'note-1', subject: 'Release digest', status: 'sent' }),
              releaseNotification({ id: 'note-2', subject: 'Your fix shipped', status: 'sent' }),
            ],
          },
        }),
      );
    });

    expect(await screen.findByText('2 recorded')).toBeInTheDocument();
    expect(screen.getByText('Your fix shipped')).toBeInTheDocument();
  });

  it('ignores a release_notification_update for a different deployment', async () => {
    (api.getDeployment as any).mockResolvedValue(
      snapshot(
        deployment(),
        [step()],
        [releaseItem()],
        [releaseNotification({ id: 'note-1', subject: 'Release digest', status: 'error' })],
      ),
    );
    render(<DeploymentsPage projectId="proj-1" onNotify={() => {}} />);

    expect(await screen.findByText('1 recorded')).toBeInTheDocument();

    act(() => {
      window.dispatchEvent(
        new CustomEvent('agenthub-release-notification-ws', {
          detail: {
            type: 'release_notification_update',
            projectId: 'proj-1',
            deploymentId: 'dep-other',
            releaseNotifications: [
              releaseNotification({ id: 'x1' }),
              releaseNotification({ id: 'x2' }),
            ],
          },
        }),
      );
    });

    // Still the original single notification for the open deployment.
    expect(screen.getByText('1 recorded')).toBeInTheDocument();
  });
});
