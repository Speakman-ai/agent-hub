import { describe, it, expect, vi } from 'vitest';
import {
  createRumLifecycleState,
  toLifecycleProjectOverrides,
  reconcileRumLifecycle,
} from './rum-lifecycle-reconciler.js';
import { rumProjectRuleId } from './replay-lifecycle.js';
import { buildProjectStoragePrefix } from './segment-store.js';
import type { provisionRumLifecycle } from './replay-lifecycle-s3.js';
import type { AppConfig } from '../types.js';

const project = (id: string, retentionDays?: number) => ({
  id,
  replay: retentionDays === undefined ? undefined : { retentionDays },
});

/** A provisioner stub matching provisionRumLifecycle's outcome shape. */
function provisionStub(outcome: { provisioned: boolean }) {
  return vi
    .fn()
    .mockResolvedValue({ applied: true, ...outcome }) as unknown as typeof provisionRumLifecycle;
}

describe('toLifecycleProjectOverrides', () => {
  it('maps overrides to prefix + retentionDays + managed rule id', () => {
    expect(toLifecycleProjectOverrides([{ projectId: 'acme', retentionDays: 7 }])).toEqual([
      {
        prefix: buildProjectStoragePrefix('acme'),
        retentionDays: 7,
        ruleId: rumProjectRuleId('acme'),
      },
    ]);
  });
});

describe('reconcileRumLifecycle', () => {
  it('provisions the current override set and records per-project confirmation', async () => {
    const state = createRumLifecycleState();
    const provision = provisionStub({ provisioned: true });
    await reconcileRumLifecycle({
      config: { replayRetentionDays: 30 } as unknown as AppConfig,
      getProjects: () => [project('acme', 7), project('other')],
      state,
      provision,
    });
    // Only the tightened tenant gets a per-prefix rule spec.
    expect(provision).toHaveBeenCalledWith(
      expect.objectContaining({
        projectOverrides: [
          {
            prefix: buildProjectStoragePrefix('acme'),
            retentionDays: 7,
            ruleId: rumProjectRuleId('acme'),
          },
        ],
      }),
    );
    expect(state.provisioned).toBe(true);
    expect([...state.provisionedProjects]).toEqual(['acme']);
  });

  it('confirms NOTHING when provisioning is unconfirmed (local storage / IAM failure)', async () => {
    const state = createRumLifecycleState();
    // Seed stale confirmation to prove it is cleared, not left dangling.
    state.provisioned = true;
    state.provisionedProjects = new Set(['stale']);
    const provision = provisionStub({ provisioned: false });
    await reconcileRumLifecycle({
      config: { replayRetentionDays: 30 } as unknown as AppConfig,
      getProjects: () => [project('acme', 7)],
      state,
      provision,
    });
    // Unconfirmed ⇒ the sweeper must keep deleting bytes itself; trust nothing.
    expect(state.provisioned).toBe(false);
    expect(state.provisionedProjects.size).toBe(0);
  });

  it('reflects a CHANGED override set on re-run (reconcile-on-change)', async () => {
    const state = createRumLifecycleState();
    const provision = provisionStub({ provisioned: true });
    let projects = [project('acme', 7)];
    const deps = {
      config: { replayRetentionDays: 30 } as unknown as AppConfig,
      getProjects: () => projects,
      state,
      provision,
    };
    await reconcileRumLifecycle(deps);
    expect([...state.provisionedProjects]).toEqual(['acme']);

    // Operator swaps the override: acme removed, globex added.
    projects = [project('globex', 14)];
    await reconcileRumLifecycle(deps);
    expect([...state.provisionedProjects]).toEqual(['globex']);
    expect(provision).toHaveBeenLastCalledWith(
      expect.objectContaining({
        projectOverrides: [
          {
            prefix: buildProjectStoragePrefix('globex'),
            retentionDays: 14,
            ruleId: rumProjectRuleId('globex'),
          },
        ],
      }),
    );
  });
});
