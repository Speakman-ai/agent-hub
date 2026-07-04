// @ts-nocheck
import { describe, expect, it } from 'vitest';
import {
  applyReleaseNotificationEvent,
  deploymentStepLogText,
  deploymentEventFromSnapshot,
  formatDeploymentLogEntry,
  isTerminalDeploymentStatus,
  isMissingDeployConfigError,
  loadReleaseVersionDeployments,
  mergeDeploymentConfigWithSnapshot,
  preferredDeploymentFromConfig,
  releaseItemCardLabel,
  releaseNotificationRecipientLabel,
  releaseNotificationStatusLabel,
  releaseItemStatusLabel,
  releaseItemSupportLabel,
  releaseVersionDeployments,
  releaseVersionLabel,
  shortDeploymentRef,
  environmentStatus,
  hasRuntimeConfig,
  sortEnvironmentsForDisplay,
} from './deployments';

function deployment(overrides = {}) {
  return {
    id: 'dep-1',
    environment: 'prod',
    ref: 'abcdef1234567890',
    status: 'running',
    updated_at: '2026-06-25 12:00:00',
    ...overrides,
  };
}

function config(envOverrides = {}) {
  return {
    environments: [
      {
        name: 'prod',
        currentRef: 'live-ref',
        currentDeploymentId: 'dep-live',
        currentDeployment: deployment({ id: 'dep-live', ref: 'live-ref', status: 'success' }),
        activeDeploymentId: null,
        activeDeployment: null,
        lastDeployment: null,
        rollbackTarget: null,
        ...envOverrides,
      },
    ],
  };
}

describe('deployment state helpers', () => {
  it('identifies terminal deployment statuses', () => {
    expect(isTerminalDeploymentStatus('success')).toBe(true);
    expect(isTerminalDeploymentStatus('error')).toBe(true);
    expect(isTerminalDeploymentStatus('cancelled')).toBe(true);
    expect(isTerminalDeploymentStatus('running')).toBe(false);
    expect(isTerminalDeploymentStatus('awaiting_approval')).toBe(false);
  });

  it('keeps active deployment state for in-flight snapshots', () => {
    const next = mergeDeploymentConfigWithSnapshot(config(), {
      deployment: deployment({ id: 'dep-running', status: 'running' }),
    });

    expect(next.environments[0].activeDeploymentId).toBe('dep-running');
    expect(next.environments[0].activeDeployment.status).toBe('running');
    expect(next.environments[0].currentRef).toBe('live-ref');
    expect(next.environments[0].lastDeployment.id).toBe('dep-running');
  });

  it('promotes successful snapshots to the current live ref and rollback target', () => {
    const next = mergeDeploymentConfigWithSnapshot(config(), {
      deployment: deployment({ id: 'dep-success', ref: 'new-ref', status: 'success' }),
    });

    expect(next.environments[0].activeDeploymentId).toBeNull();
    expect(next.environments[0].currentRef).toBe('new-ref');
    expect(next.environments[0].currentDeploymentId).toBe('dep-success');
    expect(next.environments[0].currentDeployment.id).toBe('dep-success');
    expect(next.environments[0].rollbackTarget.id).toBe('dep-live');
  });

  it('prefers active runs over last runs for initial selection', () => {
    expect(
      preferredDeploymentFromConfig(
        config({
          activeDeployment: deployment({ id: 'dep-active', status: 'awaiting_approval' }),
          lastDeployment: deployment({ id: 'dep-last', status: 'success' }),
        }),
      ).id,
    ).toBe('dep-active');
  });

  it('falls back to the newest last deployment for initial selection', () => {
    expect(
      preferredDeploymentFromConfig(
        config({
          activeDeployment: null,
          lastDeployment: deployment({ id: 'dep-last', status: 'success' }),
        }),
      ).id,
    ).toBe('dep-last');
  });

  it('creates live-stream event rows from deployment snapshots', () => {
    expect(
      deploymentEventFromSnapshot(
        { deployment: deployment({ id: 'dep-ws', environment: 'dev', status: 'running' }) },
        '2026-06-25T12:00:00.000Z',
      ),
    ).toEqual({
      id: 'dep-ws-running-2026-06-25T12:00:00.000Z',
      deploymentId: 'dep-ws',
      environment: 'dev',
      status: 'running',
      ref: 'abcdef1234567890',
      at: '2026-06-25T12:00:00.000Z',
    });
  });

  it('shortens refs for dense mobile cards', () => {
    expect(shortDeploymentRef('abcdef1234567890')).toBe('abcdef123456');
    expect(shortDeploymentRef('short')).toBe('short');
    expect(shortDeploymentRef('')).toBe('-');
  });

  it('identifies the missing deploy.yaml setup state', () => {
    expect(
      isMissingDeployConfigError(
        new Error('404: deploy.yaml not found at /repo/.agent-hub/deploy.yaml.'),
      ),
    ).toBe(true);
    expect(isMissingDeployConfigError(new Error('500: failed to read config'))).toBe(false);
  });

  it('formats structured log entries without [object Object]', () => {
    const text = formatDeploymentLogEntry([
      { stream: 'stdout', text: 'building' },
      { stream: 'stderr', text: { message: 'failed', code: 2 } },
    ]);

    expect(text).toContain('[stdout] building');
    expect(text).toContain('[stderr] {');
    expect(text).toContain('"message": "failed"');
    expect(text).not.toContain('[object Object]');
  });

  it('collects log text from per-step output fields', () => {
    const text = deploymentStepLogText({
      id: 'step-1',
      output: [{ stream: 'stdout', text: 'deployed' }],
      stderr: 'warning',
    });

    expect(text).toContain('[stdout] deployed');
    expect(text).toContain('[stderr] warning');
  });

  it('collects matching deployment detail log entries for a step', () => {
    const text = deploymentStepLogText(
      { id: 'step-1', step_order: 2, name: 'ship' },
      [
        { deployment_step_id: 'step-1', stream: 'stdout', text: 'ship started' },
        { step_order: 2, stream: 'stderr', text: 'ship warning' },
        { deployment_step_id: 'other', stream: 'stdout', text: 'ignore me' },
      ],
    );

    expect(text).toContain('[stdout] ship started');
    expect(text).toContain('[stderr] ship warning');
    expect(text).not.toContain('ignore me');
  });

  it('formats deployment release item labels', () => {
    const item = {
      inclusion_status: 'excluded',
      card: { shortId: 1227, title: 'Fix customer export' },
      supportTicket: { id: 'ticket-1', subject: 'Export fails' },
    };

    expect(releaseItemStatusLabel(item)).toBe('Excluded');
    expect(releaseItemCardLabel(item)).toBe('#1227 Fix customer export');
    expect(releaseItemSupportLabel(item)).toBe('Export fails (ticket-1)');
    expect(releaseItemStatusLabel({ inclusion_status: 'included' })).toBe('Included');
    expect(releaseItemSupportLabel({ support_ticket_id: null })).toBe('No support ticket');
  });

  it('builds successful release version picker options', () => {
    const success = deployment({
      id: 'dep-release',
      ref: 'refs/tags/v1.8.0',
      status: 'success',
    });
    const running = deployment({ id: 'dep-running', ref: 'main', status: 'running' });

    expect(releaseVersionDeployments([running, success])).toEqual([success]);
    expect(releaseVersionLabel(success)).toBe('v1.8.0 · prod');
  });

  // The pure deploymentReleaseLabel resolution is unit-tested in
  // shared/utils/deploymentReleaseLabel.test.ts (single source of truth); here we
  // only assert the mobile releaseVersionLabel wiring consumes it.
  it('releaseVersionLabel shows a short hash for a SHA deploy without a version', () => {
    expect(
      releaseVersionLabel({
        ref: 'f27b422fdeadbeef1234567890abcdef12345678',
        environment: 'production',
        status: 'success',
        meta: null,
      }),
    ).toBe('f27b422fdead · production');
  });

  it('degrades release version history failures to an empty picker', async () => {
    await expect(
      loadReleaseVersionDeployments(() => Promise.reject(new Error('history unavailable'))),
    ).resolves.toEqual([]);
  });

  it('formats release notification labels', () => {
    expect(releaseNotificationRecipientLabel({ recipient_type: 'reporter' })).toBe('Reporter');
    expect(releaseNotificationRecipientLabel({ recipient_type: 'release_digest' })).toBe(
      'Release digest',
    );
    expect(releaseNotificationStatusLabel({ status: 'sending' })).toBe('sending');
  });

  it('derives environment management status from active/enabled', () => {
    expect(environmentStatus({ active: true, enabled: true })).toBe('deployable');
    expect(environmentStatus({ active: true, enabled: false })).toBe('paused');
    expect(environmentStatus({ active: false, enabled: true })).toBe('orphaned');
    expect(environmentStatus({ active: false, enabled: false })).toBe('orphaned');
  });

  it('detects a removable runtime config row', () => {
    expect(hasRuntimeConfig({ config: { id: 'c1' } })).toBe(true);
    expect(hasRuntimeConfig({ config: null })).toBe(false);
  });

  it('sorts declared environments ahead of orphaned rows, each alphabetical', () => {
    const input = [
      { name: 'zeta', active: true },
      { name: 'legacy', active: false },
      { name: 'alpha', active: true },
    ];
    expect(sortEnvironmentsForDisplay(input).map((e) => e.name)).toEqual([
      'alpha',
      'zeta',
      'legacy',
    ]);
  });
});

describe('applyReleaseNotificationEvent', () => {
  const prev = {
    deployment: { id: 'dep-1' },
    releaseNotifications: [{ id: 'note-1', status: 'error' }],
  };

  it('patches notification history for the open deployment', () => {
    const event = {
      projectId: 'proj-1',
      deploymentId: 'dep-1',
      releaseNotifications: [
        { id: 'note-1', status: 'sent' },
        { id: 'note-2', status: 'sent' },
      ],
    };
    const next = applyReleaseNotificationEvent(prev, event, 'proj-1', 'dep-1');
    expect(next).not.toBe(prev);
    expect(next.releaseNotifications).toHaveLength(2);
    expect(next.deployment).toBe(prev.deployment);
  });

  it('ignores events for another project or deployment', () => {
    const other = { projectId: 'proj-2', deploymentId: 'dep-1', releaseNotifications: [] };
    expect(applyReleaseNotificationEvent(prev, other, 'proj-1', 'dep-1')).toBe(prev);
    const otherDep = { projectId: 'proj-1', deploymentId: 'dep-9', releaseNotifications: [] };
    expect(applyReleaseNotificationEvent(prev, otherDep, 'proj-1', 'dep-1')).toBe(prev);
  });

  it('ignores events when no deployment is open or the ids differ', () => {
    const event = { projectId: 'proj-1', deploymentId: 'dep-1', releaseNotifications: [] };
    expect(applyReleaseNotificationEvent(prev, event, 'proj-1', null)).toBe(prev);
    expect(applyReleaseNotificationEvent(null, event, 'proj-1', 'dep-1')).toBe(null);
  });

  it('defaults a missing notification list to empty', () => {
    const event = { projectId: 'proj-1', deploymentId: 'dep-1' };
    expect(applyReleaseNotificationEvent(prev, event, 'proj-1', 'dep-1').releaseNotifications).toEqual(
      [],
    );
  });
});
