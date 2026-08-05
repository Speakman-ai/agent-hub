/**
 * Tests for POST /api/sessions/:sessionId/follow-up
 *
 * The affordance behind `POST_FINALIZE_PUSH_LOCK_MESSAGE`: a session that has
 * pushed through Finalize is locked in ask mode, so one more code change needs
 * a new session. This route seeds that session with the end-of-run briefing —
 * including the follow-up steps the summary flagged — instead of leaving the
 * operator to rebuild the context by hand.
 */

import './setup.js';
import { describe, it, expect, beforeAll } from 'vitest';
import { getRequest, createProject, createAgent, createSession } from './helpers.js';
import type TestAgent from 'supertest/lib/agent.js';

let request: TestAgent;
let project: Record<string, unknown>;
let agentA: Record<string, unknown>;
let agentB: Record<string, unknown>;

beforeAll(async () => {
  request = await getRequest();
  project = await createProject({ id: 'followup-proj', name: 'Follow-up Project', cwd: '/tmp' });
  agentA = await createAgent({
    projectId: project.id as string,
    id: 'followup-agent-a',
    name: 'Agent Alpha',
  });
  agentB = await createAgent({
    projectId: project.id as string,
    id: 'followup-agent-b',
    name: 'Agent Beta',
  });
});

async function seedSession(
  agentId: string,
  messages: Array<{ role: string; content: string; metadata?: string | null }>,
  sessionName?: string,
): Promise<Record<string, unknown>> {
  const session = await createSession({ agentId, ...(sessionName ? { name: sessionName } : {}) });
  const { stmts } = await import('../db.js');
  if (!stmts) throw new Error('stmts not initialized');
  const { v4: uuidv4 } = await import('uuid');
  for (const msg of messages) {
    stmts.addMessage.run(
      uuidv4(),
      session.id as string,
      msg.role,
      msg.content,
      null,
      null,
      null,
      msg.metadata ?? null,
      null,
      null,
      null,
    );
  }
  return session;
}

function summaryMetadata(followUps: string[], runId = 'run-1'): string {
  return JSON.stringify({ kind: 'finalize_run_summary', runId, followUps });
}

async function seededContent(sessionId: string): Promise<string> {
  const res = await request.get(`/api/sessions/${sessionId}/messages`).expect(200);
  expect(res.body).toHaveLength(1);
  expect(res.body[0].role).toBe('user');
  return res.body[0].content as string;
}

describe('POST /api/sessions/:sessionId/follow-up', () => {
  it('defaults to the source agent and seeds the finalize summary + follow-up steps', async () => {
    const src = await seedSession(
      agentA.id as string,
      [
        { role: 'user', content: 'add the webhook' },
        {
          role: 'system',
          content: '## Finalize summary\n### Follow-ups\n- [ ] Run `npm run migrate` on prod',
          metadata: summaryMetadata(['Run `npm run migrate` on prod']),
        },
      ],
      'Add webhook retry',
    );

    const res = await request.post(`/api/sessions/${src.id}/follow-up`).send({}).expect(201);

    expect(res.body.session.agent_id).toBe(agentA.id);
    expect(res.body.session.name).toBe('[Follow-up] Add webhook retry');
    expect(res.body.seededMessageId).toBeTruthy();

    const content = await seededContent(res.body.session.id);
    expect(content).toContain('Follow-up steps flagged at the end of that session:');
    expect(content).toContain('- Run `npm run migrate` on prod');
    expect(content).toContain('Finalize summary from that session:');
    expect(content).toContain('NEW session on a fresh branch');
    // The transcript fallback must not fire when a summary exists.
    expect(content).not.toContain('add the webhook');
  });

  it('leads with the operator prompt', async () => {
    const src = await seedSession(agentA.id as string, [
      { role: 'system', content: '## Finalize summary', metadata: summaryMetadata([]) },
    ]);

    const res = await request
      .post(`/api/sessions/${src.id}/follow-up`)
      .send({ prompt: 'The migration command was wrong — fix it.' })
      .expect(201);

    const content = await seededContent(res.body.session.id);
    expect(content.indexOf('The migration command was wrong')).toBeLessThan(
      content.indexOf('--- Follow-up on'),
    );
  });

  it('falls back to the conversation tail when the session never finalized', async () => {
    const src = await seedSession(agentA.id as string, [
      { role: 'user', content: 'ship it by hand' },
      { role: 'assistant', content: 'done, pushed manually' },
    ]);

    const res = await request.post(`/api/sessions/${src.id}/follow-up`).send({}).expect(201);

    const content = await seededContent(res.body.session.id);
    expect(content).toContain('Recent conversation from that session:');
    expect(content).toContain('ship it by hand');
    expect(content).toContain('done, pushed manually');
  });

  it('honours an explicit target agent', async () => {
    const src = await seedSession(agentA.id as string, [{ role: 'user', content: 'hi' }]);

    const res = await request
      .post(`/api/sessions/${src.id}/follow-up`)
      .send({ targetAgentId: agentB.id })
      .expect(201);

    expect(res.body.session.agent_id).toBe(agentB.id);
    const content = await seededContent(res.body.session.id);
    // The frame still names where the work came from, not where it is going.
    expect(content).toContain('session with Agent Alpha');
  });

  // A session with zero messages is a legitimate state (created, never used).
  // Forward 400s on it; a follow-up still has the operator's prompt to carry,
  // so it must not.
  it('works on a session with no messages at all', async () => {
    const src = await createSession({ agentId: agentA.id as string });

    const res = await request
      .post(`/api/sessions/${src.id}/follow-up`)
      .send({ prompt: 'start over' })
      .expect(201);

    const content = await seededContent(res.body.session.id);
    expect(content).toContain('start over');
  });

  it('404s for an unknown source session', async () => {
    await request
      .post('/api/sessions/00000000-0000-0000-0000-000000000000/follow-up')
      .send({})
      .expect(404);
  });

  it('404s for an unknown target agent', async () => {
    const src = await seedSession(agentA.id as string, [{ role: 'user', content: 'hi' }]);
    const res = await request
      .post(`/api/sessions/${src.id}/follow-up`)
      .send({ targetAgentId: 'no-such-agent' })
      .expect(404);
    expect(res.body.error).toContain('no-such-agent');
  });

  it('400s on an over-long prompt', async () => {
    const src = await seedSession(agentA.id as string, [{ role: 'user', content: 'hi' }]);
    await request
      .post(`/api/sessions/${src.id}/follow-up`)
      .send({ prompt: 'x'.repeat(50_001) })
      .expect(400);
  });

  describe('body validation', () => {
    // The dangerous one: "false" is a truthy JS string. Coercing it would
    // dispatch a real CLI spawn the caller never asked for, so autoStart must
    // be a genuine boolean rather than anything merely truthy.
    it('rejects a stringified autoStart instead of treating it as truthy', async () => {
      const src = await seedSession(agentA.id as string, [{ role: 'user', content: 'hi' }]);
      const countSessions = async () =>
        (await request.get(`/api/agents/${agentA.id}/sessions`).expect(200)).body.length;
      const before = await countSessions();

      const res = await request
        .post(`/api/sessions/${src.id}/follow-up`)
        .send({ autoStart: 'false' })
        .expect(400);

      expect(res.body.error).toContain('autoStart');
      // Validation must reject before any write — a 400 that still leaves a
      // session (and, on the autoStart path, a spawned CLI) behind is the
      // failure this guards.
      expect(await countSessions()).toBe(before);
    });

    it('rejects a non-string targetAgentId rather than coercing it', async () => {
      const src = await seedSession(agentA.id as string, [{ role: 'user', content: 'hi' }]);
      const res = await request
        .post(`/api/sessions/${src.id}/follow-up`)
        .send({ targetAgentId: 42 })
        .expect(400);
      expect(res.body.error).toContain('targetAgentId');
    });

    it('rejects an empty-string targetAgentId instead of silently defaulting', async () => {
      const src = await seedSession(agentA.id as string, [{ role: 'user', content: 'hi' }]);
      await request
        .post(`/api/sessions/${src.id}/follow-up`)
        .send({ targetAgentId: '' })
        .expect(400);
    });

    it('rejects a non-string prompt', async () => {
      const src = await seedSession(agentA.id as string, [{ role: 'user', content: 'hi' }]);
      const res = await request
        .post(`/api/sessions/${src.id}/follow-up`)
        .send({ prompt: { text: 'nope' } })
        .expect(400);
      expect(res.body.error).toContain('prompt');
    });

    it('still accepts a real boolean autoStart', async () => {
      const src = await seedSession(agentA.id as string, [{ role: 'user', content: 'hi' }]);
      // autoStart:false is the pre-store path, so the seeded message is present.
      const res = await request
        .post(`/api/sessions/${src.id}/follow-up`)
        .send({ autoStart: false })
        .expect(201);
      expect(res.body.seededMessageId).toBeTruthy();
    });
  });

  // Two finalize runs in one session (a fix turn re-runs the pipeline). Seeding
  // the first run's steps would send the operator after a migration that was
  // already superseded.
  it('quotes the most recent finalize summary when a session finalized twice', async () => {
    const src = await seedSession(agentA.id as string, [
      {
        role: 'system',
        content: '## Finalize summary\nfirst run',
        metadata: summaryMetadata(['Run the old migration'], 'run-1'),
      },
      {
        role: 'system',
        content: '## Finalize summary\nsecond run',
        metadata: summaryMetadata(['Run the new migration'], 'run-2'),
      },
    ]);

    const res = await request.post(`/api/sessions/${src.id}/follow-up`).send({}).expect(201);

    const content = await seededContent(res.body.session.id);
    expect(content).toContain('- Run the new migration');
    expect(content).not.toContain('- Run the old migration');
    expect(content).toContain('second run');
  });
});
