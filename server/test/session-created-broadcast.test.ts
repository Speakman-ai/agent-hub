/**
 * Regression tests for `session_created` WebSocket broadcasts whenever a new
 * `sessions` row is created outside the normal chat flow — sidebar live-sync.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type supertest from 'supertest';
import { getRequest, createProject, createAgent, createCard } from './helpers.js';
import { routeDeps } from '../index.js';
import { dispatchReviewFeedback } from '../routes/webhooks.js';
import { getStmts } from '../db.js';
import { findProject, findAgent } from '../project-model.js';
import type { KanbanCardRow, ChatMessage } from '../types.js';

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

  it('dispatchReviewFeedback emits session_created when it creates a new session', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const assigneeName = `Review assignee ${Date.now()}`;
    const agent = await createAgent({
      projectId,
      name: assigneeName,
      role: 'sub',
    });
    const created = await createCard(projectId, {
      title: 'session-created dispatch card',
      assignee: assigneeName,
    });
    const stmts = getStmts();
    const card = stmts.getKanbanCard.get(created.id as string) as KanbanCardRow;
    const proj = findProject(projectId);
    expect(proj).toBeDefined();

    const broadcast = vi.fn();
    const handleChat = vi.fn(
      async (
        _ws: unknown,
        msg: ChatMessage & { _onUserMessagePersisted?: (ok: boolean) => void },
      ) => {
        msg._onUserMessagePersisted?.(true);
      },
    );

    await dispatchReviewFeedback(
      { stmts, broadcast, findAgent, handleChat },
      card,
      proj!,
      'Please address the review feedback.',
    );

    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'session_created',
        agentId: agent.id as string,
        session: expect.objectContaining({
          agent_id: agent.id as string,
          name: expect.stringMatching(/Review fixes:/),
        }),
      }),
    );
    expect(handleChat).toHaveBeenCalled();
  });
});
