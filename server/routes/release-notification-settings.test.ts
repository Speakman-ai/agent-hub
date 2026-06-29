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
    const update = await request(app)
      .put(`/api/projects/${PROJECT_ID}/release-notification-settings`)
      .send({ releaseDigestPrompt: 'Group fixes first.\nAvoid roadmap language.' });

    expect(update.status).toBe(200);
    expect(update.body).toMatchObject({
      releaseDigestPrompt: 'Group fixes first.\nAvoid roadmap language.',
      isDefault: false,
      updatedBy: 'user-1',
    });

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

    const reset = await request(app).post(
      `/api/projects/${PROJECT_ID}/release-notification-settings/reset`,
    );

    expect(reset.status).toBe(200);
    expect(reset.body.releaseDigestPrompt).toBe(DEFAULT_RELEASE_DIGEST_PROMPT);
    expect(reset.body.isDefault).toBe(true);
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

  it('wraps operator guidance inside the fixed fact-bounded template', () => {
    const prompt = buildFactBoundedReleaseDigestPrompt('Use friendly language.');
    expect(prompt).toContain('Operator guidance:\nUse friendly language.');
    expect(prompt).toContain('Do not expose secrets');
    expect(prompt).toContain('Allowed source facts:');
  });
});
