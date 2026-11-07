import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { parseSavedVariables, luaList } from './lua-saved-variables.js';
import {
  addonInstalledFor,
  chooseSnapshot,
  hubBinding,
  idempotencyKeyFor,
  createProcessedStore,
  fetchRecentSessions,
  findAddonDirs,
  luaString,
  renderDataLua,
  toUnixSeconds,
  type RecentSession,
  extractRequests,
  findSavedVariablesFiles,
  launchPending,
  resolveAgent,
  wowInstallRoots,
  type WowLaunchRequest,
} from './wow-bridge.js';

// Written by the real addon (run under a Lua VM with stubbed WoW APIs).
const ADDON_OUTPUT = readFileSync(
  new URL('./test/fixtures/AgentHub.saved-variables.lua', import.meta.url),
  'utf-8',
);
const NOW_MS = 1794082000 * 1000;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function memoryStore(initial: string[] = []) {
  const ids = new Set(initial);
  const attempts = new Map<string, string>();
  return {
    has: (id: string) => ids.has(id),
    add: (id: string) => {
      ids.add(id);
      attempts.delete(id);
    },
    attemptFor: (id: string) => attempts.get(id) ?? null,
    bindAttempt: (id: string, binding: string) => void attempts.set(id, binding),
    ids,
    attempts,
  };
}

type Post = (url: string, init: RequestInit) => Response | Promise<Response>;

/** A fake Hub: answers /api/auth/me and /api/agents, hands POSTs to `post`. */
function fakeHub(
  opts: { userId?: string | null; me?: () => Response | Promise<Response>; post?: Post } = {},
) {
  return vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url.endsWith('/api/auth/me')) {
      if (opts.me) return opts.me();
      const id = opts.userId === undefined ? 'u1' : opts.userId;
      return json({ user: id ? { id } : null });
    }
    if (url.endsWith('/api/agents') && !init.method) return json(AGENTS);
    return (opts.post ?? (() => json({ id: 'sess-1' })))(url, init);
  });
}

function posts(fetchMock: ReturnType<typeof fakeHub>) {
  return fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST') as Array<
    [string, RequestInit]
  >;
}

const AGENTS = [
  { id: 'agent-hub-dev', name: 'Agent Hub Dev' },
  { id: 'agent-hub-qa', name: 'agent-hub QA' },
  { id: 'other-dev', name: 'Other Dev' },
];

describe('extractRequests', () => {
  it('reads the queue the addon writes', () => {
    const reqs = extractRequests(ADDON_OUTPUT);
    expect(reqs.map((r) => [r.agent, r.prompt])).toEqual([
      ['x', 'recent'],
      ['agent-hub-dev', 'fix the "flaky" test \\ now'],
      ['agent-hub-qa', 'run the smoke plan'],
    ]);
    expect(reqs[1].createdAt).toBe(1794082000);
  });

  it('drops entries without an id or prompt and tolerates a missing queue', () => {
    expect(
      extractRequests('AgentHubDB = { ["queue"] = { { ["id"] = "a" }, { ["prompt"] = "p" } } }'),
    ).toEqual([]);
    expect(extractRequests('AgentHubDB = { ["defaultAgent"] = "x" }')).toEqual([]);
    expect(extractRequests('SomethingElse = {}')).toEqual([]);
  });
});

describe('resolveAgent', () => {
  it('prefers exact id, then exact name, then a unique partial match', () => {
    expect(resolveAgent('agent-hub-dev', AGENTS)).toEqual({ agent: AGENTS[0] });
    expect(resolveAgent('AGENT HUB QA', AGENTS)).toEqual({ agent: AGENTS[1] });
    expect(resolveAgent('qa', AGENTS)).toEqual({ agent: AGENTS[1] });
  });

  it('refuses to guess between several matches', () => {
    const r = resolveAgent('dev', AGENTS);
    expect(r).toEqual({ error: expect.stringContaining('matches 2 agents') });
  });

  it('explains a missing or unknown agent', () => {
    expect(resolveAgent(null, AGENTS)).toEqual({ error: expect.stringContaining('/ah agent') });
    expect(resolveAgent('nope', AGENTS)).toEqual({ error: 'No agent matches "nope".' });
  });
});

describe('findSavedVariablesFiles', () => {
  it('finds the file under any flavor folder and account where the addon is installed', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'wow-'));
    const hit = path.join(root, '_forever_', 'WTF', 'Account', 'ACCT1', 'SavedVariables');
    mkdirSync(hit, { recursive: true });
    writeFileSync(path.join(hit, 'AgentHub.lua'), '');
    mkdirSync(path.join(root, '_forever_', 'Interface', 'AddOns', 'AgentHub'), { recursive: true });
    // Leftover queue in a flavor where the addon isn't installed.
    const leftover = path.join(root, '_classic_', 'WTF', 'Account', 'ACCT2', 'SavedVariables');
    mkdirSync(leftover, { recursive: true });
    writeFileSync(path.join(leftover, 'AgentHub.lua'), '');
    // Not a flavor folder.
    const data = path.join(root, 'Data', 'WTF', 'Account', 'X', 'SavedVariables');
    mkdirSync(data, { recursive: true });
    writeFileSync(path.join(data, 'AgentHub.lua'), '');
    mkdirSync(path.join(root, 'Data', 'Interface', 'AddOns', 'AgentHub'), { recursive: true });

    expect(findSavedVariablesFiles([root, path.join(root, 'missing')])).toEqual([
      path.join(hit, 'AgentHub.lua'),
    ]);
  });

  it('ignores a queue whose addon was removed', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'wow-'));
    const sv = path.join(
      root,
      '_forever_',
      'WTF',
      'Account',
      'A',
      'SavedVariables',
      'AgentHub.lua',
    );
    const addon = path.join(root, '_forever_', 'Interface', 'AddOns', 'AgentHub');
    mkdirSync(path.dirname(sv), { recursive: true });
    writeFileSync(sv, '');
    mkdirSync(addon, { recursive: true });
    expect(addonInstalledFor(sv)).toBe(true);

    rmSync(addon, { recursive: true });
    expect(addonInstalledFor(sv)).toBe(false);
    expect(findSavedVariablesFiles([root])).toEqual([]);
  });
});

describe('wowInstallRoots', () => {
  it('uses the override when set, else platform defaults', () => {
    expect(wowInstallRoots('darwin', { AGENT_HUB_WOW_DIR: '/games/wow' }, '/Users/me')).toEqual([
      '/games/wow',
    ]);
    expect(wowInstallRoots('darwin', {}, '/Users/me')).toContain('/Applications/World of Warcraft');
    expect(
      wowInstallRoots('win32', { 'ProgramFiles(x86)': 'D:\\Programs' }, 'C:\\Users\\me'),
    ).toContain('D:\\Programs\\World of Warcraft');
    expect(wowInstallRoots('linux', {}, '/home/me')).toEqual([]);
  });
});

describe('launchPending', () => {
  const target = { baseUrl: 'https://hub.example.com', headers: { Authorization: 'Bearer t' } };
  const req = (over: Partial<WowLaunchRequest> = {}): WowLaunchRequest => ({
    id: 'r1',
    agent: 'qa',
    sessionId: null,
    prompt: 'run the smoke plan',
    createdAt: NOW_MS / 1000 - 30,
    ...over,
  });

  it('creates the session with the prompt auto-started and remembers the id', async () => {
    const fetchImpl = fakeHub();
    const store = memoryStore();
    const out = await launchPending({ requests: [req()], target, store, fetchImpl, now: NOW_MS });

    expect(out).toEqual([
      expect.objectContaining({
        kind: 'launched',
        sessionId: 'sess-1',
        title: 'Started agent-hub QA',
      }),
    ]);
    const [[url, init]] = posts(fetchImpl);
    expect(url).toBe('https://hub.example.com/api/agents/agent-hub-qa/sessions');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer t' });
    expect(JSON.parse(init.body as string)).toEqual({
      name: 'run the smoke plan',
      autoTitle: true,
      seedMessage: 'run the smoke plan',
      autoStart: true,
    });
    expect(store.ids.has('r1')).toBe(true);
    expect(store.attempts.size).toBe(0);
  });

  it('retries a lost response with the same Idempotency-Key and records the replayed session', async () => {
    const store = memoryStore();
    // Attempt 1: the Hub creates the session but the response never arrives.
    const lost = fakeHub({
      post: () => {
        throw new Error('socket hang up');
      },
    });
    const first = await launchPending({
      requests: [req()],
      target,
      store,
      fetchImpl: lost,
      now: NOW_MS,
    });
    expect(first).toEqual([expect.objectContaining({ kind: 'retry', reason: 'socket hang up' })]);
    expect(store.ids.has('r1')).toBe(false);
    expect(store.attemptFor('r1')).toBe(hubBinding('https://hub.example.com', 'u1'));

    // Attempt 2: same Hub and account, same key; the Hub replays attempt 1.
    const replay = fakeHub();
    const second = await launchPending({
      requests: [req()],
      target,
      store,
      fetchImpl: replay,
      now: NOW_MS,
    });
    expect(second).toEqual([expect.objectContaining({ kind: 'launched', sessionId: 'sess-1' })]);
    expect(store.ids.has('r1')).toBe(true);

    const key = (f: ReturnType<typeof fakeHub>) =>
      (posts(f)[0][1].headers as Record<string, string>)['Idempotency-Key'];
    expect(key(lost)).toBe('wow-r1');
    expect(key(replay)).toBe('wow-r1');
  });

  it('after a lost response, never sends the request to another Hub or account', async () => {
    const store = memoryStore();
    const hubA = { baseUrl: 'https://a.example.com', headers: { Authorization: 'Bearer a' } };
    const hubB = { baseUrl: 'https://b.example.com', headers: { Authorization: 'Bearer b' } };
    const lost = fakeHub({
      post: () => {
        throw new Error('socket hang up');
      },
    });
    await launchPending({ requests: [req()], target: hubA, store, fetchImpl: lost, now: NOW_MS });

    // The desktop app now points at another Hub: wait, don't send.
    const onB = fakeHub();
    const switched = await launchPending({
      requests: [req()],
      target: hubB,
      store,
      fetchImpl: onB,
      now: NOW_MS,
    });
    expect(switched).toEqual([
      expect.objectContaining({
        kind: 'retry',
        reason: expect.stringContaining('https://a.example.com'),
      }),
    ]);
    expect(posts(onB)).toHaveLength(0);

    // Same Hub, different account: the Hub scopes keys per user, so also wait.
    const otherUser = fakeHub({ userId: 'u2' });
    const relogged = await launchPending({
      requests: [req()],
      target: hubA,
      store,
      fetchImpl: otherUser,
      now: NOW_MS,
    });
    expect(relogged).toEqual([expect.objectContaining({ kind: 'retry' })]);
    expect(posts(otherUser)).toHaveLength(0);

    // Back on the original Hub and account: the retry goes through there.
    const back = fakeHub();
    const done = await launchPending({
      requests: [req()],
      target: hubA,
      store,
      fetchImpl: back,
      now: NOW_MS,
    });
    expect(done).toEqual([expect.objectContaining({ kind: 'launched' })]);
    expect(posts(back)[0][0]).toBe('https://a.example.com/api/agents/agent-hub-qa/sessions');
  });

  it('does not POST until the binding is saved to disk', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'wow-state-'));
    const file = path.join(dir, 'state.json');
    let failWrites = 1;
    const store = createProcessedStore(file, (f, contents) => {
      if (failWrites-- > 0) throw new Error('disk full');
      writeFileSync(f, contents);
    });

    const first = fakeHub();
    const out = await launchPending({
      requests: [req()],
      target,
      store,
      fetchImpl: first,
      now: NOW_MS,
    });
    expect(out).toEqual([
      expect.objectContaining({ kind: 'retry', reason: expect.stringContaining('disk full') }),
    ]);
    expect(posts(first)).toHaveLength(0);
    // The failed write left no binding behind, in memory or on disk.
    expect(store.attemptFor('r1')).toBeNull();
    expect(createProcessedStore(file).attemptFor('r1')).toBeNull();

    // Next rescan: the write works, the binding is durable, then it sends.
    const second = fakeHub({
      post: () => {
        expect(createProcessedStore(file).attemptFor('r1')).toBe(
          hubBinding('https://hub.example.com', 'u1'),
        );
        return json({ id: 'sess-1' });
      },
    });
    const retried = await launchPending({
      requests: [req()],
      target,
      store,
      fetchImpl: second,
      now: NOW_MS,
    });
    expect(retried).toEqual([expect.objectContaining({ kind: 'launched' })]);
    expect(posts(second)).toHaveLength(1);
  });

  it('does not rerun a handled request after many others, even from another account', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'wow-state-'));
    const store = createProcessedStore(path.join(dir, 'state.json'));
    await launchPending({ requests: [req()], target, store, fetchImpl: fakeHub(), now: NOW_MS });
    for (let i = 0; i < 600; i++) store.add(`other-${i}`);

    // The same, unchanged queue is read again while signed in as someone else.
    const otherAccount = fakeHub({ userId: 'u2' });
    const out = await launchPending({
      requests: [req()],
      target,
      store,
      fetchImpl: otherAccount,
      now: NOW_MS,
    });
    expect(out).toEqual([]);
    expect(posts(otherAccount)).toHaveLength(0);
  });

  it('treats Hub paths that differ only in case as different Hubs', async () => {
    const store = memoryStore();
    const upper = { baseUrl: 'https://hub.example.com/Hub', headers: {} };
    const lower = { baseUrl: 'https://hub.example.com/hub', headers: {} };
    const lost = fakeHub({
      post: () => {
        throw new Error('socket hang up');
      },
    });
    await launchPending({ requests: [req()], target: upper, store, fetchImpl: lost, now: NOW_MS });
    const other = fakeHub();
    const out = await launchPending({
      requests: [req()],
      target: lower,
      store,
      fetchImpl: other,
      now: NOW_MS,
    });
    expect(out).toEqual([expect.objectContaining({ kind: 'retry' })]);
    expect(posts(other)).toHaveLength(0);
  });

  it('sends a reply only to the Hub and account its session came from', async () => {
    const store = memoryStore();
    const hubA = { baseUrl: 'https://a.example.com', headers: {} };
    const hubB = { baseUrl: 'https://b.example.com', headers: {} };
    const reply = req({
      id: 'rep-a',
      sessionId: 's-a',
      binding: hubBinding('https://a.example.com', 'u1'),
    });

    // Desktop switched to Hub B before the game refreshed: wait, don't send.
    const onB = fakeHub();
    const waiting = await launchPending({
      requests: [reply],
      target: hubB,
      store,
      fetchImpl: onB,
      now: NOW_MS,
    });
    expect(waiting).toEqual([expect.objectContaining({ kind: 'retry' })]);
    expect(posts(onB)).toHaveLength(0);
    expect(store.ids.has('rep-a')).toBe(false);

    // Same Hub, other account: also wait.
    const otherUser = fakeHub({ userId: 'u2' });
    await launchPending({
      requests: [reply],
      target: hubA,
      store,
      fetchImpl: otherUser,
      now: NOW_MS,
    });
    expect(posts(otherUser)).toHaveLength(0);

    // Back on A as u1: sent there.
    const onA = fakeHub({ post: () => json({ sessionId: 's-a', queued: false }, 202) });
    const sent = await launchPending({
      requests: [reply],
      target: hubA,
      store,
      fetchImpl: onA,
      now: NOW_MS,
    });
    expect(sent).toEqual([expect.objectContaining({ kind: 'launched' })]);
    expect(posts(onA)[0][0]).toBe('https://a.example.com/api/me/sessions/s-a/reply');
  });

  it('sends the Idempotency-Key on replies too', async () => {
    const fetchImpl = fakeHub({ post: () => json({ sessionId: 's-1', queued: false }, 202) });
    await launchPending({
      requests: [req({ id: 'rep', sessionId: 's-1' })],
      target,
      store: memoryStore(),
      fetchImpl,
      now: NOW_MS,
    });
    expect(posts(fetchImpl)[0][1].headers).toMatchObject({ 'Idempotency-Key': 'wow-rep' });
  });

  it('builds keys the Hub accepts from any addon id', () => {
    expect(idempotencyKeyFor(req({ id: '1794082000-041342' }))).toBe('wow-1794082000-041342');
    expect(idempotencyKeyFor(req({ id: 'weird id/!' }))).toBe('wow-weird_id__');
  });

  it('never launches the same request twice and skips the network when nothing is new', async () => {
    const fetchImpl = vi.fn();
    const out = await launchPending({
      requests: [req()],
      target,
      store: memoryStore(['r1']),
      fetchImpl,
      now: NOW_MS,
    });
    expect(out).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('silently retires requests older than a day', async () => {
    const fetchImpl = vi.fn();
    const store = memoryStore();
    const old = req({ createdAt: NOW_MS / 1000 - 2 * 86400 });
    expect(await launchPending({ requests: [old], target, store, fetchImpl, now: NOW_MS })).toEqual(
      [],
    );
    expect(store.ids.has('r1')).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('keeps the request for retry when signed out or the hub is down', async () => {
    const store = memoryStore();
    const signedOut = fakeHub({ me: () => json({ error: 'nope' }, 401) });
    const r1 = await launchPending({
      requests: [req()],
      target,
      store,
      fetchImpl: signedOut,
      now: NOW_MS,
    });
    expect(r1).toEqual([
      expect.objectContaining({ kind: 'retry', reason: expect.stringContaining('Sign in') }),
    ]);

    const down = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const r2 = await launchPending({
      requests: [req()],
      target,
      store,
      fetchImpl: down,
      now: NOW_MS,
    });
    expect(r2).toEqual([expect.objectContaining({ kind: 'retry', reason: 'ECONNREFUSED' })]);

    const serverError = fakeHub({ post: () => json({ error: 'boom' }, 503) });
    const r3 = await launchPending({
      requests: [req()],
      target,
      store,
      fetchImpl: serverError,
      now: NOW_MS,
    });
    expect(r3).toEqual([expect.objectContaining({ kind: 'retry', reason: 'boom' })]);

    expect(store.ids.size).toBe(0);
  });

  it('retires requests that can never succeed', async () => {
    const store = memoryStore();
    const fetchImpl = fakeHub({
      post: () => json({ error: 'Reviewer agent sessions are spawned by the GitHub webhook' }, 403),
    });
    const out = await launchPending({
      requests: [req({ id: 'ambiguous', agent: 'dev' }), req({ id: 'forbidden' })],
      target,
      store,
      fetchImpl,
      now: NOW_MS,
    });
    expect(out.map((o) => o.kind)).toEqual(['rejected', 'rejected']);
    expect([...store.ids]).toEqual(['ambiguous', 'forbidden']);
    expect(store.attempts.size).toBe(0);
  });

  it('waits when there is no hub to talk to', async () => {
    const out = await launchPending({
      requests: [req()],
      target: null,
      store: memoryStore(),
      now: NOW_MS,
    });
    expect(out).toEqual([expect.objectContaining({ kind: 'retry' })]);
  });
});

describe('createProcessedStore', () => {
  it('lists the most recent ids first', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'wow-state-'));
    const store = createProcessedStore(path.join(dir, 'state.json'));
    ['a', 'b', 'c'].forEach((id) => store.add(id));
    expect(store.recent(2)).toEqual(['c', 'b']);
  });

  it('persists where an attempt was sent until the id is processed', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'wow-state-'));
    const file = path.join(dir, 'state.json');
    createProcessedStore(file).bindAttempt('r1', 'https://a|u1');
    // A restarted desktop app still knows where r1 went.
    const reopened = createProcessedStore(file);
    expect(reopened.attemptFor('r1')).toBe('https://a|u1');
    reopened.add('r1');
    expect(createProcessedStore(file).attemptFor('r1')).toBeNull();
  });

  it('leaves memory unchanged when a write fails', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'wow-state-'));
    const failing = createProcessedStore(path.join(dir, 'state.json'), () => {
      throw new Error('EACCES');
    });
    expect(() => failing.bindAttempt('r1', 'https://a|u1')).toThrow('EACCES');
    expect(failing.attemptFor('r1')).toBeNull();
    expect(() => failing.add('r2')).toThrow('EACCES');
    expect(failing.has('r2')).toBe(false);
  });

  it('remembers processed ids for the whole window a request can run in, however many follow', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'wow-state-'));
    const file = path.join(dir, 'state.json');
    let now = NOW_MS;
    const store = createProcessedStore(file, writeFileSync, () => now);
    store.add('first');
    for (let i = 0; i < 600; i++) store.add(`other-${i}`);
    expect(createProcessedStore(file).has('first')).toBe(true);

    // Two days on, nothing can still run it; the next write prunes it.
    now += 2 * 24 * 60 * 60 * 1000 + 1;
    store.add('later');
    expect(store.has('first')).toBe(false);
    expect(store.has('later')).toBe(true);
  });

  it('keeps the path case in a binding', () => {
    expect(hubBinding('https://Hub.Example.com/Hub/', 'u1')).toBe('https://hub.example.com/Hub|u1');
    expect(hubBinding('https://hub.example.com/Hub', 'u1')).not.toBe(
      hubBinding('https://hub.example.com/hub', 'u1'),
    );
  });

  it('scopes bindings by Hub and account like the server scopes keys', () => {
    expect(hubBinding('https://Hub.example.com/', 'u1')).toBe('https://hub.example.com|u1');
    expect(hubBinding('https://hub.example.com', null)).toBe('https://hub.example.com|shared');
  });

  it('persists ids across instances and survives a corrupt file', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'wow-state-'));
    const file = path.join(dir, 'nested', 'wow-bridge.json');
    const a = createProcessedStore(file);
    expect(a.has('x')).toBe(false);
    a.add('x');
    expect(createProcessedStore(file).has('x')).toBe(true);

    writeFileSync(file, '{not json');
    expect(createProcessedStore(file).has('x')).toBe(false);
  });
});

describe('replies', () => {
  const target = { baseUrl: 'https://hub.example.com', headers: { 'X-API-Key': 'k' } };

  it('extracts a reply target from the queue', () => {
    const reqs = extractRequests(
      'AgentHubDB = { ["queue"] = { { ["id"] = "r", ["sessionId"] = "s-1", ["prompt"] = "go" } } }',
    );
    expect(reqs).toEqual([
      { id: 'r', agent: null, sessionId: 's-1', binding: null, prompt: 'go', createdAt: null },
    ]);
    const bound = extractRequests(
      'AgentHubDB = { ["queue"] = { { ["id"] = "r", ["sessionId"] = "s", ["binding"] = "https://a|u1", ["prompt"] = "go" } } }',
    );
    expect(bound[0].binding).toBe('https://a|u1');
  });

  it('posts to the session reply endpoint without fetching agents', async () => {
    const fetchImpl = fakeHub({ post: () => json({ sessionId: 's-1', queued: true }, 202) });
    const store = memoryStore();
    const out = await launchPending({
      requests: [{ id: 'r', agent: null, sessionId: 's-1', prompt: 'ship it', createdAt: null }],
      target,
      store,
      fetchImpl,
    });
    expect(out).toEqual([
      expect.objectContaining({ kind: 'launched', title: 'Reply sent', sessionId: 's-1' }),
    ]);
    expect(fetchImpl.mock.calls.some(([url]) => url.endsWith('/api/agents'))).toBe(false);
    const [[url, init]] = posts(fetchImpl);
    expect(url).toBe('https://hub.example.com/api/me/sessions/s-1/reply');
    expect(JSON.parse(init.body as string)).toEqual({ content: 'ship it' });
    expect(store.ids.has('r')).toBe(true);
  });

  it('gives up on a reply to a session that is gone', async () => {
    const fetchImpl = fakeHub({ post: () => json({ error: 'Session not found' }, 404) });
    const store = memoryStore();
    const out = await launchPending({
      requests: [{ id: 'r', agent: null, sessionId: 'gone', prompt: 'hi', createdAt: null }],
      target,
      store,
      fetchImpl,
    });
    expect(out).toEqual([
      expect.objectContaining({ kind: 'rejected', reason: 'Session not found' }),
    ]);
    expect(store.ids.has('r')).toBe(true);
  });
});

describe('session snapshot', () => {
  const session: RecentSession = {
    id: 's-1',
    name: 'Fix "flaky" test',
    agentName: 'Agent Hub Dev',
    projectName: 'agent-hub',
    state: 'working',
    updatedAt: '2026-11-07 20:00:00',
    lastReply: 'Done.\nPath C:\\tmp | pipes',
    messages: [
      { role: 'user', content: 'fix it', createdAt: '2026-11-07 19:59:00' },
      { role: 'assistant', content: 'Done.\tbell\x07', createdAt: '2026-11-07T20:00:00.000Z' },
    ],
  };

  it('renders Lua that reads back to the same data', () => {
    const src = renderDataLua([session], Date.UTC(2026, 10, 7, 20, 5));
    const data = parseSavedVariables(src).AgentHubData as Record<string, never>;
    expect(data.updatedAt).toBe(Date.UTC(2026, 10, 7, 20, 5) / 1000);
    const [s] = luaList(data.sessions) as Array<Record<string, never>>;
    expect(s).toMatchObject({
      id: 's-1',
      name: 'Fix "flaky" test',
      agent: 'Agent Hub Dev',
      state: 'working',
      updatedAt: Date.UTC(2026, 10, 7, 20) / 1000,
      lastReply: 'Done.\nPath C:\\tmp | pipes',
    });
    const msgs = luaList(s.messages) as Array<Record<string, unknown>>;
    expect(msgs.map((m) => m.content)).toEqual(['fix it', 'Done.\tbell\x07']);
    expect(msgs[1].at).toBe(Date.UTC(2026, 10, 7, 20) / 1000);
  });

  it('publishes handled request ids for the addon to acknowledge', () => {
    const data = parseSavedVariables(renderDataLua([], 0, ['a-1', 'b"2'])).AgentHubData as Record<
      string,
      never
    >;
    expect(luaList(data.handled)).toEqual(['a-1', 'b"2']);
    expect(luaList(data.sessions)).toEqual([]);
  });

  it('stamps the snapshot with its Hub and account', () => {
    const data = parseSavedVariables(renderDataLua([], 0, [], 'https://a|u1'))
      .AgentHubData as Record<string, never>;
    expect(data.binding).toBe('https://a|u1');
    expect(
      (parseSavedVariables(renderDataLua([], 0)).AgentHubData as Record<string, unknown>).binding,
    ).toBeUndefined();
  });

  it('reuses a cached list only for the same Hub and account', () => {
    const cached = { sessions: [session], at: 5, binding: 'https://a|u1' };
    // Fresh data wins.
    expect(chooseSnapshot(cached, { binding: 'https://a|u1', sessions: [] }, 9)).toEqual({
      sessions: [],
      at: 9,
      binding: 'https://a|u1',
    });
    // Same account, list fetch failed: keep the cache.
    expect(chooseSnapshot(cached, { binding: 'https://a|u1', sessions: null }, 9)).toBe(cached);
    // Switched Hub or account, or identity unknown: show nothing.
    const empty = { sessions: [], at: 0, binding: null };
    expect(chooseSnapshot(cached, { binding: 'https://b|u1', sessions: null }, 9)).toEqual(empty);
    expect(chooseSnapshot(cached, { binding: 'https://a|u2', sessions: null }, 9)).toEqual(empty);
    expect(chooseSnapshot(cached, { binding: null, sessions: null }, 9)).toEqual(empty);
  });

  it('keeps one value per line and escapes control characters', () => {
    expect(luaString('a"b\\c\nd\re\x00')).toBe('"a\\"b\\\\c\\nd\\013e\\000"');
    expect(
      renderDataLua([session], 0)
        .split('\n')
        .every((l) => !l.includes('\r')),
    ).toBe(true);
  });

  it('parses SQLite and ISO timestamps', () => {
    expect(toUnixSeconds('2026-11-07 20:00:00')).toBe(Date.UTC(2026, 10, 7, 20) / 1000);
    expect(toUnixSeconds('2026-11-07T20:00:00Z')).toBe(Date.UTC(2026, 10, 7, 20) / 1000);
    expect(toUnixSeconds('garbage')).toBe(0);
    expect(toUnixSeconds(null)).toBe(0);
  });

  it('fetches recent sessions and returns null when the hub fails', async () => {
    const target = { baseUrl: 'https://hub.example.com', headers: {} };
    const ok = vi.fn().mockResolvedValue(json({ sessions: [session] }));
    expect(await fetchRecentSessions(target, ok)).toEqual([session]);
    expect(ok.mock.calls[0][0]).toBe(
      'https://hub.example.com/api/me/sessions/recent?limit=20&messages=4&maxChars=600',
    );
    expect(await fetchRecentSessions(target, vi.fn().mockResolvedValue(json({}, 401)))).toBeNull();
    expect(await fetchRecentSessions(target, vi.fn().mockRejectedValue(new Error('x')))).toBeNull();
  });

  it('finds installed copies of the addon', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'wow-addon-'));
    const installed = path.join(root, '_forever_', 'Interface', 'AddOns', 'AgentHub');
    mkdirSync(installed, { recursive: true });
    mkdirSync(path.join(root, '_retail_', 'Interface', 'AddOns', 'Other'), { recursive: true });
    expect(findAddonDirs([root])).toEqual([installed]);
  });
});
