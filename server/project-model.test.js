/**
 * Tests for project-model.js — migration and helper functions.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getRequest } from './test/helpers.js';
import config from './config.js';
import { stmts } from './db.js';
import {
  migrateWebhookRepoToProject,
  findProject,
  getProjects,
  saveProjects,
} from './project-model.js';

let originalApiKey;
const createdProjectIds = [];

beforeAll(async () => {
  // Ensure app is initialized (loads DB, projects, etc.)
  await getRequest();
  originalApiKey = config.apiKey;
  config.apiKey = null;
});

afterAll(async () => {
  // Clean up all test projects so they don't leak into the real project list
  const request = await getRequest();
  for (const id of createdProjectIds) {
    await request.delete(`/api/projects/${id}`).catch(() => {});
  }
  config.apiKey = originalApiKey;
});

describe('migrateWebhookRepoToProject', () => {
  it('sets githubRepo on a project from webhook config repo_url', async () => {
    const request = await getRequest();

    // Create a project via API
    const projId = `migrate-test-${Date.now()}`;
    createdProjectIds.push(projId);
    const res = await request
      .post('/api/projects')
      .send({ id: projId, name: 'Migrate Test', cwd: '/tmp', color: '#000' })
      .expect(201);

    const project = findProject(projId);
    expect(project).toBeTruthy();
    expect(project.githubRepo).toBeUndefined();

    // Insert a webhook config directly
    stmts.createWebhookConfig.run(
      projId,
      'https://github.com/test-org/test-repo',
      'secret123',
      '["pull_request.opened"]',
      1,
    );

    // Run migration
    migrateWebhookRepoToProject();

    // Verify
    const updated = findProject(projId);
    expect(updated.githubRepo).toBe('test-org/test-repo');
  });

  it('does not overwrite existing githubRepo', async () => {
    const request = await getRequest();

    const projId = `migrate-noop-${Date.now()}`;
    createdProjectIds.push(projId);
    await request
      .post('/api/projects')
      .send({ id: projId, name: 'No Overwrite Test', cwd: '/tmp', color: '#111' })
      .expect(201);

    // Set githubRepo manually
    const project = findProject(projId);
    project.githubRepo = 'existing/repo';
    saveProjects();

    // Insert a webhook config pointing to a different repo
    stmts.createWebhookConfig.run(
      projId,
      'https://github.com/other-org/other-repo',
      'secret456',
      '["push"]',
      1,
    );

    // Run migration — should NOT overwrite
    migrateWebhookRepoToProject();

    const updated = findProject(projId);
    expect(updated.githubRepo).toBe('existing/repo');
  });

  it('auto-created webhook config uses object format for events', async () => {
    const request = await getRequest();

    const projId = `auto-webhook-${Date.now()}`;
    await request
      .post('/api/projects')
      .send({ id: projId, name: 'Auto Webhook Test', cwd: '/tmp', color: '#333' })
      .expect(201);

    // Update project with githubRepo — should auto-create webhook config
    await request.patch(`/api/projects/${projId}`).send({ githubRepo: 'test-org/auto-repo' });

    const wh = stmts.getWebhookConfigByProjectAndRepo.get(
      projId,
      'https://github.com/test-org/auto-repo',
    );
    expect(wh).toBeTruthy();

    // Events must be an object with { enabled: true } values, not an array
    const events = JSON.parse(wh.events);
    expect(events).toBeTypeOf('object');
    expect(Array.isArray(events)).toBe(false);
    expect(events['pull_request.opened']).toEqual({ enabled: true });
    expect(events['pull_request_review.submitted']).toEqual({ enabled: true });
  });

  it('only captures owner/repo, ignoring trailing path segments', async () => {
    const request = await getRequest();

    const projId = `migrate-trailing-${Date.now()}`;
    await request
      .post('/api/projects')
      .send({ id: projId, name: 'Trailing Path Test', cwd: '/tmp', color: '#222' })
      .expect(201);

    // Insert a webhook config with extra trailing segments
    stmts.createWebhookConfig.run(
      projId,
      'https://github.com/some-org/some-repo/tree/main/extra',
      'secret789',
      '["push"]',
      1,
    );

    migrateWebhookRepoToProject();

    const updated = findProject(projId);
    expect(updated.githubRepo).toBe('some-org/some-repo');
  });
});
