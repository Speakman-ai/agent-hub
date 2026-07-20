/**
 * End-to-end integration for Hub-owned background shells, driving the REAL
 * Express app (so it exercises the index.ts construction + route mount + the
 * live `BackgroundShellRuntime`, not a fake).
 *
 * These spawn a real short-lived `sleep` via `sh -c` — allowed by the test
 * CLI-spawn guard, which only blocks the `claude`/`cursor`/`gemini`/`codex`
 * binaries. Each test tears its process down (stop or session-reap), and the
 * reap assertion uses `process.kill(pid, 0)` to prove the OS process is gone.
 */
import '../test/setup.js';
import type supertest from 'supertest';
import { describe, it, expect, beforeAll } from 'vitest';
import { getRequest, createSession } from '../test/helpers.js';

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
});

/** True if `pid` is still a live process. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('background shells — real runtime lifecycle', () => {
  it('starts, lists, gets, and stops a background shell', async () => {
    const session = await createSession();
    const sessionId = session.id as string;

    const started = await request
      .post(`/api/sessions/${sessionId}/background-shells`)
      .send({ command: 'sleep 60', label: 'itest' })
      .expect(201);
    const shell = started.body.shell;
    expect(shell.status).toBe('running');
    expect(shell.label).toBe('itest');
    expect(typeof shell.pid).toBe('number');
    expect(isAlive(shell.pid)).toBe(true);

    const listed = await request.get(`/api/sessions/${sessionId}/background-shells`).expect(200);
    expect(listed.body.shells.map((s: { id: string }) => s.id)).toContain(shell.id);

    const stopped = await request
      .post(`/api/sessions/${sessionId}/background-shells/${shell.id}/stop`)
      .expect(200);
    expect(stopped.body.shell.status).toBe('stopped');
    expect(isAlive(shell.pid)).toBe(false);
  });

  it('reaps a running shell when its session is deleted', async () => {
    const session = await createSession();
    const sessionId = session.id as string;

    const started = await request
      .post(`/api/sessions/${sessionId}/background-shells`)
      .send({ command: 'sleep 60' })
      .expect(201);
    const pid = started.body.shell.pid as number;
    expect(isAlive(pid)).toBe(true);

    // The delete handler awaits the reap hook (stopBySessionId) before
    // responding, so once this resolves the process group is gone.
    await request.delete(`/api/sessions/${sessionId}`).expect(200);
    expect(isAlive(pid)).toBe(false);
  });

  it('400s when the command is missing', async () => {
    const session = await createSession();
    await request
      .post(`/api/sessions/${session.id}/background-shells`)
      .send({ label: 'no-command' })
      .expect(400);
  });
});
