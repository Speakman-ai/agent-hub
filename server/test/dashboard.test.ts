/**
 * Integration tests for GET /api/orgs/:id/dashboard.
 *
 * Covers the happy path (active org, with some seeded projects / cards /
 * sessions so the aggregated counts aren't all zero), the 404 for an
 * unknown org, and the 409 when a caller asks for a non-active org.
 *
 * Uses the shared test harness — auth is disabled in tests (AGENT_HUB_API_KEY
 * is cleared in test/setup.ts), so the membership gate short-circuits.
 */
import type supertest from 'supertest';
import { getRequest, createProject, createCard, createAgent, createSession } from './helpers.js';

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
});

/**
 * Insert a native PR row directly into `pull_requests` — the authoritative
 * source the dashboard "Open PRs" panel reads (same table the Pulls page
 * serves from). Tests use this rather than spinning up the full native-PR
 * creation flow.
 */
async function insertNativePr(opts: {
  projectId: string;
  number: number;
  title: string;
  author?: string;
  status?: 'open' | 'merged' | 'closed';
}): Promise<string> {
  const { getDb } = await import('../db.js');
  const db = getDb();
  const id = `pr-${opts.projectId}-${opts.number}`;
  const now = Date.now();
  db.prepare(
    `INSERT INTO pull_requests (
       id, project_id, number, title, body, head_branch, base_branch,
       head_sha, status, author, created_at, updated_at
     ) VALUES (?, ?, ?, ?, '', ?, 'main', 'deadbeef', ?, ?, ?, ?)`,
  ).run(
    id,
    opts.projectId,
    opts.number,
    opts.title,
    `feat-${opts.number}`,
    opts.status ?? 'open',
    opts.author ?? 'finalize',
    now,
    now,
  );
  return id;
}

interface DashboardBody {
  orgId: string;
  orgName: string;
  isActive: boolean;
  headline: {
    projects: number;
    agents: number;
    sessions: number;
    activeSessions: number;
    openCards: number;
    openPRs: number;
    escalations: number;
  };
  kanban: {
    totalBoards: number;
    totalCards: number;
    byColumn: Array<{ columnName: string; count: number }>;
    byPriority: { urgent: number; high: number; medium: number; low: number };
  };
  activeSessions: Array<{
    sessionId: string;
    sessionName: string;
    agentId: string;
    agentName: string;
    agentColor: string | null;
    engine: string;
    model: string | null;
    prompt: string;
    state: string;
    ownerUserId: string | null;
    ownerName: string | null;
    startedAt: string | null;
    lastActivityAt: string;
  }>;
  openPRs: Array<{
    key: string;
    cardId: string | null;
    projectId: string;
    projectName: string;
    prUrl: string;
    prNumber: number;
    title: string;
    cardTitle: string | null;
    authorAgent: string | null;
    priority: string | null;
    updatedAt: number;
  }>;
  recentActivity: Array<{
    type: 'card_created' | 'card_updated' | 'session_created' | 'escalation' | 'pr_created';
    id: string;
    title: string;
    timestamp: string;
    meta?: Record<string, string | number | null>;
  }>;
}

describe('GET /api/orgs/:id/dashboard', () => {
  it('returns aggregated counts, kanban breakdown, and recent activity for the active org', async () => {
    // Seed a full set: project → agent → session → card. The helper factories
    // each hit the real endpoints so the data ends up in the same SQLite the
    // dashboard reads from.
    const project = await createProject({ name: 'Dashboard Seed Project' });
    const projectId = project.id as string;

    const agent = await createAgent({ projectId, name: 'Dashboard Seed Agent' });
    await createSession({ agentId: agent.id as string, name: 'Seed Session' });

    await createCard(projectId, {
      title: 'Dashboard seed card A',
      priority: 'high',
    });
    await createCard(projectId, {
      title: 'Dashboard seed card B',
      priority: 'urgent',
    });

    const res = await request.get('/api/orgs/default/dashboard').expect(200);
    const body = res.body as DashboardBody;

    expect(body.orgId).toBe('default');
    expect(typeof body.orgName).toBe('string');
    expect(body.isActive).toBe(true);

    // Counters are >= the values we seeded — other tests in the suite may
    // have left their own rows behind, so we only assert a lower bound.
    expect(body.headline.projects).toBeGreaterThanOrEqual(1);
    expect(body.headline.agents).toBeGreaterThanOrEqual(1);
    expect(body.headline.sessions).toBeGreaterThanOrEqual(1);
    expect(body.headline.openCards).toBeGreaterThanOrEqual(2);

    // Shape checks
    expect(typeof body.headline.activeSessions).toBe('number');
    expect(typeof body.headline.openPRs).toBe('number');
    expect(typeof body.headline.escalations).toBe('number');

    expect(body.kanban.totalBoards).toBeGreaterThanOrEqual(1);
    expect(body.kanban.totalCards).toBeGreaterThanOrEqual(2);
    expect(Array.isArray(body.kanban.byColumn)).toBe(true);
    expect(body.kanban.byColumn.length).toBeGreaterThan(0);
    expect(body.kanban.byColumn[0]).toHaveProperty('columnName');
    expect(body.kanban.byColumn[0]).toHaveProperty('count');

    // The two seeded open cards push these two priorities to at least 1.
    expect(body.kanban.byPriority.urgent).toBeGreaterThanOrEqual(1);
    expect(body.kanban.byPriority.high).toBeGreaterThanOrEqual(1);

    expect(Array.isArray(body.recentActivity)).toBe(true);
    expect(body.recentActivity.length).toBeGreaterThan(0);
    expect(body.recentActivity.length).toBeLessThanOrEqual(20);
    // Every entry has the required fields.
    for (const entry of body.recentActivity) {
      expect(entry).toHaveProperty('type');
      expect(entry).toHaveProperty('id');
      expect(entry).toHaveProperty('title');
      expect(entry).toHaveProperty('timestamp');
    }
    // Entries are sorted newest-first.
    for (let i = 1; i < body.recentActivity.length; i++) {
      expect(body.recentActivity[i - 1].timestamp >= body.recentActivity[i].timestamp).toBe(true);
    }

    // At least one of our seeded cards / the session shows up in the feed.
    const titles = body.recentActivity.map((e) => e.title);
    const seenSeed = titles.some(
      (t) => t === 'Dashboard seed card A' || t === 'Dashboard seed card B' || t === 'Seed Session',
    );
    expect(seenSeed).toBe(true);

    // Card + session activity rows must carry navigation metadata (JOIN
    // kanban_boards for project_id; sessions.agent_id for deep-links).
    for (const entry of body.recentActivity) {
      if (entry.type === 'card_created' || entry.type === 'card_updated') {
        expect(entry.meta?.projectId).toBeTruthy();
        expect(typeof entry.meta?.column).toBe('string');
      }
      if (entry.type === 'session_created') {
        expect(entry.meta?.agentId).toBeTruthy();
      }
      if (entry.type === 'escalation') {
        expect(entry.meta?.projectId).toBeTruthy();
      }
    }
  });

  it('lists a streaming session in activeSessions with state=working, enriched with agent + session labels', async () => {
    const project = await createProject({ name: 'Dashboard Active Sessions Project' });
    const projectId = project.id as string;
    const agent = await createAgent({
      projectId,
      name: 'Active Panel Agent',
      color: '#FF8800',
    });
    const agentId = agent.id as string;
    const session = await createSession({ agentId, name: 'Live Streaming Session' });
    const sessionId = session.id as string;

    const { getDb } = await import('../db.js');
    const db = getDb();
    // A running active_task → the session resolves to state 'working' and the
    // panel surfaces the running turn's prompt + start time. Direct insert —
    // tests never spawn a real CLI, so there's no streaming path otherwise.
    db.prepare(
      `INSERT OR REPLACE INTO active_tasks
         (session_id, message_id, agent_id, pid, prompt, streamed_output, engine, model, status, started_at)
       VALUES (?, ?, ?, ?, ?, '', ?, ?, 'running', ?)`,
    ).run(
      sessionId,
      'msg-active-1',
      agentId,
      4242,
      'Implement the active sessions panel',
      'claude-code',
      'claude-sonnet-4',
      '2026-06-09 00:00:00',
    );

    const res = await request.get('/api/orgs/default/dashboard').expect(200);
    const body = res.body as DashboardBody;

    expect(Array.isArray(body.activeSessions)).toBe(true);
    const row = body.activeSessions.find((s) => s.sessionId === sessionId);
    expect(row).toBeDefined();
    expect(row!.sessionName).toBe('Live Streaming Session');
    expect(row!.agentId).toBe(agentId);
    expect(row!.agentName).toBe('Active Panel Agent');
    expect(row!.agentColor).toBe('#FF8800');
    expect(row!.state).toBe('working');
    expect(row!.prompt).toBe('Implement the active sessions panel');
    expect(row!.startedAt).toBe('2026-06-09 00:00:00');
    expect(typeof row!.lastActivityAt).toBe('string');

    // The headline count agrees with the list and includes our session.
    expect(body.headline.activeSessions).toBeGreaterThanOrEqual(1);
    expect(body.headline.activeSessions).toBe(body.activeSessions.length);
  });

  it('keeps non-streaming in-flight sessions in the queue (regression: they used to disappear)', async () => {
    // The core fix: a session with no running active_task is still in-flight
    // work (waiting for user input, reviewing, etc.) and must stay in the
    // queue — the old `active_tasks WHERE status='running'` filter dropped it.
    const project = await createProject({ name: 'Dashboard Idle Session Project' });
    const projectId = project.id as string;
    const agent = await createAgent({ projectId, name: 'Idle Panel Agent' });
    const agentId = agent.id as string;
    const session = await createSession({ agentId, name: 'Awaiting Feedback Session' });
    const sessionId = session.id as string;

    const res = await request.get('/api/orgs/default/dashboard').expect(200);
    const body = res.body as DashboardBody;

    const row = body.activeSessions.find((s) => s.sessionId === sessionId);
    expect(row).toBeDefined();
    // No running task → default lifecycle state, no streaming start time.
    expect(row!.state).toBe('waiting_for_user_input');
    expect(row!.startedAt).toBeNull();
    expect(typeof row!.lastActivityAt).toBe('string');
  });

  it('resolves the owning user (owner_user_id → username) on activeSessions rows', async () => {
    const project = await createProject({ name: 'Dashboard Owner Project' });
    const projectId = project.id as string;
    const agent = await createAgent({ projectId, name: 'Owner Panel Agent' });
    const agentId = agent.id as string;
    const session = await createSession({ agentId, name: 'Owned Session' });
    const sessionId = session.id as string;

    const { createUser } = await import('../users-store.js');
    const owner = createUser({
      username: `dash-owner-${Date.now()}`,
      passwordHash: 'scrypt$deadbeef',
    });

    const { getDb } = await import('../db.js');
    getDb().prepare('UPDATE sessions SET owner_user_id = ? WHERE id = ?').run(owner.id, sessionId);

    const res = await request.get('/api/orgs/default/dashboard').expect(200);
    const body = res.body as DashboardBody;

    const row = body.activeSessions.find((s) => s.sessionId === sessionId);
    expect(row).toBeDefined();
    expect(row!.ownerUserId).toBe(owner.id);
    expect(row!.ownerName).toBe(owner.username);
  });

  it('excludes merged sessions (linked card in a Done column) from the queue + count', async () => {
    const project = await createProject({ name: 'Dashboard Merged Session Project' });
    const projectId = project.id as string;
    const agent = await createAgent({ projectId, name: 'Merged Panel Agent' });
    const agentId = agent.id as string;
    const session = await createSession({ agentId, name: 'Already Merged Session' });
    const sessionId = session.id as string;

    // Link a kanban card to the session and park it in the Done column — the
    // authoritative "merged" signal `computeSessionState` reads.
    const boardRes = await request.get(`/api/projects/${projectId}/board`).expect(200);
    const board = boardRes.body as { columns: Array<{ id: string; name: string }> };
    const doneCol = board.columns.find((c) => c.name === 'Done');
    expect(doneCol).toBeDefined();

    const card = await createCard(projectId, {
      title: 'Merged work card',
      columnId: doneCol!.id,
    });
    const { getDb } = await import('../db.js');
    getDb()
      .prepare('UPDATE kanban_cards SET session_id = ? WHERE id = ?')
      .run(sessionId, card.id as string);

    const res = await request.get('/api/orgs/default/dashboard').expect(200);
    const body = res.body as DashboardBody;

    // Merged → terminal → absent from the queue and uncounted.
    expect(body.activeSessions.some((s) => s.sessionId === sessionId)).toBe(false);
    expect(body.headline.activeSessions).toBe(body.activeSessions.length);
  });

  it('does not let a flood of merged sessions truncate older non-merged ones (cap applies after filtering)', async () => {
    // Regression for the review finding: the display cap must be applied AFTER
    // the merged/roster filter. We seed MORE THAN the 200-row display cap worth
    // of merged sessions, all sorted ahead (future updated_at) of a single
    // older non-merged session. With the old "scan top-200 then filter" logic
    // the merged flood filled the entire scan window, so the non-merged session
    // (and its headline count) silently disappeared. It must now survive.
    const project = await createProject({ name: 'Dashboard Cap-After-Filter Project' });
    const projectId = project.id as string;
    const agent = await createAgent({ projectId, name: 'Cap After Filter Agent' });
    const agentId = agent.id as string;

    const boardRes = await request.get(`/api/projects/${projectId}/board`).expect(200);
    const board = boardRes.body as { columns: Array<{ id: string; name: string }> };
    const doneCol = board.columns.find((c) => c.name === 'Done');
    expect(doneCol).toBeDefined();

    const { getDb } = await import('../db.js');
    const db = getDb();
    const boardId = (
      db.prepare('SELECT board_id FROM kanban_columns WHERE id = ?').get(doneCol!.id) as {
        board_id: string;
      }
    ).board_id;

    const tag = `capfilter-${Date.now()}`;
    // Order is keyed on `updated_at` (the active-sessions scan key). We push
    // `updated_at` far into the future so these rows sort ahead of the cap, but
    // keep `created_at` (and the cards' timestamps) in the past so they never
    // pollute the created_at/updated_at-ordered recent-activity feed other
    // tests assert against.
    const targetId = `${tag}-target`;
    db.prepare(
      `INSERT INTO sessions (id, agent_id, name, created_at, updated_at)
       VALUES (?, ?, ?, '2020-01-01 00:00:00', '2099-01-01 00:00:00')`,
    ).run(targetId, agentId, 'Older non-merged session that must survive');

    // 205 merged sessions (linked card parked in Done), each sorted AHEAD of the
    // target on `updated_at` — enough to overflow the 200-row display cap on
    // their own.
    const insertSession = db.prepare(
      `INSERT INTO sessions (id, agent_id, name, created_at, updated_at)
       VALUES (?, ?, ?, '2020-01-01 00:00:00', '2099-06-01 00:00:00')`,
    );
    const insertCard = db.prepare(
      `INSERT INTO kanban_cards (id, column_id, board_id, title, priority, session_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'low', ?, '2020-01-01 00:00:00', '2020-01-01 00:00:00')`,
    );
    const seedMerged = db.transaction((n: number) => {
      for (let i = 0; i < n; i++) {
        const sid = `${tag}-merged-${i}`;
        insertSession.run(sid, agentId, `Merged flood session ${i}`);
        insertCard.run(`${tag}-card-${i}`, doneCol!.id, boardId, `Merged flood card ${i}`, sid);
      }
    });
    seedMerged(205);

    const res = await request.get('/api/orgs/default/dashboard').expect(200);
    const body = res.body as DashboardBody;

    // The non-merged session survives the merged flood…
    expect(body.activeSessions.some((s) => s.sessionId === targetId)).toBe(true);
    // …and none of the merged flood leaks into the queue.
    expect(body.activeSessions.some((s) => s.sessionId.startsWith(`${tag}-merged-`))).toBe(false);
    // Count stays consistent with the (post-filter) list.
    expect(body.headline.activeSessions).toBe(body.activeSessions.length);
  });

  it('excludes running tasks whose agent is not in the org roster from activeSessions + count', async () => {
    // Defense-in-depth: the per-org DB is the hard boundary, but the route
    // additionally restricts the list/count to the org's current agent
    // roster (session → agent → project → org). A running row whose agent
    // belongs to no project in this org must not leak its session name /
    // prompt, nor inflate the headline count. This is the regression guard
    // for the cross-org-scoping review.
    const { getDb } = await import('../db.js');
    const db = getDb();

    const before = await request.get('/api/orgs/default/dashboard').expect(200);
    const countBefore = (before.body as DashboardBody).headline.activeSessions;

    // A session row + running task for an agent id that is NOT in any
    // project (no createAgent call for it).
    const ghostSessionId = `ghost-session-${Date.now()}`;
    db.prepare(
      `INSERT OR REPLACE INTO sessions (id, agent_id, name, created_at, updated_at)
       VALUES (?, ?, ?, datetime('now'), datetime('now'))`,
    ).run(ghostSessionId, 'ghost-agent-not-in-org', 'Secret cross-org session');
    db.prepare(
      `INSERT OR REPLACE INTO active_tasks
         (session_id, message_id, agent_id, pid, prompt, streamed_output, engine, model, status, started_at)
       VALUES (?, ?, ?, ?, ?, '', ?, ?, 'running', ?)`,
    ).run(
      ghostSessionId,
      'msg-ghost-1',
      'ghost-agent-not-in-org',
      9999,
      'Leaked prompt that must not appear',
      'claude-code',
      null,
      '2026-06-09 00:00:05',
    );

    const after = await request.get('/api/orgs/default/dashboard').expect(200);
    const body = after.body as DashboardBody;

    // The orphaned row is absent from the list…
    expect(body.activeSessions.some((s) => s.sessionId === ghostSessionId)).toBe(false);
    expect(body.activeSessions.some((s) => s.agentId === 'ghost-agent-not-in-org')).toBe(false);
    // …and never inflates the count (count stays consistent with the list).
    expect(body.headline.activeSessions).toBe(countBefore);
    expect(body.headline.activeSessions).toBe(body.activeSessions.length);
  });

  it('surfaces prUrl on dashboard recent activity when a card has a PR link', async () => {
    const project = await createProject({ name: 'Dashboard PR Meta Project' });
    const projectId = project.id as string;

    const card = await createCard(projectId, {
      title: 'Dashboard PR meta card unique title',
      priority: 'low',
    });
    const prUrl = 'https://github.com/Speakman-ai/agent-hub/pull/999';
    await request
      .put(`/api/projects/${projectId}/board/cards/${card.id as string}`)
      .send({ prUrl })
      .expect(200);

    const res = await request.get('/api/orgs/default/dashboard').expect(200);
    const body = res.body as DashboardBody;

    const entry = body.recentActivity.find(
      (e) => e.title === 'Dashboard PR meta card unique title',
    );
    expect(entry).toBeDefined();
    expect(entry!.meta?.projectId).toBe(projectId);
    expect(entry!.meta?.prUrl).toBe(prUrl);
  });

  it('lists open native PRs in openPRs, enriched with project + linked-card metadata', async () => {
    const project = await createProject({ name: 'Dashboard openPRs list project' });
    const projectId = project.id as string;

    await insertNativePr({ projectId, number: 4242, title: 'Wire up the thing' });

    // A card linking the same native PR url supplies priority + card id.
    const card = await createCard(projectId, {
      title: 'Open PR list card unique title',
      priority: 'high',
    });
    const prUrl = `/projects/${projectId}/pulls/4242`;
    await request
      .put(`/api/projects/${projectId}/board/cards/${card.id as string}`)
      .send({ prUrl })
      .expect(200);

    const res = await request.get('/api/orgs/default/dashboard').expect(200);
    const body = res.body as DashboardBody;

    expect(Array.isArray(body.openPRs)).toBe(true);
    const entry = body.openPRs.find((p) => p.prUrl === prUrl);
    expect(entry).toBeDefined();
    expect(entry!.projectId).toBe(projectId);
    expect(entry!.projectName).toBe('Dashboard openPRs list project');
    expect(entry!.prNumber).toBe(4242);
    // Title comes straight from the PR row, never the card.
    expect(entry!.title).toBe('PR #4242: Wire up the thing');
    // Linked-card enrichment: real card id + priority. The render key uses
    // the card id when one is linked.
    expect(entry!.cardId).toBe(card.id as string);
    expect(entry!.key).toBe(card.id as string);
    expect(entry!.cardTitle).toBe('Open PR list card unique title');
    expect(entry!.priority).toBe('high');

    expect(body.openPRs.length).toBeLessThanOrEqual(30);
    expect(body.headline.openPRs).toBeGreaterThanOrEqual(1);
  });

  it('counts an open native PR with NO linked kanban card (regression: card-derived list missed it)', async () => {
    // The exact reported bug: the Pulls page reads `pull_requests`, but the
    // dashboard used to derive open PRs from kanban cards. A native PR with no
    // (or only a Done-parked) linked card showed on Pulls but counted as 0
    // here. Now both read the same table.
    const project = await createProject({ name: 'Dashboard openPRs no-card project' });
    const projectId = project.id as string;

    await insertNativePr({ projectId, number: 71, title: 'Fix Grok CLI auth detection' });

    const res = await request.get('/api/orgs/default/dashboard').expect(200);
    const body = res.body as DashboardBody;

    const prUrl = `/projects/${projectId}/pulls/71`;
    const entry = body.openPRs.find((p) => p.prUrl === prUrl);
    expect(entry).toBeDefined();
    // No linked card: cardId is null (never a non-card identifier), while the
    // stable render key falls back to the PR url.
    expect(entry!.cardId).toBeNull();
    expect(entry!.key).toBe(prUrl);
    expect(entry!.cardTitle).toBeNull();
    expect(entry!.priority).toBeNull();
    expect(entry!.title).toBe('PR #71: Fix Grok CLI auth detection');
    expect(body.headline.openPRs).toBeGreaterThanOrEqual(1);
  });

  it('keeps an open native PR in openPRs even when its linked card is in a Done column', async () => {
    // PR open-ness is now sourced from `pull_requests.status`, not the card's
    // column. A still-open PR whose card a human parked in Done must remain
    // visible until the PR itself is merged/closed.
    const project = await createProject({ name: 'Dashboard openPRs done-card project' });
    const projectId = project.id as string;

    await insertNativePr({ projectId, number: 88, title: 'Still open PR' });

    const boardRes = await request.get(`/api/projects/${projectId}/board`).expect(200);
    const board = boardRes.body as { columns: Array<{ id: string; name: string }> };
    const doneCol = board.columns.find((c) => c.name === 'Done');
    expect(doneCol).toBeDefined();

    const card = await createCard(projectId, {
      title: 'PR card parked in Done',
      columnId: doneCol!.id,
    });
    const prUrl = `/projects/${projectId}/pulls/88`;
    await request
      .put(`/api/projects/${projectId}/board/cards/${card.id as string}`)
      .send({ prUrl })
      .expect(200);

    const res = await request.get('/api/orgs/default/dashboard').expect(200);
    const body = res.body as DashboardBody;

    const entry = body.openPRs.find((p) => p.prUrl === prUrl);
    expect(entry).toBeDefined();
    expect(entry!.prNumber).toBe(88);
  });

  it('drops merged/closed native PRs from openPRs (only status=open counts)', async () => {
    const project = await createProject({ name: 'Dashboard openPRs status filter project' });
    const projectId = project.id as string;

    await insertNativePr({ projectId, number: 10, title: 'Open one', status: 'open' });
    await insertNativePr({ projectId, number: 11, title: 'Merged one', status: 'merged' });
    await insertNativePr({ projectId, number: 12, title: 'Closed one', status: 'closed' });

    const res = await request.get('/api/orgs/default/dashboard').expect(200);
    const body = res.body as DashboardBody;

    expect(body.openPRs.some((p) => p.prUrl === `/projects/${projectId}/pulls/10`)).toBe(true);
    expect(body.openPRs.some((p) => p.prUrl === `/projects/${projectId}/pulls/11`)).toBe(false);
    expect(body.openPRs.some((p) => p.prUrl === `/projects/${projectId}/pulls/12`)).toBe(false);
  });

  it('excludes native PRs whose project is not in the org roster from openPRs', async () => {
    // Org scoping: a `pull_requests` row for a project_id that is not in this
    // org's current roster (e.g. left behind by a since-deleted project) must
    // not leak into the list or the count.
    const ghostProjectId = `ghost-project-${Date.now()}`;
    await insertNativePr({
      projectId: ghostProjectId,
      number: 6666,
      title: 'Leaked PR from deleted project',
    });

    const res = await request.get('/api/orgs/default/dashboard').expect(200);
    const body = res.body as DashboardBody;

    expect(body.openPRs.some((p) => p.projectId === ghostProjectId)).toBe(false);
    expect(body.openPRs.some((p) => p.prUrl === `/projects/${ghostProjectId}/pulls/6666`)).toBe(
      false,
    );
  });

  it('does not count cards in Done-ish columns toward openCards', async () => {
    const project = await createProject({ name: 'Dashboard openCards Done-ish test' });
    const projectId = project.id as string;

    const boardRes = await request.get(`/api/projects/${projectId}/board`).expect(200);
    const board = boardRes.body as {
      columns: Array<{ id: string; name: string; position: number; color: string | null }>;
    };
    const doneCol = board.columns.find((c) => c.name === 'Done');
    expect(doneCol).toBeDefined();

    await request
      .put(`/api/projects/${projectId}/board/columns/${doneCol!.id}`)
      .send({
        name: 'Deployed / Done',
        position: doneCol!.position,
        color: doneCol!.color ?? '#10B981',
      })
      .expect(200);

    const dashBefore = await request.get('/api/orgs/default/dashboard').expect(200);
    const openBefore = (dashBefore.body as DashboardBody).headline.openCards;

    await createCard(projectId, {
      title: 'Work finished in renamed Done column',
      columnId: doneCol!.id,
    });

    const dashAfter = await request.get('/api/orgs/default/dashboard').expect(200);
    const openAfter = (dashAfter.body as DashboardBody).headline.openCards;

    expect(openAfter).toBe(openBefore);
  });

  it('returns 404 for an unknown org', async () => {
    await request.get('/api/orgs/ghost-org-id/dashboard').expect(404);
  });

  it('treats `:id = "active"` as an alias for the currently-active org', async () => {
    // Remote-mode client bookmarks have browser-generated ids that don't
    // exist on the remote server, so the client falls back to the alias.
    // The response should be identical to requesting the active org by
    // its real id.
    const aliasRes = await request.get('/api/orgs/active/dashboard').expect(200);
    const realRes = await request.get('/api/orgs/default/dashboard').expect(200);

    const aliasBody = aliasRes.body as DashboardBody;
    const realBody = realRes.body as DashboardBody;

    // The alias resolves to the real org — so the returned `orgId` is the
    // real id, not the literal string "active".
    expect(aliasBody.orgId).toBe('default');
    expect(aliasBody.isActive).toBe(true);
    expect(aliasBody.orgName).toBe(realBody.orgName);
    expect(aliasBody.headline).toEqual(realBody.headline);
  });

  it('returns 409 when the requested org is not the active org', async () => {
    // Create a second org via the REST API. The test harness never calls
    // /api/orgs/:id/switch, so `default` remains active.
    const createRes = await request
      .post('/api/orgs')
      .send({ name: 'Dashboard Secondary Org' })
      .expect(201);
    const otherOrgId = createRes.body.id as string;
    expect(otherOrgId).not.toBe('default');

    const res = await request.get(`/api/orgs/${otherOrgId}/dashboard`).expect(409);
    expect(res.body).toHaveProperty('error');
    expect(res.body).toHaveProperty('activeOrgId', 'default');
  });

  it('returns 200 without a bearer token when JWT auth is configured but the server is in local-bundled mode (Electron desktop)', async () => {
    const { unlinkSync, existsSync } = await import('fs');
    const path = await import('path');
    const { saveAuthRecord, reloadAuthRecord } = await import('../auth-store.js');
    const config = (await import('../config.js')).default;
    const authPath = path.join(config.dataDir, 'auth.json');

    const originalMode = process.env.AGENT_HUB_MODE;
    try {
      // Simulate Electron's main.js setting AGENT_HUB_MODE=local before
      // spawning the embedded server. This is the env-driven signal that
      // replaced the previous `org.mode='local'` lookup.
      process.env.AGENT_HUB_MODE = 'local';
      saveAuthRecord({
        username: 'dash-local-owner',
        passwordHash: 'scrypt$deadbeef',
        jwtSecret: 'b'.repeat(64),
      });
      const res = await request.get('/api/orgs/default/dashboard').expect(200);
      const body = res.body as DashboardBody;
      expect(body.orgId).toBe('default');
      expect(body.isActive).toBe(true);
    } finally {
      if (originalMode === undefined) delete process.env.AGENT_HUB_MODE;
      else process.env.AGENT_HUB_MODE = originalMode;
      try {
        if (existsSync(authPath)) unlinkSync(authPath);
      } catch {
        /* ignore */
      }
      reloadAuthRecord();
    }
  });
});
