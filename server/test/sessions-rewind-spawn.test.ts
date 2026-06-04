import './setup.js';
import { vi, describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type supertest from 'supertest';
import * as cp from 'child_process';
import { getRequest, createAgent, createSession } from './helpers.js';
import { getStmts } from '../db.js';
import { v4 as uuidv4 } from 'uuid';

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    spawn: vi.fn(
      (
        cmd: string,
        args?: readonly string[],
        opts?: import('child_process').SpawnOptions,
      ): import('child_process').ChildProcess => {
        const a = args ?? [];
        if (a.includes('--rewind-files')) {
          const proc = {
            stdout: { on: vi.fn() },
            stderr: { on: vi.fn() },
            on: vi.fn(),
            kill: vi.fn(),
          };
          setImmediate(() => {
            const closeCb = proc.on.mock.calls.find((c) => c[0] === 'close')?.[1] as
              | ((code: number) => void)
              | undefined;
            if (closeCb) closeCb(0);
          });
          return proc as unknown as import('child_process').ChildProcess;
        }
        if (opts !== undefined) {
          return actual.spawn(cmd, [...(args ?? [])], opts);
        }
        return actual.spawn(cmd, [...(args ?? [])]);
      },
    ) as unknown as typeof actual.spawn,
  };
});

// The rewind route builds its env via `resolveSessionCliSpawnEnv`, which
// hard-fails (EngineAuthRequiredError → 409) when the session owner has no
// per-account creds. This test's harness session is NULL-owner; we assert
// the rewind argv, not auth, so stub the env builder to a bare object.
vi.mock('../per-user-cli-spawn.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../per-user-cli-spawn.js')>();
  return {
    ...actual,
    resolveSessionCliSpawnEnv: vi.fn(() => ({})),
  };
});

const spawnSpy = vi.mocked(cp.spawn);

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
});

describe('POST /api/sessions/:id/rewind — Claude spawn path', () => {
  beforeEach(() => {
    spawnSpy.mockClear();
  });

  it('spawns claude with --rewind-files and returns rewind_started', async () => {
    const agent = await createAgent({ engine: 'claude-code' });
    const session = (await createSession({
      agentId: agent.id as string,
      engine: 'claude-code',
    })) as { id: string };

    const engineSid = 'eng-sess-rewind-test';
    getStmts().updateSessionEngineSessionId.run(engineSid, session.id);

    const cpUuid = uuidv4();
    const msgId = uuidv4();
    getStmts().addCheckpoint.run(session.id, msgId, cpUuid, 1, null);

    const res = await request
      .post(`/api/sessions/${session.id}/rewind`)
      .send({ uuid: cpUuid })
      .expect(200);

    expect(res.body).toMatchObject({
      status: 'rewind_started',
      uuid: cpUuid,
      sessionId: session.id,
    });

    const rewindCalls = spawnSpy.mock.calls.filter((c) =>
      (c[1] as string[]).includes('--rewind-files'),
    );
    expect(rewindCalls.length).toBe(1);
    const args = rewindCalls[0][1] as string[];
    expect(args).toContain('--rewind-files');
    expect(args).toContain(cpUuid);
    expect(args).toContain('--resume');
    expect(args).toContain(engineSid);
  });
});
