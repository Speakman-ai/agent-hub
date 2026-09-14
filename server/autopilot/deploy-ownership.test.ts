import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createAutopilotController } from './controller.js';
import { shouldSkipAutopilotDuplicateTrigger } from './deploy-ownership.js';
import { AutopilotStore } from './store.js';
import { ensureAutopilotSchema } from './schema.js';

const PROJECT = 'demo-app';
const ACTOR = { userId: 'user-1' };
const READY = {
  brief: 'Build a disposable todo API.',
  target: {
    targetId: 'local-preview',
    origin: 'http://127.0.0.1:4310',
    readinessProbeUrl: 'http://127.0.0.1:4310/health',
  },
  limits: {
    cycleMode: 'continuous' as const,
    maxWallTimeMs: 60 * 60 * 1000,
    maxStageTimeoutMs: 10 * 60 * 1000,
    maxRetriesPerStage: 2,
  },
  credentialOwnerUserId: 'user-1',
};

describe('shouldSkipAutopilotDuplicateTrigger', () => {
  it('does not skip when no Autopilot run owns the environment', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    ensureAutopilotSchema(db);
    expect(
      shouldSkipAutopilotDuplicateTrigger({
        projectId: PROJECT,
        environment: 'local-preview',
        ref: 'abc',
        db,
      }).skip,
    ).toBe(false);
  });

  it('skips push/schedule for the opted-in experiment target of an active run', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    ensureAutopilotSchema(db);
    const controller = createAutopilotController({
      db,
      isServerEnabled: () => true,
      credentialOwnerExists: () => true,
      holderId: 'hub-a',
      assertContainment: () => undefined,
      issueWorkerCredential: ({ projectId, runId }) => ({
        keyName: `autopilot:${projectId}:${runId}`,
        keyId: `key-${runId}`,
        token: `ahub_worker_${runId}`,
      }),
      revokeWorkerCredential: () => undefined,
    });
    controller.putConfig(PROJECT, { enabled: true, ...READY }, ACTOR);
    controller.start(PROJECT, {}, ACTOR);

    const owned = shouldSkipAutopilotDuplicateTrigger({
      projectId: PROJECT,
      environment: 'local-preview',
      ref: 'deadbeef',
      db,
    });
    expect(owned.skip).toBe(true);
    expect(owned.reason).toMatch(/owns experiment target local-preview/);

    expect(
      shouldSkipAutopilotDuplicateTrigger({
        projectId: PROJECT,
        environment: 'production',
        db,
      }).skip,
    ).toBe(false);
  });

  it('names the cycle SHA when the trigger ref matches the merged revision', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    ensureAutopilotSchema(db);
    const controller = createAutopilotController({
      db,
      isServerEnabled: () => true,
      credentialOwnerExists: () => true,
      holderId: 'hub-a',
      assertContainment: () => undefined,
      issueWorkerCredential: ({ projectId, runId }) => ({
        keyName: `autopilot:${projectId}:${runId}`,
        keyId: `key-${runId}`,
        token: `ahub_worker_${runId}`,
      }),
      revokeWorkerCredential: () => undefined,
    });
    controller.putConfig(PROJECT, { enabled: true, ...READY }, ACTOR);
    const started = controller.start(PROJECT, {}, ACTOR);
    const store = new AutopilotStore(db);
    const cycle = store.getCycle(started.run.id, 1)!;
    store.updateCycle(cycle.id, { testedCommitSha: 'deadbeefcafe' });

    const skip = shouldSkipAutopilotDuplicateTrigger({
      projectId: PROJECT,
      environment: 'local-preview',
      ref: 'deadbeefcafe',
      db,
    });
    expect(skip.skip).toBe(true);
    expect(skip.reason).toMatch(/already owns local-preview at deadbeefcafe/);
  });
});
