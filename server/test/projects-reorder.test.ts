import type supertest from 'supertest';
import { getRequest, createProject } from './helpers.js';

// ═══════════════════════════════════════════════════════════════════
// PUT /api/projects/order
//
// Reorders the caller-visible slice of `projects.json`. The route lives
// before every `/api/projects/:projectId` handler in the router so
// Express doesn't match `projectId="order"`. Body shape:
//   { projectIds: string[] }
// The supplied list must be a permutation of the caller's visible
// projects — no missing ids, no extras, no duplicates.
// ═══════════════════════════════════════════════════════════════════

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
});

async function visibleIds(): Promise<string[]> {
  const res = await request.get('/api/projects').expect(200);
  const list = res.body as Array<{ id: string }>;
  return list.map((p) => p.id);
}

describe('PUT /api/projects/order', () => {
  it('reorders the project list and persists the new order on the next GET', async () => {
    const a = (await createProject()).id as string;
    const b = (await createProject()).id as string;
    const c = (await createProject()).id as string;

    const baseline = await visibleIds();
    // Build a target order where a/b/c are swapped relative to baseline.
    // We keep every other project's *relative* slot intact by reusing the
    // baseline as the scaffold and replacing the a/b/c positions.
    const target = baseline.slice();
    const positions = [a, b, c].map((id) => baseline.indexOf(id)).sort((x, y) => x - y);
    const reversed = [a, b, c].reverse();
    positions.forEach((idx, i) => {
      target[idx] = reversed[i];
    });

    const res = await request.put('/api/projects/order').send({ projectIds: target }).expect(200);
    const body = res.body as { projectIds: string[] };
    expect(body.projectIds).toEqual(target);

    // GET /api/projects must reflect the new order.
    const after = await visibleIds();
    expect(after).toEqual(target);
  });

  it('rejects 400 when projectIds is missing or not an array', async () => {
    const res1 = await request.put('/api/projects/order').send({}).expect(400);
    expect((res1.body as { error: string }).error).toMatch(/projectIds.*array/i);

    const res2 = await request
      .put('/api/projects/order')
      .send({ projectIds: 'not-an-array' })
      .expect(400);
    expect((res2.body as { error: string }).error).toMatch(/projectIds.*array/i);
  });

  it('rejects 400 when an unknown id is supplied', async () => {
    const baseline = await visibleIds();
    const bogus = [...baseline, 'does-not-exist-xyz'];
    const res = await request.put('/api/projects/order').send({ projectIds: bogus }).expect(400);
    expect((res.body as { error: string }).error).toMatch(/unknown|inaccessible/i);
  });

  it('rejects 400 when a visible id is missing from the payload', async () => {
    const baseline = await visibleIds();
    if (baseline.length < 2) {
      // Need at least two visible projects to construct a "missing" payload.
      await createProject();
      await createProject();
    }
    const current = await visibleIds();
    const partial = current.slice(0, -1); // drop the last one
    const res = await request.put('/api/projects/order').send({ projectIds: partial }).expect(400);
    expect((res.body as { error: string }).error).toMatch(/missing/i);
  });

  it('rejects 400 when duplicates are supplied', async () => {
    // Need at least two visible projects to build a duplicate that still
    // has the right length.
    await createProject();
    await createProject();
    const current = await visibleIds();
    expect(current.length).toBeGreaterThanOrEqual(2);
    const dupe: string[] = current.slice();
    dupe[1] = dupe[0]; // overwrite slot 1 with a duplicate of slot 0
    const res = await request.put('/api/projects/order').send({ projectIds: dupe }).expect(400);
    expect((res.body as { error: string }).error).toMatch(/duplicate/i);
  });

  it('rejects 400 when ids contain non-string entries', async () => {
    const baseline = await visibleIds();
    const bad: unknown[] = [123, ...baseline.slice(1)];
    const res = await request.put('/api/projects/order').send({ projectIds: bad }).expect(400);
    expect((res.body as { error: string }).error).toMatch(/non-empty strings/i);
  });
});
