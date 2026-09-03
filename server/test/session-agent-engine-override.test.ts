/**
 * Route-level spec for the per-advisor engine override in multi-agent
 * sessions. Proves that POST /api/sessions/:id/agents stores an engine
 * override, that a model is validated against the chosen engine (not the
 * agent's own), and that PUT .../engine flips the engine and resets the
 * participant model.
 */
import './setup.js';
import { describe, it, expect, beforeAll } from 'vitest';
import { getRequest, createAgent, createSession } from './helpers.js';
import config from '../config.js';

type Advisor = {
  participantId: string;
  role: string;
  engine: string;
  engineOverride: string | null;
  model: string | null;
};

let request: Awaited<ReturnType<typeof getRequest>>;
let agentId: string;
let sessionId: string;

beforeAll(async () => {
  request = await getRequest();
  const agent = await createAgent({ engine: 'claude-code' });
  agentId = agent.id as string;
  const session = await createSession({ agentId });
  sessionId = session.id as string;
});

function advisors(body: { agents?: Advisor[] }): Advisor[] {
  return (body.agents || []).filter((a) => a.role === 'advisor');
}

describe('per-advisor engine override', () => {
  it('stores an engine override on add and reports it as effective + override', async () => {
    const res = await request
      .post(`/api/sessions/${sessionId}/agents`)
      .send({ agentId, engine: 'cursor-agent' })
      .expect(200);
    const advisor = advisors(res.body).at(-1)!;
    expect(advisor.engine).toBe('cursor-agent');
    expect(advisor.engineOverride).toBe('cursor-agent');
  });

  it('validates the model against the override engine, not the agent engine', async () => {
    // A claude-code model is invalid once the override engine is cursor-agent.
    const claudeModel = config.engineValidModels['claude-code']![0]!;
    const res = await request
      .post(`/api/sessions/${sessionId}/agents`)
      .send({ agentId, engine: 'cursor-agent', model: claudeModel })
      .expect(400);
    expect(String(res.body.error)).toContain('cursor-agent');
  });

  it('changes the engine and resets the participant model via PUT .../engine', async () => {
    const added = await request
      .post(`/api/sessions/${sessionId}/agents`)
      .send({ agentId })
      .expect(200);
    const participantId = advisors(added.body).at(-1)!.participantId;

    const changed = await request
      .put(`/api/sessions/${sessionId}/agents/${participantId}/engine`)
      .send({ engine: 'codex-cli' })
      .expect(200);
    const advisor = advisors(changed.body).find((a) => a.participantId === participantId)!;
    expect(advisor.engineOverride).toBe('codex-cli');
    expect(advisor.engine).toBe('codex-cli');
    expect(advisor.model).toBeNull();

    // Clearing the override re-inherits the agent's engine.
    const cleared = await request
      .put(`/api/sessions/${sessionId}/agents/${participantId}/engine`)
      .send({ engine: null })
      .expect(200);
    const reverted = advisors(cleared.body).find((a) => a.participantId === participantId)!;
    expect(reverted.engineOverride).toBeNull();
    expect(reverted.engine).toBe('claude-code');
  });

  it('rejects an unknown engine', async () => {
    const added = await request
      .post(`/api/sessions/${sessionId}/agents`)
      .send({ agentId })
      .expect(200);
    const participantId = advisors(added.body).at(-1)!.participantId;
    await request
      .put(`/api/sessions/${sessionId}/agents/${participantId}/engine`)
      .send({ engine: 'not-an-engine' })
      .expect(400);
  });
});
