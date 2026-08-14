import { describe, it, expect, vi, afterEach } from 'vitest';
import type supertest from 'supertest';
import { getRequest, createSession } from './helpers.js';
import { routeDeps } from '../index.js';

describe('POST /api/sessions/:sessionId/workspace/ensure', () => {
  let request: supertest.Agent;

  beforeAll(async () => {
    request = await getRequest();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 404 for unknown session', async () => {
    await request
      .post('/api/sessions/00000000-0000-4000-8000-000000000099/workspace/ensure')
      .expect(404);
  });

  it('provisions worktree and returns enriched session', async () => {
    const session = (await createSession()) as { id: string };
    const worktreePath = `/tmp/agent-hub-test-wt-${session.id.slice(0, 8)}`;
    const spy = vi.spyOn(routeDeps, 'provisionSessionWorkspace').mockImplementation(async (sid) => {
      routeDeps.stmts.updateSessionWorktreePath.run(
        worktreePath,
        `agent-hub/test/session-${sid.slice(0, 8)}`,
        sid,
      );
      return worktreePath;
    });
    // Stub the env boot so the route does not try to mount a real VM/container.
    vi.spyOn(routeDeps, 'ensureSessionEnvironment').mockResolvedValue(undefined);

    const res = await request.post(`/api/sessions/${session.id}/workspace/ensure`).expect(200);

    expect(spy).toHaveBeenCalledWith(session.id);
    expect((res.body as { ok: boolean }).ok).toBe(true);
    expect((res.body as { worktreePath: string }).worktreePath).toBe(worktreePath);
    expect((res.body as { session: { worktree_path: string } }).session.worktree_path).toBe(
      worktreePath,
    );
  });

  it('boots the session environment after the clone, in order', async () => {
    // The interactive open must explicitly boot the VM/container as a step
    // distinct from the clone-only provisioning primitive. Non-interactive
    // clone callers (Finalize/RUM setup apply, design import) never receive
    // ensureSessionEnvironment, so they cannot boot an env.
    const session = (await createSession()) as { id: string };
    const worktreePath = `/tmp/agent-hub-test-wt-${session.id.slice(0, 8)}`;
    const order: string[] = [];
    const provisionSpy = vi
      .spyOn(routeDeps, 'provisionSessionWorkspace')
      .mockImplementation(async (sid) => {
        order.push('provision');
        routeDeps.stmts.updateSessionWorktreePath.run(
          worktreePath,
          `agent-hub/test/session-${sid.slice(0, 8)}`,
          sid,
        );
        return worktreePath;
      });
    const ensureEnvSpy = vi
      .spyOn(routeDeps, 'ensureSessionEnvironment')
      .mockImplementation(async () => {
        order.push('ensureEnv');
      });

    await request.post(`/api/sessions/${session.id}/workspace/ensure`).expect(200);

    expect(provisionSpy).toHaveBeenCalledWith(session.id);
    expect(ensureEnvSpy).toHaveBeenCalledWith(session.id);
    expect(order).toEqual(['provision', 'ensureEnv']);
  });
});
