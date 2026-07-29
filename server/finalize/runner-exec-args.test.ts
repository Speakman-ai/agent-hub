import { describe, it, expect, afterEach } from 'vitest';
import { buildStartJobContainerArgv, resolveHostMountPath } from './runner-exec-args.js';

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

describe('DinD is the only runner mode (SPEC-4)', () => {
  afterEach(() => {
    delete process.env.FINALIZE_RUNNER_DOCKER_MODE;
    delete process.env.FINALIZE_DOCKER_SOCKET;
  });

  // Regression: the legacy `host-socket` escape hatch mounted the HOST docker
  // socket into runner containers (a privilege-escalation surface) and added
  // `host.docker.internal` for port probes. Both are deleted; setting the old
  // env var must be completely inert rather than re-enabling either.
  it('never mounts the host docker socket, even with the legacy env var set', () => {
    process.env.FINALIZE_RUNNER_DOCKER_MODE = 'host-socket';
    process.env.FINALIZE_DOCKER_SOCKET = '/custom/docker.sock';
    const argv = buildStartJobContainerArgv({
      containerName: 'finalize-run1-checks-default',
      image: 'agent-hub/finalize-runner:ubuntu-24.04',
      worktreePath: '/tmp/wt',
      composeProjectName: 'finalize-run1-checks-default',
      resourceEnv: {},
    });
    // Scope to bind mounts: an inert `-e FINALIZE_DOCKER_SOCKET=…` passthrough is
    // harmless, a `-v …:/var/run/docker.sock` mount is the escalation surface.
    const mounts = argv.filter((a, i) => argv[i - 1] === '-v');
    expect(mounts.some((m) => m.includes('docker.sock'))).toBe(false);
    expect(argv).not.toContain('--add-host=host.docker.internal:host-gateway');
    // Still the one supported shape: a privileged DinD container with its own
    // graph volume, not an ephemeral per-step `docker run --rm`.
    expect(argv).toContain('--privileged');
    expect(argv).not.toContain('--rm');
    expect(argv.some((a) => a.includes('finalize-run1-checks-default-graph:/var/lib/docker'))).toBe(
      true,
    );
  });
});
