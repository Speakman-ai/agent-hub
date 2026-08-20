/**
 * GET/POST /api/me/hub-session — per-user Hub assistant session.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { tmpdir } from 'os';
import { mkdtempSync } from 'fs';
import path from 'path';
import type { AppConfig, RouteDeps } from '../types.js';
import {
  HUB_ASSISTANT_AGENT_ID,
  HUB_PROJECT_ID,
  HUB_SESSION_MODE,
  HUB_SESSION_NAME,
  isHubSystemProject,
} from '../../shared/utils/hub.js';

const { initOrgsDb, setOrgsDbPathForTests } = await import('../orgs.js');
const { createUser } = await import('../users-store.js');
const { initDb, getStmts } = await import('../db.js');
const { getProjects, findAgent, saveProjects } = await import('../project-model.js');
const { default: createMeHubRoutes } = await import('./me-hub.js');
const { ensureHubAssistantAgent } = await import('../hub-assistant.js');

let userA = '';
let userB = '';

const HUB_CFG = {
  engineValidModels: {
    'claude-code': ['claude-opus-5', 'claude-sonnet-5'],
    'codex-cli': ['gpt-5.6-sol'],
  },
  engineDefaultModels: {
    'claude-code': 'claude-opus-5',
    'codex-cli': 'gpt-5.6-sol',
  },
  dataDir: tmpdir(),
} as unknown as AppConfig;

function mount(authUserId: string | null): Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (authUserId) {
      Object.assign(req, { authUserId, authUser: 'x', authRole: 'User' });
    }
    next();
  });
  app.use(
    createMeHubRoutes({
      stmts: getStmts(),
      config: HUB_CFG,
      activeProcesses: new Map(),
      broadcast: () => undefined,
    } as unknown as RouteDeps),
  );
  return app;
}

beforeEach(() => {
  const dir = mkdtempSync(path.join(tmpdir(), 'me-hub-route-'));
  initDb(dir);
  setOrgsDbPathForTests(path.join(dir, 'orgs.db'));
  initOrgsDb();
  userA = createUser({ username: 'hub-user-a', passwordHash: 'x' }).id;
  userB = createUser({ username: 'hub-user-b', passwordHash: 'x' }).id;
});

describe('/api/me/hub-session', () => {
  it('requires authentication', async () => {
    await request(mount(null)).get('/api/me/hub-session').expect(401);
    await request(mount(null)).post('/api/me/hub-session').expect(401);
  });

  it('creates a per-user Hub session on the hidden assistant', async () => {
    const created = await request(mount(userA)).get('/api/me/hub-session').expect(201);
    expect(created.body.agent.id).toBe(HUB_ASSISTANT_AGENT_ID);
    expect(created.body.agent.name).toBe('Hub');
    expect(created.body.session.session_mode).toBe(HUB_SESSION_MODE);
    expect(created.body.session.agent_id).toBe(HUB_ASSISTANT_AGENT_ID);

    const again = await request(mount(userA)).get('/api/me/hub-session').expect(200);
    expect(again.body.session.id).toBe(created.body.session.id);

    const other = await request(mount(userB)).post('/api/me/hub-session').expect(201);
    expect(other.body.session.id).not.toBe(created.body.session.id);
    expect(other.body.session.agent_id).toBe(HUB_ASSISTANT_AGENT_ID);

    const hubProject = getProjects().find((p) => p.id === HUB_PROJECT_ID);
    expect(hubProject).toBeTruthy();
    expect(isHubSystemProject(hubProject)).toBe(true);
  });

  it('keeps agent-hub on the Hub assistant allowlist', async () => {
    await request(mount(userA)).get('/api/me/hub-session').expect(201);
    const found = findAgent(HUB_ASSISTANT_AGENT_ID);
    expect(found?.agent.allowedSkills).toContain('agent-hub');
    found!.agent.allowedSkills = [];
    saveProjects();
    const repaired = ensureHubAssistantAgent();
    expect(repaired.allowedSkills).toContain('agent-hub');
  });
});

describe('/api/me/hub-model', () => {
  it('requires authentication', async () => {
    await request(mount(null)).get('/api/me/hub-model').expect(401);
    await request(mount(null))
      .put('/api/me/hub-model')
      .send({ engine: 'codex-cli', model: 'gpt-5.6-sol' })
      .expect(401);
  });

  it('saves a Hub engine/model and applies it to live Hub sessions', async () => {
    const hub = await request(mount(userA)).post('/api/me/hub-session').expect(201);

    await request(mount(userA))
      .put('/api/me/hub-model')
      .send({ engine: 'codex-cli', model: 'gpt-5.6-sol' })
      .expect(200);

    const saved = await request(mount(userA)).get('/api/me/hub-model').expect(200);
    expect(saved.body).toEqual({ engine: 'codex-cli', model: 'gpt-5.6-sol' });

    const hubAgain = await request(mount(userA)).get('/api/me/hub-session').expect(200);
    expect(hubAgain.body.session.id).toBe(hub.body.session.id);
    expect(hubAgain.body.session.engine).toBe('codex-cli');
    expect(hubAgain.body.session.model).toBe('gpt-5.6-sol');
  });

  it('realigns a live Hub session that drifted from the saved pick', async () => {
    const hub = await request(mount(userA)).post('/api/me/hub-session').expect(201);
    await request(mount(userA))
      .put('/api/me/hub-model')
      .send({ engine: 'codex-cli', model: 'gpt-5.6-sol' })
      .expect(200);
    getStmts().updateSessionEngine.run('claude-code', hub.body.session.id);
    getStmts().updateSessionModel.run('claude-opus-5', hub.body.session.id);

    const again = await request(mount(userA)).get('/api/me/hub-session').expect(200);
    expect(again.body.session.id).toBe(hub.body.session.id);
    expect(again.body.session.engine).toBe('codex-cli');
    expect(again.body.session.model).toBe('gpt-5.6-sol');
  });

  it('rejects gemini-cli and unknown models', async () => {
    const gemini = await request(mount(userA))
      .put('/api/me/hub-model')
      .send({ engine: 'gemini-cli', model: 'gemini-2.5-pro' })
      .expect(400);
    expect(gemini.body.error).toMatch(/not selectable/i);

    const bad = await request(mount(userA))
      .put('/api/me/hub-model')
      .send({ engine: 'claude-code', model: 'not-a-model' })
      .expect(400);
    expect(bad.body.error).toMatch(/not valid/i);
  });
});

describe('POST /api/me/hub-session/clear', () => {
  it('archives the current Hub chat and returns a fresh empty session', async () => {
    const created = await request(mount(userA)).post('/api/me/hub-session').expect(201);
    const oldId = created.body.session.id as string;
    getStmts().addMessage.run(
      'msg-1',
      oldId,
      'user',
      'hello hub',
      'claude-code',
      'claude-opus-5',
      null,
      null,
      HUB_ASSISTANT_AGENT_ID,
      'Hub',
      '#22d3ee',
    );

    const cleared = await request(mount(userA)).post('/api/me/hub-session/clear').expect(200);
    expect(cleared.body.session.id).not.toBe(oldId);
    expect(cleared.body.session.name).toBe(HUB_SESSION_NAME);
    expect(cleared.body.clearedSessionId).toBe(oldId);
    expect(getStmts().getMessages.all(cleared.body.session.id)).toEqual([]);

    const old = getStmts().getSession.get(oldId) as { deleted_at: string | null };
    expect(old.deleted_at).toBeTruthy();

    const again = await request(mount(userA)).get('/api/me/hub-session').expect(200);
    expect(again.body.session.id).toBe(cleared.body.session.id);
  });

  it('new Hub chat after clear uses the saved Hub model', async () => {
    await request(mount(userA)).post('/api/me/hub-session').expect(201);
    await request(mount(userA))
      .put('/api/me/hub-model')
      .send({ engine: 'codex-cli', model: 'gpt-5.6-sol' })
      .expect(200);

    const cleared = await request(mount(userA)).post('/api/me/hub-session/clear').expect(200);
    expect(cleared.body.session.engine).toBe('codex-cli');
    expect(cleared.body.session.model).toBe('gpt-5.6-sol');
  });
});
