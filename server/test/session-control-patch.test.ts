import './setup.js';
import { describe, it, expect, beforeAll } from 'vitest';
import { getRequest, createAgent, createSession } from './helpers.js';
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

  it('entering Design from merge+ask resets both ship intent and ask in one call', async () => {
    const session = await createSession({ agentId, name: 'patch-design-from-merge' });
    const sessionId = session.id as string;
    giveSessionWorktree(sessionId);
    // Seed ship intent + ask mode (the "merge + Ask" starting state).
    await request
      .patch(`/api/sessions/${sessionId}`)
      .send({ finalize_automation: 'merge', ask_mode: true })
      .expect(200);

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
});
