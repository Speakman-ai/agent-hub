import { describe, expect, it } from 'vitest';
import type { SysboxRunFn, SysboxRunResult } from '../session-env/sysbox-session-env.js';
import {
  parseDockerCreatedAt,
  previewNetworkReclaimEnabled,
  reclaimIdleDockerNetworks,
} from './docker-network-reclaim.js';

const NOW = Date.parse('2026-11-04T18:00:00Z');

function fakeDocker(opts: {
  listed: string;
  members?: Record<string, string>;
  rmFails?: Record<string, string>;
  listFails?: boolean;
}) {
  const calls: string[][] = [];
  const run: SysboxRunFn = async (argv): Promise<SysboxRunResult> => {
    calls.push(argv);
    if (argv[1] === 'network' && argv[2] === 'ls') {
      return opts.listFails
        ? { ok: false, stdout: '', stderr: 'daemon down' }
        : { ok: true, stdout: opts.listed, stderr: '' };
    }
    if (argv[1] === 'ps') {
      const id = argv[argv.length - 1].replace('network=', '');
      return { ok: true, stdout: opts.members?.[id] ?? '', stderr: '' };
    }
    if (argv[1] === 'network' && argv[2] === 'rm') {
      const err = opts.rmFails?.[argv[3]];
      return err
        ? { ok: false, stdout: '', stderr: err }
        : { ok: true, stdout: argv[3], stderr: '' };
    }
    return { ok: true, stdout: '', stderr: '' };
  };
  return { run, calls };
}

const quiet = { log: () => {}, warn: () => {} };

describe('parseDockerCreatedAt', () => {
  it('parses the docker network ls CreatedAt format', () => {
    expect(parseDockerCreatedAt('2026-10-21 17:43:36.421910969 +0000 UTC')).toBe(
      Date.parse('2026-10-21T17:43:36.421Z'),
    );
    expect(parseDockerCreatedAt('2026-10-21 17:43:36 -0500 CDT')).toBe(
      Date.parse('2026-10-21T22:43:36Z'),
    );
  });

  it('returns null for anything else', () => {
    expect(parseDockerCreatedAt('')).toBeNull();
    expect(parseDockerCreatedAt('yesterday')).toBeNull();
  });
});

describe('previewNetworkReclaimEnabled', () => {
  it('is on unless explicitly turned off', () => {
    expect(previewNetworkReclaimEnabled({})).toBe(true);
    expect(previewNetworkReclaimEnabled({ AGENT_HUB_PREVIEW_NETWORK_RECLAIM: '1' })).toBe(true);
    for (const off of ['0', 'false', 'OFF', 'no']) {
      expect(previewNetworkReclaimEnabled({ AGENT_HUB_PREVIEW_NETWORK_RECLAIM: off })).toBe(false);
    }
  });
});

describe('reclaimIdleDockerNetworks', () => {
  it('removes old dangling networks no container references', async () => {
    const docker = fakeDocker({
      listed:
        'aaa\tst-canc-net\t2026-09-05 03:40:53.2 +0000 UTC\n' +
        'bbb\tp315-net\t2026-09-07 08:15:44.6 +0000 UTC\n',
    });

    const result = await reclaimIdleDockerNetworks({ run: docker.run, now: () => NOW, ...quiet });

    expect(result.removed).toEqual(['st-canc-net', 'p315-net']);
    expect(docker.calls[0]).toEqual([
      'docker',
      'network',
      'ls',
      '--filter',
      'dangling=true',
      '--format',
      '{{.ID}}\t{{.Name}}\t{{.CreatedAt}}',
    ]);
    expect(docker.calls).toContainEqual(['docker', 'network', 'rm', 'aaa']);
  });

  // Docker 29 lists networks with attached containers under dangling=true.
  it('keeps a "dangling" network that still has containers, running or stopped', async () => {
    const docker = fakeDocker({
      listed: 'ccc\tbackend_default\t2026-07-15 05:59:25.4 +0000 UTC\n',
      members: { ccc: 'c1\nc2\n' },
    });

    const result = await reclaimIdleDockerNetworks({ run: docker.run, now: () => NOW, ...quiet });

    expect(result.removed).toEqual([]);
    expect(docker.calls.some((c) => c[2] === 'rm')).toBe(false);
  });

  it('keeps a network a created, never-started container references only by name', async () => {
    // `docker create --network st-new-net` leaves the endpoint NetworkID
    // empty, so only the name filter finds the container.
    const docker = fakeDocker({
      listed: 'ggg\tst-new-net\t2026-09-05 03:40:53 +0000 UTC\n',
      members: { 'st-new-net': 'c9\n' },
    });

    const result = await reclaimIdleDockerNetworks({ run: docker.run, now: () => NOW, ...quiet });

    expect(result.removed).toEqual([]);
    expect(docker.calls).toContainEqual(['docker', 'ps', '-aq', '--filter', 'network=ggg']);
    expect(docker.calls).toContainEqual(['docker', 'ps', '-aq', '--filter', 'network=st-new-net']);
    expect(docker.calls.some((c) => c[2] === 'rm')).toBe(false);
  });

  it('keeps networks younger than the grace window and unparseable ages', async () => {
    const docker = fakeDocker({
      listed: 'ddd\tfresh-net\t2026-11-04 17:30:00.0 +0000 UTC\n' + 'eee\todd-net\tsometime\n',
    });

    const result = await reclaimIdleDockerNetworks({ run: docker.run, now: () => NOW, ...quiet });

    expect(result.removed).toEqual([]);
    expect(docker.calls).toHaveLength(1);
  });

  it('never touches predefined networks', async () => {
    const docker = fakeDocker({ listed: 'fff\tbridge\t2026-01-01 00:00:00 +0000 UTC\n' });

    const result = await reclaimIdleDockerNetworks({ run: docker.run, now: () => NOW, ...quiet });

    expect(result.removed).toEqual([]);
  });

  it('records rm failures and keeps going', async () => {
    const docker = fakeDocker({
      listed:
        'aaa\tbusy-net\t2026-09-05 03:40:53 +0000 UTC\n' +
        'bbb\tidle-net\t2026-09-05 03:40:53 +0000 UTC\n',
      rmFails: { aaa: 'error: network busy-net has active endpoints' },
    });

    const result = await reclaimIdleDockerNetworks({ run: docker.run, now: () => NOW, ...quiet });

    expect(result.removed).toEqual(['idle-net']);
    expect(result.errors).toEqual([
      'rm network busy-net failed: error: network busy-net has active endpoints',
    ]);
  });

  it('reports a failed listing without throwing', async () => {
    const docker = fakeDocker({ listed: '', listFails: true });

    const result = await reclaimIdleDockerNetworks({ run: docker.run, now: () => NOW, ...quiet });

    expect(result).toEqual({ removed: [], errors: ['list networks failed: daemon down'] });
  });
});
