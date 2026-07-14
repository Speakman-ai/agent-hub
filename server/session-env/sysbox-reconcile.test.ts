import { describe, expect, it } from 'vitest';
import { reconcileSysboxSessionEnvs } from './sysbox-reconcile.js';
import type { SysboxRunResult } from './sysbox-session-env.js';

function makeRun(respond: (argv: string[]) => SysboxRunResult) {
  const calls: string[][] = [];
  const run = async (argv: string[]) => {
    calls.push(argv);
    return respond(argv);
  };
  return { run, calls };
}

const ok = (stdout = ''): SysboxRunResult => ({ ok: true, stdout, stderr: '' });
const fail = (stderr: string): SysboxRunResult => ({ ok: false, stdout: '', stderr });

describe('reconcileSysboxSessionEnvs', () => {
  it('removes every labeled leaked container and graph volume', async () => {
    const logs: string[] = [];
    const { run, calls } = makeRun((argv) => {
      if (argv[1] === 'ps') return ok('abc123\ndef456\n');
      if (argv[1] === 'volume' && argv[2] === 'ls') return ok('agenthub-session-x-graph\n');
      return ok();
    });

    const result = await reconcileSysboxSessionEnvs({ run, log: (m) => logs.push(m) });
    expect(result).toEqual({ containersRemoved: 2, volumesRemoved: 1, errors: [] });

    expect(calls).toContainEqual(['docker', 'rm', '-f', '-v', 'abc123']);
    expect(calls).toContainEqual(['docker', 'rm', '-f', '-v', 'def456']);
    expect(calls).toContainEqual(['docker', 'volume', 'rm', '-f', 'agenthub-session-x-graph']);
    expect(logs).toEqual([
      '[session-env] reconcile: removed 2 leaked session container(s), 1 graph volume(s)',
    ]);
  });

  it('is silent when nothing leaked', async () => {
    const logs: string[] = [];
    const { run, calls } = makeRun(() => ok('\n'));
    const result = await reconcileSysboxSessionEnvs({ run, log: (m) => logs.push(m) });
    expect(result).toEqual({ containersRemoved: 0, volumesRemoved: 0, errors: [] });
    // Only the two list calls — no removals attempted.
    expect(calls).toHaveLength(2);
    expect(logs).toEqual([]);
  });

  it('records failures without aborting the sweep', async () => {
    const warnings: string[] = [];
    const { run } = makeRun((argv) => {
      if (argv[1] === 'ps') return fail('daemon unreachable');
      if (argv[1] === 'volume' && argv[2] === 'ls') return ok('vol-1\nvol-2\n');
      if (argv[1] === 'volume' && argv[2] === 'rm' && argv[4] === 'vol-2') return fail('in use');
      return ok();
    });

    const result = await reconcileSysboxSessionEnvs({
      run,
      log: () => {},
      warn: (m) => warnings.push(m),
    });
    expect(result.containersRemoved).toBe(0);
    expect(result.volumesRemoved).toBe(1);
    expect(result.errors).toEqual([
      'list containers failed: daemon unreachable',
      'rm volume vol-2 failed: in use',
    ]);
    expect(warnings).toHaveLength(2);
  });
});
