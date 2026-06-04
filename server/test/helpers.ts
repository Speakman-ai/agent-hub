import type { Express } from 'express';
import type supertest from 'supertest';

let _request: supertest.Agent | null = null;
let _app: Express | null = null;

export async function getRequest(): Promise<supertest.Agent> {
  if (!_request) {
    const st = (await import('supertest')).default;
    const { app } = await import('../index.js');
    _app = app;
    _request = st(app);
  }
  return _request;
}

export async function getApp(): Promise<Express> {
  if (!_app) await getRequest();
  return _app!;
}

// ─── Fixture factories ──────────────────────────────────────────

let _counter = 0;
function uid(prefix = 'test'): string {
  return `${prefix}-${Date.now()}-${++_counter}`;
}

interface ProjectOverrides {
  id?: string;
  name?: string;
  cwd?: string;
  color?: string;
  [key: string]: unknown;
}

export async function createProject(
  overrides: ProjectOverrides = {},
): Promise<Record<string, unknown>> {
  const request = await getRequest();
  const id = overrides.id ?? uid('proj');
  const res = await request
    .post('/api/projects')
    .send({
      id,
      name: overrides.name ?? `Test Project ${id}`,
      cwd: overrides.cwd ?? '/tmp',
      color: overrides.color ?? '#3B82F6',
      ...overrides,
    })
    .expect(201);
  return res.body as Record<string, unknown>;
}

interface AgentOverrides {
  id?: string;
  projectId?: string;
  name?: string;
  engine?: string;
  [key: string]: unknown;
}

export async function createAgent(
  overrides: AgentOverrides = {},
): Promise<Record<string, unknown>> {
  const request = await getRequest();
  let projectId = overrides.projectId;
  if (!projectId) {
    const project = await createProject();
    projectId = project.id as string;
  }
  const id = overrides.id ?? uid('agent');
  const res = await request
    .post('/api/agents')
    .send({
      id,
      projectId,
      name: overrides.name ?? `Test Agent ${id}`,
      engine: overrides.engine ?? 'claude-code',
      ...overrides,
    })
    .expect(201);
  return res.body as Record<string, unknown>;
}

interface SessionOverrides {
  agentId?: string;
  name?: string;
  [key: string]: unknown;
}

export async function createSession(
  overrides: SessionOverrides = {},
): Promise<Record<string, unknown>> {
  const request = await getRequest();
  let agentId = overrides.agentId;
  if (!agentId) {
    const agent = await createAgent();
    agentId = agent.id as string;
  }
  const res = await request.post(`/api/agents/${agentId}/sessions`).send({
    name: overrides.name ?? `Test Session`,
    ...overrides,
  });
  return res.body as Record<string, unknown>;
}

interface WikiPageOverrides {
  title?: string;
  content?: string;
  category?: string;
  updatedBy?: string;
  [key: string]: unknown;
}

export async function createWikiPage(
  projectId: string,
  overrides: WikiPageOverrides = {},
): Promise<Record<string, unknown>> {
  const request = await getRequest();
  const res = await request
    .post(`/api/projects/${projectId}/wiki`)
    .send({
      title: overrides.title ?? `Test Page ${uid('wiki')}`,
      content: overrides.content ?? '# Test\n\nTest content.',
      category: overrides.category ?? 'general',
      updatedBy: overrides.updatedBy ?? 'test-agent',
      ...overrides,
    })
    .expect(201);
  return res.body as Record<string, unknown>;
}

interface ThreadOverrides {
  name?: string;
  type?: string;
  source_id?: string | null;
  [key: string]: unknown;
}

export async function createThread(
  projectId: string,
  overrides: ThreadOverrides = {},
): Promise<Record<string, unknown>> {
  const request = await getRequest();
  const res = await request
    .post(`/api/projects/${projectId}/threads`)
    .send({
      name: overrides.name ?? `Test Thread ${uid('thread')}`,
      type: overrides.type ?? 'cron',
      source_id: overrides.source_id ?? null,
      ...overrides,
    })
    .expect(201);
  return res.body as Record<string, unknown>;
}

interface EscalationOverrides {
  type?: string;
  title?: string;
  description?: string;
  [key: string]: unknown;
}

export async function createEscalationHelper(
  projectId: string,
  overrides: EscalationOverrides = {},
): Promise<Record<string, unknown>> {
  const request = await getRequest();
  const res = await request
    .post(`/api/projects/${projectId}/escalations`)
    .send({
      type: overrides.type ?? 'blocker',
      title: overrides.title ?? `Test Escalation ${uid('esc')}`,
      description: overrides.description ?? 'Test escalation description',
      ...overrides,
    })
    .expect(201);
  return res.body as Record<string, unknown>;
}

interface NoteOverrides {
  title?: string;
  content?: string;
  [key: string]: unknown;
}

export async function createNote(
  projectId: string,
  overrides: NoteOverrides = {},
): Promise<Record<string, unknown>> {
  const request = await getRequest();
  const res = await request
    .post(`/api/projects/${projectId}/notes`)
    .send({
      title: overrides.title ?? `Test Note ${uid('note')}`,
      content: overrides.content ?? 'Some note content.',
      ...overrides,
    })
    .expect(201);
  return res.body as Record<string, unknown>;
}

interface CardOverrides {
  title?: string;
  description?: string;
  columnId?: string;
  priority?: string;
  [key: string]: unknown;
}

export async function createCard(
  projectId: string,
  overrides: CardOverrides = {},
): Promise<Record<string, unknown>> {
  const request = await getRequest();

  let columnId = overrides.columnId;
  if (!columnId) {
    const boardRes = await request.get(`/api/projects/${projectId}/board`).expect(200);
    const body = boardRes.body as { columns: Array<{ id: string }> };
    columnId = body.columns[0]?.id;
    if (!columnId) throw new Error('No kanban columns found for project');
  }

  const res = await request
    .post(`/api/projects/${projectId}/board/cards`)
    .send({
      title: overrides.title ?? `Test Card ${uid('card')}`,
      description: overrides.description ?? 'Test card description',
      columnId,
      priority: overrides.priority ?? 'medium',
      ...overrides,
    })
    .expect(200);
  return res.body as Record<string, unknown>;
}
