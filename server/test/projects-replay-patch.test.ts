import type supertest from 'supertest';
import { getRequest, createProject } from './helpers.js';

// ═══════════════════════════════════════════════════════════════════
// PATCH /api/projects/:projectId — replay (per-project session-replay policy)
//
// `replay.sampleRate` (continuous-tier sample rate in [0,1]) and
// `replay.continuous` (opt-in flag) are server-delivered so the policy applies
// to every user on the project rather than whoever flipped a per-browser
// localStorage toggle. Validation mirrors the other object-setting PATCH
// branches: object with optional fields, `null` clears, bad shapes → 400.
// ═══════════════════════════════════════════════════════════════════

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
});

type ReplayBody = { replay?: { sampleRate?: number; continuous?: boolean } };

describe('PATCH /api/projects/:projectId — replay', () => {
  it('persists a sampleRate + continuous flag', async () => {
    const project = await createProject();
    const res = await request
      .patch(`/api/projects/${project.id as string}`)
      .send({ replay: { sampleRate: 0.2, continuous: true } })
      .expect(200);
    expect((res.body as ReplayBody).replay).toEqual({ sampleRate: 0.2, continuous: true });
  });

  it('pins continuous-on to an explicit sampleRate:0 when no rate is sent', async () => {
    // A direct PATCH of { continuous: true } must not persist without a rate —
    // otherwise it resolves to the recorder default (100%) for continuous.
    const project = await createProject();
    const res = await request
      .patch(`/api/projects/${project.id as string}`)
      .send({ replay: { continuous: true } })
      .expect(200);
    expect((res.body as ReplayBody).replay).toEqual({ continuous: true, sampleRate: 0 });
  });

  it('clears the config when null is sent', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    await request
      .patch(`/api/projects/${projectId}`)
      .send({ replay: { sampleRate: 0.5 } })
      .expect(200);
    const res = await request
      .patch(`/api/projects/${projectId}`)
      .send({ replay: null })
      .expect(200);
    expect((res.body as ReplayBody).replay).toBeUndefined();
  });

  it('clears the config when an object with no recognized keys is sent', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    await request
      .patch(`/api/projects/${projectId}`)
      .send({ replay: { continuous: true } })
      .expect(200);
    const res = await request.patch(`/api/projects/${projectId}`).send({ replay: {} }).expect(200);
    expect((res.body as ReplayBody).replay).toBeUndefined();
  });

  it('rejects a non-object, non-null value with 400', async () => {
    const project = await createProject();
    const res = await request
      .patch(`/api/projects/${project.id as string}`)
      .send({ replay: 'on' })
      .expect(400);
    expect((res.body as { error: string }).error).toMatch(/replay must be an object or null/);
  });

  it('rejects a sampleRate outside [0,1] with 400', async () => {
    const project = await createProject();
    const res = await request
      .patch(`/api/projects/${project.id as string}`)
      .send({ replay: { sampleRate: 1.5 } })
      .expect(400);
    expect((res.body as { error: string }).error).toMatch(/replay.sampleRate must be between/);
  });

  it('rejects a non-numeric sampleRate with 400', async () => {
    const project = await createProject();
    const res = await request
      .patch(`/api/projects/${project.id as string}`)
      .send({ replay: { sampleRate: 'half' } })
      .expect(400);
    expect((res.body as { error: string }).error).toMatch(/replay.sampleRate must be a finite/);
  });

  it('rejects a non-boolean continuous with 400', async () => {
    const project = await createProject();
    const res = await request
      .patch(`/api/projects/${project.id as string}`)
      .send({ replay: { continuous: 'yes' } })
      .expect(400);
    expect((res.body as { error: string }).error).toMatch(/replay.continuous must be a boolean/);
  });
});
