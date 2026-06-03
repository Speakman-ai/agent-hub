import { describe, it, expect, vi } from 'vitest';
import {
  runFinalizeReaper,
  type FinalizeReaperDocker,
  type FinalizeContainerInfo,
} from './finalize-reaper.js';

const NOW = 1_700_000_000_000;
const silent = { log: () => {}, warn: () => {} };

function makeDocker(over: Partial<FinalizeReaperDocker> = {}): FinalizeReaperDocker {
  return {
    listFinalizeContainers: vi.fn(async () => [] as FinalizeContainerInfo[]),
    listFinalizeGraphVolumes: vi.fn(async () => [] as string[]),
    removeContainer: vi.fn(async () => {}),
    removeVolume: vi.fn(async () => {}),
    ...over,
  };
}

describe('finalize-reaper', () => {
  it('reaps a container whose run is terminal/absent and past the grace window', async () => {
    const docker = makeDocker({
      listFinalizeContainers: vi.fn(async () => [
        { name: 'finalize-old-e2e-core', runId: 'old', createdAtMs: NOW - 5 * 60_000 },
      ]),
    });
    const res = await runFinalizeReaper({
      activeRunIds: () => new Set(['live']),
      docker,
      now: () => NOW,
      logger: silent,
    });
    expect(docker.removeContainer).toHaveBeenCalledWith('finalize-old-e2e-core');
    expect(res.containersReaped).toEqual(['finalize-old-e2e-core']);
    expect(res.skipped).toBe(0);
  });

  it('never touches a container belonging to an active run', async () => {
    const docker = makeDocker({
      listFinalizeContainers: vi.fn(async () => [
        { name: 'finalize-live-e2e-core', runId: 'live', createdAtMs: NOW - 10 * 60_000 },
      ]),
    });
    const res = await runFinalizeReaper({
      activeRunIds: () => new Set(['live']),
      docker,
      now: () => NOW,
      logger: silent,
    });
    expect(docker.removeContainer).not.toHaveBeenCalled();
    expect(res.skipped).toBe(1);
  });

  it('skips a young container within the grace window even if its run is gone', async () => {
    const docker = makeDocker({
      listFinalizeContainers: vi.fn(async () => [
        { name: 'finalize-new-backend', runId: 'gone', createdAtMs: NOW - 10_000 },
      ]),
    });
    const res = await runFinalizeReaper({
      activeRunIds: () => new Set(),
      docker,
      now: () => NOW,
      logger: silent,
    });
    expect(docker.removeContainer).not.toHaveBeenCalled();
    expect(res.skipped).toBe(1);
  });

  it('sweeps orphaned graph volumes but leaves in-use ones (active run)', async () => {
    const docker = makeDocker({
      listFinalizeGraphVolumes: vi.fn(async () => ['finalize-a-graph', 'finalize-live-graph']),
      removeVolume: vi.fn(async (name: string) => {
        if (name === 'finalize-live-graph') throw new Error('volume is in use');
      }),
    });
    const res = await runFinalizeReaper({
      activeRunIds: () => new Set(['live']),
      docker,
      now: () => NOW,
      logger: silent,
    });
    expect(res.volumesReaped).toEqual(['finalize-a-graph']);
  });

  it('continues the sweep when an individual container removal throws', async () => {
    const docker = makeDocker({
      listFinalizeContainers: vi.fn(async () => [
        { name: 'finalize-x-backend', runId: 'gone', createdAtMs: NOW - 5 * 60_000 },
      ]),
      removeContainer: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    const res = await runFinalizeReaper({
      activeRunIds: () => new Set(),
      docker,
      now: () => NOW,
      logger: silent,
    });
    // Failure is swallowed (best-effort): not counted, no throw.
    expect(res.containersReaped).toEqual([]);
  });
});
