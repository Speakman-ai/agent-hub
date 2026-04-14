/**
 * Test helpers — fixture factories and shared utilities.
 *
 * These helpers create test entities through the API (not raw DB inserts)
 * so validation, side effects, and computed fields behave exactly as in production.
 */

let _request;
let _app;

/**
 * Lazily import the app. Must be called AFTER setup.js has configured env vars.
 * Returns a supertest agent bound to the Express app.
 */
export async function getRequest() {
  if (!_request) {
    const supertest = (await import('supertest')).default;
    const { app } = await import('../index.js');
    _app = app;
    _request = supertest(app);
  }
  return _request;
}

/** Return the raw Express app (useful for WebSocket tests). */
export async function getApp() {
  if (!_app) await getRequest();
  return _app;
}

// ─── Fixture factories ──────────────────────────────────────────

let _counter = 0;
function uid(prefix = 'test') {
  return `${prefix}-${Date.now()}-${++_counter}`;
}

/**
 * Create a test project via POST /api/projects.
 * Returns the created project object.
 */
export async function createProject(overrides = {}) {
  const request = await getRequest();
  const id = overrides.id || uid('proj');
  const res = await request
    .post('/api/projects')
    .send({
      id,
      name: overrides.name || `Test Project ${id}`,
      cwd: overrides.cwd || '/tmp',
      color: overrides.color || '#3B82F6',
      ...overrides,
    })
    .expect(201);
  return res.body;
}

/**
 * Create a test agent under a project.
 * If no projectId is given, creates a project first.
 * Returns the created agent object.
 */
export async function createAgent(overrides = {}) {
  const request = await getRequest();
  let projectId = overrides.projectId;
  if (!projectId) {
    const project = await createProject();
    projectId = project.id;
  }
  const id = overrides.id || uid('agent');
  const res = await request
    .post('/api/agents')
    .send({
      id,
      projectId,
      name: overrides.name || `Test Agent ${id}`,
      engine: overrides.engine || 'claude-code',
      ...overrides,
    })
    .expect(201);
  return res.body;
}

/**
 * Create a test session for an agent.
 * If no agentId given, creates an agent (and project) first.
 * Returns the created session object.
 */
export async function createSession(overrides = {}) {
  const request = await getRequest();
  let agentId = overrides.agentId;
  if (!agentId) {
    const agent = await createAgent();
    agentId = agent.id;
  }
  const res = await request.post(`/api/agents/${agentId}/sessions`).send({
    name: overrides.name || `Test Session`,
    ...overrides,
  });
  return res.body;
}

/**
 * Create a wiki page for a project.
 * Returns the created page object.
 */
export async function createWikiPage(projectId, overrides = {}) {
  const request = await getRequest();
  const res = await request
    .post(`/api/projects/${projectId}/wiki`)
    .send({
      title: overrides.title || `Test Page ${uid('wiki')}`,
      content: overrides.content || '# Test\n\nTest content.',
      category: overrides.category || 'general',
      updatedBy: overrides.updatedBy || 'test-agent',
      ...overrides,
    })
    .expect(201);
  return res.body;
}

/**
 * Create a thread for a project.
 * Returns the created thread object.
 */
export async function createThread(projectId, overrides = {}) {
  const request = await getRequest();
  const res = await request
    .post(`/api/projects/${projectId}/threads`)
    .send({
      name: overrides.name || `Test Thread ${uid('thread')}`,
      type: overrides.type || 'cron',
      source_id: overrides.source_id || null,
      ...overrides,
    })
    .expect(201);
  return res.body;
}

/**
 * Create a kanban card for a project.
 * Gets board columns first, then creates a card in the first column.
 * Returns the created card object.
 */
export async function createCard(projectId, overrides = {}) {
  const request = await getRequest();

  // Get board to find a column ID
  let columnId = overrides.columnId;
  if (!columnId) {
    const boardRes = await request.get(`/api/projects/${projectId}/board`).expect(200);
    columnId = boardRes.body.columns[0]?.id;
    if (!columnId) throw new Error('No kanban columns found for project');
  }

  const res = await request
    .post(`/api/projects/${projectId}/board/cards`)
    .send({
      title: overrides.title || `Test Card ${uid('card')}`,
      description: overrides.description || 'Test card description',
      columnId,
      priority: overrides.priority || 'medium',
      ...overrides,
    })
    .expect(200);
  return res.body;
}
