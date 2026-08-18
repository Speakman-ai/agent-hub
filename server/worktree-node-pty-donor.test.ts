/**
 * Regression: session worktrees on a host without a C toolchain cannot build
 * node-pty (no linux-x64 prebuild). The `postinstall` healer
 * (`scripts/ensure-native-modules.mjs`) copies a compatible prebuilt from a
 * donor named by `AGENT_HUB_NODE_PTY_DONOR`. The Hub must point that donor at
 * THIS server's own node-pty so the Terminal keeps working regardless of where
 * the Hub is installed (Docker `/app`, PM2 `~/projects/agent-hub`, …), while
 * still letting an operator override it. `installChildEnv` (the env
 * `setupDependencies` hands to `exec`) is built at module load from
 * `process.env`, so the operator-override integration case sets the var BEFORE
 * importing worktree.js — and restores it after, since process.env is shared
 * across the Vitest worker.
 */
import { afterAll, describe, expect, it } from 'vitest';

import { nodePtyDonorEnvOverride, resolveHostNodePtyDonor } from './worktree.js';

describe('resolveHostNodePtyDonor', () => {
  it('returns the module dir of the resolved node-pty package', () => {
    const donor = resolveHostNodePtyDonor(
      () => '/opt/hub/server/node_modules/node-pty/package.json',
    );
    expect(donor).toBe('/opt/hub/server/node_modules/node-pty');
  });

  it('returns null when node-pty cannot be resolved (server has none to donate)', () => {
    const donor = resolveHostNodePtyDonor(() => {
      throw new Error('Cannot find module');
    });
    expect(donor).toBeNull();
  });

  it('resolves this running server’s own node-pty via the default resolver', () => {
    // The worktree ships a compiled node-pty; the default resolver must find it.
    const donor = resolveHostNodePtyDonor();
    expect(donor).not.toBeNull();
    expect(donor).toMatch(/[/\\]node_modules[/\\]node-pty$/);
  });
});

describe('nodePtyDonorEnvOverride', () => {
  it('defaults the donor to this server’s node-pty when the operator did not set one', () => {
    expect(nodePtyDonorEnvOverride({}, '/app/server/node_modules/node-pty')).toEqual({
      AGENT_HUB_NODE_PTY_DONOR: '/app/server/node_modules/node-pty',
    });
  });

  it('lets an operator-provided AGENT_HUB_NODE_PTY_DONOR win over the default', () => {
    // Operator value already rides through the process.env spread, so the patch
    // must be empty to avoid clobbering it with the server default.
    expect(
      nodePtyDonorEnvOverride(
        { AGENT_HUB_NODE_PTY_DONOR: '/custom/donor' },
        '/app/server/node_modules/node-pty',
      ),
    ).toEqual({});
  });

  it('contributes nothing when neither an operator value nor a host donor exists', () => {
    expect(nodePtyDonorEnvOverride({}, null)).toEqual({});
  });

  it('does not override when the operator set a value even if there is no host donor', () => {
    expect(nodePtyDonorEnvOverride({ AGENT_HUB_NODE_PTY_DONOR: '/x' }, null)).toEqual({});
  });
});

describe('installChildEnv node-pty donor wiring (module load)', () => {
  const prior = process.env.AGENT_HUB_NODE_PTY_DONOR;

  afterAll(() => {
    if (prior === undefined) delete process.env.AGENT_HUB_NODE_PTY_DONOR;
    else process.env.AGENT_HUB_NODE_PTY_DONOR = prior;
  });

  it('carries a node-pty donor into the session-install env', async () => {
    const { __test } = await import('./worktree.js');
    const donor = __test.installChildEnv.AGENT_HUB_NODE_PTY_DONOR;
    // Either an operator value (if the worker env had one) or this server's own
    // node-pty — but never absent on a host that ships node-pty (this worktree
    // does), so the healer always has a concrete donor to copy from.
    expect(donor).toBeTruthy();
    expect(donor).toBe(prior ?? resolveHostNodePtyDonor());
  });
});
