import type supertest from 'supertest';
import { describe, it, expect, beforeAll } from 'vitest';
import { getRequest, createProject } from './helpers.js';

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
});

/**
 * Regression coverage for the per-section diagnostic boundary in
 * `runProjectImport()` (server/routes/config.ts).
 *
 * Background: large v3 project imports were failing on the dev hub with a
 * bare `500: Import failed: Too few parameter values were provided` — the
 * verbatim better-sqlite3 binder message with **no indication of which
 * section / statement was at fault**. That made the failure effectively
 * un-triagable from the UI alone (no log access on remote installs).
 *
 * The fix wraps each section (`project`, `crons`, `rooms`, `webhooks`,
 * `wiki`, `kanban`) in a `runSection(...)` boundary. When the section's
 * body throws — for any reason — the route's catch handler tags the 500
 * response with `section: "<name>"`. The legacy `error` field still carries
 * the original message verbatim.
 *
 * This test exercises the boundary by sending a payload that triggers a
 * deterministic SQL constraint failure inside the kanban section (CHECK
 * priority IN ('low','medium','high','urgent')) and asserts the response
 * carries `section: "kanban"`. The exact error message is intentionally
 * NOT pinned — the goal is to lock in the section-tagging contract, not
 * better-sqlite3's wording.
 */
describe('POST /api/projects/:projectId/import — section tag on failure', () => {
  it('tags the 500 response with the failing section', async () => {
    const project = await createProject();
    const projectId = project.id as string;

    await request.get(`/api/projects/${projectId}/board`).expect(200);

    const res = await request
      .post(`/api/projects/${projectId}/import`)
      .send({
        version: 3,
        type: 'project',
        kanban: {
          board: { name: 'Boundary Test Board' },
          columns: [{ id: 'lex-td', name: 'To Do', position: 0, color: '#3B82F6' }],
          epics: [],
          cards: [
            {
              id: 'lex-card-bad-priority',
              column_id: 'lex-td',
              title: `section-tag-${Date.now()}`,
              description: '',
              // CHECK(priority IN ('low','medium','high','urgent')) — this
              // value is not in the allowlist, so the INSERT fails with a
              // CHECK-constraint error from SQLite. The interesting bit for
              // this test is that the route reports WHICH section threw.
              priority: 'super-mega-urgent' as unknown as 'urgent',
              assignee: '',
              labels: '',
              position: 0,
            },
          ],
          comments: {},
        },
      })
      .expect(500);

    expect(res.body).toHaveProperty('error');
    expect(typeof res.body.error).toBe('string');
    expect(res.body.section).toBe('kanban');
    // The original SQLite message must still flow through so log-mining
    // tools (and the user) can see the underlying cause, not just the tag.
    expect(res.body.error.toLowerCase()).toMatch(/import failed/);
  });

  it('does not add a section tag on a request-level 400 (envelope rejection)', async () => {
    const project = await createProject();
    const projectId = project.id as string;

    // Wrong envelope: triggers the pre-runProjectImport guard, which 400s
    // before any section runs. The response must NOT carry a `section`
    // field because no section was entered.
    const res = await request
      .post(`/api/projects/${projectId}/import`)
      .send({ version: 2, type: 'project' })
      .expect(400);

    expect(res.body.section).toBeUndefined();
  });
});
