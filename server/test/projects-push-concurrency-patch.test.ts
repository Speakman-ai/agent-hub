import { describe, it, expect, beforeAll } from 'vitest';
import type supertest from 'supertest';
import { getRequest, createProject } from './helpers.js';

// PATCH /api/projects/:projectId — pushConcurrency ({ ci, review }: 'queue' | 'cancel').

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
});

describe('PATCH /api/projects/:projectId — pushConcurrency', () => {
  it('merges per-kind modes and clears with null', async () => {
    const projectId = (await createProject()).id as string;
    await request
      .patch(`/api/projects/${projectId}`)
      .send({ pushConcurrency: { ci: 'cancel' } })
      .expect(200);
    const res = await request
      .patch(`/api/projects/${projectId}`)
      .send({ pushConcurrency: { review: 'queue' } })
      .expect(200);
    expect(res.body.pushConcurrency).toEqual({ ci: 'cancel', review: 'queue' });

    const cleared = await request
      .patch(`/api/projects/${projectId}`)
      .send({ pushConcurrency: null })
      .expect(200);
    expect(cleared.body.pushConcurrency).toBeUndefined();
  });

  it('rejects unknown modes and non-objects', async () => {
    const projectId = (await createProject()).id as string;
    const bad = await request
      .patch(`/api/projects/${projectId}`)
      .send({ pushConcurrency: { ci: 'restart' } })
      .expect(400);
    expect(bad.body.error).toMatch(/pushConcurrency\.ci/);
    await request
      .patch(`/api/projects/${projectId}`)
      .send({ pushConcurrency: 'cancel' })
      .expect(400);
  });
});
