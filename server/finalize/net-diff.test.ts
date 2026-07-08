import { describe, expect, it, vi } from 'vitest';
import { hasPublishableChanges, type NetDiffProbe } from './net-diff.js';

describe('hasPublishableChanges', () => {
  const clean = { hasUncommitted: false, hasUnpushed: false };
  const unpushed = { hasUncommitted: false, hasUnpushed: true };
  const dirty = { hasUncommitted: true, hasUnpushed: false };

  it('is false for a clean, fully-pushed worktree (no probe)', async () => {
    const probe = vi.fn<NetDiffProbe>();
    expect(await hasPublishableChanges('/wt', clean, probe)).toBe(false);
    expect(probe).not.toHaveBeenCalled();
  });

  it('is true for a dirty worktree without probing the base', async () => {
    const probe = vi.fn<NetDiffProbe>(async () => false);
    expect(await hasPublishableChanges('/wt', dirty, probe)).toBe(true);
    expect(probe).not.toHaveBeenCalled();
  });

  it('is true when unpushed commits produce a net diff vs base', async () => {
    expect(await hasPublishableChanges('/wt', unpushed, async () => true)).toBe(true);
  });

  it('is false when unpushed commits net to zero vs base', async () => {
    // The "Finalize kicked off for an empty diff" case: commits exist but add
    // nothing to base (commit+revert / already integrated).
    expect(await hasPublishableChanges('/wt', unpushed, async () => false)).toBe(false);
  });

  it('fails open (true) when the net diff is undeterminable', async () => {
    expect(await hasPublishableChanges('/wt', unpushed, async () => null)).toBe(true);
  });
});
