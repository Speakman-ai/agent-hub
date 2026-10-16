/**
 * `reminders.sh` against a mock Hub: each subcommand must hit
 * `/api/me/reminders` with the right method and body, convert durations to
 * minutes, link the session, and send the session header so the reminder is
 * attributed to the session owner.
 */
import { spawn, spawnSync } from 'child_process';
import http from 'http';
import type { AddressInfo } from 'net';
import path from 'path';
import { fileURLToPath } from 'url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, '..', 'default-skills', 'agent-hub', 'scripts', 'reminders.sh');
const hasPython = spawnSync('python3', ['--version']).status === 0;

interface Call {
  method: string;
  url: string;
  body: unknown;
  session: string | undefined;
}

let server: http.Server;
let calls: Call[];
let baseUrl = '';

beforeEach(async () => {
  calls = [];
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      calls.push({
        method: req.method ?? '',
        url: req.url ?? '',
        body: raw ? JSON.parse(raw) : null,
        session: req.headers['x-agent-hub-session-id'] as string | undefined,
      });
      res.statusCode = req.method === 'POST' ? 201 : 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ reminder: { id: 'r1' } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function run(args: string[]) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(SCRIPT, args, {
      env: {
        ...process.env,
        AGENT_HUB_URL: baseUrl,
        AGENT_HUB_API_KEY: 'test-key',
        AGENT_HUB_SESSION_ID: 'agent-sess',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c.toString()));
    child.stderr.on('data', (c) => (stderr += c.toString()));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

describe.skipIf(!hasPython)('reminders.sh', () => {
  it('adds a relative reminder linked to the session', async () => {
    const r = await run(['add', 'Check the deploy', '--in', '2h', '--notes', 'prod only']);
    expect(r.status, r.stderr).toBe(0);
    expect(calls).toEqual([
      {
        method: 'POST',
        url: '/api/me/reminders',
        body: {
          title: 'Check the deploy',
          calendar: 'auto',
          inMinutes: 120,
          notes: 'prod only',
          sessionId: 'agent-sess',
        },
        session: 'agent-sess',
      },
    ]);
  });

  it('adds an absolute reminder without the calendar', async () => {
    const r = await run(['add', 'Standup', '--at', '2026-10-17T09:00:00-07:00', '--no-calendar']);
    expect(r.status, r.stderr).toBe(0);
    expect(calls[0].body).toEqual({
      title: 'Standup',
      calendar: 'none',
      remindAt: '2026-10-17T09:00:00-07:00',
      sessionId: 'agent-sess',
    });
  });

  it('keeps titles and notes that start with # as strings', async () => {
    for (const [title, notes] of [
      ['#123', '# Heading\n- item'],
      ['#deploy', '#'],
    ]) {
      const r = await run(['add', title, '--in', '15', '--notes', notes]);
      expect(r.status, r.stderr).toBe(0);
    }
    expect(calls.map((c) => c.body)).toEqual([
      {
        title: '#123',
        calendar: 'auto',
        inMinutes: 15,
        notes: '# Heading\n- item',
        sessionId: 'agent-sess',
      },
      { title: '#deploy', calendar: 'auto', inMinutes: 15, notes: '#', sessionId: 'agent-sess' },
    ]);
  });

  it('rejects both or neither time flags and bad durations', async () => {
    expect((await run(['add', 'x'])).status).toBe(2);
    expect((await run(['add', 'x', '--in', '5', '--at', '2026-10-17T09:00:00Z'])).status).toBe(2);
    expect((await run(['add', 'x', '--in', 'soon'])).status).toBe(2);
    expect(calls).toEqual([]);
  });

  it('lists, snoozes, dismisses, and deletes', async () => {
    for (const args of [
      ['list', '--status', 'all', '--this-session'],
      ['snooze', 'r1', '1d'],
      ['dismiss', 'r1'],
      ['delete', 'r1'],
    ]) {
      const r = await run(args);
      expect(r.status, r.stderr).toBe(0);
    }
    expect(calls.map((c) => [c.method, c.url, c.body])).toEqual([
      ['GET', '/api/me/reminders?sessionId=agent-sess&status=all', null],
      ['PATCH', '/api/me/reminders/r1', { snoozeMinutes: 1440 }],
      ['PATCH', '/api/me/reminders/r1', { status: 'dismissed' }],
      ['DELETE', '/api/me/reminders/r1', null],
    ]);
  });
});
