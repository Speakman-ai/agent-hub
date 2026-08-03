import { describe, expect, it } from 'vitest';
import {
  SYSBOX_SESSION_ENTRYPOINT,
  SYSBOX_SESSION_LABEL,
  SYSBOX_SESSION_WORKSPACE,
  buildCreateSysboxGraphVolumeArgv,
  buildExecSysboxPtyArgs,
  buildExecSysboxSpawnArgv,
  buildListSysboxSessionContainersArgv,
  buildListSysboxSessionVolumesArgv,
  buildRemoveSysboxGraphVolumeArgv,
  buildStartSysboxContainerArgv,
  buildStopSysboxContainerArgv,
  buildSysboxKillArgv,
  resolveSysboxSessionImage,
  sysboxGraphVolumeName,
  sysboxSessionContainerName,
  sysboxSpawnPidFile,
} from './sysbox-exec-args.js';

describe('resolveSysboxSessionImage', () => {
  it('prefers the dedicated override, then the finalize runner image, then the default', () => {
    expect(
      resolveSysboxSessionImage({
        AGENT_HUB_SYSBOX_SESSION_IMAGE: 'org/session:1',
        FINALIZE_RUNNER_IMAGE_UBUNTU_24_04: 'org/runner:2',
      }),
    ).toBe('org/session:1');
    expect(resolveSysboxSessionImage({ FINALIZE_RUNNER_IMAGE_UBUNTU_24_04: 'org/runner:2' })).toBe(
      'org/runner:2',
    );
    expect(resolveSysboxSessionImage({})).toBe('agent-hub/finalize-runner:ubuntu-24.04');
    // Whitespace-only overrides do not win.
    expect(resolveSysboxSessionImage({ AGENT_HUB_SYSBOX_SESSION_IMAGE: '  ' })).toBe(
      'agent-hub/finalize-runner:ubuntu-24.04',
    );
  });
});

describe('naming', () => {
  it('builds a sanitized, lowercased, bounded container name', () => {
    expect(sysboxSessionContainerName('ABC-123')).toBe('agenthub-session-abc-123');
    expect(sysboxSessionContainerName('a b/c:d')).toBe('agenthub-session-a-b-c-d');
    const long = sysboxSessionContainerName('x'.repeat(200));
    expect(long.length).toBeLessThanOrEqual(63);
    expect(sysboxSessionContainerName('///')).toBe('agenthub-session-unknown');
  });

  it('derives the graph volume name from the container name', () => {
    expect(sysboxGraphVolumeName('agenthub-session-abc')).toBe('agenthub-session-abc-graph');
  });

  it('pidfiles are unique per spawn sequence', () => {
    expect(sysboxSpawnPidFile(0)).toBe('/tmp/agenthub-proc-0.pid');
    expect(sysboxSpawnPidFile(7)).toBe('/tmp/agenthub-proc-7.pid');
  });
});

describe('buildCreateSysboxGraphVolumeArgv', () => {
  it('labels the volume for the reconcile sweep', () => {
    expect(
      buildCreateSysboxGraphVolumeArgv({ containerName: 'agenthub-session-s1', sessionId: 's1' }),
    ).toEqual([
      'docker',
      'volume',
      'create',
      '--label',
      'agent-hub.kind=session-env',
      '--label',
      'agent-hub.session-id=s1',
      'agenthub-session-s1-graph',
    ]);
  });
});

describe('buildStartSysboxContainerArgv', () => {
  const argv = buildStartSysboxContainerArgv({
    sessionId: 'sess-1',
    containerName: 'agenthub-session-sess-1',
    image: 'org/session:1',
    worktreePath: '/wt/session-1',
    ports: [
      { internalPort: 5173, hostPort: 4123 },
      { internalPort: 8080, hostPort: 4124 },
    ],
    env: { AGENT_HUB_SESSION_ID: 'sess-1' },
  });

  it('runs detached under the sysbox-runc runtime', () => {
    expect(argv.slice(0, 3)).toEqual(['docker', 'run', '-d']);
    expect(argv).toContain('--runtime=sysbox-runc');
  });

  it('never uses --privileged, host cgroups, or the host docker socket', () => {
    expect(argv).not.toContain('--privileged');
    expect(argv).not.toContain('--cgroupns=host');
    expect(argv.join(' ')).not.toMatch(/docker\.sock/);
  });

  it('bind-mounts the worktree and the named inner-docker graph volume', () => {
    const joined = argv.join(' ');
    expect(joined).toContain(`-v /wt/session-1:${SYSBOX_SESSION_WORKSPACE}:rw`);
    expect(joined).toContain('-v agenthub-session-sess-1-graph:/var/lib/docker');
  });

  it('publishes every port loopback-only', () => {
    const joined = argv.join(' ');
    expect(joined).toContain('-p 127.0.0.1:4123:5173');
    expect(joined).toContain('-p 127.0.0.1:4124:8080');
    // No publish may ever bind 0.0.0.0 (raw port leak).
    for (const [i, arg] of argv.entries()) {
      if (arg === '-p') expect(argv[i + 1]).toMatch(/^127\.0\.0\.1:/);
    }
  });

  it('labels the container, passes env, and ends with image + entrypoint', () => {
    const joined = argv.join(' ');
    expect(joined).toContain(`--label ${SYSBOX_SESSION_LABEL}`);
    expect(joined).toContain('--label agent-hub.session-id=sess-1');
    expect(joined).toContain('-e AGENT_HUB_SESSION_ID=sess-1');
    expect(argv.slice(-3)).toEqual(['org/session:1', ...SYSBOX_SESSION_ENTRYPOINT]);
  });

  it('honors a custom in-container command', () => {
    const custom = buildStartSysboxContainerArgv({
      sessionId: 's',
      containerName: 'c',
      image: 'img',
      worktreePath: '/wt',
      ports: [],
      command: ['sleep', 'infinity'],
    });
    expect(custom.slice(-3)).toEqual(['img', 'sleep', 'infinity']);
  });
});

describe('buildExecSysboxSpawnArgv', () => {
  it('passes the user command as a positional parameter, never interpolated', () => {
    const argv = buildExecSysboxSpawnArgv({
      containerName: 'agenthub-session-s1',
      command: `echo "hi"; rm -rf '$HOME'`,
      cwd: '/workspace/web',
      env: { PORT: '5173' },
      pidFile: '/tmp/agenthub-proc-0.pid',
    });
    expect(argv.slice(0, 2)).toEqual(['docker', 'exec']);
    expect(argv).toContain('-i');
    const joined = argv.join(' ');
    expect(joined).toContain('-u runner');
    expect(joined).toContain('-w /workspace/web');
    expect(joined).toContain('-e PORT=5173');
    // Wrapper script records its pid then execs the user command in place;
    // pidfile and command travel as positional parameters.
    expect(argv.slice(-6)).toEqual([
      'sh',
      '-c',
      'echo "$$" >"$1"; exec sh -c "$2"',
      'sh',
      '/tmp/agenthub-proc-0.pid',
      `echo "hi"; rm -rf '$HOME'`,
    ]);
    expect(argv).toContain('agenthub-session-s1');
  });
});

describe('buildSysboxKillArgv', () => {
  it('signals the pidfile process group with the bare signal name', () => {
    const argv = buildSysboxKillArgv({
      containerName: 'agenthub-session-s1',
      pidFile: '/tmp/agenthub-proc-0.pid',
      signal: 'SIGTERM',
    });
    expect(argv.slice(0, 3)).toEqual(['docker', 'exec', 'agenthub-session-s1']);
    expect(argv[argv.length - 1]).toBe('TERM');
    expect(argv[argv.length - 2]).toBe('/tmp/agenthub-proc-0.pid');
    expect(argv.join(' ')).toContain('kill -s "$2" -- "-$p"');
  });
});

describe('buildExecSysboxPtyArgs', () => {
  it('builds an interactive exec defaulting to bash', () => {
    const args = buildExecSysboxPtyArgs({
      containerName: 'agenthub-session-s1',
      cwd: '/workspace',
      env: { TERM: 'xterm-256color' },
    });
    expect(args.slice(0, 2)).toEqual(['exec', '-it']);
    const joined = args.join(' ');
    expect(joined).toContain('-u runner');
    expect(joined).toContain('-w /workspace');
    expect(joined).toContain('-e TERM=xterm-256color');
    expect(args.slice(-2)).toEqual(['agenthub-session-s1', '/bin/bash']);
  });

  it('omits env entries whose value is undefined (an unset, not the string)', () => {
    const args = buildExecSysboxPtyArgs({
      containerName: 'c',
      cwd: '/workspace',
      env: { TERM: 'xterm-256color', AWS_PROFILE: undefined },
    });
    const joined = args.join(' ');
    expect(joined).toContain('-e TERM=xterm-256color');
    expect(joined).not.toContain('AWS_PROFILE');
  });

  it('honors an explicit command with args', () => {
    const args = buildExecSysboxPtyArgs({
      containerName: 'c',
      cwd: '/workspace',
      command: 'htop',
      args: ['-d', '5'],
    });
    expect(args.slice(-4)).toEqual(['c', 'htop', '-d', '5']);
  });
});

describe('teardown + reconcile argvs', () => {
  it('removes the container with its anonymous volumes', () => {
    expect(buildStopSysboxContainerArgv('c1')).toEqual(['docker', 'rm', '-f', '-v', 'c1']);
  });

  it('removes the named graph volume explicitly', () => {
    expect(buildRemoveSysboxGraphVolumeArgv('c1')).toEqual([
      'docker',
      'volume',
      'rm',
      '-f',
      'c1-graph',
    ]);
  });

  it('lists session containers and volumes by label', () => {
    expect(buildListSysboxSessionContainersArgv()).toEqual([
      'docker',
      'ps',
      '-aq',
      '--filter',
      `label=${SYSBOX_SESSION_LABEL}`,
    ]);
    expect(buildListSysboxSessionVolumesArgv()).toEqual([
      'docker',
      'volume',
      'ls',
      '-q',
      '--filter',
      `label=${SYSBOX_SESSION_LABEL}`,
    ]);
  });
});
