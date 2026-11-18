import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import supertest from 'supertest';

let ownsSession = true;
vi.mock('../session-ownership.js', () => ({
  userOwnsSession: () => ownsSession,
}));
vi.mock('../session-checkpoint-rewind.js', () => ({
  enrichSessionForClient: (row: { id: string; state?: string }) => ({
    ...row,
    state: row.state ?? 'waiting_for_user_input',
    last_turn_error: null,
  }),
}));

const { default: createSessionSpawnedRoutes } = await import('./session-spawned.js');

let parent: Record<string, unknown> | undefined;
let children: Record<string, unknown>[];
let archived: Record<string, unknown>[];

function app() {
  const deps = {
    stmts: {
      getSession: { get: () => parent },
      getSpawnedSessions: { all: () => children },
      getArchivedSpawnedSessions: { all: () => archived },
    },
    findAgent: () => ({ project: { id: 'p1', mode: 'dev' }, agent: { id: 'agent-1' } }),
  } as unknown as Parameters<typeof createSessionSpawnedRoutes>[0];
  const a = express();
  a.use(createSessionSpawnedRoutes(deps));
  return supertest(a);
}

beforeEach(() => {
  ownsSession = true;
  parent = {
    id: 'parent-1',
    name: 'Project chat',
    agent_id: 'agent-1',
    deleted_at: null,
  };
  children = [
    {
      id: 'child-1',
      name: 'Fix login',
      agent_id: 'agent-1',
      state: 'working',
      updated_at: '2026-11-12 12:00:00',
    },
  ];
  archived = [
    {
      id: 'child-old',
      name: 'Old attempt',
      agent_id: 'agent-1',
      deleted_at: '2026-11-12 11:00:00',
    },
  ];
});

describe('GET /api/sessions/:sessionId/spawned', () => {
  it('returns the parent and its worker sessions', async () => {
    const res = await app().get('/api/sessions/parent-1/spawned');
    expect(res.status).toBe(200);
    expect(res.body.parent).toEqual({
      id: 'parent-1',
      name: 'Project chat',
      agent_id: 'agent-1',
      up: null,
    });
    expect(res.body.sessions).toEqual([
      {
        id: 'child-1',
        name: 'Fix login',
        agent_id: 'agent-1',
        state: 'working',
        updated_at: '2026-11-12 12:00:00',
        finalize_status: null,
        needs_input: null,
        needs_input_at: null,
        last_turn_error: null,
      },
    ]);
    expect(res.body.archived).toEqual([
      {
        id: 'child-old',
        name: 'Old attempt',
        agent_id: 'agent-1',
        deleted_at: '2026-11-12 11:00:00',
      },
    ]);
  });

  it('404s when the caller does not own the parent', async () => {
    ownsSession = false;
    const res = await app().get('/api/sessions/parent-1/spawned');
    expect(res.status).toBe(404);
  });
});
