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
});
