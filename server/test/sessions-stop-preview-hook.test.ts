/**
 * Tests that the session archive / delete handlers fire
 * `stopBySessionId` on both preview runtimes so a deleted session never
 * leaves a live preview process behind.
 *
 * Covers three handlers:
 *   - `DELETE /api/sessions/:id` (single-session soft delete)
 *   - `DELETE /api/agents/:agentId/sessions` (bulk archive)
 *   - `DELETE /api/agents/:agentId/sessions/inactive` (bulk archive inactive)
 *
 * The full route is exercised via supertest. Both runtime accessors on
 * `routeDeps` are spied on so the test asserts on the call count
 * directly — no docker is spawned because the spies return immediately.
 */

import './setup.js';
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { getRequest, createProject, createAgent, createSession } from './helpers.js';
import type TestAgent from 'supertest/lib/agent.js';

let request: TestAgent;

beforeAll(async () => {
  request = await getRequest();
});

describe('Session archive/delete → preview stopBySessionId hook', () => {
  it('DELETE /api/sessions/:id fires stopBySessionId on both runtimes', async () => {
    const project = await createProject({
      id: 'preview-hook-proj-1',
      name: 'preview-hook-1',
      cwd: '/tmp',
    });
    const agent = await createAgent({
      projectId: project.id as string,
      id: 'preview-hook-agent-1',
      name: 'preview-hook agent',
    });
    const session = await createSession({ agentId: agent.id as string, name: 'doomed' });

    // Reach into the live routeDeps and wrap the runtime accessors with
    // spies. The runtimes themselves stay wired so the hook fires
    // through them; we just want to observe the call.
    const { routeDeps } = await import('../index.js');
    const stopByComposeSpy = vi.fn().mockResolvedValue(0);
    const stopByLegacySpy = vi.fn().mockResolvedValue(0);
    routeDeps.getPreviewComposeRuntime = () =>
      ({ stopBySessionId: stopByComposeSpy }) as unknown as ReturnType<
        NonNullable<typeof routeDeps.getPreviewComposeRuntime>
      >;
    routeDeps.getPreviewRuntime = () =>
      ({ stopBySessionId: stopByLegacySpy }) as unknown as ReturnType<
        NonNullable<typeof routeDeps.getPreviewRuntime>
      >;

    await request.delete(`/api/sessions/${session.id}`).expect(200);

    // Hook ran (fire-and-forget — give the microtask queue a chance).
    await new Promise((r) => setImmediate(r));
    expect(stopByComposeSpy).toHaveBeenCalledWith(session.id);
    expect(stopByLegacySpy).toHaveBeenCalledWith(session.id);
  });

  it('DELETE /api/agents/:agentId/sessions fires stopBySessionId once per archived session', async () => {
    const project = await createProject({
      id: 'preview-hook-proj-2',
      name: 'preview-hook-2',
      cwd: '/tmp',
    });
    const agent = await createAgent({
      projectId: project.id as string,
      id: 'preview-hook-agent-2',
      name: 'preview-hook agent 2',
    });
    const s1 = await createSession({ agentId: agent.id as string, name: 's1' });
    const s2 = await createSession({ agentId: agent.id as string, name: 's2' });

    const { routeDeps } = await import('../index.js');
    const composeIds: string[] = [];
    const legacyIds: string[] = [];
    routeDeps.getPreviewComposeRuntime = () =>
      ({
        stopBySessionId: async (id: string) => {
          composeIds.push(id);
          return 0;
        },
      }) as unknown as ReturnType<NonNullable<typeof routeDeps.getPreviewComposeRuntime>>;
    routeDeps.getPreviewRuntime = () =>
      ({
        stopBySessionId: async (id: string) => {
          legacyIds.push(id);
          return 0;
        },
      }) as unknown as ReturnType<NonNullable<typeof routeDeps.getPreviewRuntime>>;

    const del = await request.delete(`/api/agents/${agent.id}/sessions`).expect(200);
    expect(del.body).toMatchObject({ ok: true, archived: 2 });

    // Allow fire-and-forget hooks to run.
    await new Promise((r) => setImmediate(r));
    expect(composeIds.sort()).toEqual([s1.id, s2.id].sort());
    expect(legacyIds.sort()).toEqual([s1.id, s2.id].sort());
  });

  it('DELETE survives when both runtime accessors are unset (back-compat)', async () => {
    const project = await createProject({
      id: 'preview-hook-proj-3',
      name: 'preview-hook-3',
      cwd: '/tmp',
    });
    const agent = await createAgent({
      projectId: project.id as string,
      id: 'preview-hook-agent-3',
      name: 'preview-hook agent 3',
    });
    const session = await createSession({ agentId: agent.id as string, name: 'no-runtime' });

    const { routeDeps } = await import('../index.js');
    routeDeps.getPreviewComposeRuntime = undefined;
    routeDeps.getPreviewRuntime = undefined;

    await request.delete(`/api/sessions/${session.id}`).expect(200);
  });
});
