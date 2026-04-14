/**
 * Tests for GET /api/heartbeats/:agentId/thread
 *
 * Verifies the shortcut endpoint that looks up a heartbeat thread by agent source_id.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { getRequest, createProject, createAgent, createThread } from './helpers.js';

let request;
let project;
let agent;

beforeAll(async () => {
  request = await getRequest();
  project = await createProject();
  agent = await createAgent({ projectId: project.id, name: 'HB Thread Route Agent' });
});

describe('GET /api/heartbeats/:agentId/thread', () => {
  it('returns null thread when no thread exists yet', async () => {
    const res = await request.get(`/api/heartbeats/${agent.id}/thread`).expect(200);
    expect(res.body.thread).toBeNull();
    expect(res.body.entries).toEqual([]);
  });

  it('returns the thread and entries when a heartbeat thread exists', async () => {
    // Create a heartbeat thread with source_id = agent.id
    const thread = await createThread(project.id, {
      name: `${agent.name} heartbeat`,
      type: 'heartbeat',
      source_id: agent.id,
    });

    // Add an entry
    await request
      .post(`/api/threads/${thread.id}/entries`)
      .send({ content: 'Heartbeat check OK' })
      .expect(201);

    const res = await request.get(`/api/heartbeats/${agent.id}/thread`).expect(200);
    expect(res.body.thread).toBeDefined();
    expect(res.body.thread.id).toBe(thread.id);
    expect(res.body.thread.type).toBe('heartbeat');
    expect(res.body.thread.source_id).toBe(agent.id);
    expect(res.body.entries.length).toBeGreaterThanOrEqual(1);
    expect(res.body.entries[0].content).toBe('Heartbeat check OK');
  });

  it('returns 404 for unknown agent ID', async () => {
    await request.get('/api/heartbeats/nonexistent-agent/thread').expect(404);
  });
});
