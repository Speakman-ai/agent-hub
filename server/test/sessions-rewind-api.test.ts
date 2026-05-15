import './setup.js';
import { describe, it, expect, beforeAll } from 'vitest';
import type supertest from 'supertest';
import { getRequest, createAgent, createSession } from './helpers.js';
import { getStmts } from '../db.js';
import { v4 as uuidv4 } from 'uuid';

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
});

describe('POST /api/sessions/:id/rewind — engine guard', () => {
  it('returns 400 with code for non-Claude engines before touching checkpoints', async () => {
    const agent = await createAgent({ engine: 'cursor-agent' });
    const session = (await createSession({
      agentId: agent.id as string,
      engine: 'cursor-agent',
    })) as { id: string };

    const res = await request
      .post(`/api/sessions/${session.id}/rewind`)
      .send({ uuid: uuidv4() })
      .expect(400);

    const body = res.body as { error: string; code?: string };
    expect(body.code).toBe('checkpoint_rewind_unsupported_engine');
    expect(body.error).toMatch(/Claude Code/i);
  });

  it('returns 400 with code when Claude session never captured engine_session_id', async () => {
    const agent = await createAgent({ engine: 'claude-code' });
    const session = (await createSession({
      agentId: agent.id as string,
      engine: 'claude-code',
    })) as { id: string };

    const cpUuid = uuidv4();
    const msgId = uuidv4();
    getStmts().addCheckpoint.run(session.id, msgId, cpUuid, 1, null);

    const res = await request
      .post(`/api/sessions/${session.id}/rewind`)
      .send({ uuid: cpUuid })
      .expect(400);

    const body = res.body as { error: string; code?: string };
    expect(body.code).toBe('checkpoint_rewind_no_engine_session');
  });
});

describe('GET /api/sessions/:id — checkpoint_rewind_supported', () => {
  it('is false for cursor-agent and true for claude-code', async () => {
    const a1 = await createAgent({ engine: 'cursor-agent' });
    const s1 = (await createSession({ agentId: a1.id as string, engine: 'cursor-agent' })) as {
      id: string;
    };
    const r1 = await request.get(`/api/sessions/${s1.id}`).expect(200);
    expect((r1.body as { checkpoint_rewind_supported: boolean }).checkpoint_rewind_supported).toBe(
      false,
    );

    const a2 = await createAgent({ engine: 'claude-code' });
    const s2 = (await createSession({ agentId: a2.id as string, engine: 'claude-code' })) as {
      id: string;
    };
    const r2 = await request.get(`/api/sessions/${s2.id}`).expect(200);
    expect((r2.body as { checkpoint_rewind_supported: boolean }).checkpoint_rewind_supported).toBe(
      true,
    );
  });
});
