/**
 * Hub-owned compose stack reaping. Every docker call is faked; nothing here
 * touches a daemon.
 */

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type { SysboxRunResult } from '../session-env/sysbox-session-env.js';
import {
  composeProjectNameForSession,
  hubComposeProjectSessionPrefix,
  makeSessionLivenessCheck,
  reapComposeStack,
  sweepOrphanedComposeStacks,
} from './compose-stack-reaper.js';

const ok = (stdout = ''): SysboxRunResult => ({ ok: true, stdout, stderr: '' });
const fail = (stderr: string): SysboxRunResult => ({ ok: false, stdout: '', stderr });

function makeRun(respond: (argv: string[]) => SysboxRunResult) {
  const calls: string[][] = [];
  const run = async (argv: string[]) => {
    calls.push(argv);
    return respond(argv);
  };
  return { run, calls };
}

const FILTER = 'label=com.docker.compose.project=session-dfcb608c';

/** Respond like a daemon holding a full stack for `session-dfcb608c`. */
function fullStack(argv: string[]): SysboxRunResult {
  const filtered = argv.includes(FILTER);
  if (argv[1] === 'ps' && filtered) return ok('c1\nc2\n');
  if (argv[1] === 'network' && argv[2] === 'ls' && filtered) return ok('n1\n');
  if (argv[1] === 'volume' && argv[2] === 'ls' && filtered)
    return ok('session-dfcb608c_preview-postgres-data\n');
  return ok();
}

describe('composeProjectNameForSession', () => {
  it('is the session worktree basename shape and round-trips through the prefix parser', () => {
    const name = composeProjectNameForSession('dfcb608c-d8ba-479f-8d60-5b9bc6f34c86');
    expect(name).toBe('session-dfcb608c');
    expect(hubComposeProjectSessionPrefix(name)).toBe('dfcb608c');
  });

  it('rejects names the Hub did not assign', () => {
    for (const name of [
      'backend',
      'surveytracker-port4101',
      'session-x',
      'session-dfcb608c-extra',
      '',
    ]) {
      expect(hubComposeProjectSessionPrefix(name)).toBeNull();
    }
  });
});

describe('reapComposeStack', () => {
  it('removes containers then networks, and keeps named volumes on a plain stop', async () => {
    const logs: string[] = [];
    const { run, calls } = makeRun(fullStack);
    const result = await reapComposeStack({
      run,
      projectName: 'session-dfcb608c',
      removeVolumes: false,
      log: (m) => logs.push(m),
    });
    expect(result).toEqual({
      projectName: 'session-dfcb608c',
      containersRemoved: 2,
      networksRemoved: 1,
      volumesRemoved: 0,
      errors: [],
    });
    expect(calls).toEqual([
      ['docker', 'ps', '-aq', '--filter', FILTER],
      ['docker', 'rm', '-f', '-v', 'c1'],
      ['docker', 'rm', '-f', '-v', 'c2'],
      ['docker', 'network', 'ls', '-q', '--filter', FILTER],
      ['docker', 'network', 'rm', 'n1'],
    ]);
    // A restart must be able to reattach the restored database volume.
    expect(calls.some((c) => c[1] === 'volume')).toBe(false);
    expect(logs).toEqual([
      '[compose-reaper] session-dfcb608c: removed 2 container(s), 1 network(s), 0 volume(s)',
    ]);
  });

  it('removes the named volumes too when asked (archive / delete)', async () => {
    const { run, calls } = makeRun(fullStack);
    const result = await reapComposeStack({
      run,
      projectName: 'session-dfcb608c',
      removeVolumes: true,
      log: () => {},
    });
    expect(result.volumesRemoved).toBe(1);
    // Volumes go last, after every container that could hold them is gone,
    // and without `-f` so an in-use volume rejects instead of being yanked.
    expect(calls.at(-2)).toEqual(['docker', 'volume', 'ls', '-q', '--filter', FILTER]);
    expect(calls.at(-1)).toEqual([
      'docker',
      'volume',
      'rm',
      'session-dfcb608c_preview-postgres-data',
    ]);
  });

  it('refuses to reap a project name the Hub did not assign', async () => {
    // `backend` is what compose derives for every session that runs from
    // `<worktree>/backend` — shared across sessions, so never reapable.
    const warnings: string[] = [];
    const { run, calls } = makeRun(fullStack);
    const result = await reapComposeStack({
      run,
      projectName: 'backend',
      removeVolumes: true,
      warn: (m) => warnings.push(m),
    });
    expect(calls).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(warnings[0]).toMatch(/refusing to reap compose project "backend"/);
  });

  it('records failures without aborting the sweep and never throws', async () => {
    const warnings: string[] = [];
    const { run } = makeRun((argv) => {
      if (argv[1] === 'ps') return fail('daemon unreachable');
      if (argv[1] === 'network' && argv[2] === 'ls') return ok('n1\nn2\n');
      if (argv[1] === 'network' && argv[2] === 'rm' && argv[3] === 'n2')
        return fail('has active endpoints');
      if (argv[1] === 'volume' && argv[2] === 'ls') return ok('v1\n');
      return ok();
    });
    const result = await reapComposeStack({
      run,
      projectName: 'session-dfcb608c',
      removeVolumes: true,
      log: () => {},
      warn: (m) => warnings.push(m),
    });
    expect(result.containersRemoved).toBe(0);
    expect(result.networksRemoved).toBe(1);
    expect(result.volumesRemoved).toBe(1);
    expect(result.errors).toEqual([
      'list containers failed: daemon unreachable',
      'rm network n2 failed: has active endpoints',
    ]);
    expect(warnings).toHaveLength(2);
  });

  it('is silent when the project holds nothing', async () => {
    const logs: string[] = [];
    const { run, calls } = makeRun(() => ok('\n'));
    const result = await reapComposeStack({
      run,
      projectName: 'session-7fb56e7f',
      removeVolumes: true,
      log: (m) => logs.push(m),
    });
    expect(result.errors).toEqual([]);
    expect(calls).toHaveLength(3); // the three list calls only
    expect(logs).toEqual([]);
  });
});

describe('sweepOrphanedComposeStacks', () => {
  it('reaps Hub-shaped stacks whose session is gone, skips live ones and foreign names', async () => {
    // The observed leak: dfcb608c archived with only its volume left (its
    // containers were removed by hand), 0e9fb5c2 left only a network, and
    // 7fb56e7f is the live session whose stack must survive. `backend` is a
    // foreign compose project that must never be touched.
    const { run, calls } = makeRun((argv) => {
      const format = argv.includes('--format');
      if (format && argv[1] === 'ps') return ok('session-7fb56e7f\nsession-7fb56e7f\nbackend\n');
      if (format && argv[1] === 'network')
        return ok('session-0e9fb5c2\nsession-7fb56e7f\nbackend\n');
      if (format && argv[1] === 'volume') return ok('session-dfcb608c\nbackend\n');
      if (argv.includes('label=com.docker.compose.project=session-dfcb608c')) {
        if (argv[1] === 'volume' && argv[2] === 'ls')
          return ok('session-dfcb608c_preview-postgres-data\n');
        return ok('');
      }
      if (argv.includes('label=com.docker.compose.project=session-0e9fb5c2')) {
        if (argv[1] === 'network' && argv[2] === 'ls') return ok('n-0e9f\n');
        return ok('');
      }
      return ok('');
    });
    const logs: string[] = [];
    const result = await sweepOrphanedComposeStacks({
      run,
      isSessionLive: (prefix) => prefix === '7fb56e7f',
      log: (m) => logs.push(m),
    });
    expect(result.skippedLive).toBe(1);
    expect(result.errors).toEqual([]);
    expect(result.reaped.map((r) => [r.projectName, r.volumesRemoved, r.networksRemoved])).toEqual([
      ['session-0e9fb5c2', 0, 1],
      ['session-dfcb608c', 1, 0],
    ]);
    expect(calls).toContainEqual([
      'docker',
      'volume',
      'rm',
      'session-dfcb608c_preview-postgres-data',
    ]);
    expect(calls).toContainEqual(['docker', 'network', 'rm', 'n-0e9f']);
    // Never any per-project call for the live session or the foreign name.
    expect(calls.some((c) => c.includes('label=com.docker.compose.project=session-7fb56e7f'))).toBe(
      false,
    );
    expect(calls.some((c) => c.includes('label=com.docker.compose.project=backend'))).toBe(false);
    expect(logs.at(-1)).toBe(
      '[compose-reaper] sweep: reaped 2 orphaned stack(s) (session-0e9fb5c2, session-dfcb608c); 1 live skipped',
    );
  });

  it('keeps going when one list call fails', async () => {
    const warnings: string[] = [];
    const { run } = makeRun((argv) => {
      if (argv.includes('--format') && argv[1] === 'ps') return fail('daemon unreachable');
      if (argv.includes('--format')) return ok('session-dfcb608c\n');
      return ok('');
    });
    const result = await sweepOrphanedComposeStacks({
      run,
      isSessionLive: () => false,
      log: () => {},
      warn: (m) => warnings.push(m),
    });
    expect(result.errors).toEqual(['list containers failed: daemon unreachable']);
    expect(result.reaped.map((r) => r.projectName)).toEqual(['session-dfcb608c']);
  });
});

describe('makeSessionLivenessCheck', () => {
  it('treats soft-deleted (archived) and missing sessions as not live', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, deleted_at TEXT)`);
    db.prepare(`INSERT INTO sessions VALUES (?, ?)`).run(
      '7fb56e7f-79c4-422b-9991-081b99bae9a0',
      null,
    );
    db.prepare(`INSERT INTO sessions VALUES (?, ?)`).run(
      'dfcb608c-d8ba-479f-8d60-5b9bc6f34c86',
      '2026-09-02 21:05:59',
    );
    const isLive = makeSessionLivenessCheck(db);
    expect(isLive('7fb56e7f')).toBe(true);
    expect(isLive('dfcb608c')).toBe(false);
    expect(isLive('0e9fb5c2')).toBe(false);
  });
});
