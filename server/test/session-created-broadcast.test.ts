/**
 * Regression tests for `session_created` WebSocket broadcasts whenever a new
 * `sessions` row is created outside the normal chat flow — sidebar live-sync.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type supertest from 'supertest';
import { getRequest, createAgent } from './helpers.js';
import { routeDeps } from '../index.js';

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
}, 60_000);

describe('session_created broadcast coverage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('POST /api/agents/:agentId/sessions emits session_created on broadcast', async () => {
    const spy = vi.spyOn(routeDeps, 'broadcast');
    const agent = await createAgent();
    spy.mockClear();
    const res = await request
      .post(`/api/agents/${agent.id}/sessions`)
      .send({ name: 'Sidebar sync session' })
      .expect(200);
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'session_created',
        agentId: agent.id,
        session: expect.objectContaining({
          id: res.body.id,
          checkpoint_rewind_supported: true,
        }),
      }),
    );
  });
});
