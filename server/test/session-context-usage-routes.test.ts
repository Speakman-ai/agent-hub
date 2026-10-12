/** GET /api/sessions/:id/context-usage */
import './setup.js';
import { describe, it, expect, beforeAll } from 'vitest';
import type TestAgent from 'supertest/lib/agent.js';
import { getRequest, createProject, createAgent, createSession } from './helpers.js';
import { getDb } from '../db.js';
import { recordContextTurn, recordReportedContext } from '../session-context-usage.js';

let request: TestAgent;
let agentId: string;

beforeAll(async () => {
  request = await getRequest();
  const project = await createProject({ id: 'ctx-usage-proj', name: 'Ctx', cwd: '/tmp' });
  const agent = await createAgent({ projectId: project.id as string, id: 'ctx-usage-agent' });
  agentId = agent.id as string;
});

describe('GET /api/sessions/:id/context-usage', () => {
  it('estimates from the transcript before any turn is recorded', async () => {
    const session = await createSession({ agentId, name: 'fresh' });
    const id = session.id as string;
    getDb()
      .prepare('INSERT INTO messages (id, session_id, role, content) VALUES (?, ?, ?, ?)')
      .run(`${id}-m1`, id, 'user', 'x'.repeat(400));
    const res = await request.get(`/api/sessions/${id}/context-usage`).expect(200);
    expect(res.body.source).toBe('estimated');
    expect(res.body.totalTokens).toBe(100);
    expect(res.body.categories).toEqual([
      { key: 'conversation', label: 'Conversation', tokens: 100 },
    ]);
  });

  it('returns the engine-reported breakdown after a turn', async () => {
    const session = await createSession({ agentId, name: 'claude' });
    const id = session.id as string;
    getDb()
      .prepare("UPDATE sessions SET engine = 'claude-code', model = 'opus' WHERE id = ?")
      .run(id);
    recordContextTurn(getDb(), id, {
      engine: 'claude-code',
      model: 'opus',
      systemPrompt: '# You are X\n\n## AGENTS.md\n' + 'a'.repeat(4000),
      userTurn: 'hello',
      freshEngineSession: true,
    });
    recordReportedContext(getDb(), id, 30_000);
    const res = await request.get(`/api/sessions/${id}/context-usage`).expect(200);
    expect(res.body.source).toBe('reported');
    expect(res.body.totalTokens).toBe(30_000);
    expect(res.body.contextWindow).toBe(200_000);
    expect(res.body.percent).toBe(15);
    const keys = res.body.categories.map((c: { key: string }) => c.key);
    expect(keys).toEqual(['system', 'rules', 'skills', 'wiki', 'memory', 'engine', 'conversation']);
  });

  it('404s for an unknown session', async () => {
    await request.get('/api/sessions/does-not-exist/context-usage').expect(404);
  });
});
