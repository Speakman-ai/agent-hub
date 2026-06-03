import { afterEach, describe, expect, it } from 'vitest';
import {
  buildExecJobStepArgv,
  buildRemoveGraphVolumeArgv,
  buildStartJobContainerArgv,
  buildStopJobContainerArgv,
  finalizeRunnerEnv,
  sanitizeJobContainerName,
} from './job-container.js';

describe('sanitizeJobContainerName', () => {
  it('produces a lowercase docker-safe name', () => {
    expect(sanitizeJobContainerName('Run-1', 'e2e', 'Core Workflows')).toMatch(
      /^finalize-run-1-e2e-core-workflows$/,
    );
  });
});

describe('buildStartJobContainerArgv', () => {
  it('starts a privileged DinD runner with workspace and graph volume', () => {
    const argv = buildStartJobContainerArgv({
      containerName: 'finalize-run1-e2e-core',
      image: 'agent-hub/finalize-runner:ubuntu-24.04',
      worktreePath: '/tmp/wt',
      composeProjectName: 'finalize-run1-e2e-core',
      env: { FINALIZE_MATRIX_SPECS: 'a.cy.ts' },
      labels: { 'agent-hub.finalize.run_id': 'run1' },
    });
    expect(argv[0]).toBe('docker');
    expect(argv).toContain('run');
    expect(argv).toContain('-d');
    expect(argv).toContain('--privileged');
    expect(argv).toContain('--cgroupns=host');
    expect(argv).toContain('--name');
    expect(argv).toContain('finalize-run1-e2e-core');
    expect(argv.some((a) => a.includes('/tmp/wt:/github/workspace'))).toBe(true);
    expect(argv.some((a) => a.includes('finalize-run1-e2e-core-graph:/var/lib/docker'))).toBe(true);
    // Shared image cache so matrix shards reuse one build instead of each rebuilding.
    expect(argv.some((a) => a.includes('finalize-image-cache:/finalize-cache'))).toBe(true);
    expect(argv).not.toContain('--add-host=host.docker.internal:host-gateway');
    expect(argv.some((a) => a.includes('docker.sock'))).toBe(false);
    expect(argv).toContain('/usr/local/bin/runner-entrypoint.sh');
    expect(argv).toContain('daemon');
  });
});

describe('finalizeRunnerEnv', () => {
  it('overrides Hub HOME=/data and strips host-only vars', () => {
    const env = finalizeRunnerEnv({
      HOME: '/data',
      AGENT_HUB_DATA_DIR: '/data',
      FOO: 'bar',
    });
    expect(env.HOME).toBe('/home/runner');
    expect(env.USER).toBe('runner');
    expect(env.NPM_CONFIG_CACHE).toBe('/tmp/.npm');
    expect(env.FOO).toBe('bar');
    expect(env.AGENT_HUB_DATA_DIR).toBeUndefined();
  });

  it('strips NODE_ENV so the runner npm ci installs devDependencies', () => {
    // The Hub runs NODE_ENV=production; if that leaked into the runner, npm ci
    // would skip devDeps (Angular CLI / `ng`, Cypress) and CI jobs would fail.
    const env = finalizeRunnerEnv({ NODE_ENV: 'production', FOO: 'bar' });
    expect(env.NODE_ENV).toBeUndefined();
    expect(env.FOO).toBe('bar');
  });
});

describe('buildExecJobStepArgv', () => {
  it('execs as runner user with sanitized env', () => {
    const argv = buildExecJobStepArgv({
      containerName: 'finalize-run1-e2e-core',
      run: 'echo hello',
      env: { FOO: 'bar', HOME: '/data' },
    });
    expect(argv[0]).toBe('docker');
    expect(argv).toContain('exec');
    expect(argv).toContain('-u');
    expect(argv).toContain('runner');
    expect(argv).toContain('-w');
    expect(argv).toContain('/github/workspace');
    expect(argv).toContain('HOME=/home/runner');
    expect(argv).toContain('FOO=bar');
    expect(argv).not.toContain('HOME=/data');
    expect(argv.slice(-5)).toEqual(['bash', '-euo', 'pipefail', '-c', 'echo hello']);
  });
});

describe('buildStopJobContainerArgv', () => {
  it('force-removes the container (and its anonymous volumes)', () => {
    expect(buildStopJobContainerArgv('finalize-x')).toEqual([
      'docker',
      'rm',
      '-f',
      '-v',
      'finalize-x',
    ]);
  });
});

describe('buildRemoveGraphVolumeArgv', () => {
  it('removes the NAMED <container>-graph volume that `docker rm -v` leaves behind', () => {
    expect(buildRemoveGraphVolumeArgv('finalize-x')).toEqual([
      'docker',
      'volume',
      'rm',
      '-f',
      'finalize-x-graph',
    ]);
  });
});
