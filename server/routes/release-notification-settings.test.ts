import '../test/setup.js';
import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { beforeEach, describe, expect, it } from 'vitest';
import { initDb } from '../db.js';
import type { Project, RouteDeps } from '../types.js';
import {
  DEFAULT_RELEASE_DIGEST_PROMPT,
  buildFactBoundedReleaseDigestPrompt,
} from '../release-notification-settings.js';
import createReleaseNotificationSettingsRoutes from './release-notification-settings.js';

const PROJECT_ID = 'release-settings-proj';

function makeApp(role: 'Owner' | 'Admin' | 'User' | null = 'Owner') {
  const project = {
    id: PROJECT_ID,
    name: 'Release Settings Project',
    cwd: '/tmp/project',
    agents: [],
  } as unknown as Project;
  const deps = {
    findProject: (id: string) => (id === PROJECT_ID ? project : null),
  } as unknown as RouteDeps;
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (role) {
      (req as unknown as { authRole?: string; authUserId?: string }).authRole = role;
      (req as unknown as { authRole?: string; authUserId?: string }).authUserId = 'user-1';
    }
    next();
  });
  app.use(createReleaseNotificationSettingsRoutes(deps));
  return app;
}

beforeEach(() => {
  initDb(mkdtempSync(path.join(tmpdir(), 'ah-release-settings-')));
});

describe('release notification settings routes', () => {
  it('returns the safe default prompt before a project setting exists', async () => {
    const res = await request(makeApp()).get(
      `/api/projects/${PROJECT_ID}/release-notification-settings`,
    );

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      projectId: PROJECT_ID,
      releaseDigestPrompt: DEFAULT_RELEASE_DIGEST_PROMPT,
      defaultReleaseDigestPrompt: DEFAULT_RELEASE_DIGEST_PROMPT,
      isDefault: true,
      promptMaxLength: 4000,
    });
    expect(res.body.factBoundedSystemTemplate).toContain('Ground every claim');
  });

  it('updates and reads a custom release digest prompt', async () => {
    const app = makeApp('Admin');
    const recipient = await request(app)
      .post(`/api/projects/${PROJECT_ID}/release-notification-settings/recipients`)
      .send({ email: 'digest@example.com', displayLabel: 'Digest list' })
      .expect(201);

    const update = await request(app)
      .put(`/api/projects/${PROJECT_ID}/release-notification-settings`)
      .send({ releaseDigestPrompt: 'Group fixes first.\nAvoid roadmap language.' });

    expect(update.status).toBe(200);
    expect(update.body).toMatchObject({
      releaseDigestPrompt: 'Group fixes first.\nAvoid roadmap language.',
      isDefault: false,
      updatedBy: 'user-1',
    });
    expect(update.body.releaseDigestRecipients).toEqual([
      expect.objectContaining({
        id: recipient.body.id,
        email: 'digest@example.com',
        displayLabel: 'Digest list',
      }),
    ]);

    const read = await request(app).get(
      `/api/projects/${PROJECT_ID}/release-notification-settings`,
    );
    expect(read.body.releaseDigestPrompt).toBe('Group fixes first.\nAvoid roadmap language.');
  });

  it('rejects invalid prompt updates before mutating the stored setting', async () => {
    const app = makeApp('Admin');
    await request(app)
      .put(`/api/projects/${PROJECT_ID}/release-notification-settings`)
      .send({ releaseDigestPrompt: 'Keep it short.' })
      .expect(200);

    const invalid = await request(app)
      .put(`/api/projects/${PROJECT_ID}/release-notification-settings`)
      .send({ releaseDigestPrompt: '   ' });

    expect(invalid.status).toBe(400);
    const read = await request(app).get(
      `/api/projects/${PROJECT_ID}/release-notification-settings`,
    );
    expect(read.body.releaseDigestPrompt).toBe('Keep it short.');
  });

  it('resets a custom prompt back to the safe default', async () => {
    const app = makeApp('Owner');
    await request(app)
      .put(`/api/projects/${PROJECT_ID}/release-notification-settings`)
      .send({ releaseDigestPrompt: 'Customer success tone.' })
      .expect(200);
    const recipient = await request(app)
      .post(`/api/projects/${PROJECT_ID}/release-notification-settings/recipients`)
      .send({ email: 'digest@example.com', enabled: false })
      .expect(201);

    const reset = await request(app).post(
      `/api/projects/${PROJECT_ID}/release-notification-settings/reset`,
    );

    expect(reset.status).toBe(200);
    expect(reset.body.releaseDigestPrompt).toBe(DEFAULT_RELEASE_DIGEST_PROMPT);
    expect(reset.body.isDefault).toBe(true);
    expect(reset.body.releaseDigestRecipients).toEqual([
      expect.objectContaining({
        id: recipient.body.id,
        email: 'digest@example.com',
        enabled: false,
      }),
    ]);
  });

  it('allows Users to read but requires Admin for update and reset', async () => {
    const app = makeApp('User');
    await request(app).get(`/api/projects/${PROJECT_ID}/release-notification-settings`).expect(200);
    await request(app)
      .put(`/api/projects/${PROJECT_ID}/release-notification-settings`)
      .send({ releaseDigestPrompt: 'Nope.' })
      .expect(403);
    await request(app)
      .post(`/api/projects/${PROJECT_ID}/release-notification-settings/reset`)
      .expect(403);
  });

  it('lets Admins add, list, disable, and remove release digest recipients', async () => {
    const app = makeApp('Admin');

    const created = await request(app)
      .post(`/api/projects/${PROJECT_ID}/release-notification-settings/recipients`)
      .send({
        email: 'Customer.Success@Example.com',
        displayLabel: 'Customer Success',
      })
      .expect(201);

    expect(created.body).toMatchObject({
      projectId: PROJECT_ID,
      email: 'Customer.Success@Example.com',
      displayLabel: 'Customer Success',
      enabled: true,
      createdBy: 'user-1',
      updatedBy: 'user-1',
    });

    const listed = await request(app)
      .get(`/api/projects/${PROJECT_ID}/release-notification-settings/recipients`)
      .expect(200);
    expect(listed.body.recipients).toHaveLength(1);
    expect(listed.body.recipients[0].email).toBe('Customer.Success@Example.com');

    const disabled = await request(app)
      .patch(
        `/api/projects/${PROJECT_ID}/release-notification-settings/recipients/${created.body.id}`,
      )
      .send({ enabled: false, displayLabel: 'CS team' })
      .expect(200);
    expect(disabled.body).toMatchObject({
      displayLabel: 'CS team',
      enabled: false,
    });

    const settings = await request(app)
      .get(`/api/projects/${PROJECT_ID}/release-notification-settings`)
      .expect(200);
    expect(settings.body.releaseDigestRecipients).toEqual([
      expect.objectContaining({ id: created.body.id, enabled: false }),
    ]);

    await request(app)
      .delete(
        `/api/projects/${PROJECT_ID}/release-notification-settings/recipients/${created.body.id}`,
      )
      .expect(200);
    const afterDelete = await request(app)
      .get(`/api/projects/${PROJECT_ID}/release-notification-settings/recipients`)
      .expect(200);
    expect(afterDelete.body.recipients).toEqual([]);
  });

  it('rejects invalid and duplicate release digest recipients', async () => {
    const app = makeApp('Admin');

    await request(app)
      .post(`/api/projects/${PROJECT_ID}/release-notification-settings/recipients`)
      .send({ email: 'not-an-email' })
      .expect(400);

    await request(app)
      .post(`/api/projects/${PROJECT_ID}/release-notification-settings/recipients`)
      .send({ email: 'digest@example.com' })
      .expect(201);

    const duplicate = await request(app)
      .post(`/api/projects/${PROJECT_ID}/release-notification-settings/recipients`)
      .send({ email: ' DIGEST@example.com ' })
      .expect(409);
    expect(duplicate.body.error).toContain('already exists');
  });

  it('does not expose recipient data to non-admin users', async () => {
    const adminApp = makeApp('Admin');
    await request(adminApp)
      .post(`/api/projects/${PROJECT_ID}/release-notification-settings/recipients`)
      .send({ email: 'digest@example.com', enabled: false })
      .expect(201);

    const userApp = makeApp('User');
    const settings = await request(userApp)
      .get(`/api/projects/${PROJECT_ID}/release-notification-settings`)
      .expect(200);
    expect(settings.body).not.toHaveProperty('releaseDigestRecipients');

    await request(userApp)
      .get(`/api/projects/${PROJECT_ID}/release-notification-settings/recipients`)
      .expect(403);
    await request(userApp)
      .post(`/api/projects/${PROJECT_ID}/release-notification-settings/recipients`)
      .send({ email: 'other@example.com' })
      .expect(403);
  });

  it('wraps operator guidance inside the fixed fact-bounded template', () => {
    const prompt = buildFactBoundedReleaseDigestPrompt('Use friendly language.');
    expect(prompt).toContain('Operator guidance:\nUse friendly language.');
    expect(prompt).toContain('Do not expose secrets');
    expect(prompt).toContain('Allowed source facts:');
  });
});
