import type supertest from 'supertest';
import { getRequest, createProject } from './helpers.js';

// ═══════════════════════════════════════════════════════════════════
// PATCH /api/projects/:projectId — securityAutoPr toggle
//
// `securityAutoPr.enabled` gates Dependabot-style auto-PR generation for
// the dependency security audit. Mirrors the ciOnPush object-setting
// validation: an object with an optional boolean `enabled`, `null` clears
// it, a non-boolean enabled / non-object value is rejected with 400.
// ═══════════════════════════════════════════════════════════════════

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
});

describe('PATCH /api/projects/:projectId — securityAutoPr', () => {
  it('persists securityAutoPr.enabled=true', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const res = await request
      .patch(`/api/projects/${projectId}`)
      .send({ securityAutoPr: { enabled: true } })
      .expect(200);
    expect((res.body as { securityAutoPr?: { enabled?: boolean } }).securityAutoPr).toEqual({
      enabled: true,
    });
  });

  it('clears the setting when null is sent', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    await request
      .patch(`/api/projects/${projectId}`)
      .send({ securityAutoPr: { enabled: true } })
      .expect(200);
    const res = await request
      .patch(`/api/projects/${projectId}`)
      .send({ securityAutoPr: null })
      .expect(200);
    expect((res.body as { securityAutoPr?: { enabled?: boolean } }).securityAutoPr).toBeUndefined();
  });

  it('rejects a non-object value with 400', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const res = await request
      .patch(`/api/projects/${projectId}`)
      .send({ securityAutoPr: 'yes' })
      .expect(400);
    expect((res.body as { error: string }).error).toMatch(/securityAutoPr must be an object/);
  });

  it('rejects a non-boolean enabled with 400', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const res = await request
      .patch(`/api/projects/${projectId}`)
      .send({ securityAutoPr: { enabled: 'yes' } })
      .expect(400);
    expect((res.body as { error: string }).error).toMatch(
      /securityAutoPr.enabled must be a boolean/,
    );
  });
});
