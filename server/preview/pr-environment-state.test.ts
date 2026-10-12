import { describe, it, expect } from 'vitest';
import { transitionPrEnvironment, type PrEnvironmentState } from './pr-environment-state.js';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

function state(over: Partial<PrEnvironmentState> = {}): PrEnvironmentState {
  return {
    status: 'ready',
    headSha: SHA_A,
    headBranch: 'fix/login',
    generation: 1,
    url: 'http://pr-1.example',
    runnerRef: 'job-1',
    error: null,
    stopReason: null,
    cleanupPending: false,
    cleanupTarget: null,
    ...over,
  };
}

describe('transitionPrEnvironment', () => {
  it('queues a first build on PR open (no teardown)', () => {
    const t = transitionPrEnvironment(null, { type: 'pr_open', headSha: SHA_A, headBranch: 'x' });
    expect(t.next).toMatchObject({ status: 'queued', headSha: SHA_A, generation: 1 });
    expect(t.effects).toEqual({ teardown: false, build: true });
  });

  it('a replayed open at the same sha is a no-op while active', () => {
    for (const status of ['queued', 'building', 'ready'] as const) {
      const cur = state({ status });
      const t = transitionPrEnvironment(cur, { type: 'pr_open', headSha: SHA_A, headBranch: null });
      expect(t.changed).toBe(false);
      expect(t.next).toBe(cur);
    }
  });

  it('a new head sha rebuilds: new generation, old stack torn down', () => {
    const t = transitionPrEnvironment(state(), {
      type: 'pr_open',
      headSha: SHA_B,
      headBranch: 'fix/login',
    });
    expect(t.next).toMatchObject({ status: 'queued', headSha: SHA_B, generation: 2, url: null });
    expect(t.effects).toEqual({ teardown: true, build: true });
  });

  it('does not loop a failed build on a replayed webhook, but manual start retries it', () => {
    const failed = state({ status: 'failed', url: null, error: 'boom' });
    expect(
      transitionPrEnvironment(failed, { type: 'pr_open', headSha: SHA_A, headBranch: null })
        .changed,
    ).toBe(false);
    const retry = transitionPrEnvironment(failed, {
      type: 'manual_start',
      headSha: SHA_A,
      headBranch: null,
    });
    expect(retry.next).toMatchObject({ status: 'queued', generation: 2, error: null });
    expect(retry.effects).toEqual({ teardown: true, build: true });
  });

  it('merge and close tear down and record the reason', () => {
    const merged = transitionPrEnvironment(state(), { type: 'pr_closed', merged: true });
    expect(merged.next).toMatchObject({ status: 'stopped', stopReason: 'merged', url: null });
    expect(merged.effects).toEqual({ teardown: true, build: false });
    const closed = transitionPrEnvironment(state(), { type: 'pr_closed', merged: false });
    expect(closed.next).toMatchObject({ status: 'stopped', stopReason: 'closed' });
  });

  it('closing a PR that never had an environment leaves no row', () => {
    const t = transitionPrEnvironment(null, { type: 'pr_closed', merged: false });
    expect(t).toMatchObject({ next: null, changed: false });
  });

  it('closing after a manual stop records the PR reason without another teardown', () => {
    const stopped = state({ status: 'stopped', url: null, stopReason: 'manual' });
    const t = transitionPrEnvironment(stopped, { type: 'pr_closed', merged: true });
    expect(t.next).toMatchObject({ status: 'stopped', stopReason: 'merged' });
    expect(t.effects).toEqual({ teardown: false, build: false });
  });

  it('a manually stopped env tracks new commits but does not restart on them', () => {
    const stopped = state({ status: 'stopped', url: null, stopReason: 'manual' });
    const t = transitionPrEnvironment(stopped, {
      type: 'pr_open',
      headSha: SHA_B,
      headBranch: 'fix/login',
    });
    expect(t.next).toMatchObject({ status: 'stopped', headSha: SHA_B, generation: 1 });
    expect(t.effects).toEqual({ teardown: false, build: false });
  });

  it('reopening a closed PR rebuilds', () => {
    const closed = state({ status: 'stopped', url: null, stopReason: 'closed' });
    const t = transitionPrEnvironment(closed, {
      type: 'pr_open',
      headSha: SHA_A,
      headBranch: null,
    });
    expect(t.next).toMatchObject({ status: 'queued', generation: 2, stopReason: null });
    expect(t.effects).toEqual({ teardown: false, build: true });
  });

  it('config_removed stops a running env and records the new head', () => {
    const t = transitionPrEnvironment(state(), {
      type: 'config_removed',
      headSha: SHA_B,
      headBranch: 'fix/login',
    });
    expect(t.next).toMatchObject({
      status: 'stopped',
      stopReason: 'no_preview_config',
      headSha: SHA_B,
    });
    expect(t.effects).toEqual({ teardown: true, build: false });
  });

  it('config_removed on an already-stopped env still tracks the new head', () => {
    const stopped = state({ status: 'stopped', url: null, stopReason: 'manual' });
    const t = transitionPrEnvironment(stopped, {
      type: 'config_removed',
      headSha: SHA_B,
      headBranch: 'fix/login',
    });
    expect(t.next).toMatchObject({ status: 'stopped', headSha: SHA_B });
    expect(t.effects).toEqual({ teardown: false, build: false });
  });

  it('config_unresolved fails at the new head with a new generation and tears down the old build', () => {
    const t = transitionPrEnvironment(state(), {
      type: 'config_unresolved',
      headSha: SHA_B,
      headBranch: null,
      error: 'unreadable',
    });
    expect(t.next).toMatchObject({
      status: 'failed',
      headSha: SHA_B,
      generation: 2,
      error: 'unreadable',
      url: null,
    });
    expect(t.effects).toEqual({ teardown: true, build: false });
    // First sighting creates an explicit failed row.
    expect(
      transitionPrEnvironment(null, {
        type: 'config_unresolved',
        headSha: SHA_B,
        headBranch: 'x',
        error: 'unreadable',
      }).next,
    ).toMatchObject({ status: 'failed', headSha: SHA_B, generation: 1 });
  });

  it('runtime callbacks advance queued → building → ready for the current generation', () => {
    const queued = state({ status: 'queued', url: null, runnerRef: null, generation: 3 });
    const building = transitionPrEnvironment(queued, {
      type: 'runtime_building',
      generation: 3,
      runnerRef: 'runner-7',
    }).next!;
    expect(building).toMatchObject({ status: 'building', runnerRef: 'runner-7' });
    const ready = transitionPrEnvironment(building, {
      type: 'runtime_ready',
      generation: 3,
      url: 'http://x',
    }).next!;
    expect(ready).toMatchObject({ status: 'ready', url: 'http://x' });
  });

  it('ignores callbacks from a superseded generation', () => {
    const queued = state({ status: 'queued', generation: 2, url: null });
    for (const event of [
      { type: 'runtime_building', generation: 1, runnerRef: null } as const,
      { type: 'runtime_ready', generation: 1, url: 'http://old' } as const,
      { type: 'runtime_failed', generation: 1, error: 'old' } as const,
    ]) {
      expect(transitionPrEnvironment(queued, event).changed).toBe(false);
    }
  });

  it('a stopped env cannot be flipped to ready or failed by a late callback', () => {
    const stopped = state({ status: 'stopped', url: null, stopReason: 'manual' });
    expect(
      transitionPrEnvironment(stopped, { type: 'runtime_ready', generation: 1, url: 'http://x' })
        .changed,
    ).toBe(false);
    expect(
      transitionPrEnvironment(stopped, { type: 'runtime_failed', generation: 1, error: 'x' })
        .changed,
    ).toBe(false);
  });

  it('stopping marks cleanup pending until the runtime confirms the teardown', () => {
    const stopped = transitionPrEnvironment(state(), { type: 'manual_stop' }).next!;
    expect(stopped).toMatchObject({ status: 'stopped', cleanupPending: true });
    const done = transitionPrEnvironment(stopped, { type: 'teardown_done' });
    expect(done.next).toMatchObject({ cleanupPending: false });
  });

  it('a stop or close on a stopped env with failed cleanup retries the teardown', () => {
    const pending = state({
      status: 'stopped',
      url: null,
      stopReason: 'manual',
      cleanupPending: true,
    });
    expect(transitionPrEnvironment(pending, { type: 'manual_stop' }).effects).toEqual({
      teardown: true,
      build: false,
    });
    const closed = transitionPrEnvironment(pending, { type: 'pr_closed', merged: false });
    expect(closed.next).toMatchObject({ stopReason: 'closed' });
    expect(closed.effects.teardown).toBe(true);
    // Fully cleaned up: nothing to retry.
    const clean = state({ status: 'stopped', url: null, stopReason: 'manual' });
    expect(transitionPrEnvironment(clean, { type: 'manual_stop' }).effects.teardown).toBe(false);
  });

  it('a failed teardown blocks the waiting replacement build (queued → failed)', () => {
    const queued = state({ status: 'queued', url: null, cleanupPending: true, generation: 2 });
    const t = transitionPrEnvironment(queued, { type: 'teardown_failed', error: 'docker down' });
    expect(t.next).toMatchObject({
      status: 'failed',
      cleanupPending: true,
      error: 'Teardown failed: docker down',
    });
  });

  it('rebuilding over a stopped env with failed cleanup tears down first', () => {
    const pending = state({
      status: 'stopped',
      url: null,
      stopReason: 'closed',
      cleanupPending: true,
    });
    const t = transitionPrEnvironment(pending, {
      type: 'pr_open',
      headSha: SHA_B,
      headBranch: null,
    });
    expect(t.effects).toEqual({ teardown: true, build: true });
    expect(t.next).toMatchObject({ status: 'queued', cleanupPending: true });
  });

  it('a rebuild records the live runner as the cleanup target until teardown is confirmed', () => {
    const t = transitionPrEnvironment(state({ runnerRef: 'runner-A' }), {
      type: 'pr_open',
      headSha: SHA_B,
      headBranch: null,
    });
    expect(t.next).toMatchObject({ runnerRef: null, cleanupPending: true });
    expect(t.next!.cleanupTarget).toMatchObject({
      runnerRef: 'runner-A',
      headSha: SHA_A,
      generation: 1,
    });

    const failed = transitionPrEnvironment(t.next, { type: 'teardown_failed', error: 'x' }).next!;
    expect(failed.cleanupTarget).toMatchObject({ runnerRef: 'runner-A' });

    // A further rebuild before the teardown is confirmed keeps the oldest target.
    const again = transitionPrEnvironment(failed, {
      type: 'manual_start',
      headSha: SHA_B,
      headBranch: null,
    }).next!;
    expect(again.cleanupTarget).toMatchObject({ runnerRef: 'runner-A' });

    const done = transitionPrEnvironment(again, { type: 'teardown_done' }).next!;
    expect(done).toMatchObject({ cleanupPending: false, cleanupTarget: null });
  });

  it('a manual stop replaces no_preview_config, but never a closed/merged tombstone', () => {
    const noConfig = state({ status: 'stopped', url: null, stopReason: 'no_preview_config' });
    expect(transitionPrEnvironment(noConfig, { type: 'manual_stop' }).next).toMatchObject({
      stopReason: 'manual',
    });
    for (const terminal of ['closed', 'merged'] as const) {
      const t = transitionPrEnvironment(
        state({ status: 'stopped', url: null, stopReason: terminal }),
        {
          type: 'manual_stop',
        },
      );
      expect(t.next).toMatchObject({ stopReason: terminal });
      expect(t.changed).toBe(false);
    }
  });

  it('an open at the same head rebuilds a row that failed only because its head was unreadable', () => {
    const unread = state({
      status: 'failed',
      url: null,
      error: 'Could not read head commit aaaaaaaaaaaa to check its `preview:` block.',
    });
    expect(
      transitionPrEnvironment(unread, { type: 'pr_open', headSha: SHA_A, headBranch: null }).next,
    ).toMatchObject({ status: 'queued', error: null });
    // A real build failure at the same head is still not looped by replays.
    const broken = state({ status: 'failed', url: null, error: 'compose up exited 1' });
    expect(
      transitionPrEnvironment(broken, { type: 'pr_open', headSha: SHA_A, headBranch: null })
        .changed,
    ).toBe(false);
  });
});

describe('runtime_lost', () => {
  it('requeues a lost ready environment at the same head, tearing down the old runner', () => {
    const t = transitionPrEnvironment(state(), {
      type: 'runtime_lost',
      generation: 1,
      error: 'runner lost',
      requeue: true,
    });
    expect(t.next).toMatchObject({
      status: 'queued',
      headSha: SHA_A,
      generation: 2,
      url: null,
      runnerRef: null,
      error: 'runner lost',
      cleanupPending: true,
      cleanupTarget: { generation: 1, runnerRef: 'job-1' },
    });
    expect(t.effects).toEqual({ teardown: true, build: true });
  });

  it('fails without requeue once the budget is spent', () => {
    const t = transitionPrEnvironment(state({ status: 'building' }), {
      type: 'runtime_lost',
      generation: 1,
      error: 'lost again',
      requeue: false,
    });
    expect(t.next).toMatchObject({
      status: 'failed',
      generation: 1,
      error: 'lost again',
      cleanupPending: true,
    });
    expect(t.effects).toEqual({ teardown: true, build: false });
  });

  it('ignores a loss from a superseded generation or an inactive row', () => {
    const stale = transitionPrEnvironment(state({ generation: 3 }), {
      type: 'runtime_lost',
      generation: 2,
      error: 'x',
      requeue: true,
    });
    expect(stale.changed).toBe(false);
    const stopped = transitionPrEnvironment(state({ status: 'stopped' }), {
      type: 'runtime_lost',
      generation: 1,
      error: 'x',
      requeue: true,
    });
    expect(stopped.changed).toBe(false);
  });

  it('a ready report after the requeue clears the loss message', () => {
    const lost = transitionPrEnvironment(state(), {
      type: 'runtime_lost',
      generation: 1,
      error: 'runner lost',
      requeue: true,
    }).next!;
    const ready = transitionPrEnvironment(lost, { type: 'runtime_ready', generation: 2, url: 'u' });
    expect(ready.next).toMatchObject({ status: 'ready', error: null });
  });
});
