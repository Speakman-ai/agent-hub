import { describe, it, expect, beforeAll, vi } from 'vitest';
import type supertest from 'supertest';
import { getRequest, createProject } from '../test/helpers.js';

// Stub the investigation trigger so creating a bug ticket never spawns a CLI.
vi.mock('../support-ticket-investigation.js', () => ({
  triggerSupportTicketInvestigation: vi.fn(),
}));

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
}, 60_000);

interface OverviewTicket {
  id: string;
  severity: string;
  status: string;
  project_id: string;
  project_name: string;
}
interface OverviewBody {
  tickets: OverviewTicket[];
  projects: { id: string; name: string; count: number }[];
}

async function seedTicket(projectId: string, severity: string, status?: string): Promise<string> {
  const res = await request
    .post(`/api/projects/${projectId}/support-tickets`)
    .send({ body: `${severity} in ${projectId}`, severity, type: 'bug' })
    .expect(201);
  const id = res.body.id as string;
  if (status && status !== 'new') {
    await request
      .patch(`/api/projects/${projectId}/support-tickets/${id}`)
      .send({ status })
      .expect(200);
  }
  return id;
}

describe('support-tickets overview (cross-project)', () => {
  it('aggregates tickets across projects, severity-ordered, with project_name', async () => {
    const a = await createProject();
    const b = await createProject();

    // Scramble severities across two projects.
    await seedTicket(a.id as string, 'low');
    await seedTicket(b.id as string, 'critical');
    await seedTicket(a.id as string, 'medium');
    await seedTicket(b.id as string, 'high');

    const res = await request.get('/api/support-tickets').expect(200);
    const body = res.body as OverviewBody;

    // Only consider the rows from the two projects this test created — the
    // shared DB may carry tickets from other suites.
    const mine = body.tickets.filter((t) => t.project_id === a.id || t.project_id === b.id);

    // Global severity order holds across projects (critical → low).
    const rank: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
    for (let i = 1; i < mine.length; i++) {
      expect(rank[mine[i].severity]).toBeGreaterThanOrEqual(rank[mine[i - 1].severity]);
    }
    expect(mine.map((t) => t.severity)).toEqual(['critical', 'high', 'medium', 'low']);

    // Every row is enriched with its project's display name.
    const aRow = mine.find((t) => t.project_id === a.id)!;
    expect(aRow.project_name).toBe(a.name);

    // The project filter options include both projects with their counts.
    const optA = body.projects.find((p) => p.id === a.id);
    const optB = body.projects.find((p) => p.id === b.id);
    expect(optA?.count).toBe(2);
    expect(optB?.count).toBe(2);
    expect(optA?.name).toBe(a.name);
  });

  it('filters by projectId while keeping the full project option set', async () => {
    const a = await createProject();
    const b = await createProject();
    await seedTicket(a.id as string, 'high');
    await seedTicket(b.id as string, 'low');

    const res = await request.get(`/api/support-tickets?projectId=${a.id}`).expect(200);
    const body = res.body as OverviewBody;

    // tickets are scoped to project a…
    expect(body.tickets.every((t) => t.project_id === a.id)).toBe(true);
    expect(body.tickets.some((t) => t.project_id === a.id)).toBe(true);
    // …but the project filter options still list project b (full unfiltered set).
    expect(body.projects.some((p) => p.id === b.id)).toBe(true);
  });

  it('filters by status', async () => {
    const a = await createProject();
    await seedTicket(a.id as string, 'critical', 'new');
    await seedTicket(a.id as string, 'high', 'closed');

    const res = await request
      .get(`/api/support-tickets?projectId=${a.id}&status=closed`)
      .expect(200);
    const body = res.body as OverviewBody;
    expect(body.tickets.every((t) => t.status === 'closed')).toBe(true);
    expect(body.tickets.length).toBe(1);
  });

  it('400s on an invalid status and 404s on an unknown project', async () => {
    await request.get('/api/support-tickets?status=bogus').expect(400);
    await request.get('/api/support-tickets?projectId=does-not-exist').expect(404);
  });
});
