/**
 * Skill option REST — Vitest integration (real orgs.db + auth wiring).
 * Mirrors skill-credentials-auth.test.ts. Options are non-secret enums.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { tmpdir } from 'os';
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import path from 'path';

var _skillOptTestRoot = '';
var _skillOptApiKeyOverride: string | null = null;

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js');
  const base = actual.default;
  return {
    default: new Proxy(base, {
      get(t, prop, recv) {
        if (prop === 'dataDir') return _skillOptTestRoot || Reflect.get(t, 'dataDir', recv);
        if (prop === 'projectsDir')
          return _skillOptTestRoot
            ? path.join(_skillOptTestRoot, 'persist', 'projects')
            : Reflect.get(t, 'projectsDir', recv);
        if (prop === 'apiKey')
          return _skillOptApiKeyOverride !== null
            ? _skillOptApiKeyOverride
            : Reflect.get(t, 'apiKey', recv);
        const v = Reflect.get(t, prop, recv);
        return typeof v === 'function' ? v.bind(t) : v;
      },
    }),
  };
});

const { reloadProjects, resolveProjectSkillsDir } = await import('../project-model.js');
const { default: createAuthRoutes } = await import('./auth.js');
const { authMiddleware } = await import('../auth.js');
const { setAuthFilePathForTests, reloadAuthRecord } = await import('../auth-store.js');
const { initOrgsDb, setOrgsDbPathForTests, updateOrg } = await import('../orgs.js');

function buildGatedApp() {
  const app = express();
  app.use(express.json());
  app.use(authMiddleware);
  app.use(createAuthRoutes());
  return app;
}

async function setupOwner(app: ReturnType<typeof buildGatedApp>): Promise<string> {
  const res = await supertest(app)
    .post('/api/auth/setup')
    .send({ email: 'owner@example.com', password: 'x'.repeat(20) });
  if (res.status !== 200) throw new Error(`setup failed: ${JSON.stringify(res.body)}`);
  return res.body.token as string;
}

/** Register a project whose project-skill store declares an `options:` block. */
function registerSkillWithOptions(skillId = 'survey-tracker', agentId = 'opt-agent'): void {
  const repo = path.join(_skillOptTestRoot, 'repo');
  mkdirSync(repo, { recursive: true });
  writeFileSync(
    path.join(_skillOptTestRoot, 'projects.json'),
    JSON.stringify([
      {
        id: 'p-opt',
        name: 'Opt',
        cwd: repo,
        agents: [{ id: agentId, name: 'Bot', engine: 'claude-code', cwd: repo }],
      },
    ]) + '\n',
    'utf8',
  );
  reloadProjects(_skillOptTestRoot);

  const ahw = path.join(_skillOptTestRoot, 'persist', 'projects', 'p-opt');
  const dir = path.join(resolveProjectSkillsDir({ id: 'p-opt', ahw }), skillId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---
name: ${skillId}
options:
  - name: SURVEY_TRACKER_ENV
    label: Environment
    choices:
      - value: dev
        label: Development
      - value: prod
        label: Production
    default: dev
---
`,
    'utf8',
  );
}

beforeEach(() => {
  _skillOptTestRoot = mkdtempSync(path.join(tmpdir(), 'skill-opt-test-'));
  _skillOptApiKeyOverride = null;
  mkdirSync(path.join(_skillOptTestRoot, 'persist', 'projects'), { recursive: true });
  writeFileSync(path.join(_skillOptTestRoot, 'projects.json'), '[]', 'utf8');
  reloadProjects(_skillOptTestRoot);

  setAuthFilePathForTests(path.join(_skillOptTestRoot, 'auth.json'));
  setOrgsDbPathForTests(path.join(_skillOptTestRoot, 'orgs.db'));
  initOrgsDb();
  updateOrg('default', { mode: 'remote' });
  reloadAuthRecord();
});

describe('/api/auth/me/skill-options', () => {
  it('returns 401 for api-key-only callers (no uid)', async () => {
    const app = buildGatedApp();
    _skillOptApiKeyOverride = 'sekrit';
    const res = await supertest(app)
      .get('/api/auth/me/skill-options?skillId=survey-tracker')
      .set('x-api-key', 'sekrit');
    expect(res.status).toBe(401);
  });

  it('GET returns the option schema with the default as the effective selection', async () => {
    registerSkillWithOptions();
    const app = buildGatedApp();
    const token = await setupOwner(app);
    const res = await supertest(app)
      .get('/api/auth/me/skill-options?skillId=survey-tracker&agentId=opt-agent')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.options).toHaveLength(1);
    expect(res.body.options[0].name).toBe('SURVEY_TRACKER_ENV');
    expect(res.body.options[0].selected).toBe('dev');
    expect(res.body.options[0].choices).toHaveLength(2);
  });

  it('PUT stores a legal selection and GET reflects it', async () => {
    registerSkillWithOptions();
    const app = buildGatedApp();
    const token = await setupOwner(app);

    const put = await supertest(app)
      .put('/api/auth/me/skill-options')
      .set('Authorization', `Bearer ${token}`)
      .send({
        skill_id: 'survey-tracker',
        option_name: 'SURVEY_TRACKER_ENV',
        value: 'prod',
        agent_id: 'opt-agent',
      });
    expect(put.status).toBe(200);
    expect(put.body.option.value).toBe('prod');

    const res = await supertest(app)
      .get('/api/auth/me/skill-options?skillId=survey-tracker&agentId=opt-agent')
      .set('Authorization', `Bearer ${token}`);
    expect(res.body.options[0].selected).toBe('prod');
  });

  it('PUT rejects a value that is not a declared choice', async () => {
    registerSkillWithOptions();
    const app = buildGatedApp();
    const token = await setupOwner(app);
    const put = await supertest(app)
      .put('/api/auth/me/skill-options')
      .set('Authorization', `Bearer ${token}`)
      .send({
        skill_id: 'survey-tracker',
        option_name: 'SURVEY_TRACKER_ENV',
        value: 'staging',
        agent_id: 'opt-agent',
      });
    expect(put.status).toBe(400);
    expect(String(put.body.error)).toMatch(/not a declared choice/);
  });

  it('PUT rejects an unknown option name', async () => {
    registerSkillWithOptions();
    const app = buildGatedApp();
    const token = await setupOwner(app);
    const put = await supertest(app)
      .put('/api/auth/me/skill-options')
      .set('Authorization', `Bearer ${token}`)
      .send({
        skill_id: 'survey-tracker',
        option_name: 'NOPE',
        value: 'dev',
        agent_id: 'opt-agent',
      });
    expect(put.status).toBe(400);
    expect(String(put.body.error)).toMatch(/Unknown option/);
  });

  it('DELETE resets to default', async () => {
    registerSkillWithOptions();
    const app = buildGatedApp();
    const token = await setupOwner(app);

    await supertest(app)
      .put('/api/auth/me/skill-options')
      .set('Authorization', `Bearer ${token}`)
      .send({
        skill_id: 'survey-tracker',
        option_name: 'SURVEY_TRACKER_ENV',
        value: 'prod',
        agent_id: 'opt-agent',
      })
      .expect(200);

    await supertest(app)
      .delete('/api/auth/me/skill-options/survey-tracker/SURVEY_TRACKER_ENV')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const res = await supertest(app)
      .get('/api/auth/me/skill-options?skillId=survey-tracker&agentId=opt-agent')
      .set('Authorization', `Bearer ${token}`);
    expect(res.body.options[0].selected).toBe('dev');
  });

  it('GET 400s without skillId', async () => {
    const app = buildGatedApp();
    const token = await setupOwner(app);
    const res = await supertest(app)
      .get('/api/auth/me/skill-options')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
  });
});
