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
import { getRequest, createSession, createProject, createAgent } from '../test/helpers.js';

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
  it('makes saved project profiles available to a shell started through the API', async () => {
    const project = await createProject();
    await request
      .put(`/api/projects/${project.id}/aws-profiles`)
      .send({
        profiles: {
          musc: {
            sso_start_url: 'https://example.awsapps.com/start',
            sso_region: 'us-east-1',
            sso_account_id: '111111111111',
            sso_role_name: 'ReadOnly',
            region: 'us-east-1',
          },
        },
        defaultProfile: 'musc',
      })
      .expect(200);
    const agent = await createAgent({ projectId: project.id as string });
    const session = await createSession({ agentId: agent.id as string });
    const started = await request
      .post(`/api/sessions/${session.id}/background-shells`)
      .send({
        command:
          'test -r "$AWS_CONFIG_FILE" && test -r "$AWS_SHARED_CREDENTIALS_FILE" && printf "%s\\n" "$AWS_PROFILE" "$PROJECT_ID" "$AGENT_HUB_SESSION_ID"',
        watch: false,
      })
      .expect(201);
    const shellId = started.body.shell.id as string;
    try {
      await expect
        .poll(async () => {
          const result = await request
            .get(`/api/sessions/${session.id}/background-shells/${shellId}`)
            .expect(200);
          return result.body.shell.status;
        })
        .toBe('exited');
      const result = await request
        .get(`/api/sessions/${session.id}/background-shells/${shellId}/logs`)
        .expect(200);
      expect(result.body.logs).toEqual(['musc', project.id, session.id]);
    } finally {
      await request.post(`/api/sessions/${session.id}/background-shells/${shellId}/stop`);
    }
  });

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

  it('times out a still-running shell at the requested cap', async () => {
    const session = await createSession();
    const sessionId = session.id as string;

    const started = await request
      .post(`/api/sessions/${sessionId}/background-shells`)
      .send({ command: 'sleep 60', label: 'cap', timeoutMs: 400 })
      .expect(201);
    const shell = started.body.shell;
    expect(shell.timeout_ms).toBe(400);
    expect(isAlive(shell.pid)).toBe(true);

    const deadline = Date.now() + 8_000;
    let status = shell.status as string;
    while (Date.now() < deadline && status === 'running') {
      await new Promise((r) => setTimeout(r, 100));
      const got = await request
        .get(`/api/sessions/${sessionId}/background-shells/${shell.id}`)
        .expect(200);
      status = got.body.shell.status;
    }
    expect(status).toBe('timed_out');
    expect(isAlive(shell.pid)).toBe(false);
  });
});
