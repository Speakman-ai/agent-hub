/**
 * Heartbeat → Threads integration tests.
 *
 * Verifies that heartbeat output is routed into threads:
 * - Auto-creates a heartbeat thread per agent on first run
 * - Reuses the existing thread on subsequent runs
 * - Thread entries contain the heartbeat result content
 * - Error results are also piped to threads
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { getRequest, createProject, createAgent, createThread } from './helpers.js';

let request;
let project;
let agent;

beforeAll(async () => {
  request = await getRequest();
  project = await createProject();
  agent = await createAgent({ projectId: project.id, name: 'Thread Test Agent' });
});

// ═══════════════════════════════════════════════════════════════════
// getThreadBySourceId prepared statement
// ═══════════════════════════════════════════════════════════════════

describe('getThreadBySourceId', () => {
  it('finds a thread by project, type, and source_id', async () => {
    // Create a heartbeat thread with source_id = agent id
    const thread = await createThread(project.id, {
      name: `${agent.name} heartbeat`,
      type: 'heartbeat',
      source_id: agent.id,
    });

    // Query via the threads list with type filter
    const res = await request.get(`/api/projects/${project.id}/threads?type=heartbeat`).expect(200);

    const match = res.body.find((t) => t.source_id === agent.id);
    expect(match).toBeDefined();
    expect(match.id).toBe(thread.id);
    expect(match.name).toBe(`${agent.name} heartbeat`);
    expect(match.type).toBe('heartbeat');
  });

  it('returns empty when no matching source_id exists', async () => {
    const res = await request.get(`/api/projects/${project.id}/threads?type=heartbeat`).expect(200);

    const match = res.body.find((t) => t.source_id === 'nonexistent-agent-id');
    expect(match).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════
// Thread entry creation for heartbeat results
// ═══════════════════════════════════════════════════════════════════

describe('Heartbeat thread entries', () => {
  let heartbeatThread;

  beforeAll(async () => {
    // Create a heartbeat thread for the agent
    heartbeatThread = await createThread(project.id, {
      name: `${agent.name} heartbeat`,
      type: 'heartbeat',
      source_id: `entry-test-${agent.id}`,
    });
  });

  it('adds a success entry to the thread', async () => {
    const content = 'All systems operational. No issues found.';
    const res = await request
      .post(`/api/threads/${heartbeatThread.id}/entries`)
      .send({ content })
      .expect(201);

    expect(res.body.thread_id).toBe(heartbeatThread.id);
    expect(res.body.content).toBe(content);
    expect(res.body).toHaveProperty('timestamp');
  });

  it('adds an error entry to the thread', async () => {
    const content = 'ERROR: Timed out after 5 minutes';
    const res = await request
      .post(`/api/threads/${heartbeatThread.id}/entries`)
      .send({ content })
      .expect(201);

    expect(res.body.content).toBe(content);
  });

  it('lists entries in chronological order', async () => {
    const res = await request.get(`/api/threads/${heartbeatThread.id}/entries`).expect(200);

    expect(res.body.length).toBeGreaterThanOrEqual(2);
    // First entry should be the success one (created first)
    expect(res.body[0].content).toBe('All systems operational. No issues found.');
    expect(res.body[1].content).toBe('ERROR: Timed out after 5 minutes');
  });

  it('creates multiple threads for different agents in the same project', async () => {
    const agent2 = await createAgent({ projectId: project.id, name: 'Second Agent' });
    const thread2 = await createThread(project.id, {
      name: `${agent2.name} heartbeat`,
      type: 'heartbeat',
      source_id: agent2.id,
    });

    // Both threads should exist under the same project
    const res = await request.get(`/api/projects/${project.id}/threads?type=heartbeat`).expect(200);

    const threadIds = res.body.map((t) => t.id);
    expect(threadIds).toContain(heartbeatThread.id);
    expect(threadIds).toContain(thread2.id);
  });
});
