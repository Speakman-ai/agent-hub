import { describe, expect, it } from 'vitest';
import {
  buildExecJobStepArgv,
  buildRemoveGraphVolumeArgv,
  buildStartJobContainerArgv,
  buildStopJobContainerArgv,
  finalizeRunnerEnv,
  sanitizeJobContainerName,
} from './job-container.js';
import { mergeRunnerPath } from './runner-exec-args.js';

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

  it('applies GitHub-parity CPU/memory caps from the resolved profile', () => {
    const GiB = 1024 * 1024 * 1024;
    const argv = buildStartJobContainerArgv({
      containerName: 'finalize-run1-e2e-core',
      image: 'agent-hub/finalize-runner:ubuntu-24.04',
      worktreePath: '/tmp/wt',
      composeProjectName: 'finalize-run1-e2e-core',
      // Inject a fixed env so the test doesn't depend on the host's env.
      resourceEnv: { FINALIZE_RUNNER_RESOURCE_PROFILE: 'ubuntu-private' },
    });
    expect(argv).toContain('--cpus');
    expect(argv[argv.indexOf('--cpus') + 1]).toBe('2');
    expect(argv).toContain('--memory');
    expect(argv[argv.indexOf('--memory') + 1]).toBe(String(8 * GiB));
    // Hard cap: swap limit equals the memory limit (no swap headroom).
    expect(argv).toContain('--memory-swap');
    expect(argv[argv.indexOf('--memory-swap') + 1]).toBe(String(8 * GiB));
  });

  it('derives the GitHub-parity tier from repo visibility when no env override is set', () => {
    const GiB = 1024 * 1024 * 1024;
    const argv = buildStartJobContainerArgv({
      containerName: 'finalize-run1-e2e-core',
      image: 'agent-hub/finalize-runner:ubuntu-24.04',
      worktreePath: '/tmp/wt',
      composeProjectName: 'finalize-run1-e2e-core',
      resourceEnv: {}, // no explicit FINALIZE_RUNNER_RESOURCE_PROFILE
      visibility: 'public',
    });
    // public repo -> ubuntu-public (4 vCPU / 16 GB), exact GitHub parity.
    expect(argv[argv.indexOf('--cpus') + 1]).toBe('4');
    expect(argv[argv.indexOf('--memory') + 1]).toBe(String(16 * GiB));
  });

  it('lets an explicit env profile win over repo visibility', () => {
    const argv = buildStartJobContainerArgv({
      containerName: 'finalize-run1-e2e-core',
      image: 'agent-hub/finalize-runner:ubuntu-24.04',
      worktreePath: '/tmp/wt',
      composeProjectName: 'finalize-run1-e2e-core',
      resourceEnv: { FINALIZE_RUNNER_RESOURCE_PROFILE: 'ubuntu-private' },
      visibility: 'public', // would derive ubuntu-public, but env wins
    });
    expect(argv[argv.indexOf('--cpus') + 1]).toBe('2');
  });

  it('omits resource flags when the unconstrained escape hatch is set', () => {
    const argv = buildStartJobContainerArgv({
      containerName: 'finalize-run1-e2e-core',
      image: 'agent-hub/finalize-runner:ubuntu-24.04',
      worktreePath: '/tmp/wt',
      composeProjectName: 'finalize-run1-e2e-core',
      resourceEnv: { FINALIZE_RUNNER_RESOURCE_PROFILE: 'unconstrained' },
    });
    expect(argv).not.toContain('--cpus');
    expect(argv).not.toContain('--memory');
    expect(argv).not.toContain('--memory-swap');
  });

  it('baseEnvOnly suppresses the process.env fallback (deploy isolation)', () => {
    const sentinel = `LEAK_SENTINEL_${Date.now()}`;
    process.env[sentinel] = 'hub-or-agent-secret';
    try {
      // Default (Finalize): an undefined env falls back to process.env, so the
      // host sentinel leaks into the container.
      const leaky = buildStartJobContainerArgv({
        containerName: 'finalize-run1-e2e-core',
        image: 'agent-hub/finalize-runner:ubuntu-24.04',
        worktreePath: '/tmp/wt',
        composeProjectName: 'finalize-run1-e2e-core',
        resourceEnv: { FINALIZE_RUNNER_RESOURCE_PROFILE: 'unconstrained' },
      });
      expect(leaky.some((a) => a.startsWith(`${sentinel}=`))).toBe(true);

      // baseEnvOnly (deploy): the container env is built from ONLY opts.env, so
      // the host/agent process.env never seeds it — even when env is empty.
      const isolated = buildStartJobContainerArgv({
        containerName: 'deploy-1-prod',
        image: 'agent-hub/finalize-runner:ubuntu-24.04',
        worktreePath: '/tmp/wt',
        composeProjectName: 'deploy-1-prod',
        env: { PATH: '/usr/bin' },
        baseEnvOnly: true,
        resourceEnv: { FINALIZE_RUNNER_RESOURCE_PROFILE: 'unconstrained' },
      });
      expect(isolated.some((a) => a.startsWith(`${sentinel}=`))).toBe(false);
      // Allowlisted basics still pass through — PATH is preserved (and the
      // guaranteed container toolchain dirs are appended, see mergeRunnerPath).
      const pathArg = isolated.find((a) => a.startsWith('PATH='));
      expect(pathArg).toBeDefined();
      expect(pathArg!.split('=')[1].split(':')).toContain('/usr/bin');
    } finally {
      delete process.env[sentinel];
    }
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

  it('guarantees the image toolchain dirs are on PATH even when the injected PATH omits them', () => {
    // Regression: a self-deploy restarted the Hub under a PM2/nvm PATH that did
    // not include /usr/bin. That PATH was carried into the deploy container and
    // the github_workflow recovery step died with `gh: command not found`
    // (watch exit 127) though the image ships gh at /usr/bin/gh.
    const env = finalizeRunnerEnv({ PATH: '/root/.nvm/versions/node/v22.11.0/bin' });
    const dirs = (env.PATH ?? '').split(':');
    // Caller-provided dir keeps priority...
    expect(dirs[0]).toBe('/root/.nvm/versions/node/v22.11.0/bin');
    // ...and the image toolchain dirs are always reachable.
    expect(dirs).toContain('/usr/bin');
    expect(dirs).toContain('/usr/local/bin');
  });

  it('sets a usable PATH even when no PATH is provided', () => {
    const env = finalizeRunnerEnv({ FOO: 'bar' });
    expect((env.PATH ?? '').split(':')).toContain('/usr/bin');
  });

  it('strips macOS TMPDIR/TMP/TEMP so Linux runners use their own tmp', () => {
    // macOS hosts set TMPDIR=/var/folders/… — Cypress's installer (and
    // anything honoring TMPDIR) fails with EACCES mkdir /var/folders inside
    // the Ubuntu runner container.
    const env = finalizeRunnerEnv({
      TMPDIR: '/var/folders/zz/abc/T/',
      TMP: '/var/folders/zz/abc/T/',
      TEMP: '/var/folders/zz/abc/T/',
      FOO: 'bar',
    });
    expect(env.TMPDIR).toBeUndefined();
    expect(env.TMP).toBeUndefined();
    expect(env.TEMP).toBeUndefined();
    expect(env.FOO).toBe('bar');
  });
});

describe('mergeRunnerPath', () => {
  it('appends and de-dupes the guaranteed dirs, preserving caller order', () => {
    expect(mergeRunnerPath('/opt/tool/bin:/usr/bin')).toBe(
      '/opt/tool/bin:/usr/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/sbin:/bin:/home/runner/.local/bin',
    );
  });

  it('returns just the guaranteed dirs for empty/undefined input', () => {
    expect(mergeRunnerPath(undefined)).toBe(
      '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/home/runner/.local/bin',
    );
    expect(mergeRunnerPath('')).toBe(mergeRunnerPath(undefined));
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
