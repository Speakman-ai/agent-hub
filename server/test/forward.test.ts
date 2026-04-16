/**
 * Tests for POST /api/sessions/:sessionId/forward
 *
 * Validates the "Forward to agent" feature — routing conversation context
 * from one agent's session to a new session under a different agent.
 */

import './setup.js';
import { describe, it, expect, beforeAll } from 'vitest';
import { getRequest, createProject, createAgent, createSession } from './helpers.js';
import type TestAgent from 'supertest/lib/agent.js';

let request: TestAgent;

// Shared fixtures — two agents under the same project
let project: Record<string, unknown>;
let agentA: Record<string, unknown>;
let agentB: Record<string, unknown>;

beforeAll(async () => {
  request = await getRequest();
  project = await createProject({ id: 'fwd-proj', name: 'Forward Project', cwd: '/tmp' });
  agentA = await createAgent({
    projectId: project.id as string,
    id: 'agent-a',
    name: 'Agent Alpha',
  });
  agentB = await createAgent({
    projectId: project.id as string,
    id: 'agent-b',
    name: 'Agent Beta',
  });
});

/**
 * Seed a session with messages via direct DB access (supertest can't send
 * WebSocket chat messages, and POST endpoints don't exist for raw messages).
 */
async function createSessionWithMessages(
  agentId: string,
  messages: Array<{ role: string; content: string }>,
): Promise<{ session: Record<string, unknown>; messageIds: string[] }> {
  const session = await createSession({ agentId });

  const { stmts } = await import('../db.js');
  if (!stmts) throw new Error('stmts not initialized');
  const { v4: uuidv4 } = await import('uuid');

  const ids: string[] = [];
  for (const msg of messages) {
    const id = uuidv4();
    stmts.addMessage.run(id, session.id as string, msg.role, msg.content, null, null, null, null);
    ids.push(id);
  }

  return { session, messageIds: ids };
}

// ═══════════════════════════════════════════════════════════════════
// Forward to agent
// ═══════════════════════════════════════════════════════════════════

describe('POST /api/sessions/:sessionId/forward', () => {
  it('forwards all messages to a new session on the target agent', async () => {
    const { session: srcSession } = await createSessionWithMessages(agentA.id as string, [
      { role: 'user', content: 'Hello from the user' },
      { role: 'assistant', content: 'Hi, I am Agent Alpha' },
    ]);

    const res = await request
      .post(`/api/sessions/${srcSession.id}/forward`)
      .send({ targetAgentId: agentB.id })
      .expect(201);

    // Response shape
    expect(res.body).toHaveProperty('session');
    expect(res.body).toHaveProperty('forwardedMessageId');
    expect(res.body.session.agent_id).toBe(agentB.id);
    expect(res.body.session.name).toContain('[Fwd]');
    expect(res.body.session.name).toContain('Agent Alpha');

    // The new session should contain the forwarded message
    const msgRes = await request.get(`/api/sessions/${res.body.session.id}/messages`).expect(200);

    expect(msgRes.body).toHaveLength(1);
    expect(msgRes.body[0].role).toBe('user');
    expect(msgRes.body[0].content).toContain('Forwarded from session with Agent Alpha');
    expect(msgRes.body[0].content).toContain('Hello from the user');
    expect(msgRes.body[0].content).toContain('Hi, I am Agent Alpha');
  });

  it('forwards only selected messages when messageIds is provided', async () => {
    const { session: srcSession, messageIds } = await createSessionWithMessages(
      agentA.id as string,
      [
        { role: 'user', content: 'First message' },
        { role: 'assistant', content: 'First reply' },
        { role: 'user', content: 'Second message' },
        { role: 'assistant', content: 'Second reply' },
      ],
    );

    // Forward only the second exchange
    const res = await request
      .post(`/api/sessions/${srcSession.id}/forward`)
      .send({ targetAgentId: agentB.id, messageIds: [messageIds[2], messageIds[3]] })
      .expect(201);

    const msgRes = await request.get(`/api/sessions/${res.body.session.id}/messages`).expect(200);

    expect(msgRes.body[0].content).toContain('Second message');
    expect(msgRes.body[0].content).toContain('Second reply');
    expect(msgRes.body[0].content).not.toContain('First message');
  });

  it('prepends custom prompt when provided', async () => {
    const { session: srcSession } = await createSessionWithMessages(agentA.id as string, [
      { role: 'user', content: 'Some context' },
    ]);

    const res = await request
      .post(`/api/sessions/${srcSession.id}/forward`)
      .send({
        targetAgentId: agentB.id,
        prompt: 'Please review the following conversation and extract action items.',
      })
      .expect(201);

    const msgRes = await request.get(`/api/sessions/${res.body.session.id}/messages`).expect(200);

    // Prompt should appear before the forwarded context
    const content = msgRes.body[0].content as string;
    const promptIdx = content.indexOf('Please review the following');
    const forwardIdx = content.indexOf('Forwarded from session');
    expect(promptIdx).toBeLessThan(forwardIdx);
  });

  // ─── autoStart ─────────────────────────────────────────────────

  it('does not pre-store message when autoStart is true', async () => {
    const { session: srcSession } = await createSessionWithMessages(agentA.id as string, [
      { role: 'user', content: 'Auto-start test' },
    ]);

    const res = await request
      .post(`/api/sessions/${srcSession.id}/forward`)
      .send({ targetAgentId: agentB.id, autoStart: true })
      .expect(201);

    // forwardedMessageId should be null when autoStart is true
    // because handleChat stores the message itself
    expect(res.body.forwardedMessageId).toBeNull();

    // A new session should still be created
    expect(res.body.session).toBeDefined();
    expect(res.body.session.agent_id).toBe(agentB.id);
  });

  it('pre-stores message when autoStart is false', async () => {
    const { session: srcSession } = await createSessionWithMessages(agentA.id as string, [
      { role: 'user', content: 'No auto-start test' },
    ]);

    const res = await request
      .post(`/api/sessions/${srcSession.id}/forward`)
      .send({ targetAgentId: agentB.id, autoStart: false })
      .expect(201);

    // forwardedMessageId should be a valid UUID when not auto-starting
    expect(res.body.forwardedMessageId).toBeTruthy();

    // The message should be in the new session
    const msgRes = await request.get(`/api/sessions/${res.body.session.id}/messages`).expect(200);
    expect(msgRes.body).toHaveLength(1);
    expect(msgRes.body[0].id).toBe(res.body.forwardedMessageId);
  });

  // ─── Validation ────────────────────────────────────────────────

  it('returns 400 when targetAgentId is missing', async () => {
    const session = await createSession({ agentId: agentA.id as string });
    await request.post(`/api/sessions/${session.id}/forward`).send({}).expect(400);
  });

  it('returns 404 for non-existent source session', async () => {
    await request
      .post('/api/sessions/non-existent-session-id/forward')
      .send({ targetAgentId: agentB.id })
      .expect(404);
  });

  it('returns 404 for non-existent target agent', async () => {
    const { session: srcSession } = await createSessionWithMessages(agentA.id as string, [
      { role: 'user', content: 'test' },
    ]);
    await request
      .post(`/api/sessions/${srcSession.id}/forward`)
      .send({ targetAgentId: 'no-such-agent' })
      .expect(404);
  });

  it('returns 400 when source session has no messages', async () => {
    const emptySession = await createSession({ agentId: agentA.id as string });
    await request
      .post(`/api/sessions/${emptySession.id}/forward`)
      .send({ targetAgentId: agentB.id })
      .expect(400);
  });

  it('returns 400 when none of the specified messageIds match', async () => {
    const { session: srcSession } = await createSessionWithMessages(agentA.id as string, [
      { role: 'user', content: 'test' },
    ]);

    await request
      .post(`/api/sessions/${srcSession.id}/forward`)
      .send({ targetAgentId: agentB.id, messageIds: ['bogus-id-1', 'bogus-id-2'] })
      .expect(400);
  });

  // ─── Size / count guards ────────────────────────────────────────

  it('returns 400 when forwarded content exceeds size limit', async () => {
    // Create a session with a single very large message (~600 KB > 500 KB limit)
    const largeContent = 'x'.repeat(600_000);
    const { session: srcSession } = await createSessionWithMessages(agentA.id as string, [
      { role: 'user', content: largeContent },
    ]);

    const res = await request
      .post(`/api/sessions/${srcSession.id}/forward`)
      .send({ targetAgentId: agentB.id })
      .expect(400);

    expect(res.body.error).toMatch(/too large/i);
  });

  it('returns 400 when prompt exceeds max length', async () => {
    const { session: srcSession } = await createSessionWithMessages(agentA.id as string, [
      { role: 'user', content: 'test' },
    ]);

    await request
      .post(`/api/sessions/${srcSession.id}/forward`)
      .send({ targetAgentId: agentB.id, prompt: 'x'.repeat(50_001) })
      .expect(400);
  });

  // ─── Edge cases ────────────────────────────────────────────────

  it('can forward to the same agent (self-forward)', async () => {
    const { session: srcSession } = await createSessionWithMessages(agentA.id as string, [
      { role: 'user', content: 'Self-forward test' },
    ]);

    const res = await request
      .post(`/api/sessions/${srcSession.id}/forward`)
      .send({ targetAgentId: agentA.id })
      .expect(201);

    // Should create a DIFFERENT session even though same agent
    expect(res.body.session.id).not.toBe(srcSession.id);
    expect(res.body.session.agent_id).toBe(agentA.id);
  });

  it('session name is truncated for long agent names', async () => {
    const longNameAgent = await createAgent({
      projectId: project.id as string,
      id: 'agent-long-name',
      name: 'A'.repeat(120),
    });
    const { session: srcSession } = await createSessionWithMessages(agentA.id as string, [
      { role: 'user', content: 'test' },
    ]);

    const res = await request
      .post(`/api/sessions/${srcSession.id}/forward`)
      .send({ targetAgentId: longNameAgent.id })
      .expect(201);

    expect(res.body.session.name.length).toBeLessThanOrEqual(100);
  });
});
