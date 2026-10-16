import { describe, expect, it } from 'vitest';
import { createHubDockerDesktopHost, type DockerCli } from './container-desktop-host.js';
import { buildDesktopHomeTarArgv, buildDesktopRunArgv } from './desktop-container-args.js';

const KEY = { userId: 'u1', agentId: 'a1', projectId: 'p1' };
const LIMITS = { image: 'agent-hub/desktop:test', memory: '2g', cpus: '1' };

function dockerError(stderr: string): Error {
  return Object.assign(new Error('docker failed'), { stderr });
}

function fakeDocker(handlers: Record<string, (args: string[]) => string | Error> = {}) {
  const calls: Array<{ args: string[]; env?: NodeJS.ProcessEnv }> = [];
  const docker: DockerCli = {
    async run(args, env) {
      calls.push({ args, env });
      const h = handlers[args[0]];
      const out = h ? h(args) : '';
      if (out instanceof Error) throw out;
      return { stdout: out };
    },
  };
  return { docker, calls };
}

describe('desktop container argv', () => {
  it('runs the desktop unprivileged with its home on the volume and the token kept out of argv', () => {
    const argv = buildDesktopRunArgv({
      name: 'agent-hub-desktop-c1',
      computerId: 'c1',
      volume: 'agent-hub-desktop-home-c1',
      limits: LIMITS,
      publishHost: '127.0.0.1',
    });
    expect(argv.slice(0, 3)).toEqual(['docker', 'run', '-d']);
    expect(argv).toEqual(expect.arrayContaining(['--cap-drop', 'ALL', 'no-new-privileges']));
    expect(argv).not.toContain('--privileged');
    expect(argv.join(' ')).not.toMatch(/docker\.sock/);
    expect(argv).toEqual(
      expect.arrayContaining([
        '-v',
        'agent-hub-desktop-home-c1:/home/desktop',
        '-p',
        '127.0.0.1::7300',
        '-e',
        'DESKTOP_CONTROL_TOKEN',
      ]),
    );
    expect(argv.at(-1)).toBe(LIMITS.image);
  });

  it('snapshots and restores the home as the desktop user with no network', () => {
    const snap = buildDesktopHomeTarArgv({ volume: 'v', image: 'img', mode: 'snapshot' });
    expect(snap).toEqual(expect.arrayContaining(['--user', '1000:1000', '--network', 'none']));
    expect(snap.slice(-5)).toEqual(['-czf', '-', '-C', '/home/desktop', '.']);
    const restore = buildDesktopHomeTarArgv({ volume: 'v', image: 'img', mode: 'restore' });
    expect(restore).toContain('-i');
    expect(restore.slice(-4)).toEqual(['-xzf', '-', '-C', '/home/desktop']);
  });
});

describe('hub-docker desktop host', () => {
  it('creates the home volume, replaces a stale container and passes the token by env', async () => {
    const { docker, calls } = fakeDocker({
      rm: () => dockerError('Error: No such container: agent-hub-desktop-c1'),
    });
    const host = createHubDockerDesktopHost({ docker, env: {}, limits: LIMITS });
    const res = await host.start({
      computerId: 'c1',
      runnerRef: 'agent-hub-desktop-c1',
      key: KEY,
      controlToken: 'secret',
      homeRef: null,
    });
    expect(res).toEqual({ homeRef: 'agent-hub-desktop-home-c1' });
    expect(calls.map((c) => c.args[0])).toEqual(['volume', 'rm', 'run']);
    const run = calls[2];
    expect(run.args.join(' ')).not.toContain('secret');
    expect(run.env).toEqual({ DESKTOP_CONTROL_TOKEN: 'secret' });
  });

  it('reports a running container with its published port, and a vanished one as lost', async () => {
    const { docker } = fakeDocker({
      inspect: (a) => (a.at(-1) === 'gone' ? dockerError('Error: No such object: gone') : 'true\n'),
      port: () => '127.0.0.1:49153\n',
    });
    const host = createHubDockerDesktopHost({ docker, env: {}, limits: LIMITS });
    expect(await host.status('agent-hub-desktop-c1')).toEqual({
      state: 'running',
      endpoint: { host: '127.0.0.1', port: 49153 },
      detail: null,
    });
    expect(await host.status('gone')).toMatchObject({ state: 'lost' });
  });

  it('keeps the volume on stop and removes it on deleteHome', async () => {
    const { docker, calls } = fakeDocker({
      volume: () => dockerError('Error: No such volume'),
    });
    const host = createHubDockerDesktopHost({ docker, env: {}, limits: LIMITS });
    await host.stop('agent-hub-desktop-c1', 'c1');
    expect(calls.map((c) => c.args.slice(0, 2))).toEqual([['rm', '-f']]);
    await host.deleteHome('c1');
    expect(calls.at(-1)!.args).toEqual(['volume', 'rm', '-f', 'agent-hub-desktop-home-c1']);
  });

  it('knows its container name up front and confirms a stop once rm succeeds', async () => {
    const { docker, calls } = fakeDocker({
      run: () => dockerError('Error: port is already allocated'),
    });
    const host = createHubDockerDesktopHost({ docker, env: {}, limits: LIMITS });
    // The runtime records this before `start`, then cleans up through `stop`.
    expect(host.allocateRef('c1')).toBe('agent-hub-desktop-c1');
    await expect(
      host.start({
        computerId: 'c1',
        key: KEY,
        controlToken: 'secret',
        homeRef: null,
        runnerRef: 'agent-hub-desktop-c1',
      }),
    ).rejects.toThrow(/docker failed/);
    expect(await host.stop('agent-hub-desktop-c1', 'c1')).toEqual({ confirmed: true });
    expect(calls.at(-1)!.args).toEqual(['rm', '-f', 'agent-hub-desktop-c1']);
  });
});
