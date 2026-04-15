import { getRequest } from './test/helpers.js';
import config from './config.js';
import { stmts } from './db.js';
import {
  migrateWebhookRepoToProject,
  findProject,
  getProjects,
  saveProjects,
} from './project-model.js';
import type { Stmts, Project } from './types.js';

let originalApiKey: string | null;
const createdProjectIds: string[] = [];

beforeAll(async () => {
  await getRequest();
  originalApiKey = config.apiKey;
  config.apiKey = null;
});

afterAll(async () => {
  const request = await getRequest();
  for (const id of createdProjectIds) {
    await (request as { delete(url: string): Promise<unknown> })
      .delete(`/api/projects/${id}`)
      .catch(() => {});
  }
  config.apiKey = originalApiKey;
});

describe('migrateWebhookRepoToProject', () => {
  it('sets githubRepo on a project from webhook config repo_url', async () => {
    const request = await getRequest();

    const projId = `migrate-test-${Date.now()}`;
    createdProjectIds.push(projId);
    const res = await (
      request as {
        post(url: string): {
          send(body: Record<string, unknown>): {
            expect(code: number): Promise<{ body: Record<string, unknown> }>;
          };
        };
      }
    )
      .post('/api/projects')
      .send({ id: projId, name: 'Migrate Test', cwd: '/tmp', color: '#000' })
      .expect(201);

    const project = findProject(projId);
    expect(project).toBeTruthy();
    expect(project!.githubRepo).toBeUndefined();

    (stmts as Stmts).createWebhookConfig.run(
      projId,
      'https://github.com/test-org/test-repo',
      'secret123',
      '["pull_request.opened"]',
      1,
    );

    migrateWebhookRepoToProject();

    const updated = findProject(projId);
    expect(updated!.githubRepo).toBe('test-org/test-repo');
  });

  it('does not overwrite existing githubRepo', async () => {
    const request = await getRequest();

    const projId = `migrate-noop-${Date.now()}`;
    createdProjectIds.push(projId);
    await (
      request as {
        post(url: string): {
          send(body: Record<string, unknown>): { expect(code: number): Promise<unknown> };
        };
      }
    )
      .post('/api/projects')
      .send({ id: projId, name: 'No Overwrite Test', cwd: '/tmp', color: '#111' })
      .expect(201);

    const project = findProject(projId);
    project!.githubRepo = 'existing/repo';
    saveProjects();

    (stmts as Stmts).createWebhookConfig.run(
      projId,
      'https://github.com/other-org/other-repo',
      'secret456',
      '["push"]',
      1,
    );

    migrateWebhookRepoToProject();

    const updated = findProject(projId);
    expect(updated!.githubRepo).toBe('existing/repo');
  });

  it('auto-created webhook config uses object format for events', async () => {
    const request = await getRequest();

    const projId = `auto-webhook-${Date.now()}`;
    await (
      request as {
        post(url: string): {
          send(body: Record<string, unknown>): { expect(code: number): Promise<unknown> };
        };
      }
    )
      .post('/api/projects')
      .send({ id: projId, name: 'Auto Webhook Test', cwd: '/tmp', color: '#333' })
      .expect(201);

    await (
      request as { patch(url: string): { send(body: Record<string, unknown>): Promise<unknown> } }
    )
      .patch(`/api/projects/${projId}`)
      .send({ githubRepo: 'test-org/auto-repo' });

    const wh = (stmts as Stmts).getWebhookConfigByProjectAndRepo.get(
      projId,
      'https://github.com/test-org/auto-repo',
    ) as { events: string } | undefined;
    expect(wh).toBeTruthy();

    const events = JSON.parse(wh!.events) as Record<string, { enabled: boolean }>;
    expect(events).toBeTypeOf('object');
    expect(Array.isArray(events)).toBe(false);
    expect(events['pull_request.opened']).toEqual({ enabled: true });
    expect(events['pull_request_review.submitted']).toEqual({ enabled: true });
  });

  it('only captures owner/repo, ignoring trailing path segments', async () => {
    const request = await getRequest();

    const projId = `migrate-trailing-${Date.now()}`;
    await (
      request as {
        post(url: string): {
          send(body: Record<string, unknown>): { expect(code: number): Promise<unknown> };
        };
      }
    )
      .post('/api/projects')
      .send({ id: projId, name: 'Trailing Path Test', cwd: '/tmp', color: '#222' })
      .expect(201);

    (stmts as Stmts).createWebhookConfig.run(
      projId,
      'https://github.com/some-org/some-repo/tree/main/extra',
      'secret789',
      '["push"]',
      1,
    );

    migrateWebhookRepoToProject();

    const updated = findProject(projId);
    expect(updated!.githubRepo).toBe('some-org/some-repo');
  });
});
