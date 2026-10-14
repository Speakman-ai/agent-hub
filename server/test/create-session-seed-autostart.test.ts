/**
 * `autoStart` on POST /api/agents/:agentId/sessions: the seed runs as the first
 * chat turn via handleChat instead of sitting pre-stored until a follow-up.
 */

import './setup.js';
import express from 'express';
import supertest from 'supertest';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { createProject, createAgent, getRequest } from './helpers.js';
import type { RouteDeps } from '../types.js';

const handleChat = vi.fn((_ws: unknown, _msg: unknown) => Promise.resolve());
let request: supertest.Agent;
let agentId: string;

beforeAll(async () => {
  await getRequest();
  const createSessionRoutes = (await import('../routes/sessions.js')).default;
  const { getStmts } = await import('../db.js');
  const { findAgent, findProject, getEnrichedAgent } = await import('../project-model.js');
  const app = express();
  app.use(express.json());
  app.use(
    createSessionRoutes({
      stmts: getStmts(),
      findAgent,
      findProject,
      getEnrichedAgent,
      handleChat,
      broadcast: () => {},
      activeProcesses: new Map(),
      config: { engineValidModels: {}, engineDefaultModels: {} },
    } as unknown as RouteDeps),
  );
  request = supertest.agent(app);
  const project = await createProject({ id: 'seed-auto-proj', name: 'Seed Auto', cwd: '/tmp' });
  const agent = await createAgent({
    projectId: project.id as string,
    id: 'seed-auto-agent',
    name: 'Seed Auto Agent',
  });
  agentId = agent.id as string;
});

beforeEach(() => handleChat.mockClear());

describe('POST /api/agents/:agentId/sessions autoStart', () => {
  it('runs the seed as the first turn and does not pre-store it', async () => {
    const res = await request
      .post(`/api/agents/${agentId}/sessions`)
      .send({ name: 'From chat', seedMessage: '  Look at this thread.  ', autoStart: true })
      .expect(200);

    expect(handleChat).toHaveBeenCalledTimes(1);
    expect(handleChat.mock.calls[0][1]).toEqual({
      type: 'chat',
      agentId,
      sessionId: res.body.id,
      content: 'Look at this thread.',
    });
    const { getStmts } = await import('../db.js');
    expect(getStmts().getMessages.all(res.body.id)).toHaveLength(0);
  });

  it('keeps the pre-store behavior when autoStart is omitted', async () => {
    const res = await request
      .post(`/api/agents/${agentId}/sessions`)
      .send({ name: 'From email', seedMessage: 'An email.' })
      .expect(200);
    expect(handleChat).not.toHaveBeenCalled();
    const { getStmts } = await import('../db.js');
    expect(getStmts().getMessages.all(res.body.id)).toHaveLength(1);
  });

  it('does not start a turn without a seed', async () => {
    await request
      .post(`/api/agents/${agentId}/sessions`)
      .send({ name: 'empty', autoStart: true })
      .expect(200);
    expect(handleChat).not.toHaveBeenCalled();
  });
});
