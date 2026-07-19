import './setup.js';
import { describe, it, expect, beforeAll } from 'vitest';
import { getRequest, createAgent, createProject, createSession } from './helpers.js';
import { routeDeps } from '../index.js';
import type TestAgent from 'supertest/lib/agent.js';

let request: TestAgent;
let agentId: string;

/** Attach an isolated worktree to a session so design mode is permitted. */
function giveSessionWorktree(sessionId: string): void {
  routeDeps.stmts.updateSessionWorktreePath.run(
    `/tmp/agent-hub-test-wt-${sessionId.slice(0, 8)}`,
    `agent-hub/test/session-${sessionId.slice(0, 8)}`,
    sessionId,
  );
}

beforeAll(async () => {
  request = await getRequest();
  const agent = await createAgent({
    id: 'session-mode-route-agent',
    name: 'Session Mode Route Agent',
    engine: 'claude-code',
  });
  agentId = agent.id as string;
});

describe('PUT /api/sessions/:sessionId/mode', () => {
  it('defaults new sessions to chat mode', async () => {
    const session = await createSession({ agentId, name: 'mode-default' });
    const fetched = await request.get(`/api/sessions/${session.id}`).expect(200);
    expect(fetched.body.session_mode).toBe('chat');
  });

  it('returns 400 for an unknown mode', async () => {
    const session = await createSession({ agentId, name: 'mode-bad-body' });
    await request.put(`/api/sessions/${session.id}/mode`).send({ mode: 'deploy' }).expect(400);
  });

  it('returns 404 for an unknown session id', async () => {
    await request
      .put('/api/sessions/00000000-0000-4000-8000-0000000000aa/mode')
      .send({ mode: 'design' })
      .expect(404);
  });

  it('switches a session WITH a worktree to design mode and back to chat', async () => {
    const session = await createSession({ agentId, name: 'mode-toggle' });
    const sessionId = session.id as string;
    giveSessionWorktree(sessionId);

    const design = await request
      .put(`/api/sessions/${sessionId}/mode`)
      .send({ mode: 'design' })
      .expect(200);
    expect(design.body.session_mode).toBe('design');

    const chat = await request
      .put(`/api/sessions/${sessionId}/mode`)
      .send({ mode: 'chat' })
      .expect(200);
    expect(chat.body.session_mode).toBe('chat');
  });

  it('rejects design mode (400) for a session without an isolated worktree', async () => {
    const session = await createSession({ agentId, name: 'mode-no-worktree' });
    const sessionId = session.id as string;

    const res = await request
      .put(`/api/sessions/${sessionId}/mode`)
      .send({ mode: 'design' })
      .expect(400);
    expect(res.body.error).toBe('design_mode_requires_worktree');

    // The mode must NOT have been persisted — API/UI state stays `chat`.
    const fetched = await request.get(`/api/sessions/${sessionId}`).expect(200);
    expect(fetched.body.session_mode).toBe('chat');
  });

  it('allows chat mode on a session without a worktree', async () => {
    const session = await createSession({ agentId, name: 'mode-chat-no-worktree' });
    const sessionId = session.id as string;
    const res = await request
      .put(`/api/sessions/${sessionId}/mode`)
      .send({ mode: 'chat' })
      .expect(200);
    expect(res.body.session_mode).toBe('chat');
  });

  it('accepts design mode on a workflow (no-code) session WITHOUT a worktree', async () => {
    // Workflow projects never provision a worktree, but design artifacts go to
    // the data-dir store — so design mode is allowed and can_design_mode is true.
    const wfProject = await createProject({ name: 'WF Design', mode: 'workflow' });
    const wfAgent = await createAgent({
      name: 'WF Design Agent',
      projectId: wfProject.id as string,
      engine: 'claude-code',
    });
    const session = await createSession({
      agentId: wfAgent.id as string,
      name: 'wf-design',
    });
    const sessionId = session.id as string;

    const res = await request
      .put(`/api/sessions/${sessionId}/mode`)
      .send({ mode: 'design' })
      .expect(200);
    expect(res.body.session_mode).toBe('design');
    expect(res.body.can_design_mode).toBe(true);

    const fetched = await request.get(`/api/sessions/${sessionId}`).expect(200);
    expect(fetched.body.session_mode).toBe('design');
  });

  it('allows skill-builder mode on a dev agent session', async () => {
    const session = await createSession({ agentId, name: 'mode-skill-builder-dev' });
    const res = await request
      .put(`/api/sessions/${session.id}/mode`)
      .send({ mode: 'skill-builder' })
      .expect(200);
    expect(res.body.session_mode).toBe('skill-builder');
  });

  it.each(['consult', 'scoping', 'skill-builder'] as const)(
    'clears legacy ask and ship intent when switching to %s mode',
    async (mode) => {
      const session = await createSession({ agentId, name: `mode-clears-${mode}` });
      const sessionId = session.id as string;
      routeDeps.stmts.updateSessionAskMode.run(1, sessionId);
      routeDeps.stmts.updateSessionFinalizeAutomation.run('push', sessionId);

      const res = await request.put(`/api/sessions/${sessionId}/mode`).send({ mode }).expect(200);

      expect(res.body.session_mode).toBe(mode);
      expect(res.body.ask_mode).toBeFalsy();
      expect(res.body.finalize_automation).toBe('manual');
    },
  );
});

describe('skill-builder mode is rejected on helper agents', () => {
  it('PUT /mode 400s skill-builder for a docs helper and does not persist', async () => {
    const docs = await createAgent({
      id: 'session-mode-docs-helper',
      name: 'Docs Helper',
      role: 'docs',
      engine: 'claude-code',
    });
    const session = await createSession({ agentId: docs.id as string, name: 'docs-skill-builder' });

    const res = await request
      .put(`/api/sessions/${session.id}/mode`)
      .send({ mode: 'skill-builder' })
      .expect(400);
    expect(res.body.error).toBe('skill_builder_requires_dev_agent');

    const fetched = await request.get(`/api/sessions/${session.id}`).expect(200);
    expect(fetched.body.session_mode).toBe('chat');
  });

  it('PATCH session 400s skill-builder for a helper agent', async () => {
    const helper = await createAgent({
      id: 'session-mode-patch-helper',
      name: 'Docs Helper 2',
      role: 'docs',
      engine: 'claude-code',
    });
    const session = await createSession({
      agentId: helper.id as string,
      name: 'patch-helper-skill-builder',
    });

    const res = await request
      .patch(`/api/sessions/${session.id}`)
      .send({ session_mode: 'skill-builder' })
      .expect(400);
    expect(res.body.error).toBe('skill_builder_requires_dev_agent');

    const fetched = await request.get(`/api/sessions/${session.id}`).expect(200);
    expect(fetched.body.session_mode).toBe('chat');
  });
});
