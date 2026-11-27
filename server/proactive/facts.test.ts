/**
 * Dev-work fact snapshot: plain SQL reads over the user's own sessions and
 * Finalize runs.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { tmpdir } from 'os';
import { mkdtempSync } from 'fs';
import path from 'path';
import type { AppConfig, Project, Stmts } from '../types.js';
import type { ProactiveFact } from './facts.js';

const { initOrgsDb, setOrgsDbPathForTests } = await import('../orgs.js');
const { createUser } = await import('../users-store.js');
const { initDb, getStmts, getDb } = await import('../db.js');
const { setSessionOwner } = await import('../session-ownership.js');
const { collectDevFacts, STUCK_SESSION_MS } = await import('./facts.js');
const check = await import('./check.js');
const store = await import('./offers-store.js');
const { normalizeProactivePrefs } = await import('../../shared/utils/serverAgentProactive.js');

let userId = '';
let otherId = '';
const now = new Date('2026-11-27T12:00:00Z');

function session(id: string, owner: string): void {
  getStmts().createSession.run(id, 'agent-x', `Session ${id}`, 'claude-code', 'm', 0, 0, 1);
  setSessionOwner(id, owner);
}

function finalizeRun(id: string, sessionId: string, status: string, startedAt: number): void {
  getDb()
    .prepare(
      `INSERT INTO finalize_runs (id, card_id, session_id, project_id, branch, head_sha,
         idempotency_key, status, trigger_source, triggered_by_user_id, author_name, author_email,
         started_at)
       VALUES (?, '', ?, 'proj', 'b', 'sha', ?, ?, 'manual', ?, 'a', 'a@x', ?)`,
    )
    .run(id, sessionId, `idem-${id}`, status, userId, startedAt);
}

function collect(uid = userId) {
  return collectDevFacts({
    userId: uid,
    caller: { userId: uid, localBypass: true },
    getProjects: () => [{ id: 'proj', name: 'Proj' } as Project],
    stmts: getStmts() as Stmts,
    projectIdForAgent: () => 'proj',
    now,
  });
}

beforeEach(() => {
  const dir = mkdtempSync(path.join(tmpdir(), 'proactive-facts-'));
  initDb(dir);
  setOrgsDbPathForTests(path.join(dir, 'orgs.db'));
  initOrgsDb();
  userId = createUser({
    username: `f-${Math.random().toString(36).slice(2)}`,
    passwordHash: 'x',
  }).id;
  otherId = createUser({
    username: `g-${Math.random().toString(36).slice(2)}`,
    passwordHash: 'x',
  }).id;
});

describe('collectDevFacts', () => {
  it('reports only the latest failed Finalize run per owned session', () => {
    session('s1', userId);
    session('s2', otherId);
    finalizeRun('r-old', 's1', 'failed', now.getTime() - 60_000 * 30);
    finalizeRun('r-new', 's1', 'failed', now.getTime() - 60_000);
    finalizeRun('r-other', 's2', 'failed', now.getTime() - 60_000);
    const facts = collect().filter((f) => f.kind === 'finalize_failed');
    expect(facts.map((f) => f.id)).toEqual(['finalize_failed:r-new']);
    expect(facts[0].target).toMatchObject({ sessionId: 's1', projectId: 'proj' });
  });

  it('drops a failure once a newer run exists for the session', () => {
    session('s1', userId);
    finalizeRun('r1', 's1', 'failed', now.getTime() - 120_000);
    finalizeRun('r2', 's1', 'passed', now.getTime() - 60_000);
    expect(collect().filter((f) => f.kind === 'finalize_failed')).toEqual([]);
  });

  it('flags a turn running longer than the stuck threshold', () => {
    session('s1', userId);
    const started = new Date(now.getTime() - STUCK_SESSION_MS - 60_000)
      .toISOString()
      .replace('T', ' ')
      .slice(0, 19);
    getDb()
      .prepare(
        `INSERT INTO active_tasks (session_id, message_id, agent_id, prompt, engine, status, started_at)
         VALUES ('s1', 'm1', 'agent-x', 'p', 'claude-code', 'running', ?)`,
      )
      .run(started);
    const stuck = collect().filter((f) => f.kind === 'session_stuck');
    expect(stuck).toHaveLength(1);
    expect(stuck[0].target.sessionId).toBe('s1');
  });
});

describe('fingerprints on production facts', () => {
  let reviewClock = 0;
  /** Mirrors the production review-status update, which bumps updated_at. */
  function reviewCard(reviewStatus: string | null) {
    const db = getDb();
    db.prepare(
      `INSERT OR IGNORE INTO kanban_boards (id, project_id, name) VALUES ('b1', 'proj', 'Board')`,
    ).run();
    db.prepare(
      `INSERT OR IGNORE INTO kanban_columns (id, board_id, name, position) VALUES ('col-review', 'b1', 'Review', 2)`,
    ).run();
    reviewClock += 1;
    const updatedAt = `2026-11-27 1${reviewClock % 10}:00:00`;
    db.prepare(
      `INSERT INTO kanban_cards (id, column_id, board_id, title, priority, assigned_user_id, pr_url, review_status, updated_at)
       VALUES ('c1', 'col-review', 'b1', 'Ship it', 'high', ?, 'https://hub/pulls/7', ?, ?)
       ON CONFLICT(id) DO UPDATE SET review_status = excluded.review_status, updated_at = excluded.updated_at`,
    ).run(userId, reviewStatus, updatedAt);
  }

  it('treats a new PR card review state as a new occurrence', () => {
    reviewCard('pending');
    const [before] = collect().filter((f) => f.kind === 'pr_review');
    reviewCard('changes_requested');
    const [after] = collect().filter((f) => f.kind === 'pr_review');
    expect(after.target.cardId).toBe(before.target.cardId);
    expect(after.id).not.toBe(before.id);
  });

  it('pending → changes_requested → pending is a new review request, not blocked by the first accept', () => {
    reviewCard('pending');
    const [first] = collect().filter((f) => f.kind === 'pr_review');
    const offer = store.insertOffer({
      userId,
      dedupeKey: first.id,
      kind: 'pr_review',
      title: 'Review it',
      reason: '',
      action: '',
      urgency: 'normal',
      source: 'scheduled',
      target: first.target,
      fact: {},
      now,
    });
    store.transitionOffer(userId, offer.id, 'accepted', now);
    expect(store.blockedDedupeKeys(userId, now).has(first.id)).toBe(true);

    reviewCard('changes_requested');
    reviewCard('pending');
    const [again] = collect().filter((f) => f.kind === 'pr_review');
    expect(again.target.cardId).toBe(first.target.cardId);
    expect(again.id).not.toBe(first.id);
    expect(store.blockedDedupeKeys(userId, now).has(again.id)).toBe(false);
  });

  it('shows a declined fact to the model again once its content changes', async () => {
    reviewCard('pending');
    const classify = vi.fn(async () => []);
    const deps = {
      config: {} as AppConfig,
      stmts: getStmts() as Stmts,
      broadcast: vi.fn(),
      getProjects: () => [],
      collectors: { dev: () => collect().filter((f) => f.kind === 'pr_review') },
      classify,
      now: () => now,
    };
    const prefs = normalizeProactivePrefs({
      enabled: true,
      quietHours: { enabled: false },
    });
    await check.runProactiveCheck(userId, prefs, deps, { source: 'scheduled' });
    expect(
      (await check.runProactiveCheck(userId, prefs, deps, { source: 'scheduled' })).status,
    ).toBe('unchanged');
    reviewCard('changes_requested');
    await check.runProactiveCheck(userId, prefs, deps, { source: 'scheduled' });
    expect(classify).toHaveBeenCalledTimes(2);
  });
});

describe('successive input requests in one session', () => {
  const ask = (q: string) =>
    '```agenthub:ask\n' +
    JSON.stringify({ question: q, header: 'Q', options: [{ label: 'Yes' }, { label: 'No' }] }) +
    '\n```';

  function message(id: string, sid: string, role: 'user' | 'assistant', content: string) {
    getStmts().addMessage.run(
      id,
      sid,
      role,
      content,
      'claude-code',
      'm',
      null,
      null,
      null,
      null,
      null,
    );
  }

  it('a distinct later question in the same session is a new fact, not blocked by the first', async () => {
    session('s1', userId);
    message('m-a', 's1', 'assistant', ask('Ship to staging?'));
    const [first] = collect().filter((f) => f.kind === 'session_needs_input');
    expect(first.id).toBe('session_needs_input:s1:question:m-a');

    // Request A gets an offer that the user accepts.
    const offer = store.insertOffer({
      userId,
      dedupeKey: first.id,
      kind: 'session_needs_input',
      title: 'Answer it',
      reason: '',
      action: '',
      urgency: 'normal',
      source: 'scheduled',
      target: first.target,
      fact: {},
      now,
    });
    store.transitionOffer(userId, offer.id, 'accepted', now);

    // The user answers, the session resumes, and later asks something else.
    message('m-reply', 's1', 'user', 'Yes');
    message('m-b', 's1', 'assistant', ask('Also bump the version?'));
    const [second] = collect().filter((f) => f.kind === 'session_needs_input');
    expect(second.id).toBe('session_needs_input:s1:question:m-b');
    expect(store.blockedDedupeKeys(userId, now).has(second.id)).toBe(false);

    const classify = vi.fn(async (_u: string, batch: ProactiveFact[]) =>
      batch.map((_, i) => ({
        fact: `f${i + 1}`,
        title: 'Answer B',
        reason: '',
        action: '',
        urgency: 'normal' as const,
      })),
    );
    const res = await check.runProactiveCheck(
      userId,
      normalizeProactivePrefs({ enabled: true, quietHours: { enabled: false } }),
      {
        config: {} as AppConfig,
        stmts: getStmts() as Stmts,
        broadcast: vi.fn(),
        getProjects: () => [],
        collectors: { dev: () => collect().filter((f) => f.kind === 'session_needs_input') },
        classify,
        now: () => now,
      },
      { source: 'scheduled' },
    );
    expect(res.offers.map((o) => o.dedupeKey)).toEqual(['session_needs_input:s1:question:m-b']);
  });
});

describe('project access before the session caps', () => {
  const ask =
    '```agenthub:ask\n' +
    JSON.stringify({ question: 'Go?', header: 'Q', options: [{ label: 'Yes' }, { label: 'No' }] }) +
    '\n```';
  const projects = [
    { id: 'secret', name: 'Secret' },
    { id: 'open', name: 'Open' },
  ] as Project[];
  const restricted = {
    userId: '',
    localBypass: false,
    assignedProjectIds: new Set<string>(),
    restrictedProjectIds: new Set(['secret']),
  };

  function runWith(classify: ReturnType<typeof vi.fn>) {
    const caller = { ...restricted, userId };
    return check.runProactiveCheck(
      userId,
      normalizeProactivePrefs({ enabled: true, quietHours: { enabled: false } }),
      {
        config: {} as AppConfig,
        stmts: getStmts() as Stmts,
        broadcast: vi.fn(),
        getProjects: () => projects,
        visibilityCaller: () => caller,
        projectIdForAgent: (agentId: string) => (agentId === 'agent-secret' ? 'secret' : 'open'),
        collectors: {
          dev: (ctx: import('./check.js').FactContext) =>
            collectDevFacts({
              userId,
              caller,
              getProjects: () => projects,
              stmts: getStmts() as Stmts,
              projectIdForAgent: (agentId) => (agentId === 'agent-secret' ? 'secret' : 'open'),
              now,
              match: ctx.match,
              scoped: ctx.scoped,
            }),
        },
        classify,
        now: () => now,
      } as never,
      { source: 'scheduled' },
    );
  }

  function sessionIn(id: string, agent: string, updatedAt: string) {
    getStmts().createSession.run(id, agent, `Session ${id}`, 'claude-code', 'm', 0, 0, 1);
    setSessionOwner(id, userId);
    getDb().prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(updatedAt, id);
  }

  it('an accessible session waiting on input is classified behind ten inaccessible ones', async () => {
    for (let i = 0; i < 10; i++) {
      const sid = `hidden${i}`;
      sessionIn(sid, 'agent-secret', `2026-11-27 11:${String(50 - i).padStart(2, '0')}:00`);
      getStmts().addMessage.run(
        `m-${sid}`,
        sid,
        'assistant',
        ask,
        'claude-code',
        'm',
        null,
        null,
        null,
        null,
        null,
      );
    }
    sessionIn('visible', 'agent-open', '2026-11-27 10:00:00');
    getStmts().addMessage.run(
      'm-visible',
      'visible',
      'assistant',
      ask,
      'claude-code',
      'm',
      null,
      null,
      null,
      null,
      null,
    );

    const classify = vi.fn(async () => []);
    await runWith(classify);
    expect(classify).toHaveBeenCalledTimes(1);
    const sent = (classify.mock.calls[0] as unknown[])[1] as Array<{
      kind: string;
      target: { sessionId?: string };
    }>;
    expect(
      sent.filter((f) => f.kind === 'session_needs_input').map((f) => f.target.sessionId),
    ).toEqual(['visible']);
  });

  it('an accessible stuck turn is classified behind ten inaccessible ones', async () => {
    const started = (minutesAgo: number) =>
      new Date(now.getTime() - minutesAgo * 60_000).toISOString().replace('T', ' ').slice(0, 19);
    const task = getDb().prepare(
      `INSERT INTO active_tasks (session_id, message_id, agent_id, prompt, engine, status, started_at)
       VALUES (?, ?, ?, 'p', 'claude-code', 'running', ?)`,
    );
    for (let i = 0; i < 10; i++) {
      const sid = `stuck-hidden${i}`;
      sessionIn(sid, 'agent-secret', '2026-11-27 11:00:00');
      task.run(sid, `t-${sid}`, 'agent-secret', started(300 - i));
    }
    sessionIn('stuck-visible', 'agent-open', '2026-11-27 11:00:00');
    task.run('stuck-visible', 't-visible', 'agent-open', started(120));

    const classify = vi.fn(async () => []);
    await runWith(classify);
    const sent = (classify.mock.calls[0] as unknown[])[1] as Array<{
      kind: string;
      target: { sessionId?: string };
    }>;
    expect(sent.filter((f) => f.kind === 'session_stuck').map((f) => f.target.sessionId)).toEqual([
      'stuck-visible',
    ]);
  });
});
