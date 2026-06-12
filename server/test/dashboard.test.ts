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
    startedAt: string;
  }>;
  openPRs: Array<{
    cardId: string;
    projectId: string;
    projectName: string;
    prUrl: string;
    prNumber: number | null;
    title: string;
    cardTitle: string;
    authorAgent: string | null;
    priority: string;
    updatedAt: string;
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

  it('lists running active_tasks rows in activeSessions, enriched with agent + session labels', async () => {
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
    // Two rows for the same agent: one running (must appear) and one done
    // (must NOT appear). Direct insert — tests never spawn a real CLI, so
    // there's no streaming path to create these for us.
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

    const doneSession = await createSession({ agentId, name: 'Finished Session' });
    db.prepare(
      `INSERT OR REPLACE INTO active_tasks
         (session_id, message_id, agent_id, pid, prompt, streamed_output, engine, model, status, started_at)
       VALUES (?, ?, ?, ?, ?, '', ?, ?, 'done', ?)`,
    ).run(
      doneSession.id as string,
      'msg-done-1',
      agentId,
      0,
      'Already finished',
      'claude-code',
      null,
      '2026-06-09 00:00:01',
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
    expect(row!.engine).toBe('claude-code');
    expect(row!.model).toBe('claude-sonnet-4');
    expect(row!.prompt).toBe('Implement the active sessions panel');
    expect(row!.startedAt).toBe('2026-06-09 00:00:00');

    // The 'done' row is excluded from the list (only status='running').
    expect(body.activeSessions.some((s) => s.sessionId === (doneSession.id as string))).toBe(false);

    // The headline count is at least the one running row we inserted, and it
    // never counts the 'done' row.
    expect(body.headline.activeSessions).toBeGreaterThanOrEqual(1);
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

  it('lists cards with a PR link in openPRs, enriched with project + card metadata', async () => {
    const project = await createProject({ name: 'Dashboard openPRs list project' });
    const projectId = project.id as string;

    const card = await createCard(projectId, {
      title: 'Open PR list card unique title',
      priority: 'high',
    });
    const prUrl = 'https://github.com/Speakman-ai/agent-hub/pull/4242';
    await request
      .put(`/api/projects/${projectId}/board/cards/${card.id as string}`)
      .send({ prUrl })
      .expect(200);

    const res = await request.get('/api/orgs/default/dashboard').expect(200);
    const body = res.body as DashboardBody;

    expect(Array.isArray(body.openPRs)).toBe(true);
    const entry = body.openPRs.find((p) => p.cardId === (card.id as string));
    expect(entry).toBeDefined();
    expect(entry!.prUrl).toBe(prUrl);
    expect(entry!.projectId).toBe(projectId);
    expect(entry!.projectName).toBe('Dashboard openPRs list project');
    expect(entry!.cardTitle).toBe('Open PR list card unique title');
    // No pr_creation_logs row for this URL, so the title falls back to the
    // card title and prNumber is null.
    expect(entry!.title).toBe('Open PR list card unique title');
    expect(entry!.prNumber).toBeNull();
    expect(entry!.priority).toBe('high');

    // The list never exceeds the cap, and its length is consistent with the
    // headline count being at least 1 (the card we just linked).
    expect(body.openPRs.length).toBeLessThanOrEqual(30);
    expect(body.headline.openPRs).toBeGreaterThanOrEqual(1);
  });

  it('excludes PR cards on boards whose project is not in the org roster from openPRs', async () => {
    // Regression guard for the cross-org-scoping review: the openPRs detail
    // list must be restricted to the org's *current* project roster
    // (card → board → project → org), not just the per-org DB handle. A board
    // row left behind by a since-deleted project (its project_id no longer in
    // projects.json) must not leak its PR / card metadata into the list.
    const { getDb } = await import('../db.js');
    const db = getDb();

    const ghostProjectId = `ghost-project-${Date.now()}`;
    const ghostBoardId = `ghost-board-${Date.now()}`;
    const ghostColumnId = `ghost-col-${Date.now()}`;
    const ghostCardId = `ghost-card-${Date.now()}`;
    const ghostPrUrl = 'https://github.com/Speakman-ai/agent-hub/pull/6666';

    db.prepare(`INSERT INTO kanban_boards (id, project_id, name) VALUES (?, ?, ?)`).run(
      ghostBoardId,
      ghostProjectId,
      'Orphaned board',
    );
    // A non-Done column so the card would otherwise pass the open-set filter.
    db.prepare(
      `INSERT INTO kanban_columns (id, board_id, name, position) VALUES (?, ?, 'To Do', 0)`,
    ).run(ghostColumnId, ghostBoardId);
    db.prepare(
      `INSERT INTO kanban_cards (id, column_id, board_id, title, priority, pr_url)
       VALUES (?, ?, ?, ?, 'high', ?)`,
    ).run(
      ghostCardId,
      ghostColumnId,
      ghostBoardId,
      'Leaked PR card from deleted project',
      ghostPrUrl,
    );

    const res = await request.get('/api/orgs/default/dashboard').expect(200);
    const body = res.body as DashboardBody;

    // The orphaned card is absent from the list — neither by id nor by its
    // ghost project / PR url.
    expect(body.openPRs.some((p) => p.cardId === ghostCardId)).toBe(false);
    expect(body.openPRs.some((p) => p.projectId === ghostProjectId)).toBe(false);
    expect(body.openPRs.some((p) => p.prUrl === ghostPrUrl)).toBe(false);
  });

  it('excludes PR cards in Done-ish columns from openPRs (matches the headline semantics)', async () => {
    const project = await createProject({ name: 'Dashboard openPRs Done-ish test' });
    const projectId = project.id as string;

    const boardRes = await request.get(`/api/projects/${projectId}/board`).expect(200);
    const board = boardRes.body as {
      columns: Array<{ id: string; name: string }>;
    };
    const doneCol = board.columns.find((c) => c.name === 'Done');
    expect(doneCol).toBeDefined();

    const card = await createCard(projectId, {
      title: 'Merged PR card in Done column',
      columnId: doneCol!.id,
    });
    await request
      .put(`/api/projects/${projectId}/board/cards/${card.id as string}`)
      .send({ prUrl: 'https://github.com/Speakman-ai/agent-hub/pull/5555' })
      .expect(200);

    const res = await request.get('/api/orgs/default/dashboard').expect(200);
    const body = res.body as DashboardBody;

    // A PR card sitting in a Done column is "closed" work — absent from the
    // open PRs list, the same rule the headline openPRs counter uses.
    expect(body.openPRs.some((p) => p.cardId === (card.id as string))).toBe(false);
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
