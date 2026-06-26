// @ts-nocheck
import { describe, expect, it } from 'vitest';
import {
  deploymentStepLogText,
  deploymentEventFromSnapshot,
  formatDeploymentLogEntry,
  isTerminalDeploymentStatus,
  isMissingDeployConfigError,
  mergeDeploymentConfigWithSnapshot,
  preferredDeploymentFromConfig,
  shortDeploymentRef,
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
});
