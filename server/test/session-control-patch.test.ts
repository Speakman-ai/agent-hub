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
    id: 'session-control-patch-agent',
    name: 'Session Control Patch Agent',
    engine: 'claude-code',
  });
  agentId = agent.id as string;
});

/**
 * PATCH /api/sessions/:sessionId now applies session_mode + ask_mode +
 * finalize_automation in a single transaction. The session-mode picker relies on
 * this atomicity: entering Design from a ship level must reset ship intent AND
 * switch the mode all-or-nothing, so a failed worktree check cannot leave the
 * session with ship intent silently dropped (the bug the reviewer flagged).
 */
describe('PATCH /api/sessions/:sessionId — atomic multi-axis control change', () => {
  it('applies session_mode + ask_mode + finalize_automation together', async () => {
    const session = await createSession({ agentId, name: 'patch-multi' });
    const sessionId = session.id as string;
    giveSessionWorktree(sessionId);

    const res = await request
      .patch(`/api/sessions/${sessionId}`)
      .send({ session_mode: 'design', ask_mode: false, finalize_automation: 'manual' })
      .expect(200);
    expect(res.body.session_mode).toBe('design');
    expect(res.body.ask_mode).toBeFalsy();
    expect(res.body.finalize_automation).toBe('manual');
  });

  it('entering Design from merge+legacy ask clears ship intent and ask in one call', async () => {
    const session = await createSession({ agentId, name: 'patch-design-from-merge' });
    const sessionId = session.id as string;
    giveSessionWorktree(sessionId);
    // Seed ship intent + legacy ask flag (pre-Consult rows used ask_mode).
    await request
      .patch(`/api/sessions/${sessionId}`)
      .send({ finalize_automation: 'merge' })
      .expect(200);
    await request.put(`/api/sessions/${sessionId}/ask-mode`).send({ enabled: true }).expect(200);

    // One atomic patch flips to Design and clears both other axes.
    const res = await request
      .patch(`/api/sessions/${sessionId}`)
      .send({ session_mode: 'design', ask_mode: false, finalize_automation: 'manual' })
      .expect(200);
    expect(res.body.session_mode).toBe('design');
    expect(res.body.ask_mode).toBeFalsy();
    expect(res.body.finalize_automation).toBe('manual');
  });

  it('rejects the WHOLE patch (400) when design is requested without a worktree', async () => {
    const session = await createSession({ agentId, name: 'patch-no-worktree' });
    const sessionId = session.id as string;
    // Start from a known ship level so we can prove it is preserved on rejection.
    await request
      .patch(`/api/sessions/${sessionId}`)
      .send({ finalize_automation: 'merge' })
      .expect(200);

    const res = await request
      .patch(`/api/sessions/${sessionId}`)
      .send({ session_mode: 'design', ask_mode: false, finalize_automation: 'manual' })
      .expect(400);
    expect(res.body.error).toBe('design_mode_requires_worktree');

    // Atomicity: NOTHING was mutated — ship intent and mode are unchanged, so the
    // user does not silently lose their merge intent on a failed mode switch.
    const fetched = await request.get(`/api/sessions/${sessionId}`).expect(200);
    expect(fetched.body.session_mode).toBe('chat');
    expect(fetched.body.finalize_automation).toBe('merge');
  });

  it('still supports single-field patches (finalize_automation only)', async () => {
    const session = await createSession({ agentId, name: 'patch-single' });
    const sessionId = session.id as string;
    const res = await request
      .patch(`/api/sessions/${sessionId}`)
      .send({ finalize_automation: 'push' })
      .expect(200);
    expect(res.body.finalize_automation).toBe('push');
  });

  it('atomically leaves legacy Ask and arms review automation', async () => {
    const session = await createSession({ agentId, name: 'patch-legacy-ask-to-review' });
    const sessionId = session.id as string;
    routeDeps.stmts.updateSessionAskMode.run(1, sessionId);

    const res = await request
      .patch(`/api/sessions/${sessionId}`)
      .send({ ask_mode: false, finalize_automation: 'review' })
      .expect(200);

    expect(res.body.session_mode).toBe('chat');
    expect(res.body.ask_mode).toBeFalsy();
    expect(res.body.finalize_automation).toBe('review');
  });

  it('translates ask_mode:true on PATCH to Consult for legacy clients', async () => {
    const session = await createSession({ agentId, name: 'patch-ask-compat' });
    const sessionId = session.id as string;
    await request
      .patch(`/api/sessions/${sessionId}`)
      .send({ finalize_automation: 'merge' })
      .expect(200);

    const res = await request
      .patch(`/api/sessions/${sessionId}`)
      .send({ ask_mode: true })
      .expect(200);
    expect(res.body.session_mode).toBe('consult');
    expect(res.body.ask_mode).toBeFalsy();
    expect(res.body.finalize_automation).toBe('manual');
  });

  it('aliases PUT ask-mode to Consult/chat while clearing the legacy flag and ship intent', async () => {
    const session = await createSession({ agentId, name: 'put-ask-compat' });
    const sessionId = session.id as string;
    await request
      .patch(`/api/sessions/${sessionId}`)
      .send({ finalize_automation: 'push' })
      .expect(200);

    const enabled = await request
      .put(`/api/sessions/${sessionId}/ask-mode`)
      .send({ enabled: true })
      .expect(200);
    expect(enabled.body.session_mode).toBe('consult');
    expect(enabled.body.ask_mode).toBeFalsy();
    expect(enabled.body.finalize_automation).toBe('manual');

    const disabled = await request
      .put(`/api/sessions/${sessionId}/ask-mode`)
      .send({ enabled: false })
      .expect(200);
    expect(disabled.body.session_mode).toBe('chat');
    expect(disabled.body.ask_mode).toBeFalsy();
    expect(disabled.body.finalize_automation).toBe('manual');
  });

  it('allows session_mode consult on dev project sessions', async () => {
    const session = await createSession({ agentId, name: 'patch-consult-dev' });
    const sessionId = session.id as string;
    const res = await request
      .patch(`/api/sessions/${sessionId}`)
      .send({ session_mode: 'consult', finalize_automation: 'manual' })
      .expect(200);
    expect(res.body.session_mode).toBe('consult');
  });

  it('rejects hidden ship intent when PATCH enters Consult mode', async () => {
    const session = await createSession({ agentId, name: 'patch-consult-push' });
    const sessionId = session.id as string;
    const res = await request
      .patch(`/api/sessions/${sessionId}`)
      .send({ session_mode: 'consult', finalize_automation: 'push' })
      .expect(400);
    expect(res.body.error).toBe('finalize_not_allowed_in_session_mode');

    const fetched = await request.get(`/api/sessions/${sessionId}`).expect(200);
    expect(fetched.body.session_mode).toBe('chat');
    expect(fetched.body.finalize_automation).toBe('manual');
  });

  it('translates ask_mode:true on POST create to Consult for legacy clients', async () => {
    const res = await request
      .post(`/api/agents/${agentId}/sessions`)
      .send({ name: 'create-ask-compat', ask_mode: true })
      .expect(200);
    expect(res.body.session_mode).toBe('consult');
    expect(res.body.ask_mode).toBeFalsy();
  });

  it('rejects switching a workflow project session back to chat mode', async () => {
    const workflowId = `workflow-session-mode-guard-${Date.now()}`;
    const project = await createProject({
      id: workflowId,
      name: 'Workflow Session Mode Guard',
      mode: 'workflow',
    });
    const workflowAgent = await createAgent({
      projectId: project.id as string,
      name: 'Workflow Guard Agent',
      engine: 'claude-code',
    });
    const session = await createSession({
      agentId: workflowAgent.id as string,
      name: 'workflow-default-consult',
    });
    expect(session.session_mode).toBe('consult');

    const res = await request
      .patch(`/api/sessions/${session.id}`)
      .send({ session_mode: 'chat' })
      .expect(400);
    expect(res.body.error).toBe('session_mode_not_allowed_on_workflow_project');

    const fetched = await request.get(`/api/sessions/${session.id}`).expect(200);
    expect(fetched.body.session_mode).toBe('consult');

    const disabled = await request
      .put(`/api/sessions/${session.id}/ask-mode`)
      .send({ enabled: false })
      .expect(200);
    expect(disabled.body.session_mode).toBe('scoping');
    expect(disabled.body.ask_mode).toBeFalsy();
  });

  it('creates dev sessions in consult mode when session_mode consult is sent', async () => {
    const res = await request
      .post(`/api/agents/${agentId}/sessions`)
      .send({ name: 'create-consult', session_mode: 'consult' })
      .expect(200);
    expect(res.body.session_mode).toBe('consult');
  });

  it.each(['scoping', 'skill-builder'] as const)(
    'creates dev sessions in %s mode when requested',
    async (sessionMode) => {
      const res = await request
        .post(`/api/agents/${agentId}/sessions`)
        .send({ name: `create-${sessionMode}`, session_mode: sessionMode })
        .expect(200);
      expect(res.body.session_mode).toBe(sessionMode);
    },
  );

  it('rejects create-time design mode until a worktree exists', async () => {
    const res = await request
      .post(`/api/agents/${agentId}/sessions`)
      .send({ name: 'create-design', session_mode: 'design' })
      .expect(400);
    expect(res.body.error).toBe('design_mode_requires_worktree');
  });
});
