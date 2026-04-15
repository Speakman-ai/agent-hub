import type supertest from 'supertest';
import {
  getRequest,
  createProject,
  createAgent,
  createSession,
  createWikiPage,
  createCard,
  createThread,
} from './helpers.js';

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
});

// ═══════════════════════════════════════════════════════════════════
// Health Check
// ═══════════════════════════════════════════════════════════════════

describe('GET /api/health', () => {
  it('returns status ok', async () => {
    const res = await request.get('/api/health').expect(200);
    expect(res.body.status).toBe('ok');
    expect(res.body).toHaveProperty('uptime');
    expect(res.body).toHaveProperty('projects');
    expect(res.body).toHaveProperty('agents');
  });

  it('returns version from package.json', async () => {
    const res = await request.get('/api/health').expect(200);
    expect(res.body.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Projects CRUD
// ═══════════════════════════════════════════════════════════════════

describe('Projects', () => {
  describe('POST /api/projects', () => {
    it('creates a project with valid data', async () => {
      const res = await request
        .post('/api/projects')
        .send({ id: 'test-proj-1', name: 'Test Project', cwd: '/tmp', color: '#FF0000' })
        .expect(201);

      expect(res.body.id).toBe('test-proj-1');
      expect(res.body.name).toBe('Test Project');
      expect(res.body.color).toBe('#FF0000');
      expect(res.body.agents).toEqual([]);
    });

    it('rejects invalid project ID', async () => {
      await request.post('/api/projects').send({ id: 'invalid id!', name: 'Bad' }).expect(400);
    });

    it('rejects duplicate project ID', async () => {
      const proj = await createProject();
      await request.post('/api/projects').send({ id: proj.id, name: 'Duplicate' }).expect(409);
    });

    it('creates project with commands', async () => {
      const res = await request
        .post('/api/projects')
        .send({
          id: 'proj-with-cmds',
          name: 'Cmds Project',
          cwd: '/tmp',
          commands: {
            install: 'npm install',
            build: 'npm run build',
            test: 'npm test',
            lint: 'npm run lint',
          },
        })
        .expect(201);

      expect(res.body.commands.install).toBe('npm install');
      expect(res.body.commands.test).toBe('npm test');
    });
  });

  describe('GET /api/projects', () => {
    it('lists all projects', async () => {
      const res = await request.get('/api/projects').expect(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('GET /api/projects/:projectId', () => {
    it('returns a project by ID', async () => {
      const proj = await createProject();
      const res = await request.get(`/api/projects/${proj.id}`).expect(200);
      expect(res.body.id).toBe(proj.id);
    });

    it('returns 404 for missing project', async () => {
      await request.get('/api/projects/nonexistent-xyz').expect(404);
    });
  });

  describe('PATCH /api/projects/:projectId', () => {
    it('updates project name and color', async () => {
      const proj = await createProject();
      const res = await request
        .patch(`/api/projects/${proj.id}`)
        .send({ name: 'Updated Name', color: '#00FF00' })
        .expect(200);

      expect(res.body.name).toBe('Updated Name');
      expect(res.body.color).toBe('#00FF00');
    });

    it('updates githubWorkflow settings', async () => {
      const proj = await createProject();
      const res = await request
        .patch(`/api/projects/${proj.id}`)
        .send({ githubWorkflow: { autoMerge: true, waitForCI: true } })
        .expect(200);

      expect(res.body.githubWorkflow.autoMerge).toBe(true);
      expect(res.body.githubWorkflow.waitForCI).toBe(true);
    });

    it('returns 404 for nonexistent project', async () => {
      await request.patch('/api/projects/does-not-exist').send({ name: 'Nope' }).expect(404);
    });
  });

  describe('DELETE /api/projects/:projectId', () => {
    it('deletes a project', async () => {
      const proj = await createProject();
      await request.delete(`/api/projects/${proj.id}`).expect(204);
      await request.get(`/api/projects/${proj.id}`).expect(404);
    });

    it('returns 404 for nonexistent project', async () => {
      await request.delete('/api/projects/does-not-exist').expect(404);
    });

    it('cleans up associated wiki, board, and thread data', async () => {
      const proj = await createProject();

      await createWikiPage(proj.id as string, { title: 'Cleanup Test' });
      await createCard(proj.id as string, { title: 'Cleanup Card' });
      await createThread(proj.id as string, { name: 'Cleanup Thread' });

      await request.get(`/api/projects/${proj.id}/wiki`).expect(200);
      const boardRes = await request.get(`/api/projects/${proj.id}/board`).expect(200);
      expect(boardRes.body.cards.length).toBeGreaterThan(0);

      await request.delete(`/api/projects/${proj.id}`).expect(204);

      await request.get(`/api/projects/${proj.id}/wiki`).expect(404);
      await request.get(`/api/projects/${proj.id}/board`).expect(404);
      await request.get(`/api/projects/${proj.id}/threads`).expect(404);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// Agents CRUD
// ═══════════════════════════════════════════════════════════════════

describe('Agents', () => {
  describe('POST /api/agents', () => {
    it('creates an agent under a project', async () => {
      const proj = await createProject();
      const res = await request
        .post('/api/agents')
        .send({ id: 'test-agent-1', projectId: proj.id, name: 'Test Agent', engine: 'claude-code' })
        .expect(201);

      expect(res.body.id).toBe('test-agent-1');
      expect(res.body.name).toBe('Test Agent');
      expect(res.body.engine).toBe('claude-code');
    });

    it('rejects agent without projectId', async () => {
      await request
        .post('/api/agents')
        .send({ id: 'orphan-agent', name: 'No Project' })
        .expect(400);
    });

    it('rejects invalid agent ID', async () => {
      const proj = await createProject();
      await request.post('/api/agents').send({ id: 'bad id!', projectId: proj.id }).expect(400);
    });

    it('rejects duplicate agent ID', async () => {
      const agent = await createAgent();
      const proj = await createProject();
      await request.post('/api/agents').send({ id: agent.id, projectId: proj.id }).expect(409);
    });
  });

  describe('GET /api/agents', () => {
    it('lists all agents with enriched data', async () => {
      await createAgent();
      const res = await request.get('/api/agents').expect(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThanOrEqual(1);
      expect(res.body[0]).toHaveProperty('lastActivity');
    });
  });

  describe('PATCH /api/agents/:agentId', () => {
    it('updates agent name and engine', async () => {
      const agent = await createAgent();
      const res = await request
        .patch(`/api/agents/${agent.id}`)
        .send({ name: 'Renamed Agent', engine: 'cursor-agent' })
        .expect(200);

      expect(res.body.name).toBe('Renamed Agent');
      expect(res.body.engine).toBe('cursor-agent');
    });

    it('returns 404 for nonexistent agent', async () => {
      await request.patch('/api/agents/nope').send({ name: 'X' }).expect(404);
    });
  });

  describe('DELETE /api/agents/:agentId', () => {
    it('deletes an agent', async () => {
      const agent = await createAgent();
      await request.delete(`/api/agents/${agent.id}`).expect(204);
    });

    it('returns 404 for nonexistent agent', async () => {
      await request.delete('/api/agents/nope').expect(404);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// Sessions
// ═══════════════════════════════════════════════════════════════════

describe('Sessions', () => {
  describe('POST /api/agents/:agentId/sessions', () => {
    it('creates a session for an agent', async () => {
      const agent = await createAgent();
      const res = await request
        .post(`/api/agents/${agent.id}/sessions`)
        .send({ name: 'My Session' });

      expect(res.body).toHaveProperty('id');
      expect(res.body.agent_id).toBe(agent.id);
      expect(res.body.name).toBe('My Session');
    });
  });

  describe('GET /api/agents/:agentId/sessions', () => {
    it('lists sessions for an agent', async () => {
      const agent = await createAgent();
      await createSession({ agentId: agent.id as string, name: 'S1' });
      await createSession({ agentId: agent.id as string, name: 'S2' });

      const res = await request.get(`/api/agents/${agent.id}/sessions`).expect(200);
      expect(res.body.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('GET /api/sessions/:sessionId/messages', () => {
    it('returns empty messages for new session', async () => {
      const session = await createSession();
      const res = await request.get(`/api/sessions/${session.id}/messages`).expect(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBe(0);
    });
  });

  describe('PATCH /api/sessions/:sessionId', () => {
    it('renames a session', async () => {
      const session = await createSession();
      const res = await request
        .patch(`/api/sessions/${session.id}`)
        .send({ name: 'Renamed Session' })
        .expect(200);

      expect(res.body.name).toBe('Renamed Session');
    });
  });

  describe('PUT /api/sessions/:sessionId/engine', () => {
    it('switches session engine', async () => {
      const session = await createSession();
      const res = await request
        .put(`/api/sessions/${session.id}/engine`)
        .send({ engine: 'cursor-agent' })
        .expect(200);

      expect(res.body.engine).toBe('cursor-agent');
    });

    it('rejects invalid engine', async () => {
      const session = await createSession();
      await request
        .put(`/api/sessions/${session.id}/engine`)
        .send({ engine: 'invalid-engine' })
        .expect(400);
    });
  });

  describe('DELETE /api/sessions/:sessionId', () => {
    it('deletes a session', async () => {
      const session = await createSession();
      await request.delete(`/api/sessions/${session.id}`).expect(200);
      const res = await request.get(`/api/sessions/${session.id}/messages`).expect(200);
      expect(res.body).toEqual([]);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// Kanban Board
// ═══════════════════════════════════════════════════════════════════

describe('Kanban Board', () => {
  let testProject: Record<string, unknown>;

  beforeAll(async () => {
    testProject = await createProject();
  });

  describe('GET /api/projects/:projectId/board', () => {
    it('returns board with default columns', async () => {
      const res = await request.get(`/api/projects/${testProject.id}/board`).expect(200);
      expect(res.body).toHaveProperty('columns');
      expect(Array.isArray(res.body.columns)).toBe(true);
      expect(res.body.columns.length).toBe(5);
      const names = (res.body.columns as Array<{ name: string }>).map((c) => c.name);
      expect(names).toContain('Backlog');
      expect(names).toContain('Done');
    });
  });

  describe('Cards CRUD', () => {
    it('creates a card', async () => {
      const card = await createCard(testProject.id as string, {
        title: 'Test Task',
        priority: 'high',
      });
      expect(card.title).toBe('Test Task');
      expect(card.priority).toBe('high');
      expect(card).toHaveProperty('id');
    });

    it('lists cards for a project', async () => {
      await createCard(testProject.id as string);
      const res = await request.get(`/api/projects/${testProject.id}/board/cards`).expect(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThanOrEqual(1);
    });

    it('updates a card', async () => {
      const card = await createCard(testProject.id as string);
      const res = await request
        .put(`/api/projects/${testProject.id}/board/cards/${card.id}`)
        .send({ title: 'Updated Title', priority: 'urgent' })
        .expect(200);

      expect(res.body.title).toBe('Updated Title');
      expect(res.body.priority).toBe('urgent');
    });

    it('moves a card between columns', async () => {
      const card = await createCard(testProject.id as string);
      const boardRes = await request.get(`/api/projects/${testProject.id}/board`).expect(200);
      const doneCol = (boardRes.body.columns as Array<{ id: string; name: string }>).find(
        (c) => c.name === 'Done',
      )!;

      const res = await request
        .post(`/api/projects/${testProject.id}/board/cards/${card.id}/move`)
        .send({ columnId: doneCol.id })
        .expect(200);

      expect(res.body.column_id).toBe(doneCol.id);
    });

    it('deletes a card', async () => {
      const card = await createCard(testProject.id as string);
      await request.delete(`/api/projects/${testProject.id}/board/cards/${card.id}`).expect(200);
    });
  });

  describe('Card Comments', () => {
    it('creates and lists comments on a card', async () => {
      const card = await createCard(testProject.id as string);

      const createRes = await request
        .post(`/api/projects/${testProject.id}/board/cards/${card.id}/comments`)
        .send({ author: 'test-agent', content: 'Working on this.' })
        .expect(200);

      expect(Array.isArray(createRes.body)).toBe(true);
      expect(createRes.body.length).toBe(1);
      expect(createRes.body[0].content).toBe('Working on this.');

      const res = await request
        .get(`/api/projects/${testProject.id}/board/cards/${card.id}/comments`)
        .expect(200);

      expect(res.body.length).toBe(1);
    });

    it('deletes a comment', async () => {
      const card = await createCard(testProject.id as string);
      const commentRes = await request
        .post(`/api/projects/${testProject.id}/board/cards/${card.id}/comments`)
        .send({ author: 'test', content: 'Delete me' })
        .expect(200);

      const commentId = (commentRes.body as Array<{ id: string }>)[0].id;
      await request
        .delete(`/api/projects/${testProject.id}/board/cards/${card.id}/comments/${commentId}`)
        .expect(200);
    });
  });

  describe('Epics', () => {
    it('creates and lists epics', async () => {
      const res = await request
        .post(`/api/projects/${testProject.id}/board/epics`)
        .send({ name: 'Test Epic', description: 'Epic description', color: '#3B82F6' })
        .expect(200);

      expect(res.body.name).toBe('Test Epic');
      expect(res.body).toHaveProperty('id');

      const listRes = await request.get(`/api/projects/${testProject.id}/board/epics`).expect(200);
      expect(listRes.body.length).toBeGreaterThanOrEqual(1);
    });

    it('links a card to an epic', async () => {
      const epicRes = await request
        .post(`/api/projects/${testProject.id}/board/epics`)
        .send({ name: 'Link Test', color: '#FF0000' })
        .expect(200);

      const card = await createCard(testProject.id as string);
      const res = await request
        .put(`/api/projects/${testProject.id}/board/cards/${card.id}`)
        .send({ epicId: epicRes.body.id })
        .expect(200);

      expect(res.body.epic_id).toBe(epicRes.body.id);
    });

    it('deletes an epic', async () => {
      const epicRes = await request
        .post(`/api/projects/${testProject.id}/board/epics`)
        .send({ name: 'Delete Me', color: '#FF0000' })
        .expect(200);

      await request
        .delete(`/api/projects/${testProject.id}/board/epics/${epicRes.body.id}`)
        .expect(200);
    });
  });

  describe('Columns', () => {
    it('creates a custom column', async () => {
      const res = await request
        .post(`/api/projects/${testProject.id}/board/columns`)
        .send({ name: 'QA' })
        .expect(200);

      expect(Array.isArray(res.body)).toBe(true);
      const qa = (res.body as Array<{ name: string }>).find((c) => c.name === 'QA');
      expect(qa).toBeDefined();
    });

    it('updates a column name', async () => {
      const createRes = await request
        .post(`/api/projects/${testProject.id}/board/columns`)
        .send({ name: 'Temp Col' })
        .expect(200);

      const tempCol = (
        createRes.body as Array<{ id: string; name: string; position: number }>
      ).find((c) => c.name === 'Temp Col')!;

      const res = await request
        .put(`/api/projects/${testProject.id}/board/columns/${tempCol.id}`)
        .send({ name: 'Renamed Col', position: tempCol.position })
        .expect(200);

      expect(res.body.ok).toBe(true);
    });

    it('deletes a column', async () => {
      const createRes = await request
        .post(`/api/projects/${testProject.id}/board/columns`)
        .send({ name: 'Delete Me Col' })
        .expect(200);

      const delCol = (createRes.body as Array<{ id: string; name: string }>).find(
        (c) => c.name === 'Delete Me Col',
      )!;

      await request
        .delete(`/api/projects/${testProject.id}/board/columns/${delCol.id}`)
        .expect(200);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// Wiki
// ═══════════════════════════════════════════════════════════════════

describe('Wiki', () => {
  let testProject: Record<string, unknown>;

  beforeAll(async () => {
    testProject = await createProject();
  });

  describe('POST /api/projects/:projectId/wiki', () => {
    it('creates a wiki page', async () => {
      const res = await request
        .post(`/api/projects/${testProject.id}/wiki`)
        .send({
          title: 'Getting Started',
          content: '# Getting Started\n\nWelcome!',
          category: 'onboarding',
          updatedBy: 'test-agent',
        })
        .expect(201);

      expect(res.body.title).toBe('Getting Started');
      expect(res.body.slug).toBe('getting-started');
      expect(res.body.category).toBe('onboarding');
    });

    it('rejects page without title', async () => {
      await request
        .post(`/api/projects/${testProject.id}/wiki`)
        .send({ content: 'No title' })
        .expect(400);
    });
  });

  describe('GET /api/projects/:projectId/wiki', () => {
    it('lists all wiki pages', async () => {
      await createWikiPage(testProject.id as string);
      const res = await request.get(`/api/projects/${testProject.id}/wiki`).expect(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThanOrEqual(1);
    });

    it('searches wiki pages by query', async () => {
      await createWikiPage(testProject.id as string, {
        title: 'Unique Search Term XYZ',
        content: 'Findable content',
      });
      const res = await request.get(`/api/projects/${testProject.id}/wiki?q=XYZ`).expect(200);

      expect(res.body.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('GET /api/projects/:projectId/wiki/:slug', () => {
    it('returns a wiki page by slug', async () => {
      const page = await createWikiPage(testProject.id as string, { title: 'Slug Test Page' });
      const res = await request
        .get(`/api/projects/${testProject.id}/wiki/${page.slug}`)
        .expect(200);

      expect(res.body.title).toBe('Slug Test Page');
      expect(res.body.content).toContain('Test');
    });

    it('returns 404 for nonexistent page', async () => {
      await request.get(`/api/projects/${testProject.id}/wiki/does-not-exist`).expect(404);
    });
  });

  describe('PUT /api/projects/:projectId/wiki/:slug', () => {
    it('updates a wiki page', async () => {
      const page = await createWikiPage(testProject.id as string, { title: 'Update Me' });
      const res = await request
        .put(`/api/projects/${testProject.id}/wiki/${page.slug}`)
        .send({ content: '# Updated Content', updatedBy: 'test-agent' })
        .expect(200);

      expect(res.body.content).toBe('# Updated Content');
    });
  });

  describe('DELETE /api/projects/:projectId/wiki/:slug', () => {
    it('deletes a wiki page', async () => {
      const page = await createWikiPage(testProject.id as string, { title: 'Delete Me' });
      await request.delete(`/api/projects/${testProject.id}/wiki/${page.slug}`).expect(200);

      await request.get(`/api/projects/${testProject.id}/wiki/${page.slug}`).expect(404);
    });
  });

  describe('GET /api/projects/:projectId/wiki/categories', () => {
    it('returns list of valid categories', async () => {
      const res = await request.get(`/api/projects/${testProject.id}/wiki/categories`).expect(200);

      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body).toContain('general');
      expect(res.body).toContain('api-docs');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// Webhooks
// ═══════════════════════════════════════════════════════════════════

describe('Webhooks', () => {
  describe('GET /api/webhooks', () => {
    it('lists all webhooks', async () => {
      const res = await request.get('/api/webhooks').expect(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });

  describe('CRUD lifecycle', () => {
    it('creates, lists, updates, and deletes a webhook', async () => {
      const proj = await createProject();

      const createRes = await request
        .post('/api/webhooks')
        .send({
          projectId: proj.id,
          repoUrl: 'https://github.com/test/repo',
          events: 'push,pull_request',
        })
        .expect(200);

      expect(createRes.body).toHaveProperty('id');
      const id = createRes.body.id as string;

      const listRes = await request.get(`/api/webhooks/project/${proj.id}`).expect(200);
      expect(listRes.body.length).toBeGreaterThanOrEqual(1);

      await request.put(`/api/webhooks/${id}`).send({ events: 'push' }).expect(200);

      await request.delete(`/api/webhooks/${id}`).expect(200);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// Crons
// ═══════════════════════════════════════════════════════════════════

describe('Crons', () => {
  describe('GET /api/crons', () => {
    it('lists all crons', async () => {
      const res = await request.get('/api/crons').expect(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });

  describe('CRUD lifecycle', () => {
    it('creates, updates, and deletes a cron', async () => {
      const createRes = await request
        .post('/api/crons')
        .send({ name: 'Test Cron', schedule: '0 * * * *', prompt: 'echo hello', cwd: '/tmp' })
        .expect(200);

      expect(createRes.body).toHaveProperty('id');
      const id = createRes.body.id as number;

      const updateRes = await request
        .put(`/api/crons/${id}`)
        .send({ name: 'Updated Cron', schedule: '*/5 * * * *' })
        .expect(200);
      expect(updateRes.body.name).toBe('Updated Cron');

      await request.get(`/api/crons/${id}/logs`).expect(200);

      await request.delete(`/api/crons/${id}`).expect(200);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// Heartbeats
// ═══════════════════════════════════════════════════════════════════

describe('Heartbeats', () => {
  describe('GET /api/heartbeats', () => {
    it('lists heartbeat configs', async () => {
      const res = await request.get('/api/heartbeats').expect(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });

  describe('GET /api/heartbeats/state', () => {
    it('returns heartbeat state', async () => {
      const res = await request.get('/api/heartbeats/state').expect(200);
      expect(typeof res.body).toBe('object');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// Conference Rooms
// ═══════════════════════════════════════════════════════════════════

describe('Rooms', () => {
  describe('GET /api/rooms', () => {
    it('lists all rooms', async () => {
      const res = await request.get('/api/rooms').expect(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });

  describe('CRUD lifecycle', () => {
    it('creates and gets a room', async () => {
      const createRes = await request.post('/api/rooms').send({ name: 'Test Room' }).expect(200);

      expect(createRes.body).toHaveProperty('id');
      const id = createRes.body.id as string;

      const getRes = await request.get(`/api/rooms/${id}`).expect(200);
      expect(getRes.body.name).toBe('Test Room');

      const updateRes = await request
        .patch(`/api/rooms/${id}`)
        .send({ name: 'Renamed Room' })
        .expect(200);
      expect(updateRes.body.name).toBe('Renamed Room');

      const msgRes = await request.get(`/api/rooms/${id}/messages`).expect(200);
      expect(Array.isArray(msgRes.body)).toBe(true);

      await request.delete(`/api/rooms/${id}`).expect(200);
    });
  });

  describe('Room agents', () => {
    it('adds and removes agents from a room', async () => {
      const room = await request.post('/api/rooms').send({ name: 'Agent Room' }).expect(200);
      const agent = await createAgent();

      await request
        .post(`/api/rooms/${room.body.id}/agents`)
        .send({ agentId: agent.id })
        .expect(200);

      const getRes = await request.get(`/api/rooms/${room.body.id}`).expect(200);
      expect((getRes.body.agents as Array<{ id: string }>).some((a) => a.id === agent.id)).toBe(
        true,
      );

      await request.delete(`/api/rooms/${room.body.id}/agents/${agent.id}`).expect(200);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// Skills Registry
// ═══════════════════════════════════════════════════════════════════

describe('Skills Registry', () => {
  describe('GET /api/skills/registry', () => {
    it('lists all registry skills', async () => {
      const res = await request.get('/api/skills/registry').expect(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });

  describe('CRUD lifecycle', () => {
    it('creates, gets, and deletes a registry skill', async () => {
      const createRes = await request
        .post('/api/skills/registry')
        .send({
          name: 'Test Skill',
          description: 'A test skill for testing',
          category: 'development',
          content: '# Test Skill\n\nDo testing things.',
        })
        .expect(201);

      expect(createRes.body).toHaveProperty('id');
      const id = createRes.body.id as string;

      const getRes = await request.get(`/api/skills/registry/${id}`).expect(200);
      expect(getRes.body.name).toBe('Test Skill');

      await request.delete(`/api/skills/registry/${id}`).expect(200);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// Config
// ═══════════════════════════════════════════════════════════════════

describe('Config', () => {
  describe('GET /api/config', () => {
    it('returns server configuration', async () => {
      const res = await request.get('/api/config').expect(200);
      expect(res.body).toHaveProperty('port');
      expect(res.body).toHaveProperty('authRequired');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// Device tokens
// ═══════════════════════════════════════════════════════════════════

describe('Device Tokens', () => {
  it('registers and unregisters a device token', async () => {
    await request
      .post('/api/devices')
      .send({ token: 'test-token-abc', platform: 'ios' })
      .expect(200);

    await request.delete('/api/devices/test-token-abc').expect(200);
  });

  it('rejects registration without token', async () => {
    await request.post('/api/devices').send({ platform: 'ios' }).expect(400);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Slack
// ═══════════════════════════════════════════════════════════════════

describe('Slack', () => {
  describe('GET /api/slack/status', () => {
    it('returns slack connection status', async () => {
      const res = await request.get('/api/slack/status').expect(200);
      expect(typeof res.body).toBe('object');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// Active Tasks
// ═══════════════════════════════════════════════════════════════════

describe('Active Tasks', () => {
  describe('GET /api/active-tasks', () => {
    it('returns active tasks list', async () => {
      const res = await request.get('/api/active-tasks').expect(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// Background Tasks
// ═══════════════════════════════════════════════════════════════════

describe('Background Tasks', () => {
  describe('GET /api/tasks', () => {
    it('returns task list', async () => {
      const res = await request.get('/api/tasks').expect(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });

  describe('GET /api/tasks/:taskId', () => {
    it('returns 404 for nonexistent task', async () => {
      await request.get('/api/tasks/nonexistent-task-id').expect(404);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// Usage
// ═══════════════════════════════════════════════════════════════════

describe('Usage', () => {
  describe('GET /api/usage', () => {
    it('returns usage statistics', async () => {
      const res = await request.get('/api/usage').expect(200);
      expect(res.body).toHaveProperty('totals');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// Setup
// ═══════════════════════════════════════════════════════════════════

describe('Setup', () => {
  describe('GET /api/setup/status', () => {
    it('returns setup status', async () => {
      const res = await request.get('/api/setup/status').expect(200);
      expect(res.body).toHaveProperty('firstRun');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// Session Queue & Delegations
// ═══════════════════════════════════════════════════════════════════

describe('Session Queue', () => {
  it('returns queue for a session', async () => {
    const session = await createSession();
    const res = await request.get(`/api/sessions/${session.id}/queue`).expect(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

describe('Delegations', () => {
  it('returns delegations for a session', async () => {
    const session = await createSession();
    const res = await request.get(`/api/sessions/${session.id}/delegations`).expect(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Threads
// ═══════════════════════════════════════════════════════════════════

describe('Threads', () => {
  let project: Record<string, unknown>;

  beforeAll(async () => {
    project = await createProject();
  });

  describe('POST /api/projects/:projectId/threads', () => {
    it('creates a cron thread', async () => {
      const res = await request
        .post(`/api/projects/${project.id}/threads`)
        .send({ name: 'Daily backup', type: 'cron', source_id: 'cron-123' })
        .expect(201);

      expect(res.body.id).toBeDefined();
      expect(res.body.name).toBe('Daily backup');
      expect(res.body.type).toBe('cron');
      expect(res.body.source_id).toBe('cron-123');
      expect(res.body.project_id).toBe(project.id);
      expect(res.body.created_at).toBeDefined();
    });

    it('creates a heartbeat thread', async () => {
      const res = await request
        .post(`/api/projects/${project.id}/threads`)
        .send({ name: 'Agent check-in', type: 'heartbeat' })
        .expect(201);

      expect(res.body.type).toBe('heartbeat');
    });

    it('rejects missing name', async () => {
      await request.post(`/api/projects/${project.id}/threads`).send({ type: 'cron' }).expect(400);
    });

    it('rejects invalid type', async () => {
      await request
        .post(`/api/projects/${project.id}/threads`)
        .send({ name: 'Bad', type: 'invalid' })
        .expect(400);
    });

    it('returns 404 for unknown project', async () => {
      await request
        .post('/api/projects/nonexistent/threads')
        .send({ name: 'Test', type: 'cron' })
        .expect(404);
    });
  });

  describe('GET /api/projects/:projectId/threads', () => {
    it('lists threads for a project', async () => {
      const proj = await createProject();
      await createThread(proj.id as string, { name: 'Thread A', type: 'cron' });
      await createThread(proj.id as string, { name: 'Thread B', type: 'heartbeat' });

      const res = await request.get(`/api/projects/${proj.id}/threads`).expect(200);
      expect(res.body.length).toBe(2);
    });

    it('filters by type', async () => {
      const proj = await createProject();
      await createThread(proj.id as string, { name: 'Cron 1', type: 'cron' });
      await createThread(proj.id as string, { name: 'HB 1', type: 'heartbeat' });

      const res = await request.get(`/api/projects/${proj.id}/threads?type=heartbeat`).expect(200);
      expect(res.body.length).toBe(1);
      expect(res.body[0].type).toBe('heartbeat');
    });
  });

  describe('GET /api/threads/:threadId', () => {
    it('returns a single thread', async () => {
      const thread = await createThread(project.id as string);
      const res = await request.get(`/api/threads/${thread.id}`).expect(200);
      expect(res.body.id).toBe(thread.id);
    });

    it('returns 404 for unknown thread', async () => {
      await request.get('/api/threads/nonexistent').expect(404);
    });
  });

  describe('DELETE /api/threads/:threadId', () => {
    it('deletes a thread', async () => {
      const thread = await createThread(project.id as string);
      await request.delete(`/api/threads/${thread.id}`).expect(200);
      await request.get(`/api/threads/${thread.id}`).expect(404);
    });

    it('returns 404 for unknown thread', async () => {
      await request.delete('/api/threads/nonexistent').expect(404);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// Thread Entries
// ═══════════════════════════════════════════════════════════════════

describe('Thread Entries', () => {
  let project: Record<string, unknown>;

  beforeAll(async () => {
    project = await createProject();
  });

  describe('POST /api/threads/:threadId/entries', () => {
    it('creates an entry', async () => {
      const thread = await createThread(project.id as string);
      const res = await request
        .post(`/api/threads/${thread.id}/entries`)
        .send({ content: 'Cron started' })
        .expect(201);

      expect(res.body.id).toBeDefined();
      expect(res.body.thread_id).toBe(thread.id);
      expect(res.body.content).toBe('Cron started');
      expect(res.body.timestamp).toBeDefined();
    });

    it('rejects missing content', async () => {
      const thread = await createThread(project.id as string);
      await request.post(`/api/threads/${thread.id}/entries`).send({}).expect(400);
    });

    it('returns 404 for unknown thread', async () => {
      await request.post('/api/threads/nonexistent/entries').send({ content: 'test' }).expect(404);
    });
  });

  describe('GET /api/threads/:threadId/entries', () => {
    it('lists entries in chronological order', async () => {
      const thread = await createThread(project.id as string);
      await request
        .post(`/api/threads/${thread.id}/entries`)
        .send({ content: 'First' })
        .expect(201);
      await request
        .post(`/api/threads/${thread.id}/entries`)
        .send({ content: 'Second' })
        .expect(201);

      const res = await request.get(`/api/threads/${thread.id}/entries`).expect(200);
      expect(res.body.length).toBe(2);
      expect(res.body[0].content).toBe('First');
      expect(res.body[1].content).toBe('Second');
    });

    it('returns 404 for unknown thread', async () => {
      await request.get('/api/threads/nonexistent/entries').expect(404);
    });
  });

  describe('cascade delete', () => {
    it('deleting a thread removes its entries', async () => {
      const thread = await createThread(project.id as string);
      await request
        .post(`/api/threads/${thread.id}/entries`)
        .send({ content: 'Will be deleted' })
        .expect(201);

      await request.delete(`/api/threads/${thread.id}`).expect(200);
      await request.get(`/api/threads/${thread.id}/entries`).expect(404);
    });
  });
});
