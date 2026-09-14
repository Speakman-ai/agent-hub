import { describe, expect, it } from 'vitest';
import { AutopilotError } from './errors.js';
import {
  assertAutopilotContainment,
  assertAutopilotWorkerLaunch,
  authorizedFirecrackerContainmentDrives,
  authorizedSysboxContainmentMounts,
  ENFORCED_DOCKER_RESOURCE_CONTROLLERS,
  evaluateAutopilotContainment,
  evaluateAutopilotIsolationCapability,
  extraFirecrackerHostDrives,
  firecrackerEffectiveHostDrives,
  inspectIsolatedAdapterRuntime,
  inspectWorkerLaunch,
  parseDockerInfoResourceControllers,
  parseDockerRunContainment,
  probeAutopilotContainment,
  probeDockerResourceControllers,
  dockerResourceControllersAvailable,
  type AutopilotContainmentProbe,
  type AutopilotWorkerLaunch,
} from './containment.js';
import {
  SYSBOX_SESSION_DEFAULT_CPUS,
  SYSBOX_SESSION_DEFAULT_MEMORY_BYTES,
  SYSBOX_SESSION_GRAPH_DEST,
  SYSBOX_SESSION_WORKSPACE,
  buildStartSysboxContainerArgv,
  sysboxGraphVolumeName,
  sysboxSessionContainerName,
} from '../session-env/sysbox-exec-args.js';
import { resolveHostMountPath } from '../finalize/runner-exec-args.js';
import { getSessionEnvSelection } from '../session-env/sysbox-capability.js';

const isolated: AutopilotContainmentProbe = {
  adapter: 'sysbox',
  fellBack: false,
  inspectable: true,
  dockerSocketMounted: false,
  extraHostMounts: [],
  resourceLimitsEnforced: true,
  privileged: false,
  hostNamespacesShared: false,
  isolationRuntime: 'sysbox-runc',
};

const PROBE_CONTAINER = sysboxSessionContainerName('autopilot-containment-probe');
const AUTHORIZED_WORKTREE = resolveHostMountPath('/wt/session-1');
const AUTHORIZED_GRAPH = sysboxGraphVolumeName(PROBE_CONTAINER);
const AUTHORIZED_MOUNTS = authorizedSysboxContainmentMounts({
  worktreePath: '/wt/session-1',
  containerName: PROBE_CONTAINER,
});

function productionSysboxArgv() {
  return buildStartSysboxContainerArgv({
    sessionId: 'autopilot-containment-probe',
    containerName: PROBE_CONTAINER,
    image: 'org/session:1',
    worktreePath: '/wt/session-1',
    ports: [],
  });
}

function parseAuthorized(argv: string[]) {
  return parseDockerRunContainment(argv, {
    authorizedMounts: AUTHORIZED_MOUNTS,
    resourceControllers: ENFORCED_DOCKER_RESOURCE_CONTROLLERS,
  });
}

function sysboxLaunch(
  argv: readonly string[] = productionSysboxArgv(),
  extra: Partial<Extract<AutopilotWorkerLaunch, { kind: 'docker-run' }>> = {},
): AutopilotWorkerLaunch {
  return {
    kind: 'docker-run',
    argv,
    authorizedMounts: AUTHORIZED_MOUNTS,
    resourceControllers: ENFORCED_DOCKER_RESOURCE_CONTROLLERS,
    ...extra,
  };
}

/** Insert docker-run options before the image so the tokenizer sees them. */
function withRunFlags(argv: string[], ...flags: string[]): string[] {
  const idx = argv.indexOf('run');
  if (idx === -1) return [...argv, ...flags];
  return [...argv.slice(0, idx + 1), ...flags, ...argv.slice(idx + 1)];
}

/** Last occurrence wins, matching Docker. Prefer the `--flag=value` form. */
function withLastEqualsFlag(argv: string[], flag: string, value: string): string[] {
  const equals = `${flag}=`;
  const lastEquals = argv.reduce((idx, arg, i) => (arg.startsWith(equals) ? i : idx), -1);
  const lastSep = argv.lastIndexOf(flag);
  if (lastEquals >= lastSep && lastEquals !== -1) {
    const next = [...argv];
    next[lastEquals] = `${equals}${value}`;
    return next;
  }
  if (lastSep !== -1) {
    const next = [...argv];
    next.splice(lastSep, 2, `${equals}${value}`);
    return next;
  }
  return withRunFlags(argv, `${equals}${value}`);
}

describe('parseDockerRunContainment', () => {
  it('reads mounts and resource caps from the production sysbox start argv', () => {
    const parsed = parseAuthorized(productionSysboxArgv());
    expect(parsed.inspectable).toBe(true);
    expect(parsed.dockerSocketMounted).toBe(false);
    expect(parsed.extraHostMounts).toEqual([]);
    expect(parsed.resourceLimitsEnforced).toBe(true);
    expect(parsed.privileged).toBe(false);
    expect(parsed.hostNamespacesShared).toBe(false);
    expect(parsed.isolationRuntime).toBe('sysbox-runc');
    expect(productionSysboxArgv().join(' ')).toContain(`:${SYSBOX_SESSION_WORKSPACE}:rw`);
    expect(productionSysboxArgv()).toContain('--cpus');
    expect(productionSysboxArgv()).toContain(String(SYSBOX_SESSION_DEFAULT_CPUS));
    expect(productionSysboxArgv()).toContain(String(SYSBOX_SESSION_DEFAULT_MEMORY_BYTES));
  });

  it('treats every mount as extra when the authorized allowlist is omitted', () => {
    const parsed = parseDockerRunContainment(productionSysboxArgv());
    expect(parsed.extraHostMounts).toEqual(
      expect.arrayContaining([AUTHORIZED_WORKTREE, AUTHORIZED_GRAPH]),
    );
  });

  it('detects a docker socket mount and extra host binds on the production parser', () => {
    const leaky = withRunFlags(
      productionSysboxArgv(),
      '-v',
      '/var/run/docker.sock:/var/run/docker.sock',
      '--mount',
      'type=bind,source=/home/shared,target=/host-shared',
    );
    const parsed = parseAuthorized(leaky);
    expect(parsed.dockerSocketMounted).toBe(true);
    expect(parsed.extraHostMounts).toEqual(expect.arrayContaining(['/home/shared']));
    expect(parsed.extraHostMounts).not.toContain(AUTHORIZED_WORKTREE);
  });

  it('rejects an unrelated host directory mounted beneath the workspace', () => {
    const nested = withRunFlags(
      productionSysboxArgv(),
      '-v',
      `/etc:${SYSBOX_SESSION_WORKSPACE}/host-data`,
    );
    const parsed = parseAuthorized(nested);
    expect(parsed.extraHostMounts).toEqual(expect.arrayContaining(['/etc']));
    expect(evaluateAutopilotContainment({ adapter: 'sysbox', fellBack: false, ...parsed }).ok).toBe(
      false,
    );
  });

  it('rejects an unrelated named volume mounted beneath the workspace', () => {
    const nested = withRunFlags(
      productionSysboxArgv(),
      '-v',
      `other-project-data:${SYSBOX_SESSION_WORKSPACE}/other`,
    );
    const parsed = parseAuthorized(nested);
    expect(parsed.extraHostMounts).toEqual(expect.arrayContaining(['other-project-data']));
    expect(evaluateAutopilotContainment({ adapter: 'sysbox', fellBack: false, ...parsed }).ok).toBe(
      false,
    );
  });

  it('rejects a volumes-from or tmpfs attach even with a valid allowlist', () => {
    const parsed = parseAuthorized(
      withRunFlags(
        productionSysboxArgv(),
        '--volumes-from',
        'other-session',
        '--tmpfs',
        `${SYSBOX_SESSION_WORKSPACE}/cache`,
      ),
    );
    expect(parsed.extraHostMounts).toEqual(
      expect.arrayContaining(['other-session', `${SYSBOX_SESSION_WORKSPACE}/cache`]),
    );
  });

  it('rejects a different project worktree or graph volume', () => {
    const swapped = [
      'docker',
      'run',
      '-d',
      '--runtime=sysbox-runc',
      '--cpus',
      '2',
      '--memory',
      '1024',
      '-v',
      `/other-project:${SYSBOX_SESSION_WORKSPACE}:rw`,
      '-v',
      `stolen-graph:${SYSBOX_SESSION_GRAPH_DEST}`,
      'img',
    ];
    const parsed = parseAuthorized(swapped);
    expect(parsed.extraHostMounts).toEqual(
      expect.arrayContaining(['/other-project', 'stolen-graph']),
    );
  });

  it('rejects host devices even when isolation and resource flags are valid', () => {
    const parsed = parseAuthorized(withRunFlags(productionSysboxArgv(), '--device', '/dev/sda'));
    expect(parsed.extraHostMounts).toEqual(expect.arrayContaining(['/dev/sda']));
  });

  it('rejects privileged isolation argv from the production container builder', () => {
    const argv = buildStartSysboxContainerArgv({
      sessionId: 'autopilot-containment-probe',
      containerName: sysboxSessionContainerName('autopilot-containment-probe'),
      image: 'org/session:1',
      worktreePath: '/wt/session-1',
      ports: [],
      isolation: 'privileged',
    });
    const parsed = parseAuthorized(argv);
    expect(parsed.privileged).toBe(true);
    expect(parsed.hostNamespacesShared).toBe(true);
    expect(
      evaluateAutopilotContainment({ adapter: 'container', fellBack: false, ...parsed }).ok,
    ).toBe(false);
  });

  it('rejects argv that omit managed resource limits as unverified', () => {
    const parsed = parseDockerRunContainment(
      [
        'docker',
        'run',
        '-d',
        '--runtime=sysbox-runc',
        '-v',
        `/wt:${SYSBOX_SESSION_WORKSPACE}:rw`,
        'img',
      ],
      {
        authorizedMounts: [{ source: '/wt', destination: SYSBOX_SESSION_WORKSPACE, kind: 'bind' }],
      },
    );
    expect(parsed.resourceLimitsEnforced).toBe(false);
    expect(parsed.extraHostMounts).toEqual([]);
    expect(
      evaluateAutopilotContainment({
        adapter: 'sysbox',
        fellBack: false,
        ...parsed,
      }).ok,
    ).toBe(false);
  });

  it('rejects unlimited Docker swap even when CPU and memory caps are set', () => {
    const unlimited = withLastEqualsFlag(productionSysboxArgv(), '--memory-swap', '-1');
    expect(unlimited).toContain('--memory-swap=-1');
    const parsed = parseAuthorized(unlimited);
    expect(parsed.inspectable).toBe(true);
    expect(parsed.resourceLimitsEnforced).toBe(false);
    expect(evaluateAutopilotContainment({ adapter: 'sysbox', fellBack: false, ...parsed }).ok).toBe(
      false,
    );
  });

  it('rejects a two-token --memory-swap -1 the same way as the equals form', () => {
    const argv = productionSysboxArgv();
    const idx = argv.lastIndexOf('--memory-swap');
    const twoToken = [...argv.slice(0, idx), '--memory-swap', '-1', ...argv.slice(idx + 2)];
    const parsed = parseAuthorized(twoToken);
    expect(parsed.resourceLimitsEnforced).toBe(false);
  });

  it('does not treat CPU and memory caps as sufficient when swap is omitted', () => {
    const parsed = parseAuthorized([
      'docker',
      'run',
      '-d',
      '--runtime=sysbox-runc',
      '--cpus',
      '2',
      '--memory',
      String(SYSBOX_SESSION_DEFAULT_MEMORY_BYTES),
      '-v',
      `${AUTHORIZED_WORKTREE}:${SYSBOX_SESSION_WORKSPACE}:rw`,
      '-v',
      `${AUTHORIZED_GRAPH}:${SYSBOX_SESSION_GRAPH_DEST}`,
      'img',
    ]);
    expect(parsed.resourceLimitsEnforced).toBe(false);
  });

  it('does not treat requested --memory-swap as enforcement without SwapLimit support', () => {
    const argv = productionSysboxArgv();
    expect(
      parseDockerRunContainment(argv, { authorizedMounts: AUTHORIZED_MOUNTS })
        .resourceLimitsEnforced,
    ).toBe(false);
    const withControllers = parseAuthorized(argv);
    expect(withControllers.resourceLimitsEnforced).toBe(true);
    const unsupported = parseDockerRunContainment(argv, {
      authorizedMounts: AUTHORIZED_MOUNTS,
      resourceControllers: { memoryLimit: true, swapLimit: false, cpuQuota: true },
    });
    expect(unsupported.resourceLimitsEnforced).toBe(false);
    expect(
      evaluateAutopilotContainment({ adapter: 'sysbox', fellBack: false, ...unsupported }).ok,
    ).toBe(false);
    expect(
      evaluateAutopilotContainment({ adapter: 'sysbox', fellBack: false, ...unsupported }).reason,
    ).toMatch(/resource limits are not enforced/);
  });

  it('parses Docker Info controller flags and fails closed on missing SwapLimit', () => {
    expect(
      parseDockerInfoResourceControllers(
        JSON.stringify({
          MemoryLimit: true,
          SwapLimit: true,
          CpuCfsQuota: true,
          CpuCfsPeriod: true,
        }),
      ),
    ).toEqual(ENFORCED_DOCKER_RESOURCE_CONTROLLERS);
    expect(
      parseDockerInfoResourceControllers(
        `WARNING: No swap limit support\n${JSON.stringify({
          MemoryLimit: true,
          SwapLimit: false,
          CpuCfsQuota: true,
          CpuCfsPeriod: true,
        })}`,
      ),
    ).toEqual({ memoryLimit: true, swapLimit: false, cpuQuota: true });
    expect(parseDockerInfoResourceControllers('not json')).toBeNull();
  });

  it('probes docker info and denies unavailable resource controllers', async () => {
    const denied = await probeDockerResourceControllers(async (argv) => {
      expect(argv).toEqual(['docker', 'info', '--format', '{{json .}}']);
      return {
        ok: true,
        stdout: JSON.stringify({
          MemoryLimit: true,
          SwapLimit: false,
          CpuCfsQuota: true,
          CpuCfsPeriod: true,
        }),
      };
    });
    expect(denied).toEqual({ memoryLimit: true, swapLimit: false, cpuQuota: true });
    expect(dockerResourceControllersAvailable(denied)).toBe(false);
    const unreachable = await probeDockerResourceControllers(async () => ({
      ok: false,
      stdout: '',
    }));
    expect(unreachable).toBeNull();
  });

  it('treats --privileged=true as privileged, not as an absent boolean', () => {
    const parsed = parseAuthorized(withRunFlags(productionSysboxArgv(), '--privileged=true'));
    expect(parsed.inspectable).toBe(true);
    expect(parsed.privileged).toBe(true);
    expect(evaluateAutopilotContainment({ adapter: 'sysbox', fellBack: false, ...parsed }).ok).toBe(
      false,
    );
  });

  it('treats --net=host as a shared host namespace', () => {
    const parsed = parseAuthorized(withRunFlags(productionSysboxArgv(), '--net=host'));
    expect(parsed.inspectable).toBe(true);
    expect(parsed.hostNamespacesShared).toBe(true);
    expect(evaluateAutopilotContainment({ adapter: 'sysbox', fellBack: false, ...parsed }).ok).toBe(
      false,
    );
  });

  it('does not treat --privileged=false as privileged', () => {
    const parsed = parseAuthorized(withRunFlags(productionSysboxArgv(), '--privileged=false'));
    expect(parsed.privileged).toBe(false);
    expect(evaluateAutopilotContainment({ adapter: 'sysbox', fellBack: false, ...parsed }).ok).toBe(
      true,
    );
  });

  it('fails closed on unrecognized docker run options', () => {
    const parsed = parseAuthorized(withRunFlags(productionSysboxArgv(), '--gpus=all'));
    expect(parsed.inspectable).toBe(false);
    expect(evaluateAutopilotContainment({ adapter: 'sysbox', fellBack: false, ...parsed }).ok).toBe(
      false,
    );
  });

  it('rejects --userns=host and --cap-add equals forms', () => {
    const userns = parseAuthorized(withRunFlags(productionSysboxArgv(), '--userns=host'));
    expect(userns.hostNamespacesShared).toBe(true);
    const caps = parseAuthorized(withRunFlags(productionSysboxArgv(), '--cap-add=SYS_ADMIN'));
    expect(caps.extraHostMounts).toEqual(expect.arrayContaining(['SYS_ADMIN']));
  });

  it('rejects an authorized volume name that conceals a host bind via volume-opt', () => {
    const spec = [
      'type=volume',
      `source=${AUTHORIZED_GRAPH}`,
      `target=${SYSBOX_SESSION_GRAPH_DEST}`,
      'volume-driver=local',
      'volume-opt=type=none',
      'volume-opt=device=/etc',
      'volume-opt=o=bind',
    ].join(',');
    const parsed = parseAuthorized(withRunFlags(productionSysboxArgv(), '--mount', spec));
    expect(parsed.extraHostMounts).toEqual(expect.arrayContaining(['/etc']));
    expect(evaluateAutopilotContainment({ adapter: 'sysbox', fellBack: false, ...parsed }).ok).toBe(
      false,
    );
  });

  it('rejects bind-propagation and -v mode flags on an otherwise authorized mount', () => {
    const bind = parseAuthorized(
      withRunFlags(
        productionSysboxArgv(),
        '--mount',
        `type=bind,source=${AUTHORIZED_WORKTREE},target=${SYSBOX_SESSION_WORKSPACE},bind-propagation=rshared`,
      ),
    );
    expect(bind.extraHostMounts).toEqual(expect.arrayContaining([AUTHORIZED_WORKTREE]));
    const shared = parseAuthorized(
      withRunFlags(
        productionSysboxArgv(),
        '-v',
        `${AUTHORIZED_WORKTREE}:${SYSBOX_SESSION_WORKSPACE}:rw,rshared`,
      ),
    );
    expect(shared.extraHostMounts).toEqual(expect.arrayContaining([AUTHORIZED_WORKTREE]));
  });

  it('accepts a single src/dst alias pair for an authorized bind', () => {
    const parsed = parseDockerRunContainment(
      [
        'docker',
        'run',
        '-d',
        '--runtime=sysbox-runc',
        '--cpus',
        '2',
        '--memory',
        '1024',
        '--memory-swap',
        '1024',
        '--mount',
        `type=bind,src=${AUTHORIZED_WORKTREE},dst=${SYSBOX_SESSION_WORKSPACE}`,
        '-v',
        `${AUTHORIZED_GRAPH}:${SYSBOX_SESSION_GRAPH_DEST}`,
        'img',
      ],
      {
        authorizedMounts: AUTHORIZED_MOUNTS,
        resourceControllers: ENFORCED_DOCKER_RESOURCE_CONTROLLERS,
      },
    );
    expect(parsed.extraHostMounts).toEqual([]);
    expect(evaluateAutopilotContainment({ adapter: 'sysbox', fellBack: false, ...parsed }).ok).toBe(
      true,
    );
  });

  it('rejects substituting a bind for the authorized graph volume', () => {
    const argv = productionSysboxArgv();
    const graphSpec = `${AUTHORIZED_GRAPH}:${SYSBOX_SESSION_GRAPH_DEST}`;
    const idx = argv.indexOf(graphSpec);
    expect(idx).toBeGreaterThan(0);
    const withoutGraph = [...argv.slice(0, idx - 1), ...argv.slice(idx + 1)];
    const substituted = withRunFlags(
      withoutGraph,
      '--mount',
      `type=bind,source=${AUTHORIZED_GRAPH},target=${SYSBOX_SESSION_GRAPH_DEST}`,
    );
    const parsed = parseAuthorized(substituted);
    expect(parsed.extraHostMounts).toEqual(expect.arrayContaining([AUTHORIZED_GRAPH]));
    expect(evaluateAutopilotContainment({ adapter: 'sysbox', fellBack: false, ...parsed }).ok).toBe(
      false,
    );

    const worktreeSpec = `${AUTHORIZED_WORKTREE}:${SYSBOX_SESSION_WORKSPACE}:rw`;
    const wtIdx = argv.indexOf(worktreeSpec);
    expect(wtIdx).toBeGreaterThan(0);
    const volumeWorktree = withRunFlags(
      [...argv.slice(0, wtIdx - 1), ...argv.slice(wtIdx + 1)],
      '--mount',
      `type=volume,source=${AUTHORIZED_WORKTREE},target=${SYSBOX_SESSION_WORKSPACE}`,
    );
    const volumeParsed = parseAuthorized(volumeWorktree);
    expect(volumeParsed.extraHostMounts).toEqual(expect.arrayContaining([AUTHORIZED_WORKTREE]));
  });

  it('rejects conflicting --mount source and destination aliases', () => {
    const sourceAlias = parseAuthorized(
      withRunFlags(
        productionSysboxArgv(),
        '--mount',
        `type=bind,source=${AUTHORIZED_WORKTREE},src=/etc,target=${SYSBOX_SESSION_WORKSPACE}`,
      ),
    );
    expect(sourceAlias.extraHostMounts).toEqual(expect.arrayContaining(['/etc']));
    expect(
      evaluateAutopilotContainment({ adapter: 'sysbox', fellBack: false, ...sourceAlias }).ok,
    ).toBe(false);

    const destAlias = parseAuthorized(
      withRunFlags(
        productionSysboxArgv(),
        '--mount',
        `type=bind,source=${AUTHORIZED_WORKTREE},target=${SYSBOX_SESSION_WORKSPACE},dst=/hidden`,
      ),
    );
    expect(destAlias.extraHostMounts).toEqual(expect.arrayContaining(['/hidden']));
    expect(
      evaluateAutopilotContainment({ adapter: 'sysbox', fellBack: false, ...destAlias }).ok,
    ).toBe(false);

    const lastWinsAuthorized = parseAuthorized(
      withRunFlags(
        productionSysboxArgv(),
        '--mount',
        `type=bind,src=/etc,source=${AUTHORIZED_WORKTREE},destination=/hidden,target=${SYSBOX_SESSION_WORKSPACE}`,
      ),
    );
    expect(
      evaluateAutopilotContainment({ adapter: 'sysbox', fellBack: false, ...lastWinsAuthorized })
        .ok,
    ).toBe(false);
  });

  it('rejects mount sources that differ only by trailing whitespace', () => {
    const spaced = `${AUTHORIZED_WORKTREE} `;
    const volume = parseAuthorized(
      withRunFlags(productionSysboxArgv(), '-v', `${spaced}:${SYSBOX_SESSION_WORKSPACE}:rw`),
    );
    expect(volume.extraHostMounts).toEqual(expect.arrayContaining([spaced]));
    expect(evaluateAutopilotContainment({ adapter: 'sysbox', fellBack: false, ...volume }).ok).toBe(
      false,
    );

    const mount = parseAuthorized(
      withRunFlags(
        productionSysboxArgv(),
        '--mount',
        `type=bind,source=${spaced},target=${SYSBOX_SESSION_WORKSPACE}`,
      ),
    );
    expect(mount.extraHostMounts).toEqual(expect.arrayContaining([spaced]));
    expect(evaluateAutopilotContainment({ adapter: 'sysbox', fellBack: false, ...mount }).ok).toBe(
      false,
    );
  });
});

describe('extraFirecrackerHostDrives', () => {
  const authorized = [
    { drive_id: 'rootfs', path_on_host: '/probe/rootfs.ext4' },
    { drive_id: 'workspace', path_on_host: '/probe/workspace.ext4' },
  ];

  it('allows the authorized rootfs and workspace disks only', () => {
    expect(
      extraFirecrackerHostDrives(
        [
          { drive_id: 'rootfs', path_on_host: '/probe/rootfs.ext4' },
          { drive_id: 'workspace', path_on_host: '/probe/workspace.ext4' },
        ],
        authorized,
      ),
    ).toEqual([]);
  });

  it('rejects an extra host disk and a swapped workspace image', () => {
    expect(
      extraFirecrackerHostDrives(
        [
          { drive_id: 'rootfs', path_on_host: '/probe/rootfs.ext4' },
          { drive_id: 'workspace', path_on_host: '/probe/workspace.ext4' },
          { drive_id: 'host-data', path_on_host: '/etc' },
        ],
        authorized,
      ),
    ).toEqual(['/etc']);
    expect(
      extraFirecrackerHostDrives(
        [
          { drive_id: 'rootfs', path_on_host: '/probe/rootfs.ext4' },
          { drive_id: 'workspace', path_on_host: '/other-project.ext4' },
        ],
        authorized,
      ),
    ).toEqual(expect.arrayContaining(['/other-project.ext4', '/probe/workspace.ext4']));
  });

  it('rejects a workspace disk path that differs only by trailing whitespace', () => {
    expect(
      extraFirecrackerHostDrives(
        [
          { drive_id: 'rootfs', path_on_host: '/probe/rootfs.ext4' },
          { drive_id: 'workspace', path_on_host: '/probe/workspace.ext4 ' },
        ],
        authorized,
      ),
    ).toEqual(expect.arrayContaining(['/probe/workspace.ext4 ', '/probe/workspace.ext4']));
  });

  it('rejects a swapped rootfs backing path even with an authorized workspace', () => {
    expect(
      extraFirecrackerHostDrives(
        [
          { drive_id: 'rootfs', path_on_host: '/other/rootfs.ext4' },
          { drive_id: 'workspace', path_on_host: '/probe/workspace.ext4' },
        ],
        authorized,
      ),
    ).toEqual(expect.arrayContaining(['/other/rootfs.ext4', '/probe/rootfs.ext4']));
  });

  it('rewrites jailer-staged paths to the host disks that will actually attach', () => {
    expect(
      firecrackerEffectiveHostDrives({
        configDrives: [
          { drive_id: 'rootfs', path_on_host: 'rootfs.ext4' },
          { drive_id: 'workspace', path_on_host: 'workspace.ext4' },
        ],
        hostRootfsPath: '/run/sess-1/rootfs.ext4',
        hostWorkspacePath: '/run/sess-1/workspace.ext4',
        stagedRootfsPath: 'rootfs.ext4',
        stagedWorkspacePath: 'workspace.ext4',
      }),
    ).toEqual([
      { drive_id: 'rootfs', path_on_host: '/run/sess-1/rootfs.ext4' },
      { drive_id: 'workspace', path_on_host: '/run/sess-1/workspace.ext4' },
    ]);
    expect(
      firecrackerEffectiveHostDrives({
        configDrives: [
          { drive_id: 'rootfs', path_on_host: 'rootfs.ext4' },
          { drive_id: 'workspace', path_on_host: 'workspace.ext4' },
          { drive_id: 'extra', path_on_host: '/etc' },
        ],
        hostRootfsPath: '/run/sess-1/rootfs.ext4',
        hostWorkspacePath: '/run/sess-1/workspace.ext4',
        stagedRootfsPath: 'rootfs.ext4',
        stagedWorkspacePath: 'workspace.ext4',
      }).some((drive) => drive.path_on_host === '/etc'),
    ).toBe(true);
  });
});

describe('inspectWorkerLaunch', () => {
  it('does not treat an adapter name as a contained worker', () => {
    const sysbox = inspectIsolatedAdapterRuntime('sysbox');
    expect(sysbox.inspectable).toBe(false);
    expect(evaluateAutopilotContainment({ adapter: 'sysbox', fellBack: false, ...sysbox }).ok).toBe(
      false,
    );
    const firecracker = inspectWorkerLaunch('firecracker');
    expect(firecracker.inspectable).toBe(false);
  });

  it('inspects the supplied sysbox start argv', () => {
    const sysbox = inspectWorkerLaunch('sysbox', sysboxLaunch());
    expect(sysbox.inspectable).toBe(true);
    expect(sysbox.dockerSocketMounted).toBe(false);
    expect(sysbox.extraHostMounts).toEqual([]);
    expect(sysbox.resourceLimitsEnforced).toBe(true);
    expect(sysbox.privileged).toBe(false);
    expect(sysbox.isolationRuntime).toBe('sysbox-runc');
    expect(evaluateAutopilotContainment({ adapter: 'sysbox', fellBack: false, ...sysbox }).ok).toBe(
      true,
    );
  });

  it('denies a worker launch when Docker SwapLimit is unavailable', () => {
    expect(() =>
      assertAutopilotWorkerLaunch(
        'sysbox',
        sysboxLaunch(productionSysboxArgv(), {
          resourceControllers: { memoryLimit: true, swapLimit: false, cpuQuota: true },
        }),
      ),
    ).toThrow(/resource limits are not enforced/);
  });

  it('rejects the privileged container adapter on the production start argv', () => {
    const argv = buildStartSysboxContainerArgv({
      sessionId: 'autopilot-containment-probe',
      containerName: PROBE_CONTAINER,
      image: 'org/session:1',
      worktreePath: '/wt/session-1',
      ports: [],
      isolation: 'privileged',
    });
    const container = inspectWorkerLaunch('container', {
      kind: 'docker-run',
      argv,
      authorizedMounts: AUTHORIZED_MOUNTS,
    });
    expect(container.inspectable).toBe(true);
    expect(container.privileged).toBe(true);
    expect(container.hostNamespacesShared).toBe(true);
    expect(container.isolationRuntime).toBe('none');
    expect(
      evaluateAutopilotContainment({ adapter: 'container', fellBack: false, ...container }).ok,
    ).toBe(false);
    expect(
      evaluateAutopilotContainment({ adapter: 'container', fellBack: false, ...container }).reason,
    ).toMatch(/privileged|sysbox or firecracker/);
  });

  it('inspects the supplied firecracker host disks and machine-config', () => {
    const authorized = authorizedFirecrackerContainmentDrives({
      rootfsPath: '/run/sess-1/rootfs.ext4',
      workspacePath: '/run/sess-1/workspace.ext4',
    });
    const probe = inspectWorkerLaunch('firecracker', {
      kind: 'firecracker',
      drives: authorized,
      authorizedDrives: authorized,
      vcpuCount: 2,
      memSizeMib: 1024,
    });
    expect(probe.inspectable).toBe(true);
    expect(probe.dockerSocketMounted).toBe(false);
    expect(probe.extraHostMounts).toEqual([]);
    expect(probe.resourceLimitsEnforced).toBe(true);
    expect(probe.isolationRuntime).toBe('firecracker');
    expect(
      evaluateAutopilotContainment({ adapter: 'firecracker', fellBack: false, ...probe }).ok,
    ).toBe(true);
  });

  it('blocks an unsafe worker launch even when a sample builder configuration would pass', () => {
    const sampleArgv = buildStartSysboxContainerArgv({
      sessionId: 'autopilot-containment-probe',
      containerName: PROBE_CONTAINER,
      image: 'org/session:1',
      worktreePath: '/workspace/autopilot-containment-probe',
      ports: [],
      cpus: SYSBOX_SESSION_DEFAULT_CPUS,
      memoryBytes: SYSBOX_SESSION_DEFAULT_MEMORY_BYTES,
    });
    const sampleLaunch: AutopilotWorkerLaunch = {
      kind: 'docker-run',
      argv: sampleArgv,
      authorizedMounts: authorizedSysboxContainmentMounts({
        worktreePath: '/workspace/autopilot-containment-probe',
        containerName: PROBE_CONTAINER,
      }),
      resourceControllers: ENFORCED_DOCKER_RESOURCE_CONTROLLERS,
    };
    const sample = inspectWorkerLaunch('sysbox', sampleLaunch);
    expect(evaluateAutopilotContainment({ adapter: 'sysbox', fellBack: false, ...sample }).ok).toBe(
      true,
    );

    const workerContainer = sysboxSessionContainerName('sess-worker');
    const unsafeArgv = withRunFlags(
      buildStartSysboxContainerArgv({
        sessionId: 'sess-worker',
        containerName: workerContainer,
        image: 'org/session:1',
        worktreePath: '/wt/session-1',
        ports: [],
      }),
      '-v',
      '/etc:/workspace/etc',
    );
    expect(() =>
      assertAutopilotWorkerLaunch('sysbox', {
        kind: 'docker-run',
        argv: unsafeArgv,
        authorizedMounts: authorizedSysboxContainmentMounts({
          worktreePath: '/wt/session-1',
          containerName: workerContainer,
        }),
      }),
    ).toThrow(/arbitrary host mounts/);

    const sampleDisks = authorizedFirecrackerContainmentDrives({
      rootfsPath: '/probe/rootfs.ext4',
      workspacePath: '/probe/workspace.ext4',
    });
    expect(
      evaluateAutopilotContainment({
        adapter: 'firecracker',
        fellBack: false,
        ...inspectWorkerLaunch('firecracker', {
          kind: 'firecracker',
          drives: sampleDisks,
          authorizedDrives: sampleDisks,
          vcpuCount: 2,
          memSizeMib: 1024,
        }),
      }).ok,
    ).toBe(true);
    expect(() =>
      assertAutopilotWorkerLaunch('firecracker', {
        kind: 'firecracker',
        drives: firecrackerEffectiveHostDrives({
          configDrives: [
            { drive_id: 'rootfs', path_on_host: '/other/rootfs.ext4' },
            { drive_id: 'workspace', path_on_host: '/run/sess-1/workspace.ext4' },
          ],
          hostRootfsPath: '/run/sess-1/rootfs.ext4',
          hostWorkspacePath: '/run/sess-1/workspace.ext4',
        }),
        authorizedDrives: authorizedFirecrackerContainmentDrives({
          rootfsPath: '/run/sess-1/rootfs.ext4',
          workspacePath: '/run/sess-1/workspace.ext4',
        }),
        vcpuCount: 2,
        memSizeMib: 1024,
      }),
    ).toThrow(/arbitrary host mounts/);
  });
});

describe('evaluateAutopilotContainment', () => {
  it('allows sysbox and firecracker without host mounts, privilege, or a docker socket', () => {
    expect(evaluateAutopilotContainment(isolated).ok).toBe(true);
    expect(evaluateAutopilotContainment({ ...isolated, adapter: 'container' }).ok).toBe(false);
    expect(
      evaluateAutopilotContainment({
        ...isolated,
        adapter: 'firecracker',
        isolationRuntime: 'firecracker',
      }).ok,
    ).toBe(true);
  });

  it('blocks the host adapter and isolation fallback', () => {
    expect(evaluateAutopilotContainment({ ...isolated, adapter: 'host' }).ok).toBe(false);
    expect(
      evaluateAutopilotContainment({
        adapter: 'host',
        fellBack: true,
        inspectable: true,
        dockerSocketMounted: false,
        extraHostMounts: [],
        resourceLimitsEnforced: false,
        privileged: true,
        hostNamespacesShared: true,
        isolationRuntime: 'none',
      }).reason,
    ).toMatch(/fell back to the host adapter/);
  });

  it('blocks a docker socket mount, extra host mounts, and unverifiable probes', () => {
    expect(evaluateAutopilotContainment({ ...isolated, dockerSocketMounted: true }).ok).toBe(false);
    expect(
      evaluateAutopilotContainment({
        ...isolated,
        extraHostMounts: ['/var/run/docker.sock'],
      }).ok,
    ).toBe(false);
    expect(evaluateAutopilotContainment({ ...isolated, inspectable: false }).ok).toBe(false);
    expect(evaluateAutopilotContainment({ ...isolated, resourceLimitsEnforced: false }).ok).toBe(
      false,
    );
    expect(evaluateAutopilotContainment({ ...isolated, privileged: true }).ok).toBe(false);
    expect(evaluateAutopilotContainment({ ...isolated, hostNamespacesShared: true }).ok).toBe(
      false,
    );
  });
});

describe('probeAutopilotContainment', () => {
  it('does not inspect a sample builder when no worker launch is supplied', () => {
    const probe = probeAutopilotContainment();
    const selection = getSessionEnvSelection();
    expect(probe.adapter).toBe(selection.adapter);
    expect(probe.fellBack).toBe(selection.fellBack);
    if (selection.adapter === 'host') {
      expect(probe.extraHostMounts).toEqual(['/']);
      expect(evaluateAutopilotContainment(probe).ok).toBe(false);
    } else if (selection.adapter === 'sysbox') {
      expect(probe.inspectable).toBe(false);
      expect(evaluateAutopilotContainment(probe).ok).toBe(false);
      expect(evaluateAutopilotIsolationCapability(selection).ok).toBe(false);
      expect(
        evaluateAutopilotIsolationCapability(selection, ENFORCED_DOCKER_RESOURCE_CONTROLLERS).ok,
      ).toBe(true);
    } else if (selection.adapter === 'firecracker') {
      expect(probe.inspectable).toBe(false);
      expect(evaluateAutopilotContainment(probe).ok).toBe(false);
      expect(evaluateAutopilotIsolationCapability(selection).ok).toBe(true);
    }
  });

  it('blocks Start on the production probe when isolation is host', () => {
    const probe = probeAutopilotContainment({
      getSelection: () => ({
        adapter: 'host',
        mode: 'host',
        forced: true,
        fellBack: false,
        reason: 'test',
        probe: { available: false, checks: [], missing: [] },
      }),
    });
    expect(probe.extraHostMounts).toEqual(['/']);
    expect(probe.resourceLimitsEnforced).toBe(false);
    expect(evaluateAutopilotContainment(probe).ok).toBe(false);
  });
});

describe('assertAutopilotContainment', () => {
  it('throws containment_unavailable when the host adapter is the only option', () => {
    try {
      assertAutopilotContainment({ ...isolated, adapter: 'host' });
      throw new Error('expected containment_unavailable');
    } catch (err) {
      expect(err).toBeInstanceOf(AutopilotError);
      expect((err as AutopilotError).code).toBe('containment_unavailable');
    }
  });

  it('Start without a worker launch requires Sysbox resource-controller evidence', () => {
    const sysboxSelection = {
      adapter: 'sysbox' as const,
      mode: 'sysbox' as const,
      forced: true,
      fellBack: false,
      reason: 'test',
      probe: { available: true, checks: [], missing: [] },
    };
    expect(() =>
      assertAutopilotContainment(undefined, {
        getSelection: () => sysboxSelection,
        getResourceControllers: () => null,
      }),
    ).toThrow(/resource limits are not enforced/);
    expect(() =>
      assertAutopilotContainment(undefined, {
        getSelection: () => sysboxSelection,
        getResourceControllers: () => ({ memoryLimit: true, swapLimit: false, cpuQuota: true }),
      }),
    ).toThrow(/resource limits are not enforced/);
    assertAutopilotContainment(undefined, {
      getSelection: () => sysboxSelection,
      getResourceControllers: () => ENFORCED_DOCKER_RESOURCE_CONTROLLERS,
    });
    assertAutopilotContainment(undefined, {
      getSelection: () => ({
        adapter: 'firecracker',
        mode: 'firecracker',
        forced: true,
        fellBack: false,
        reason: 'test',
        probe: { available: true, checks: [], missing: [] },
      }),
    });
  });

  it('throws when the supplied worker launch cannot be verified', () => {
    try {
      assertAutopilotContainment(undefined, {
        getSelection: () => ({
          adapter: 'sysbox',
          mode: 'sysbox',
          forced: true,
          fellBack: false,
          reason: 'test',
          probe: { available: true, checks: [], missing: [] },
        }),
        launch: {
          kind: 'docker-run',
          argv: withRunFlags(productionSysboxArgv(), '-v', '/etc:/workspace/etc'),
          authorizedMounts: AUTHORIZED_MOUNTS,
        },
      });
      throw new Error('expected containment_unavailable');
    } catch (err) {
      expect((err as AutopilotError).code).toBe('containment_unavailable');
      expect((err as AutopilotError).message).toMatch(/arbitrary host mounts/);
    }
  });
});
