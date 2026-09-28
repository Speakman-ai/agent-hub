/**
 * POST /api/sessions/:sessionId/discard-changes
 *
 * The session worktree is a {@link FakeWorktreeIo} backed by a small in-memory
 * git model, injected through `routeDeps.getSessionWorktreeIo`. `gh` is
 * mocked at its wrapper module. While a discard runs, every child_process
 * launcher throws, so these tests prove the discard path starts no process.
 */
import type supertest from 'supertest';
import { v4 as uuidv4 } from 'uuid';
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';

// ── No-process guard ────────────────────────────────────────────────────────
// Hoisted above every import, so modules that bind `promisify(execFile)` at
// load (session-env/worktree-io.ts) get the guarded launcher too.
const guard = vi.hoisted(() => ({ forbid: false, launched: [] as string[] }));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { promisify } = await import('util');
  const check = (name: string, cmd: unknown) => {
    if (!guard.forbid) return;
    guard.launched.push(`${name}(${String(cmd)})`);
    throw new Error(`discard tests must not launch processes: ${name}(${String(cmd)})`);
  };
  const out: Record<string, unknown> = { ...actual };
  for (const name of [
    'spawn',
    'spawnSync',
    'exec',
    'execSync',
    'execFile',
    'execFileSync',
    'fork',
  ]) {
    const original = actual[name] as ((...a: unknown[]) => unknown) & Record<symbol, unknown>;
    const wrapped = ((...args: unknown[]) => {
      check(name, args[0]);
      return original(...args);
    }) as ((...a: unknown[]) => unknown) & Record<symbol, unknown>;
    const custom = original[promisify.custom] as ((...a: unknown[]) => unknown) | undefined;
    if (custom) {
      wrapped[promisify.custom] = (...args: unknown[]) => {
        check(name, args[0]);
        return custom(...args);
      };
    }
    out[name] = wrapped;
  }
  return { ...out, default: out };
});

vi.mock('../github-branch-pr.js', () => ({ lookupGithubOpenPr: vi.fn() }));

import { getDb } from '../db.js';
import { activeProcesses, routeDeps } from '../index.js';
import { lookupGithubOpenPr } from '../github-branch-pr.js';
import { discardSessionChanges } from '../session-discard.js';
import {
  HostWorktreeIo,
  type SessionWorktreeIo,
  type WorktreeGitResult,
} from '../session-env/worktree-io.js';
import {
  releaseSessionWorktreeLock,
  tryAcquireSessionWorktreeLock,
} from '../session-worktree-lock.js';
import type { SessionRow } from '../types.js';
import { FakeWorktreeIo } from './fake-worktree-io.js';
import { getRequest, createSession, createAgent, createCard } from './helpers.js';

const lookupGithub = vi.mocked(lookupGithubOpenPr);

/** Run `fn` with every child_process launcher throwing; assert nothing tried. */
async function withoutProcesses<T>(fn: () => Promise<T>): Promise<T> {
  guard.forbid = true;
  try {
    return await fn();
  } finally {
    guard.forbid = false;
    expect(guard.launched).toEqual([]);
  }
}

// ── In-memory git model ─────────────────────────────────────────────────────
const BASE_SHA = 'b'.repeat(40);
const SESSION_SHA = 's'.repeat(40);
const SESSION_BRANCH = 'agent-hub/test/session-x';

interface RepoState {
  branch: string | null;
  head: string;
  refs: Record<string, string>;
  forkPoints: Record<string, string>;
  remotes: Record<string, string>;
  originHead: string | null;
  dirty: boolean;
  untracked: boolean;
}

interface Fault {
  match: string[];
  result?: Partial<WorktreeGitResult>;
}

function fakeRepo(opts: { origin?: string | null; faults?: Fault[] } = {}): {
  io: FakeWorktreeIo;
  state: RepoState;
} {
  const state: RepoState = {
    branch: SESSION_BRANCH,
    head: SESSION_SHA,
    refs: { main: BASE_SHA },
    forkPoints: { main: BASE_SHA },
    remotes: {},
    originHead: null,
    dirty: true,
    untracked: true,
  };
  if (opts.origin) {
    state.remotes.origin = opts.origin;
    state.refs['origin/main'] = BASE_SHA;
    state.forkPoints['origin/main'] = BASE_SHA;
    state.originHead = 'main';
  }
  const eq = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

  const io = new FakeWorktreeIo('env-owned', null, {
    git: (args) => {
      for (const f of opts.faults ?? []) {
        if (f.match.every((m, i) => args[i] === m)) {
          return { stderr: 'fatal: injected failure', exitCode: 128, ...f.result };
        }
      }
      if (eq(args, ['remote'])) return { stdout: Object.keys(state.remotes).join('\n') };
      if (args[0] === 'remote' && args[1] === 'get-url') {
        const url = state.remotes[args[2]!];
        return url ? { stdout: `${url}\n` } : { exitCode: 2, stderr: 'error: No such remote' };
      }
      if (eq(args, ['rev-parse', '--abbrev-ref', 'HEAD']))
        return { stdout: state.branch ?? 'HEAD' };
      if (eq(args, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'])) {
        return state.originHead
          ? { stdout: `refs/remotes/origin/${state.originHead}` }
          : { exitCode: 1 };
      }
      if (args[0] === 'rev-parse' && args[1] === '--verify') {
        const sha = state.refs[args[3]!.replace(/\^\{commit\}$/, '')];
        return sha ? { stdout: sha } : { exitCode: 1 };
      }
      if (args[0] === 'merge-base') {
        const sha = state.forkPoints[args[2]!];
        return sha ? { stdout: sha } : { exitCode: 1 };
      }
      if (args[0] === 'reset' && args[1] === '--hard') {
        state.head = args[2]!;
        state.dirty = false;
        return {};
      }
      if (eq(args, ['clean', '-fd'])) {
        state.untracked = false;
        return {};
      }
      return { exitCode: 128, stderr: `unexpected git ${args.join(' ')}` };
    },
  });
  return { io, state };
}

function wroteWorktree(io: FakeWorktreeIo): boolean {
  return io.gitCalls.some((c) => c.args[0] === 'reset' || c.args[0] === 'clean');
}

// ── Session fixtures ────────────────────────────────────────────────────────
const fakes = new Map<string, SessionWorktreeIo>();
const realGetIo = routeDeps.getSessionWorktreeIo;
let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
  routeDeps.getSessionWorktreeIo = async (id) => fakes.get(id) ?? (await realGetIo?.(id)) ?? null;
});

afterAll(() => {
  routeDeps.getSessionWorktreeIo = realGetIo;
});

afterEach(() => {
  lookupGithub.mockReset();
  fakes.clear();
  guard.launched.length = 0;
});

async function sessionWithWorktree(
  repo: { origin?: string | null; faults?: Fault[] } = {},
): Promise<{
  sessionId: string;
  agentId: string;
  projectId: string;
  io: FakeWorktreeIo;
  state: RepoState;
}> {
  const agent = await createAgent();
  const session = await createSession({ agentId: agent.id as string });
  const sessionId = session.id as string;
  getDb()
    .prepare(
      'UPDATE sessions SET worktree_path = ?, worktree_branch = ?, use_worktree = 1, changes_ready = ? WHERE id = ?',
    )
    .run(
      `/fake/worktrees/${sessionId}`,
      SESSION_BRANCH,
      JSON.stringify({ branch: SESSION_BRANCH, hasUncommitted: true }),
      sessionId,
    );
  const { io, state } = fakeRepo(repo);
  fakes.set(sessionId, io);
  return {
    sessionId,
    agentId: agent.id as string,
    projectId: agent.projectId as string,
    io,
    state,
  };
}

function postDiscard(sessionId: string, status: number) {
  return withoutProcesses(() =>
    request.post(`/api/sessions/${sessionId}/discard-changes`).expect(status),
  );
}

function sessionRow(id: string): { changes_ready: string | null; discarded_at: string | null } {
  return getDb()
    .prepare('SELECT changes_ready, discarded_at FROM sessions WHERE id = ?')
    .get(id) as { changes_ready: string | null; discarded_at: string | null };
}

const GITHUB_ORIGIN = 'https://github.com/acme/widgets.git';

describe('POST /api/sessions/:sessionId/discard-changes', () => {
  it('process guard intercepts launches from the host worktree io', async () => {
    guard.forbid = true;
    try {
      await expect(new HostWorktreeIo('/tmp').git(['status'])).rejects.toThrow(
        /must not launch processes/,
      );
    } finally {
      guard.forbid = false;
    }
    expect(guard.launched).toEqual(['execFile(git)']);
  });

  it('resets to the fork point, cleans untracked files, and clears changes_ready', async () => {
    const s = await sessionWithWorktree();

    const res = await postDiscard(s.sessionId, 200);
    expect(res.body).toMatchObject({
      ok: true,
      sessionId: s.sessionId,
      baseRef: 'main',
      baseSha: BASE_SHA,
    });

    const writes = s.io.gitCalls
      .map((c) => c.args)
      .filter((a) => a[0] === 'reset' || a[0] === 'clean');
    // -fd without -x: ignored files (dependency installs) are kept.
    expect(writes).toEqual([
      ['reset', '--hard', BASE_SHA],
      ['clean', '-fd'],
    ]);
    expect(s.state).toMatchObject({ head: BASE_SHA, dirty: false, untracked: false });

    const row = sessionRow(s.sessionId);
    expect(row.changes_ready).toBeNull();
    expect(row.discarded_at).toBeTruthy();

    const msgs = getDb()
      .prepare("SELECT metadata FROM messages WHERE session_id = ? AND role = 'system'")
      .all(s.sessionId) as { metadata: string | null }[];
    expect(msgs.some((m) => m.metadata?.includes('"changes_discarded"'))).toBe(true);
    // No origin remote: nothing to ask GitHub about.
    expect(lookupGithub).not.toHaveBeenCalled();
  });

  it('treats a local-path origin as having no PR host', async () => {
    const s = await sessionWithWorktree({ origin: '/home/node/projects/widgets' });
    await postDiscard(s.sessionId, 200);
    expect(lookupGithub).not.toHaveBeenCalled();
    expect(s.state.head).toBe(BASE_SHA);
  });

  it('refuses with 409 while a turn is running', async () => {
    const s = await sessionWithWorktree();
    activeProcesses.set(s.sessionId, {} as never);
    try {
      const res = await postDiscard(s.sessionId, 409);
      expect(res.body.code).toBe('session_running');
    } finally {
      activeProcesses.delete(s.sessionId);
    }
    expect(wroteWorktree(s.io)).toBe(false);
    expect(sessionRow(s.sessionId).changes_ready).not.toBeNull();
  });

  it('refuses with 409 while Finalize is in flight', async () => {
    const s = await sessionWithWorktree();
    const cols = (
      getDb().prepare('PRAGMA table_info(finalize_runs)').all() as {
        name: string;
        notnull: number;
        dflt_value: unknown;
      }[]
    ).filter((c) => c.notnull && c.dflt_value == null);
    const values: Record<string, unknown> = {};
    for (const c of cols) values[c.name] = 'x';
    Object.assign(values, { id: uuidv4(), session_id: s.sessionId, status: 'running' });
    const keys = Object.keys(values);
    getDb()
      .prepare(
        `INSERT INTO finalize_runs (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`,
      )
      .run(...keys.map((k) => values[k]));

    const res = await postDiscard(s.sessionId, 409);
    expect(res.body.code).toBe('finalize_in_flight');
    expect(wroteWorktree(s.io)).toBe(false);
  });

  it('refuses with 409 while a native PR for the branch is open', async () => {
    const s = await sessionWithWorktree();
    const now = Date.now();
    getDb()
      .prepare(
        `INSERT INTO pull_requests (id, project_id, number, title, head_branch, base_branch, head_sha, status, author, created_at, updated_at)
         VALUES (?, ?, 1, 'wip', ?, 'main', 'abc', 'open', 'u', ?, ?)`,
      )
      .run(uuidv4(), s.projectId, SESSION_BRANCH, now, now);

    const res = await postDiscard(s.sessionId, 409);
    expect(res.body.code).toBe('pr_open');
    expect(wroteWorktree(s.io)).toBe(false);
    expect(sessionRow(s.sessionId).discarded_at).toBeNull();
  });

  it('returns 400 for a session with no worktree', async () => {
    const session = await createSession();
    const res = await postDiscard(session.id as string, 400);
    expect(res.body.code).toBe('no_worktree');
  });

  it('returns 404 for an unknown session', async () => {
    await postDiscard('does-not-exist-discard', 404);
  });

  describe('GitHub PR state', () => {
    it('refuses when GitHub reports an open PR even though the linked card is in Done', async () => {
      const s = await sessionWithWorktree({ origin: GITHUB_ORIGIN });
      const board = await request.get(`/api/projects/${s.projectId}/board`).expect(200);
      const done = (board.body.columns as { id: string; name: string }[]).find((c) =>
        /done/i.test(c.name),
      );
      expect(done).toBeTruthy();
      await createCard(s.projectId, {
        columnId: done!.id,
        session_id: s.sessionId,
        pr_url: 'https://github.com/acme/widgets/pull/7',
      });
      lookupGithub.mockResolvedValue({
        kind: 'open',
        ref: 'https://github.com/acme/widgets/pull/7',
      });

      const res = await postDiscard(s.sessionId, 409);
      expect(res.body.code).toBe('pr_open');
      expect(lookupGithub).toHaveBeenCalledWith(
        expect.objectContaining({ repo: 'acme/widgets', branch: SESSION_BRANCH }),
      );
      expect(wroteWorktree(s.io)).toBe(false);
    });

    it('refuses when GitHub reports an open PR for a session with no card', async () => {
      const s = await sessionWithWorktree({ origin: GITHUB_ORIGIN });
      lookupGithub.mockResolvedValue({ kind: 'open', ref: '#3' });
      const res = await postDiscard(s.sessionId, 409);
      expect(res.body.code).toBe('pr_open');
      expect(sessionRow(s.sessionId).changes_ready).not.toBeNull();
    });

    it('refuses when PR state cannot be established', async () => {
      const s = await sessionWithWorktree({ origin: GITHUB_ORIGIN });
      lookupGithub.mockResolvedValue({ kind: 'unknown', reason: 'gh: not logged in' });
      const res = await postDiscard(s.sessionId, 409);
      expect(res.body.code).toBe('pr_state_unknown');
      expect(wroteWorktree(s.io)).toBe(false);
    });

    it('refuses when origin is a network remote that is not GitHub', async () => {
      const s = await sessionWithWorktree({ origin: 'https://gitlab.example.com/acme/w.git' });
      const res = await postDiscard(s.sessionId, 409);
      expect(res.body.code).toBe('pr_state_unknown');
      expect(wroteWorktree(s.io)).toBe(false);
    });

    it('discards against origin/<base> when GitHub confirms no open PR', async () => {
      const s = await sessionWithWorktree({ origin: GITHUB_ORIGIN });
      lookupGithub.mockResolvedValue({ kind: 'none' });
      const res = await postDiscard(s.sessionId, 200);
      expect(res.body.baseRef).toBe('origin/main');
      expect(s.state.head).toBe(BASE_SHA);
    });
  });

  describe('concurrency', () => {
    it('refuses while another operation holds the session worktree lock', async () => {
      const s = await sessionWithWorktree();
      expect(tryAcquireSessionWorktreeLock(s.sessionId, 'turn-start')).toBe(true);
      try {
        const res = await postDiscard(s.sessionId, 409);
        expect(res.body.code).toBe('session_busy');
      } finally {
        releaseSessionWorktreeLock(s.sessionId, 'turn-start');
      }
      expect(s.io.gitCalls).toEqual([]);
    });

    it('blocks turn start, Finalize kickoff, and ship while paused before reset', async () => {
      const s = await sessionWithWorktree();
      const session = getDb()
        .prepare('SELECT * FROM sessions WHERE id = ?')
        .get(s.sessionId) as SessionRow;
      const found = routeDeps.findAgent(s.agentId)!;

      let releaseIo!: (io: SessionWorktreeIo) => void;
      const ioGate = new Promise<SessionWorktreeIo>((resolve) => {
        releaseIo = resolve;
      });
      const drainQueue = vi.fn();
      guard.forbid = true;
      const pending = discardSessionChanges({
        session,
        project: found.project,
        config: routeDeps.config,
        stmts: routeDeps.stmts,
        activeProcesses: routeDeps.activeProcesses,
        broadcast: () => {},
        getIo: () => ioGate,
        drainQueue,
      });
      guard.forbid = false;

      // Discard is parked inside getIo with the lock held.
      expect(tryAcquireSessionWorktreeLock(s.sessionId, 'turn-start')).toBe(false);
      expect(tryAcquireSessionWorktreeLock(s.sessionId, 'finalize')).toBe(false);
      expect(tryAcquireSessionWorktreeLock(s.sessionId, 'multi-agent-round')).toBe(false);
      const ship = await withoutProcesses(() =>
        request.post(`/api/sessions/${s.sessionId}/ship`).expect(409),
      );
      expect(ship.body.code).toBe('discard_in_progress');
      const second = await postDiscard(s.sessionId, 409);
      expect(second.body.code).toBe('session_busy');

      const result = await withoutProcesses(async () => {
        releaseIo(s.io);
        return pending;
      });
      expect(result.ok).toBe(true);
      expect(s.state.head).toBe(BASE_SHA);

      // Lock released and queued turns replayed.
      expect(tryAcquireSessionWorktreeLock(s.sessionId, 'turn-start')).toBe(true);
      releaseSessionWorktreeLock(s.sessionId, 'turn-start');
      await new Promise((r) => setImmediate(r));
      expect(drainQueue).toHaveBeenCalledWith(s.sessionId);
    });
  });

  describe('fails closed when a pre-reset git probe fails', () => {
    const cases: Array<{
      name: string;
      fault: Fault;
      origin?: string;
      code: string;
    }> = [
      { name: 'listing remotes fails', fault: { match: ['remote'] }, code: 'pr_state_unknown' },
      {
        name: 'reading the origin URL fails',
        fault: { match: ['remote', 'get-url'] },
        origin: GITHUB_ORIGIN,
        code: 'pr_state_unknown',
      },
      {
        name: 'reading the origin URL prints nothing',
        fault: { match: ['remote', 'get-url'], result: { exitCode: 0, stderr: '' } },
        origin: GITHUB_ORIGIN,
        code: 'pr_state_unknown',
      },
      {
        name: 'reading the checked-out branch fails',
        fault: { match: ['rev-parse', '--abbrev-ref'] },
        code: 'branch_unresolved',
      },
      {
        name: 'reading origin/HEAD fails',
        fault: { match: ['symbolic-ref'] },
        code: 'base_unresolved',
      },
      {
        name: 'verifying the base ref fails',
        fault: { match: ['rev-parse', '--verify'] },
        code: 'base_unresolved',
      },
      { name: 'merge-base fails', fault: { match: ['merge-base'] }, code: 'base_unresolved' },
    ];

    for (const c of cases) {
      it(`refuses without reset or clean when ${c.name}`, async () => {
        const s = await sessionWithWorktree({ origin: c.origin, faults: [c.fault] });
        lookupGithub.mockResolvedValue({ kind: 'none' });

        const res = await postDiscard(s.sessionId, 409);
        expect(res.body.code).toBe(c.code);
        expect(wroteWorktree(s.io)).toBe(false);
        expect(s.state).toMatchObject({ head: SESSION_SHA, dirty: true, untracked: true });
        expect(sessionRow(s.sessionId).changes_ready).not.toBeNull();
        expect(lookupGithub).not.toHaveBeenCalled();
      });
    }

    it('refuses on a detached HEAD with no recorded branch', async () => {
      const s = await sessionWithWorktree();
      s.state.branch = null;
      getDb().prepare('UPDATE sessions SET worktree_branch = NULL WHERE id = ?').run(s.sessionId);
      const res = await postDiscard(s.sessionId, 409);
      expect(res.body.code).toBe('branch_unresolved');
      expect(wroteWorktree(s.io)).toBe(false);
    });
  });
});
