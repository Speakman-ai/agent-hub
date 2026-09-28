import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getStmts } from '../db.js';
import type { AutopilotRowStmts } from '../session-autopilot-slot.js';
import { setMainlineSlotFreedListener } from '../session-autopilot-slot.js';
import {
  type AutopilotSessionConfig,
  parseAutopilotSessionConfig,
} from '../../shared/utils/sessionAutopilot.js';
import { idleMainlineSlot, type MainlineSlot } from '../../shared/utils/autopilotMainlineSlot.js';
import {
  buildDefaultBranchPushArgs,
  classifyDefaultBranchPush,
  pushValidatedCommitToDefaultBranch,
  runGitCapturingOutput,
  type DefaultBranchGitRunner,
} from './push-to-default-branch.js';

const SHA = 'a'.repeat(40);
const DEST = 'refs/heads/main';
const project = { id: 'proj-mainline', githubRepo: 'o/r', cwd: '/tmp/project' };
const allowOrigin = vi.fn(async () => {});

function baseConfig(slot: MainlineSlot = idleMainlineSlot()): AutopilotSessionConfig {
  return {
    durationHours: 0,
    brief: 'Ship it',
    goal: 'Live',
    escalation: 'medium',
    branch: 'main',
    startedAt: '2026-09-27T10:00:00.000Z',
    deadlineAt: null,
    status: 'running',
    cycle: 0,
    lastPushSha: null,
    target: 'mainline',
    mainline: { deployEnvironment: 'prod', landedCount: 0, slot },
  };
}

let seq = 0;
function seedSession(cfg: AutopilotSessionConfig): string {
  const stmts = getStmts();
  const id = `ap-push-${++seq}-${Date.now()}`;
  stmts.createSession.run(id, 'agent-1', 'Autopilot', 'claude-code', 'test', 1, 0, 1);
  stmts.updateSessionMode.run('autopilot', id);
  stmts.updateSessionAutopilotConfig.run(JSON.stringify(cfg), id);
  return id;
}

function stored(id: string): AutopilotSessionConfig {
  const row = getStmts().getSession.get(id) as { autopilot_session_config: string | null };
  return parseAutopilotSessionConfig(row.autopilot_session_config)!;
}

function gitReturning(result: {
  exitCode: number | null;
  stdout?: string;
  stderr?: string;
}): DefaultBranchGitRunner & ReturnType<typeof vi.fn> {
  return vi.fn(async () => ({ stdout: '', stderr: '', ...result }));
}

function push(sessionId: string, git: DefaultBranchGitRunner, stmts?: AutopilotRowStmts) {
  return pushValidatedCommitToDefaultBranch({
    stmts: stmts ?? getStmts(),
    sessionId,
    project,
    worktreePath: '/tmp/wt',
    sha: SHA,
    defaultBranch: 'main',
    env: process.env,
    git,
    guardOrigin: allowOrigin,
    mintAttemptId: () => 'attempt-1',
    log: () => {},
  });
}

describe('buildDefaultBranchPushArgs', () => {
  it('pushes exactly one ref with tags off', () => {
    expect(buildDefaultBranchPushArgs(SHA, 'main')).toEqual([
      '-c',
      'push.followTags=false',
      'push',
      '--porcelain',
      '--no-follow-tags',
      'origin',
      `${SHA}:refs/heads/main`,
    ]);
  });
});

describe('classifyDefaultBranchPush', () => {
  const line = (flag: string, to = DEST) => `${flag}\t${SHA}:${to}\t[summary]`;

  it.each([' ', '+', '*', '='])('flag %j is landed', (flag) => {
    expect(classifyDefaultBranchPush(`To origin\n${line(flag)}\nDone\n`, DEST)).toMatchObject({
      outcome: 'landed',
      upToDate: flag === '=',
    });
  });

  it('is up to date only when every endpoint already had the commit', () => {
    const out = `To a\n${line('=')}\nTo b\n${line(' ')}\nDone\n`;
    expect(classifyDefaultBranchPush(out, DEST, 2)).toMatchObject({
      outcome: 'landed',
      upToDate: false,
    });
  });

  it('flag ! is rejected', () => {
    const out = `To origin\n!\t${SHA}:${DEST}\t[rejected] (non-fast-forward)\nDone\n`;
    expect(classifyDefaultBranchPush(out, DEST)).toEqual({
      outcome: 'rejected',
      line: `!\t${SHA}:${DEST}\t[rejected] (non-fast-forward)`,
      upToDate: false,
    });
  });

  it('[remote rejected] (the remote reported ng) is rejected', () => {
    const out = `!\t${SHA}:${DEST}\t[remote rejected] (pre-receive hook declined)\n`;
    expect(classifyDefaultBranchPush(out, DEST).outcome).toBe('rejected');
  });

  it.each([
    '[remote failure] (remote failed to report status)',
    '[no match]',
    '[something new]',
    '',
  ])('flag ! with summary %j is unknown, not rejected', (summary) => {
    const out = `To origin\n!\t${SHA}:${DEST}\t${summary}\nDone\n`;
    expect(classifyDefaultBranchPush(out, DEST).outcome).toBe('unknown');
  });

  it('reads only the destination line: a rejected tag does not hide a landed branch', () => {
    const out = [
      'To origin',
      '!\trefs/tags/v1:refs/tags/v1\t[rejected] (already exists)',
      line(' '),
      'Done',
    ].join('\n');
    expect(classifyDefaultBranchPush(out, DEST).outcome).toBe('landed');
  });

  it('another branch landing does not count for ours', () => {
    expect(classifyDefaultBranchPush(line(' ', 'refs/heads/other'), DEST).outcome).toBe('unknown');
  });

  it('no destination line is unknown', () => {
    expect(classifyDefaultBranchPush('', DEST)).toEqual({
      outcome: 'unknown',
      line: null,
      upToDate: false,
    });
  });
});

describe('classifyDefaultBranchPush: several push endpoints', () => {
  const rejected = `!\t${SHA}:${DEST}\t[rejected] (non-fast-forward)`;
  const landed = ` \t${SHA}:${DEST}\ta..b`;
  const failure = `!\t${SHA}:${DEST}\t[remote failure] (remote failed to report status)`;
  const sections = (...bodies: string[]) =>
    bodies.map((b, i) => `To endpoint-${i}\n${b}\nDone`).join('\n');

  it('rejection then success is unknown, not rejected', () => {
    expect(classifyDefaultBranchPush(sections(rejected, landed), DEST, 2).outcome).toBe('unknown');
  });

  it('rejection then an ambiguous remote failure is unknown', () => {
    expect(classifyDefaultBranchPush(sections(rejected, failure), DEST, 2).outcome).toBe('unknown');
  });

  it('rejection then an endpoint that printed nothing for our ref is unknown', () => {
    expect(classifyDefaultBranchPush(sections(rejected, ''), DEST, 2).outcome).toBe('unknown');
  });

  it('rejection with the second endpoint never reached is unknown', () => {
    expect(classifyDefaultBranchPush(sections(rejected), DEST, 2).outcome).toBe('unknown');
  });

  it('every endpoint rejecting is rejected; every endpoint landing is landed', () => {
    expect(classifyDefaultBranchPush(sections(rejected, rejected), DEST, 2).outcome).toBe(
      'rejected',
    );
    expect(classifyDefaultBranchPush(sections(landed, landed), DEST, 2).outcome).toBe('landed');
  });

  it('more sections than expected still need agreement', () => {
    expect(classifyDefaultBranchPush(sections(rejected, landed), DEST).outcome).toBe('unknown');
  });
});

describe('pushValidatedCommitToDefaultBranch', () => {
  it('lands: slot idle → pushing (read back) → landed, counter bumped', async () => {
    const id = seedSession(baseConfig());
    const git = vi.fn<DefaultBranchGitRunner>(async () => {
      // The intent is durable before git runs.
      expect(stored(id).mainline!.slot).toMatchObject({
        phase: 'pushing',
        attemptId: 'attempt-1',
        sha: SHA,
      });
      return { exitCode: 0, stdout: `To origin\n \t${SHA}:${DEST}\tabc..def\nDone\n`, stderr: '' };
    });
    const res = await push(id, git);
    expect(res).toMatchObject({ kind: 'landed', attemptId: 'attempt-1', slotRecorded: true });
    expect(git).toHaveBeenCalledOnce();
    expect(git.mock.calls[0]![0]).toEqual(buildDefaultBranchPushArgs(SHA, 'main'));
    expect(stored(id).mainline).toMatchObject({ slot: { phase: 'landed' }, landedCount: 1 });
  });

  const upToDate = () =>
    gitReturning({ exitCode: 0, stdout: `To origin\n=\t${SHA}:${DEST}\t[up to date]\nDone\n` });

  it("a re-push of this session's last landing (`=`) frees the slot without a new landing", async () => {
    const cfg = baseConfig();
    const id = seedSession({
      ...cfg,
      mainline: { ...cfg.mainline!, landedCount: 1, lastLandedSha: SHA },
    });
    expect(await push(id, upToDate())).toMatchObject({
      kind: 'already_landed',
      slotRecorded: true,
    });
    expect(stored(id).mainline).toMatchObject({
      slot: { phase: 'idle', attemptId: null },
      landedCount: 1,
    });
  });

  it('a `=` for a commit this session never landed is a landing that deploys', async () => {
    const cfg = baseConfig();
    const id = seedSession({
      ...cfg,
      mainline: { ...cfg.mainline!, landedCount: 1, lastLandedSha: 'c'.repeat(40) },
    });
    expect(await push(id, upToDate())).toMatchObject({ kind: 'landed', slotRecorded: true });
    expect(stored(id).mainline).toMatchObject({
      slot: { phase: 'landed', sha: SHA },
      landedCount: 2,
      lastLandedSha: SHA,
    });
  });

  it('an intent write that throws pushes nothing and reports the write failure', async () => {
    const id = seedSession(baseConfig());
    const real = getStmts();
    const stmts = {
      getSession: real.getSession,
      casSessionAutopilotConfig: {
        run: () => {
          throw new Error('SQLITE_IOERR: disk I/O error');
        },
      },
    } as unknown as AutopilotRowStmts;
    const git = gitReturning({ exitCode: 0 });
    expect(await push(id, git, stmts)).toMatchObject({
      kind: 'refused',
      reason: 'slot_write_failed',
    });
    expect(git).not.toHaveBeenCalled();
    expect(stored(id).mainline!.slot.phase).toBe('idle');
  });

  it('an outcome write that throws leaves the intent for the reconciler', async () => {
    const id = seedSession(baseConfig());
    const real = getStmts();
    let writes = 0;
    const stmts = {
      getSession: real.getSession,
      casSessionAutopilotConfig: {
        run: (...args: [string, string, string | null]) => {
          if (++writes > 1) throw new Error('SQLITE_IOERR: disk I/O error');
          return real.casSessionAutopilotConfig.run(...args);
        },
      },
    } as unknown as AutopilotRowStmts;
    const git = gitReturning({ exitCode: 0, stdout: `To origin\n \t${SHA}:${DEST}\ta..b\n` });
    expect(await push(id, git, stmts)).toMatchObject({ kind: 'landed', slotRecorded: false });
    expect(stored(id).mainline!.slot).toMatchObject({ phase: 'pushing', attemptId: 'attempt-1' });
  });

  it('tag rejected but branch landed (non-zero exit) is landed', async () => {
    const id = seedSession(baseConfig());
    const git = gitReturning({
      exitCode: 1,
      stdout: `To origin\n!\trefs/tags/v1:refs/tags/v1\t[rejected]\n \t${SHA}:${DEST}\ta..b\nDone\n`,
      stderr: 'error: failed to push some refs',
    });
    expect((await push(id, git)).kind).toBe('landed');
    expect(stored(id).mainline!.slot.phase).toBe('landed');
  });

  it('non-fast-forward is rejected and clears only this attempt', async () => {
    const id = seedSession(baseConfig());
    const freed = vi.fn();
    setMainlineSlotFreedListener(freed);
    try {
      const git = gitReturning({
        exitCode: 1,
        stdout: `To origin\n!\t${SHA}:${DEST}\t[rejected] (non-fast-forward)\nDone\n`,
      });
      const res = await push(id, git);
      expect(res).toMatchObject({ kind: 'rejected', slotRecorded: true });
      expect(stored(id).mainline).toMatchObject({
        slot: { phase: 'idle', attemptId: null },
        landedCount: 0,
      });
      expect(freed).toHaveBeenCalledWith(id);
    } finally {
      setMainlineSlotFreedListener(null);
    }
  });

  it('transport error after the remote accepted the ref is landed', async () => {
    const id = seedSession(baseConfig());
    const git = gitReturning({
      exitCode: 128,
      stdout: `To origin\n \t${SHA}:${DEST}\ta..b\n`,
      stderr: 'fatal: the remote end hung up unexpectedly',
    });
    expect((await push(id, git)).kind).toBe('landed');
    expect(stored(id).mainline!.slot.phase).toBe('landed');
  });

  it('remote failure (status report lost) keeps the attempt as uncertain', async () => {
    const id = seedSession(baseConfig());
    const freed = vi.fn();
    setMainlineSlotFreedListener(freed);
    try {
      const git = gitReturning({
        exitCode: 1,
        stdout: `To origin\n!\t${SHA}:${DEST}\t[remote failure] (remote failed to report status)\nDone\n`,
        stderr: 'error: failed to push some refs to origin',
      });
      const res = await push(id, git);
      expect(res).toMatchObject({ kind: 'unknown', slotRecorded: true });
      expect(stored(id).mainline!.slot).toMatchObject({
        phase: 'uncertain',
        attemptId: 'attempt-1',
        sha: SHA,
      });
      expect(freed).not.toHaveBeenCalled();
    } finally {
      setMainlineSlotFreedListener(null);
    }
  });

  it.each([
    ['success', ` \t${SHA}:${DEST}\ta..b`],
    ['an unknown outcome', `!\t${SHA}:${DEST}\t[remote failure] (remote failed to report status)`],
  ])('rejection followed by %s keeps the attempt as uncertain', async (_label, second) => {
    const id = seedSession(baseConfig());
    const freed = vi.fn();
    setMainlineSlotFreedListener(freed);
    try {
      const git = gitReturning({
        exitCode: 1,
        stdout:
          `To a\n!\t${SHA}:${DEST}\t[rejected] (non-fast-forward)\nDone\n` +
          `To b\n${second}\nDone\n`,
      });
      expect((await push(id, git)).kind).toBe('unknown');
      expect(stored(id).mainline!.slot).toMatchObject({
        phase: 'uncertain',
        attemptId: 'attempt-1',
      });
      expect(freed).not.toHaveBeenCalled();
    } finally {
      setMainlineSlotFreedListener(null);
    }
  });

  it('a killed push with no porcelain line is unknown → uncertain', async () => {
    const id = seedSession(baseConfig());
    const res = await push(id, gitReturning({ exitCode: null, stderr: 'killed' }));
    expect(res.kind).toBe('unknown');
    expect(stored(id).mainline!.slot).toMatchObject({
      phase: 'uncertain',
      attemptId: 'attempt-1',
      sha: SHA,
    });
  });

  it('refuses when the slot is not idle; git never runs', async () => {
    const busy: MainlineSlot = {
      ...idleMainlineSlot(),
      phase: 'deploying',
      attemptId: 'old',
      sha: 'b'.repeat(40),
      deploymentId: 'd1',
    };
    const id = seedSession(baseConfig(busy));
    const git = gitReturning({ exitCode: 0 });
    const res = await push(id, git);
    expect(res).toMatchObject({ kind: 'refused', reason: 'slot_busy' });
    expect(git).not.toHaveBeenCalled();
    expect(stored(id).mainline!.slot).toMatchObject({ phase: 'deploying', attemptId: 'old' });
  });

  it('slot write failure: nothing is pushed', async () => {
    const id = seedSession(baseConfig());
    const real = getStmts();
    const failing = {
      getSession: real.getSession,
      casSessionAutopilotConfig: { run: () => ({ changes: 0 }) },
    } as unknown as AutopilotRowStmts;
    const git = gitReturning({ exitCode: 0 });
    const res = await push(id, git, failing);
    expect(res).toMatchObject({ kind: 'refused', reason: 'slot_write_failed' });
    expect(git).not.toHaveBeenCalled();
  });

  it('write reported but not read back: nothing is pushed', async () => {
    const id = seedSession(baseConfig());
    const real = getStmts();
    // Claims success without writing, so the read-back still sees idle.
    const lying = {
      getSession: real.getSession,
      casSessionAutopilotConfig: { run: () => ({ changes: 1 }) },
    } as unknown as AutopilotRowStmts;
    const git = gitReturning({ exitCode: 0 });
    const res = await push(id, git, lying);
    expect(res).toMatchObject({ kind: 'refused', reason: 'slot_write_failed' });
    expect(git).not.toHaveBeenCalled();
  });

  it('origin guard failure refuses before claiming the slot', async () => {
    const id = seedSession(baseConfig());
    const git = gitReturning({ exitCode: 0 });
    const res = await pushValidatedCommitToDefaultBranch({
      stmts: getStmts(),
      sessionId: id,
      project,
      worktreePath: '/tmp/wt',
      sha: SHA,
      defaultBranch: 'main',
      env: process.env,
      git,
      guardOrigin: async () => {
        throw new Error('github push refused: origin mismatch');
      },
    });
    expect(res).toMatchObject({ kind: 'refused', reason: 'origin_refused' });
    expect(git).not.toHaveBeenCalled();
    expect(stored(id).mainline!.slot.phase).toBe('idle');
  });
});

describe('real git: porcelain from an actual push', () => {
  let root: string;
  let remote: string;
  let work: string;
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@e',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@e',
      },
    }).trim();
  const commit = (msg: string) => {
    writeFileSync(join(work, 'f.txt'), msg);
    git(work, 'add', '.');
    git(work, 'commit', '-qm', msg);
    return git(work, 'rev-parse', 'HEAD');
  };
  const pushSha = async (sha: string) => {
    const res = await runGitCapturingOutput(buildDefaultBranchPushArgs(sha, 'main'), {
      cwd: work,
      env: process.env,
    });
    return { res, ...classifyDefaultBranchPush(res.stdout, DEST) };
  };

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'mainline-push-'));
    remote = join(root, 'remote.git');
    work = join(root, 'work');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
    execFileSync('git', ['init', '-q', '-b', 'main', work]);
    git(work, 'remote', 'add', 'origin', remote);
    // Make followTags the configured default so the command has to override it.
    git(work, 'config', 'push.followTags', 'true');
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('new branch, fast-forward, and up-to-date all land; no tag is pushed', async () => {
    const first = commit('one');
    expect((await pushSha(first)).outcome).toBe('landed');
    const second = commit('two');
    git(work, 'tag', '-a', 'v1', '-m', 'v1');
    const ff = await pushSha(second);
    expect(ff.outcome).toBe('landed');
    expect(ff.res.exitCode).toBe(0);
    expect(git(remote, 'rev-parse', 'refs/heads/main')).toBe(second);
    expect(git(remote, 'tag', '--list')).toBe('');
    expect((await pushSha(second)).outcome).toBe('landed');
  });

  it('a non-fast-forward is rejected and the remote is unchanged', async () => {
    const before = git(remote, 'rev-parse', 'refs/heads/main');
    git(work, 'reset', '-q', '--hard', 'HEAD~1');
    const diverged = commit('diverged');
    const res = await pushSha(diverged);
    expect(res.outcome).toBe('rejected');
    expect(res.res.exitCode).not.toBe(0);
    expect(git(remote, 'rev-parse', 'refs/heads/main')).toBe(before);
  });
});

describe('real git: two push URLs, one rejects and one accepts', () => {
  let root: string;
  const run = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@e',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@e',
      },
    }).trim();

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'mainline-two-urls-'));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('the combined result is unknown, not rejected', async () => {
    const a = join(root, 'a.git');
    const b = join(root, 'b.git');
    const work = join(root, 'work');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', a]);
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', b]);
    execFileSync('git', ['init', '-q', '-b', 'main', work]);
    const commit = (msg: string) => {
      writeFileSync(join(work, 'f.txt'), msg);
      run(work, 'add', '.');
      run(work, 'commit', '-qm', msg);
      return run(work, 'rev-parse', 'HEAD');
    };
    const base = commit('base');
    // `a` has moved on, so pushing a child of `base` there is a non-fast-forward.
    run(work, 'commit', '-q', '--amend', '-m', 'elsewhere');
    const elsewhere = run(work, 'rev-parse', 'HEAD');
    run(a, 'fetch', '-q', work, `${elsewhere}:refs/heads/main`);
    run(b, 'fetch', '-q', work, `${base}:refs/heads/main`);
    run(work, 'reset', '-q', '--hard', base);
    const next = commit('next');

    run(work, 'remote', 'add', 'origin', a);
    run(work, 'config', '--add', 'remote.origin.pushurl', a);
    run(work, 'config', '--add', 'remote.origin.pushurl', b);

    const res = await runGitCapturingOutput(buildDefaultBranchPushArgs(next, 'main'), {
      cwd: work,
      env: process.env,
    });
    expect(run(b, 'rev-parse', 'refs/heads/main')).toBe(next);
    expect(classifyDefaultBranchPush(res.stdout, DEST, 2).outcome).toBe('unknown');
  });
});
