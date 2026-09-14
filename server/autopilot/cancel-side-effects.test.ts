import { describe, it, expect, beforeEach } from 'vitest';
import { getDb } from '../db.js';
import { wipeTables } from '../test/destructive-db.js';
import {
  acquireEnvironmentLock,
  addDeploymentStep,
  createDeployment,
  ensureDeploymentEnvironment,
  getDeployment,
  getDeploymentEnvironment,
  listDeploymentSteps,
  updateDeploymentStatus,
} from '../deploy/deployment-store.js';
import { cancelAutopilotSideEffects } from './cancel-side-effects.js';
import type { AutopilotCancelRefs } from './types.js';

const PROJECT = 'autopilot-cancel-proj';

const EMPTY_REFS: AutopilotCancelRefs = {
  sessionIds: [],
  finalizeRunIds: [],
  deploymentIds: [],
  operationIds: [],
};

describe('cancelAutopilotSideEffects', () => {
  beforeEach(() => {
    wipeTables(getDb(), ['deployment_steps', 'deployments', 'deployment_environments']);
  });

  it('cancels a running deployment through the production side-effect handler', () => {
    const deployment = createDeployment({
      projectId: PROJECT,
      environment: 'dev',
      ref: 'sha-live',
    });
    ensureDeploymentEnvironment(PROJECT, 'dev');
    expect(acquireEnvironmentLock(PROJECT, 'dev', deployment.id)).toBe(true);
    updateDeploymentStatus(deployment.id, 'running');
    addDeploymentStep({
      deploymentId: deployment.id,
      name: 'ship',
      stepOrder: 0,
      status: 'running',
    });

    const result = cancelAutopilotSideEffects(
      { ...EMPTY_REFS, deploymentIds: [deployment.id], operationIds: ['op-1'] },
      { activeProcesses: new Map() },
    );
    expect(result).toEqual([]);

    expect(getDeployment(deployment.id)?.status).toBe('cancelled');
    expect(listDeploymentSteps(deployment.id).map((step) => step.status)).toEqual(['cancelled']);
    expect(getDeploymentEnvironment(PROJECT, 'dev')?.active_deployment_id).toBeNull();
  });

  it('is a no-op for an already terminal deployment', () => {
    const deployment = createDeployment({
      projectId: PROJECT,
      environment: 'dev',
      ref: 'sha-done',
    });
    updateDeploymentStatus(deployment.id, 'success');

    const result = cancelAutopilotSideEffects(
      { ...EMPTY_REFS, deploymentIds: [deployment.id] },
      { activeProcesses: new Map() },
    );
    expect(result).toEqual([]);
    expect(getDeployment(deployment.id)?.status).toBe('success');
  });

  it('returns unexpected deployment cancellation failures instead of swallowing them', () => {
    const failures = cancelAutopilotSideEffects(
      { ...EMPTY_REFS, deploymentIds: ['dep-boom'] },
      {
        activeProcesses: new Map(),
        cancelDeployment: () => {
          throw new Error('deploy backend unavailable');
        },
      },
    );
    expect(failures).toEqual([
      {
        kind: 'deployment',
        id: 'dep-boom',
        message: 'deploy backend unavailable',
      },
    ]);
  });
});
