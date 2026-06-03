import { describe, it, expect, afterEach } from 'vitest';
import { buildDockerRunArgv, resolveHostMountPath } from './container-runner.js';

describe('resolveHostMountPath', () => {
  afterEach(() => {
    delete process.env.AGENT_HUB_HOST_WORKSPACES_DIR;
    delete process.env.AGENT_HUB_CONTAINER_WORKSPACES_DIR;
  });

  it('returns path unchanged when translation env is unset', () => {
    expect(resolveHostMountPath('/tmp/my-worktree')).toBe('/tmp/my-worktree');
  });

  it('translates container worktree path to host when env is set', () => {
    process.env.AGENT_HUB_HOST_WORKSPACES_DIR = '/data/workspaces';
    process.env.AGENT_HUB_CONTAINER_WORKSPACES_DIR = '/home/node/.agent-hub/workspaces';
    const container = '/home/node/.agent-hub/workspaces/wt-abc';
    expect(resolveHostMountPath(container)).toBe('/data/workspaces/wt-abc');
  });
});

describe('buildDockerRunArgv', () => {
  afterEach(() => {
    delete process.env.FINALIZE_DOCKER_SOCKET;
    delete process.env.FINALIZE_RUNNER_DOCKER_MODE;
  });

  it('builds legacy host-socket per-step run argv', () => {
    process.env.FINALIZE_RUNNER_DOCKER_MODE = 'host-socket';
    const argv = buildDockerRunArgv({
      image: 'agent-hub/finalize-runner:ubuntu-24.04',
      worktreePath: '/tmp/wt',
      run: 'echo hello',
      composeProjectName: 'finalize-run1-e2e-shard0',
      hostSocketMode: true,
    });
    expect(argv[0]).toBe('docker');
    expect(argv).toContain('run');
    expect(argv).toContain('--rm');
    expect(argv).toContain('-v');
    expect(argv.some((a) => a.startsWith('/tmp/wt:/github/workspace'))).toBe(true);
    expect(argv).toContain('-w');
    expect(argv).toContain('/github/workspace');
    expect(argv).toContain('agent-hub/finalize-runner:ubuntu-24.04');
    expect(argv).toContain('echo hello');
    expect(argv.some((a) => a.startsWith('COMPOSE_PROJECT_NAME='))).toBe(true);
    expect(argv).toContain('--add-host=host.docker.internal:host-gateway');
    expect(argv.some((a) => a.includes('docker.sock'))).toBe(true);
  });

  it('does not mount host socket in default dind mode', () => {
    const argv = buildDockerRunArgv({
      image: 'img:tag',
      worktreePath: '/wt',
      run: 'true',
    });
    expect(argv.some((a) => a.includes('docker.sock'))).toBe(false);
    expect(argv).not.toContain('--add-host=host.docker.internal:host-gateway');
  });

  it('omits docker socket when mountDockerSocket is false', () => {
    process.env.FINALIZE_RUNNER_DOCKER_MODE = 'host-socket';
    const argv = buildDockerRunArgv({
      image: 'img:tag',
      worktreePath: '/wt',
      run: 'true',
      mountDockerSocket: false,
      hostSocketMode: true,
    });
    expect(argv.some((a) => a.includes('docker.sock'))).toBe(false);
  });

  it('applies custom labels', () => {
    const argv = buildDockerRunArgv({
      image: 'img:tag',
      worktreePath: '/wt',
      run: 'true',
      hostSocketMode: true,
      labels: { 'finalize.run_id': 'run-123' },
    });
    expect(argv).toContain('--label');
    expect(argv).toContain('finalize.run_id=run-123');
  });
});
