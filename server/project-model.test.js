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
});
