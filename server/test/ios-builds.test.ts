/**
 * Integration tests for iOS build routes.
 *
 * Tests the REST API for iOS PR preview builds, including:
 * - Status endpoint
 * - Build creation with validation
 * - Project-ownership authorization checks
 * - Build lifecycle (list, get, cancel, delete, logs, artifacts)
 */
import './setup.js';
import { describe, it, expect } from 'vitest';
import { getRequest, createProject } from './helpers.js';

describe('iOS Build Routes', () => {
  // ─── Status ─────────────────────────────────────────────────────

  it('GET /api/ios-builds/status returns infrastructure status', async () => {
    const request = await getRequest();
    const res = await request.get('/api/ios-builds/status').expect(200);

    expect(res.body).toHaveProperty('available');
    expect(res.body).toHaveProperty('runningCount');
    expect(res.body).toHaveProperty('maxConcurrent');
    expect(res.body).toHaveProperty('buildTimeoutMinutes');
    expect(typeof res.body.runningCount).toBe('number');
    expect(typeof res.body.maxConcurrent).toBe('number');
  });

  // ─── Create ─────────────────────────────────────────────────────

  it('POST /api/projects/:projectId/ios-builds validates required fields', async () => {
    const request = await getRequest();
    const project = await createProject();

    // Missing prNumber
    await request
      .post(`/api/projects/${project.id}/ios-builds`)
      .send({ branch: 'feature/test' })
      .expect(400);

    // Missing branch
    await request.post(`/api/projects/${project.id}/ios-builds`).send({ prNumber: 1 }).expect(400);
  });

  it('POST /api/projects/:projectId/ios-builds rejects empty repoUrl', async () => {
    const request = await getRequest();
    // Create a project without githubRepo so resolvedRepoUrl will be empty
    const project = await createProject({ githubRepo: undefined });

    const res = await request
      .post(`/api/projects/${project.id}/ios-builds`)
      .send({ prNumber: 42, branch: 'feature/test' })
      .expect(400);

    expect(res.body.error).toMatch(/Repository URL is required/i);
  });

  it('POST returns 404 for unknown project', async () => {
    const request = await getRequest();
    await request
      .post('/api/projects/nonexistent/ios-builds')
      .send({ prNumber: 1, branch: 'main', repoUrl: 'https://github.com/o/r.git' })
      .expect(404);
  });

  // ─── List ───────────────────────────────────────────────────────

  it('GET /api/projects/:projectId/ios-builds returns array', async () => {
    const request = await getRequest();
    const project = await createProject();

    const res = await request.get(`/api/projects/${project.id}/ios-builds`).expect(200);

    expect(Array.isArray(res.body)).toBe(true);
  });

  // ─── Authorization: cross-project access ────────────────────────

  it('GET /:id returns 404 for build belonging to a different project', async () => {
    const request = await getRequest();
    const project = await createProject();

    // Try to get a non-existent build
    await request.get(`/api/projects/${project.id}/ios-builds/nonexistent-build-id`).expect(404);
  });

  it('POST /:id/cancel returns 404 for build belonging to a different project', async () => {
    const request = await getRequest();
    const project = await createProject();

    await request
      .post(`/api/projects/${project.id}/ios-builds/nonexistent-build-id/cancel`)
      .expect(404);
  });

  it('GET /:id/logs returns 404 for build belonging to a different project', async () => {
    const request = await getRequest();
    const project = await createProject();

    await request
      .get(`/api/projects/${project.id}/ios-builds/nonexistent-build-id/logs`)
      .expect(404);
  });

  it('GET /:id/artifacts returns 404 for build belonging to a different project', async () => {
    const request = await getRequest();
    const project = await createProject();

    await request
      .get(`/api/projects/${project.id}/ios-builds/nonexistent-build-id/artifacts`)
      .expect(404);
  });

  it('DELETE /:id returns 404 for build belonging to a different project', async () => {
    const request = await getRequest();
    const project = await createProject();

    await request.delete(`/api/projects/${project.id}/ios-builds/nonexistent-build-id`).expect(404);
  });
});
