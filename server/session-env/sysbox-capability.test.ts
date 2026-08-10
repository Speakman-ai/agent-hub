import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  beginSessionEnvSelection,
  coerceSessionEnvAdapterMode,
  getSessionEnvSelection,
  initSessionEnvSelection,
  kernelAtLeast,
  logSessionEnvSelection,
  parseKernelRelease,
  probeSysboxCapability,
  resetSessionEnvSelectionForTest,
  selectSessionEnvAdapter,
  whenSessionEnvSelectionReady,
  type SysboxProbeDeps,
  type SysboxProbeResult,
} from './sysbox-capability.js';

function makeDeps(overrides: Partial<SysboxProbeDeps> = {}): SysboxProbeDeps {
  return {
    platform: 'linux',
    kernelRelease: () => '6.1.134-150.224.amzn2023.x86_64',
    readTextFile: async (p: string) => {
      if (p === '/proc/sys/user/max_user_namespaces') return '63398\n';
      throw new Error(`ENOENT: ${p}`);
    },
    run: async (cmd: string) => {
      if (cmd === 'sysbox-runc') return { ok: true, stdout: 'sysbox-runc version 0.7.0\n' };
      if (cmd === 'docker')
        return {
          ok: true,
          stdout: '{"runc":{"path":"runc"},"sysbox-runc":{"path":"/usr/bin/sysbox-runc"}}\n',
        };
      return { ok: false, stdout: '' };
    },
    ...overrides,
  };
}

afterEach(() => {
  resetSessionEnvSelectionForTest();
});

describe('parseKernelRelease', () => {
  it('parses Amazon Linux 2023 releases', () => {
    expect(parseKernelRelease('6.1.134-150.224.amzn2023.x86_64')).toEqual({ major: 6, minor: 1 });
  });

  it('parses Ubuntu generic releases', () => {
    expect(parseKernelRelease('5.15.0-91-generic')).toEqual({ major: 5, minor: 15 });
  });

  it('returns null on garbage', () => {
    expect(parseKernelRelease('not-a-kernel')).toBeNull();
    expect(parseKernelRelease('')).toBeNull();
  });
});

describe('kernelAtLeast', () => {
  it('compares major.minor correctly', () => {
    expect(kernelAtLeast({ major: 6, minor: 1 }, { major: 5, minor: 12 })).toBe(true);
    expect(kernelAtLeast({ major: 5, minor: 12 }, { major: 5, minor: 12 })).toBe(true);
    expect(kernelAtLeast({ major: 5, minor: 11 }, { major: 5, minor: 12 })).toBe(false);
    expect(kernelAtLeast({ major: 4, minor: 19 }, { major: 5, minor: 12 })).toBe(false);
  });
});

describe('selectSessionEnvAdapter — microVM tier', () => {
  const noSysbox = { available: false, checks: [], missing: ['binary: not found'] };
  const withSysbox = { available: true, checks: [], missing: [] };
  const noContainer = { dockerAvailable: false, routing: 'published-ports' as const };
  const vmReady = { available: true, reason: '' };
  const noVm = { available: false, reason: '/dev/kvm is missing' };

  it('auto picks sysbox over microVM and explains why microVM was skipped', () => {
    const selection = selectSessionEnvAdapter(
      'auto',
      withSysbox,
      { dockerAvailable: true, routing: 'container-ip' },
      vmReady,
    );
    expect(selection.adapter).toBe('sysbox');
    expect(selection.reason).toMatch(/skipped for safety/);
    expect(selection.fellBack).toBe(false);
  });

  it('explains in the boot log why the microVM was skipped', () => {
    const selection = selectSessionEnvAdapter('auto', withSysbox, noContainer, noVm);
    expect(selection.adapter).toBe('sysbox');
    expect(selection.reason).toContain('/dev/kvm is missing');
  });

  it('does not silently degrade a forced microVM to a weaker boundary', () => {
    // resolveSessionEnvBackend throws for this case, so reporting a sysbox /
    // container / host fallback would describe a run that never happens. An
    // operator who wrote "firecracker" asked for a hardware boundary, and a
    // container is not one.
    for (const [sysbox, container] of [
      [withSysbox, noContainer],
      [noSysbox, { dockerAvailable: true, routing: 'container-ip' } as const],
      [noSysbox, noContainer],
    ] as const) {
      expect(selectSessionEnvAdapter('firecracker', sysbox, container, noVm).adapter).toBe(
        'firecracker',
      );
    }
  });

  it('says sessions will fail rather than claiming a fallback', () => {
    const selection = selectSessionEnvAdapter('firecracker', withSysbox, noContainer, noVm);
    expect(selection.fellBack).toBe(false);
    expect(selection.forced).toBe(true);
    expect(selection.reason).toMatch(/sessions will fail/);
    // Points at the mode that does degrade, so the operator has a next step.
    expect(selection.reason).toMatch(/sessionEnvAdapter=auto/);
  });

  it('honors a forced microVM when the probe passes', () => {
    const selection = selectSessionEnvAdapter('firecracker', noSysbox, noContainer, vmReady);
    expect(selection).toMatchObject({ adapter: 'firecracker', forced: true, fellBack: false });
    expect(selection.reason).toMatch(/jailer on by default/);
    expect(selection.reason).not.toMatch(/jailer not default/);
  });

  it('leaves existing selections unchanged when nothing probed the VM tier', () => {
    // The default summary keeps every pre-existing caller on its old path.
    expect(selectSessionEnvAdapter('auto', withSysbox).adapter).toBe('sysbox');
    expect(selectSessionEnvAdapter('host', withSysbox).adapter).toBe('host');
  });
});

describe('coerceSessionEnvAdapterMode', () => {
  it('accepts every valid mode case-insensitively', () => {
    expect(coerceSessionEnvAdapterMode('auto')).toBe('auto');
    expect(coerceSessionEnvAdapterMode(' HOST ')).toBe('host');
    expect(coerceSessionEnvAdapterMode('Sysbox')).toBe('sysbox');
    expect(coerceSessionEnvAdapterMode('container')).toBe('container');
    expect(coerceSessionEnvAdapterMode('FireCracker')).toBe('firecracker');
  });

  it('falls back to auto on unknown values — a typo never forces a backend', () => {
    expect(coerceSessionEnvAdapterMode('firecraker')).toBe('auto');
    expect(coerceSessionEnvAdapterMode('vm')).toBe('auto');
    expect(coerceSessionEnvAdapterMode(undefined)).toBe('auto');
    expect(coerceSessionEnvAdapterMode(null)).toBe('auto');
    expect(coerceSessionEnvAdapterMode(42)).toBe('auto');
  });
});

describe('probeSysboxCapability', () => {
  it('reports available when every check passes', async () => {
    const result = await probeSysboxCapability(makeDeps());
    expect(result.available).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.checks.map((c) => c.name)).toEqual([
      'platform',
      'kernel',
      'userns',
      'binary',
      'docker-runtime',
    ]);
  });

  it('short-circuits off-Linux with a single platform failure', async () => {
    const run = vi.fn();
    const result = await probeSysboxCapability(
      makeDeps({ platform: 'darwin', run: run as unknown as SysboxProbeDeps['run'] }),
    );
    expect(result.available).toBe(false);
    expect(result.checks).toHaveLength(1);
    expect(result.missing[0]).toContain('platform');
    expect(run).not.toHaveBeenCalled();
  });

  it('fails on a kernel below the 5.12 idmapped-mounts baseline', async () => {
    const result = await probeSysboxCapability(
      makeDeps({ kernelRelease: () => '5.10.0-28-cloud-amd64' }),
    );
    expect(result.available).toBe(false);
    expect(result.missing.some((m) => m.startsWith('kernel:'))).toBe(true);
  });

  it('notes the 5.19 recommendation for 5.12–5.18 kernels but still passes', async () => {
    const result = await probeSysboxCapability(
      makeDeps({ kernelRelease: () => '5.15.0-91-generic' }),
    );
    const kernel = result.checks.find((c) => c.name === 'kernel');
    expect(kernel?.ok).toBe(true);
    expect(kernel?.detail).toContain('5.19');
  });

  it('fails on an unparseable kernel release', async () => {
    const result = await probeSysboxCapability(makeDeps({ kernelRelease: () => 'weird' }));
    expect(result.available).toBe(false);
    expect(result.missing.some((m) => m.includes('unparseable'))).toBe(true);
  });

  it('fails when user namespaces are disabled', async () => {
    const result = await probeSysboxCapability(makeDeps({ readTextFile: async () => '0\n' }));
    expect(result.available).toBe(false);
    expect(result.missing.some((m) => m.startsWith('userns:'))).toBe(true);
  });

  it('fails when the userns sysctl is unreadable', async () => {
    const result = await probeSysboxCapability(
      makeDeps({
        readTextFile: async () => {
          throw new Error('ENOENT');
        },
      }),
    );
    expect(result.available).toBe(false);
    expect(result.missing.some((m) => m.startsWith('userns:'))).toBe(true);
  });

  it('fails when sysbox-runc is not installed', async () => {
    const result = await probeSysboxCapability(
      makeDeps({
        run: async (cmd: string) => {
          if (cmd === 'sysbox-runc') return { ok: false, stdout: '' };
          return { ok: true, stdout: '{"sysbox-runc":{}}' };
        },
      }),
    );
    expect(result.available).toBe(false);
    expect(result.missing.some((m) => m.startsWith('binary:'))).toBe(true);
  });

  it('fails when docker has no sysbox-runc runtime registered', async () => {
    const result = await probeSysboxCapability(
      makeDeps({
        run: async (cmd: string) => {
          if (cmd === 'sysbox-runc') return { ok: true, stdout: 'sysbox-runc version 0.7.0' };
          return { ok: true, stdout: '{"runc":{"path":"runc"}}' };
        },
      }),
    );
    expect(result.available).toBe(false);
    expect(result.missing.some((m) => m.startsWith('docker-runtime:'))).toBe(true);
  });

  it('fails cleanly when docker info is unreachable or unparseable', async () => {
    const unreachable = await probeSysboxCapability(
      makeDeps({
        run: async (cmd: string) =>
          cmd === 'docker' ? { ok: false, stdout: '' } : { ok: true, stdout: 'v' },
      }),
    );
    expect(unreachable.missing.some((m) => m.includes('daemon unreachable'))).toBe(true);

    const garbled = await probeSysboxCapability(
      makeDeps({
        run: async (cmd: string) =>
          cmd === 'docker' ? { ok: true, stdout: 'not-json' } : { ok: true, stdout: 'v' },
      }),
    );
    expect(garbled.missing.some((m) => m.includes('could not parse'))).toBe(true);
  });
});

function probeResult(available: boolean, missing: string[] = []): SysboxProbeResult {
  return { available, checks: [], missing };
}

describe('selectSessionEnvAdapter', () => {
  it('auto + available → sysbox', () => {
    const sel = selectSessionEnvAdapter('auto', probeResult(true));
    expect(sel.adapter).toBe('sysbox');
    expect(sel.fellBack).toBe(false);
  });

  it('auto + unavailable → host with the missing reasons in the message', () => {
    const sel = selectSessionEnvAdapter(
      'auto',
      probeResult(false, ['binary: sysbox-runc not found']),
    );
    expect(sel.adapter).toBe('host');
    expect(sel.fellBack).toBe(false);
    expect(sel.reason).toContain('sysbox-runc not found');
  });

  it('forced host wins regardless of the probe', () => {
    const sel = selectSessionEnvAdapter('host', probeResult(true));
    expect(sel.adapter).toBe('host');
    expect(sel.forced).toBe(true);
  });

  it('forced sysbox + available → sysbox', () => {
    const sel = selectSessionEnvAdapter('sysbox', probeResult(true));
    expect(sel.adapter).toBe('sysbox');
    expect(sel.forced).toBe(true);
  });

  it('forced sysbox + unavailable → fail closed (no silent degrade)', () => {
    const sel = selectSessionEnvAdapter('sysbox', probeResult(false, ['kernel: too old']));
    expect(sel.adapter).toBe('sysbox');
    expect(sel.forced).toBe(true);
    expect(sel.fellBack).toBe(false);
    expect(sel.reason).toContain('kernel: too old');
    expect(sel.reason).toContain('sessions will fail');
  });
});

const usableContainer = { dockerAvailable: true, routing: 'container-ip' } as const;

describe('selectSessionEnvAdapter — container backend', () => {
  it('auto declines the container backend even when sysbox is missing', () => {
    const sel = selectSessionEnvAdapter(
      'auto',
      probeResult(false, ['binary: sysbox-runc not found']),
      usableContainer,
    );
    expect(sel.adapter).toBe('host');
    expect(sel.reason).toMatch(/skipped for safety/);
    expect(sel.fellBack).toBe(false);
  });

  it('auto still prefers sysbox when it is available', () => {
    const sel = selectSessionEnvAdapter('auto', probeResult(true), usableContainer);
    expect(sel.adapter).toBe('sysbox');
  });

  it('auto declines a container that would have to publish ports', () => {
    const sel = selectSessionEnvAdapter('auto', probeResult(false, ['x']), {
      dockerAvailable: true,
      routing: 'published-ports',
    });
    expect(sel.adapter).toBe('host');
    expect(sel.reason).toMatch(/skipped for safety/);
  });

  it('auto falls to host when docker is unusable', () => {
    const sel = selectSessionEnvAdapter('auto', probeResult(false, ['x']), {
      dockerAvailable: false,
      routing: 'container-ip',
      detail: 'docker socket missing',
    });
    expect(sel.adapter).toBe('host');
    expect(sel.reason).toContain('docker socket missing');
  });

  it('a forced sysbox that fails its probe does not degrade to privileged container', () => {
    const sel = selectSessionEnvAdapter(
      'sysbox',
      probeResult(false, ['kernel: too old']),
      usableContainer,
    );
    expect(sel.adapter).toBe('sysbox');
    expect(sel.fellBack).toBe(false);
  });

  it('forced container is honored even when it must publish ports', () => {
    const sel = selectSessionEnvAdapter('container', probeResult(false), {
      dockerAvailable: true,
      routing: 'published-ports',
    });
    expect(sel.adapter).toBe('container');
    expect(sel.forced).toBe(true);
  });

  it('forced container without docker falls back to host loudly', () => {
    const sel = selectSessionEnvAdapter('container', probeResult(false), {
      dockerAvailable: false,
      routing: 'container-ip',
      detail: 'no usable docker daemon',
    });
    expect(sel.adapter).toBe('host');
    expect(sel.fellBack).toBe(true);
  });

  it('accepts "container" as a configured mode', () => {
    expect(coerceSessionEnvAdapterMode('container')).toBe('container');
  });
});

describe('logSessionEnvSelection', () => {
  it('warns when forced sysbox is unavailable on Linux (fail-closed selection)', () => {
    const logger = { log: vi.fn(), warn: vi.fn() };
    logSessionEnvSelection(
      selectSessionEnvAdapter('sysbox', probeResult(false, ['x'])),
      logger,
      'linux',
    );
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.log).not.toHaveBeenCalled();
  });

  it('warns on a Linux host degraded to host in auto mode', () => {
    const logger = { log: vi.fn(), warn: vi.fn() };
    logSessionEnvSelection(
      selectSessionEnvAdapter('auto', probeResult(false, ['x'])),
      logger,
      'linux',
    );
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('stays quiet-info for the expected local-dev paths', () => {
    const logger = { log: vi.fn(), warn: vi.fn() };
    // Mac auto → host is the normal local path, not a degradation.
    logSessionEnvSelection(
      selectSessionEnvAdapter('auto', probeResult(false, ['x'])),
      logger,
      'darwin',
    );
    // Explicit host mode is operator intent even on Linux.
    logSessionEnvSelection(
      selectSessionEnvAdapter('host', probeResult(false, ['x'])),
      logger,
      'linux',
    );
    // Sysbox selected is the happy path.
    logSessionEnvSelection(selectSessionEnvAdapter('auto', probeResult(true)), logger, 'linux');
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.log).toHaveBeenCalledTimes(3);
  });
});

describe('initSessionEnvSelection / getSessionEnvSelection', () => {
  it('defaults to host before the probe has run', () => {
    const sel = getSessionEnvSelection();
    expect(sel.adapter).toBe('host');
    expect(sel.reason).toContain('probe has not run');
  });

  it('caches the boot selection for later readers', async () => {
    const sel = await initSessionEnvSelection('auto', makeDeps());
    expect(sel.adapter).toBe('sysbox');
    expect(getSessionEnvSelection()).toBe(sel);
  });

  it('blocks whenSessionEnvSelectionReady until init finishes after begin', async () => {
    beginSessionEnvSelection();
    let ready = false;
    const waiting = whenSessionEnvSelectionReady().then(() => {
      ready = true;
    });
    await Promise.resolve();
    expect(ready).toBe(false);
    await initSessionEnvSelection('auto', makeDeps());
    await waiting;
    expect(ready).toBe(true);
  });
});
