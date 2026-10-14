/**
 * `chat.sh` and `sessions.sh dispatch` against a mock Hub: the wrappers must
 * hit the chat and dispatch routes with the right bodies, resolve channel
 * names and usernames, join public channels before posting, and append
 * --ref chips as `@[label](kind:id)` tokens.
 */
import { spawn, spawnSync } from 'child_process';
import http from 'http';
import type { AddressInfo } from 'net';
import path from 'path';
import { fileURLToPath } from 'url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = path.join(__dirname, '..', 'default-skills', 'agent-hub', 'scripts');
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

const CHANNELS = {
  channels: [
    { id: 'c-mine', kind: 'channel', name: 'deploys' },
    { id: 'c-dm', kind: 'dm', name: '' },
  ],
};
const BROWSE = { channels: [{ id: 'c-public', kind: 'channel', name: 'general' }] };
const MEMBERS = {
  members: [
    { userId: 'u-alice', username: 'alice' },
    { userId: 'u-bob', username: 'bob' },
  ],
};

function route(method: string, url: string): [number, unknown] {
  if (method === 'GET' && url === '/api/chat/channels') return [200, CHANNELS];
  if (method === 'GET' && url === '/api/chat/channels/browse') return [200, BROWSE];
  if (method === 'GET' && url === '/api/chat/members') return [200, MEMBERS];
  if (method === 'POST' && url === '/api/chat/dms') return [201, { channel: { id: 'c-new-dm' } }];
  if (method === 'POST' && /^\/api\/chat\/channels\/[^/]+\/join$/.test(url)) return [200, {}];
  if (method === 'POST' && /^\/api\/chat\/channels\/[^/]+\/messages$/.test(url)) {
    return [201, { message: { id: 'm1' } }];
  }
  if (method === 'POST' && /^\/api\/projects\/[^/]+\/sessions\/dispatch$/.test(url)) {
    return [201, { sessionId: 'new-sess', ref: '@[x](session:new-sess)' }];
  }
  return [404, { error: 'not found' }];
}

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
      const [status, body] = route(req.method ?? '', req.url ?? '');
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function run(script: string, args: string[], stdin?: string) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(path.join(SCRIPTS, script), args, {
      env: {
        ...process.env,
        AGENT_HUB_URL: baseUrl,
        AGENT_HUB_API_KEY: 'test-key',
        AGENT_HUB_SESSION_ID: 'agent-sess',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c.toString()));
    child.stderr.on('data', (c) => (stderr += c.toString()));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(stdin ?? '');
  });
}

const posts = () => calls.filter((c) => c.method === 'POST' && c.url.endsWith('/messages'));

describe.skipIf(!hasPython)('chat.sh', () => {
  it('posts to a joined channel by #name with ref chips, sending the session id', async () => {
    const r = await run('chat.sh', [
      'post',
      '#deploys',
      'Build is green',
      '--ref',
      'session:s-1=Fix login',
      '--ref',
      'card:card-9',
    ]);
    expect(r.status, r.stderr).toBe(0);
    expect(posts()).toEqual([
      {
        method: 'POST',
        url: '/api/chat/channels/c-mine/messages',
        body: { body: 'Build is green @[Fix login](session:s-1) @[card-9](card:card-9)' },
        session: 'agent-sess',
      },
    ]);
    expect(calls.some((c) => c.url.endsWith('/join'))).toBe(false);
  });

  it('joins a public channel before posting, and reads the body from stdin', async () => {
    const r = await run('chat.sh', ['post', 'general', '-'], 'from stdin\n');
    expect(r.status, r.stderr).toBe(0);
    const urls = calls.filter((c) => c.method === 'POST').map((c) => c.url);
    expect(urls).toEqual([
      '/api/chat/channels/c-public/join',
      '/api/chat/channels/c-public/messages',
    ]);
    expect(posts()[0]!.body).toEqual({ body: 'from stdin' });
  });

  it('DMs a user by username', async () => {
    const r = await run('chat.sh', ['dm', '@bob', 'Card is ready']);
    expect(r.status, r.stderr).toBe(0);
    expect(calls.find((c) => c.url === '/api/chat/dms')!.body).toEqual({ userId: 'u-bob' });
    expect(posts()[0]).toMatchObject({
      url: '/api/chat/channels/c-new-dm/messages',
      body: { body: 'Card is ready' },
    });
  });

  it('fails clearly on an unknown channel, user or ref kind', async () => {
    const ch = await run('chat.sh', ['post', '#nope', 'hi']);
    expect(ch.status).not.toBe(0);
    expect(ch.stderr).toContain("no channel '#nope'");

    const user = await run('chat.sh', ['dm', 'zed', 'hi']);
    expect(user.status).not.toBe(0);
    expect(user.stderr).toContain("no org member 'zed'");

    const ref = await run('chat.sh', ['post', '#deploys', 'hi', '--ref', 'thing:1']);
    expect(ref.status).toBe(2);
    expect(posts()).toHaveLength(0);
  });
});

describe.skipIf(!hasPython)('sessions.sh dispatch', () => {
  it('POSTs the dispatch route with the prompt, agent, mode and skills', async () => {
    const r = await run('sessions.sh', [
      'dispatch',
      'web',
      '--prompt',
      'Fix the "login" redirect',
      '--agent',
      'web-dev',
      '--mode',
      'review',
      '--skill',
      'agent-hub-kanban',
    ]);
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ sessionId: 'new-sess' });
    expect(calls).toEqual([
      {
        method: 'POST',
        url: '/api/projects/web/sessions/dispatch',
        body: {
          prompt: 'Fix the "login" redirect',
          agentId: 'web-dev',
          mode: 'review',
          skills: ['agent-hub-kanban'],
        },
        session: 'agent-sess',
      },
    ]);
  });

  it('requires a prompt', async () => {
    const r = await run('sessions.sh', ['dispatch', 'web']);
    expect(r.status).toBe(2);
    expect(calls).toHaveLength(0);
  });
});
