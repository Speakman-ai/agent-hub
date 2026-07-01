/**
 * Skill credential REST — Vitest integration (real orgs.db + auth wiring).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { tmpdir } from 'os';
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import path from 'path';

vi.mock('../secret-crypto.js', () => ({
  encryptSecret(s: string) {
    return Buffer.from(s, 'utf8').toString('base64url');
  },
  decryptSecret(s: string) {
    return Buffer.from(s, 'base64url').toString('utf8');
  },
}));

var _skillCredTestRoot = '';
var _skillCredApiKeyOverride: string | null = null;

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js');
  const base = actual.default;
  return {
    default: new Proxy(base, {
      get(t, prop, recv) {
        if (prop === 'dataDir') return _skillCredTestRoot || Reflect.get(t, 'dataDir', recv);
        if (prop === 'projectsDir')
          return _skillCredTestRoot
            ? path.join(_skillCredTestRoot, 'persist', 'projects')
            : Reflect.get(t, 'projectsDir', recv);
        if (prop === 'apiKey')
          return _skillCredApiKeyOverride !== null
            ? _skillCredApiKeyOverride
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

/** Hydrates `project.ahw` via `persist/projects/<projectId>/` — required for PUT schema resolution. */
function registerMinimalAgentProject(agentId = 'cred-agent'): void {
  const repo = path.join(_skillCredTestRoot, 'repo');
  mkdirSync(repo, { recursive: true });
  writeFileSync(
    path.join(_skillCredTestRoot, 'projects.json'),
    JSON.stringify([
      {
        id: 'p-cred',
        name: 'Cred',
        cwd: repo,
        agents: [{ id: agentId, name: 'Bot', engine: 'claude-code', cwd: repo }],
      },
    ]) + '\n',
    'utf8',
  );
  reloadProjects(_skillCredTestRoot);
}

beforeEach(() => {
  _skillCredTestRoot = mkdtempSync(path.join(tmpdir(), 'skill-cred-test-'));
  _skillCredApiKeyOverride = null;
  mkdirSync(path.join(_skillCredTestRoot, 'persist', 'projects'), { recursive: true });
  writeFileSync(path.join(_skillCredTestRoot, 'projects.json'), '[]', 'utf8');
  reloadProjects(_skillCredTestRoot);

  setAuthFilePathForTests(path.join(_skillCredTestRoot, 'auth.json'));
  setOrgsDbPathForTests(path.join(_skillCredTestRoot, 'orgs.db'));
  initOrgsDb();
  updateOrg('default', { mode: 'remote' });
  reloadAuthRecord();
});

describe('/api/auth/me/skill-credentials', () => {
  it('returns 401 for api-key-only callers (no uid)', async () => {
    const app = buildGatedApp();
    _skillCredApiKeyOverride = 'sekrit';
    const res = await supertest(app)
      .get('/api/auth/me/skill-credentials')
      .set('x-api-key', 'sekrit');
    expect(res.status).toBe(401);
  });

  it('PUT round-trips with masked GET and DELETE clears row', async () => {
    registerMinimalAgentProject('cred-agent');
    const app = buildGatedApp();
    const token = await setupOwner(app);

    const put = await supertest(app)
      .put('/api/auth/me/skill-credentials')
      .set('Authorization', `Bearer ${token}`)
      .send({
        skill_id: 'github',
        key_name: 'GH_TOKEN',
        value: 'ghp_integration_test_value_xx',
        agent_id: 'cred-agent',
      });
    expect(put.status).toBe(200);
    expect(put.body.credential.key_name).toBe('GH_TOKEN');
    expect(put.body.credential.masked_preview).toMatch(/^••••/);

    const listed = await supertest(app)
      .get('/api/auth/me/skill-credentials?skillId=github')
      .set('Authorization', `Bearer ${token}`);
    expect(listed.status).toBe(200);
    expect(listed.body.credentials).toHaveLength(1);

    const id = listed.body.credentials[0].id as string;

    await supertest(app)
      .delete(`/api/auth/me/skill-credentials/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const after = await supertest(app)
      .get('/api/auth/me/skill-credentials')
      .set('Authorization', `Bearer ${token}`);
    expect(after.body.credentials).toHaveLength(0);
  });

  it('accepts PUT for credential keys declared on a workspace-only skill', async () => {
    mkdirSync(path.join(_skillCredTestRoot, 'repo'), { recursive: true });
    const project = {
      id: 'p1',
      name: 'Proj',
      cwd: path.join(_skillCredTestRoot, 'repo'),
      agents: [
        {
          id: 'a1',
          name: 'Bot',
          engine: 'claude-code',
          cwd: path.join(_skillCredTestRoot, 'repo'),
        },
      ],
    };

    writeFileSync(
      path.join(_skillCredTestRoot, 'projects.json'),
      JSON.stringify([project]) + '\n',
      'utf8',
    );
    reloadProjects(_skillCredTestRoot);

    const ahw = path.join(_skillCredTestRoot, 'persist', 'projects', 'p1');
    const wsSkill = path.join(resolveProjectSkillsDir({ id: 'p1', ahw }), 'ws-only-skill');
    mkdirSync(wsSkill, { recursive: true });
    writeFileSync(
      path.join(wsSkill, 'SKILL.md'),
      `---
name: ws-only-skill
credentials:
  - name: WORKSPACE_SECRET
    label: Token
    required: true
    type: secret
---
`,
      'utf8',
    );

    const app = buildGatedApp();
    const token = await setupOwner(app);
    const put = await supertest(app)
      .put('/api/auth/me/skill-credentials')
      .set('Authorization', `Bearer ${token}`)
      .send({
        skill_id: 'ws-only-skill',
        key_name: 'WORKSPACE_SECRET',
        value: 'secret-from-worktree',
        agent_id: 'a1',
      });
    expect(put.status).toBe(200);
    expect(put.body.credential.key_name).toBe('WORKSPACE_SECRET');
  });

  it('noop on optional credential save with empty value when no stored row exists', async () => {
    registerMinimalAgentProject('cred-agent');
    const app = buildGatedApp();
    const token = await setupOwner(app);
    const put = await supertest(app)
      .put('/api/auth/me/skill-credentials')
      .set('Authorization', `Bearer ${token}`)
      .send({
        skill_id: 'github',
        key_name: 'GH_TOKEN',
        value: '   ',
        agent_id: 'cred-agent',
      });
    expect(put.status).toBe(200);
    expect(put.body.skipped).toBe(true);
    expect(put.body.credential).toBeNull();

    const listed = await supertest(app)
      .get('/api/auth/me/skill-credentials?skillId=github')
      .set('Authorization', `Bearer ${token}`);
    expect(listed.body.credentials).toHaveLength(0);
  });

  it('clears optional credential when PUT with empty value and a row exists', async () => {
    registerMinimalAgentProject('cred-agent');
    const app = buildGatedApp();
    const token = await setupOwner(app);

    await supertest(app)
      .put('/api/auth/me/skill-credentials')
      .set('Authorization', `Bearer ${token}`)
      .send({
        skill_id: 'github',
        key_name: 'GH_TOKEN',
        value: 'ghp_clear_me',
        agent_id: 'cred-agent',
      })
      .expect(200);

    const clear = await supertest(app)
      .put('/api/auth/me/skill-credentials')
      .set('Authorization', `Bearer ${token}`)
      .send({
        skill_id: 'github',
        key_name: 'GH_TOKEN',
        value: '',
        agent_id: 'cred-agent',
      });
    expect(clear.status).toBe(200);
    expect(clear.body.cleared).toBe(true);
    expect(clear.body.credential).toBeNull();

    const listed = await supertest(app)
      .get('/api/auth/me/skill-credentials?skillId=github')
      .set('Authorization', `Bearer ${token}`);
    expect(listed.body.credentials).toHaveLength(0);
  });

  it('rejects PUT for unknown credential key names', async () => {
    registerMinimalAgentProject('cred-agent');
    const app = buildGatedApp();
    const token = await setupOwner(app);
    const put = await supertest(app)
      .put('/api/auth/me/skill-credentials')
      .set('Authorization', `Bearer ${token}`)
      .send({
        skill_id: 'github',
        key_name: 'NOT_A_REAL_KEY',
        value: 'x',
        agent_id: 'cred-agent',
      });
    expect(put.status).toBe(400);
  });

  it('accepts PUT without agent_id for bundled default skills (Account page flow)', async () => {
    // No project is registered — the Account page personal-credentials
    // section operates without a project context. The skill schema must
    // resolve from `server/default-skills/<skillId>/SKILL.md` alone.
    const app = buildGatedApp();
    const token = await setupOwner(app);
    const put = await supertest(app)
      .put('/api/auth/me/skill-credentials')
      .set('Authorization', `Bearer ${token}`)
      .send({
        skill_id: 'linear',
        key_name: 'LINEAR_API_KEY',
        value: 'lin_api_personal_test_xx',
      });
    expect(put.status).toBe(200);
    expect(put.body.credential.skill_id).toBe('linear');
    expect(put.body.credential.key_name).toBe('LINEAR_API_KEY');
    expect(put.body.credential.masked_preview).toMatch(/^••••/);

    const listed = await supertest(app)
      .get('/api/auth/me/skill-credentials?skillId=linear')
      .set('Authorization', `Bearer ${token}`);
    expect(listed.status).toBe(200);
    expect(listed.body.credentials).toHaveLength(1);
    expect(listed.body.credentials[0].key_name).toBe('LINEAR_API_KEY');
  });

  it('rejects PUT without agent_id for an unknown skill that does not resolve from defaults', async () => {
    const app = buildGatedApp();
    const token = await setupOwner(app);
    const put = await supertest(app)
      .put('/api/auth/me/skill-credentials')
      .set('Authorization', `Bearer ${token}`)
      .send({
        skill_id: 'definitely-not-a-real-skill-xyz',
        key_name: 'WHATEVER',
        value: 'x',
      });
    // The schema resolver returns an empty credentials list when the skill
    // is unknown — the PUT handler then 400s with the "no credentials"
    // error rather than silently allowing arbitrary skill ids to seed rows.
    expect(put.status).toBe(400);
    expect(String(put.body.error)).toMatch(/no credentials|Unknown credential|invalid credential/i);
  });

  it('clears optional credential when PUT with empty value and a row exists (no agent_id)', async () => {
    const app = buildGatedApp();
    const token = await setupOwner(app);

    // Seed via the no-agent path.
    await supertest(app)
      .put('/api/auth/me/skill-credentials')
      .set('Authorization', `Bearer ${token}`)
      .send({
        skill_id: 'linear',
        key_name: 'LINEAR_API_KEY',
        value: 'lin_api_to_clear',
      })
      .expect(200);

    // Clear via the no-agent path.
    const clear = await supertest(app)
      .put('/api/auth/me/skill-credentials')
      .set('Authorization', `Bearer ${token}`)
      .send({
        skill_id: 'linear',
        key_name: 'LINEAR_API_KEY',
        value: '',
      });
    expect(clear.status).toBe(200);
    expect(clear.body.cleared).toBe(true);

    const listed = await supertest(app)
      .get('/api/auth/me/skill-credentials?skillId=linear')
      .set('Authorization', `Bearer ${token}`);
    expect(listed.body.credentials).toHaveLength(0);
  });

  it('still rejects PUT without skill_id', async () => {
    const app = buildGatedApp();
    const token = await setupOwner(app);
    const put = await supertest(app)
      .put('/api/auth/me/skill-credentials')
      .set('Authorization', `Bearer ${token}`)
      .send({
        key_name: 'LINEAR_API_KEY',
        value: 'x',
      });
    expect(put.status).toBe(400);
    expect(String(put.body.error)).toContain('skill_id');
  });

  it('rejects PUT for unknown agent_id', async () => {
    registerMinimalAgentProject('cred-agent');
    const app = buildGatedApp();
    const token = await setupOwner(app);
    const put = await supertest(app)
      .put('/api/auth/me/skill-credentials')
      .set('Authorization', `Bearer ${token}`)
      .send({
        skill_id: 'github',
        key_name: 'GH_TOKEN',
        value: 'x',
        agent_id: 'no-such-agent',
      });
    expect(put.status).toBe(404);
  });

  it('validates credential keys against the agent workspace, not another project', async () => {
    const repoA = path.join(_skillCredTestRoot, 'repo-a');
    const repoB = path.join(_skillCredTestRoot, 'repo-b');
    mkdirSync(repoA, { recursive: true });
    mkdirSync(repoB, { recursive: true });
    writeFileSync(
      path.join(_skillCredTestRoot, 'projects.json'),
      JSON.stringify([
        {
          id: 'p-alpha',
          name: 'Alpha',
          cwd: repoA,
          agents: [
            {
              id: 'alpha-a',
              name: 'A',
              engine: 'claude-code',
              cwd: repoA,
            },
          ],
        },
        {
          id: 'p-beta',
          name: 'Beta',
          cwd: repoB,
          agents: [
            {
              id: 'beta-a',
              name: 'B',
              engine: 'claude-code',
              cwd: repoB,
            },
          ],
        },
      ]) + '\n',
      'utf8',
    );
    reloadProjects(_skillCredTestRoot);

    const ahwA = path.join(_skillCredTestRoot, 'persist', 'projects', 'p-alpha');
    const ahwB = path.join(_skillCredTestRoot, 'persist', 'projects', 'p-beta');
    const dup = 'dup-skill';

    function writeDupSkill(projectId: string, ahwRoot: string, keyName: string) {
      const dir = path.join(resolveProjectSkillsDir({ id: projectId, ahw: ahwRoot }), dup);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        path.join(dir, 'SKILL.md'),
        `---
name: dup-skill
credentials:
  - name: ${keyName}
    label: Token
    required: false
    type: secret
---
`,
        'utf8',
      );
    }
    writeDupSkill('p-alpha', ahwA, 'KEY_ALPHA');
    writeDupSkill('p-beta', ahwB, 'KEY_BETA');

    const app = buildGatedApp();
    const token = await setupOwner(app);

    await supertest(app)
      .put('/api/auth/me/skill-credentials')
      .set('Authorization', `Bearer ${token}`)
      .send({
        skill_id: dup,
        key_name: 'KEY_ALPHA',
        value: 'va',
        agent_id: 'alpha-a',
      })
      .expect(200);

    const wrongKey = await supertest(app)
      .put('/api/auth/me/skill-credentials')
      .set('Authorization', `Bearer ${token}`)
      .send({
        skill_id: dup,
        key_name: 'KEY_BETA',
        value: 'vb',
        agent_id: 'alpha-a',
      });
    expect(wrongKey.status).toBe(400);

    await supertest(app)
      .put('/api/auth/me/skill-credentials')
      .set('Authorization', `Bearer ${token}`)
      .send({
        skill_id: dup,
        key_name: 'KEY_BETA',
        value: 'vb',
        agent_id: 'beta-a',
      })
      .expect(200);

    const wrongKeyBeta = await supertest(app)
      .put('/api/auth/me/skill-credentials')
      .set('Authorization', `Bearer ${token}`)
      .send({
        skill_id: dup,
        key_name: 'KEY_ALPHA',
        value: 'va2',
        agent_id: 'beta-a',
      });
    expect(wrongKeyBeta.status).toBe(400);
  });
});
