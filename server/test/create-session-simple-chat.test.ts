/**
 * `simpleChat` on POST /api/agents/:agentId/sessions marks the consult chat the
 * Simple view opens, so the full Hub sidebar can leave it out.
 */

import './setup.js';
import express from 'express';
import supertest from 'supertest';
import { describe, it, expect, beforeAll } from 'vitest';
import { createProject, createAgent, getRequest } from './helpers.js';
import type { RouteDeps } from '../types.js';

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
      broadcast: () => {},
      activeProcesses: new Map(),
      config: { engineValidModels: {}, engineDefaultModels: {} },
    } as unknown as RouteDeps),
  );
  request = supertest.agent(app);
  const project = await createProject({ id: 'simple-chat-proj', name: 'Simple', cwd: '/tmp' });
  const agent = await createAgent({
    projectId: project.id as string,
    id: 'simple-chat-agent',
    name: 'Simple Chat Agent',
  });
  agentId = agent.id as string;
});

describe('POST /api/agents/:agentId/sessions simpleChat', () => {
  it('flags a Simple view chat', async () => {
    const res = await request
      .post(`/api/agents/${agentId}/sessions`)
      .send({ name: 'Chat', session_mode: 'consult', simpleChat: true })
      .expect(200);
    expect(res.body.simple_chat).toBe(1);
    expect(res.body.session_mode).toBe('consult');
  });

  it('leaves other sessions unflagged, consult or not', async () => {
    const consult = await request
      .post(`/api/agents/${agentId}/sessions`)
      .send({ name: 'Ask', session_mode: 'consult' })
      .expect(200);
    expect(consult.body.simple_chat).toBe(0);
    const plain = await request
      .post(`/api/agents/${agentId}/sessions`)
      .send({ name: 'Build' })
      .expect(200);
    expect(plain.body.simple_chat).toBe(0);
  });
});
