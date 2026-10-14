/**
 * Scheduled channel digests: window selection, due selection, skip-on-empty,
 * posting with ref chips, and failure handling. The model is always mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { tmpdir } from 'os';
import { mkdtempSync } from 'fs';
import path from 'path';
import type { AppConfig, Project } from './types.js';
import type { OneShotFailoverOutcome } from './one-shot-failover.js';

const { initDb, getDb } = await import('./db.js');
const { initOrgsDb, setOrgsDbPathForTests, createOrg, setActiveOrgId } = await import('./orgs.js');
const { createUser } = await import('./users-store.js');
const { createMembership } = await import('./memberships-store.js');
const chat = await import('./hub-chat-store.js');
const digestStore = await import('./hub-chat-digests-store.js');
const digests = await import('./hub-chat-digests.js');
const { runDailySummaryScheduleTick, resetDailySummaryFiredGuard } =
  await import('./daily-summary-schedule.js');

type Row = import('./hub-chat-digests-store.js').ChannelDigestRow;

let alice = '';
let bob = '';
const project = { id: 'web', name: 'Web', cwd: '/tmp', agents: [] } as unknown as Project;

beforeEach(() => {
  const dir = mkdtempSync(path.join(tmpdir(), 'hub-chat-digests-'));
  initDb(dir);
  setOrgsDbPathForTests(path.join(dir, 'orgs.db'));
  initOrgsDb();
  createOrg({ id: 'acme', name: 'Acme', mode: 'remote' });
  setActiveOrgId('acme');
  alice = createUser({ username: 'alice', passwordHash: 'x' }).id;
  bob = createUser({ username: 'bob', passwordHash: 'x' }).id;
  createMembership(alice, 'acme', 'Owner');
  createMembership(bob, 'acme', 'User');
  digests.resetChannelDigestGuards();
  resetDailySummaryFiredGuard();
});

function row(extra: Partial<Row> = {}): Row {
  return {
    channel_id: 'c1',
    enabled: 1,
    cron: '0 9 * * *',
    time_zone: 'UTC',
    scope: 'channel',
    project_id: null,
    owner_user_id: 'u1',
    window_start: '2026-10-13T09:00:00.000Z',
    last_run_at: null,
    last_status: null,
    last_error: null,
    last_message_id: null,
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
    ...extra,
  };
}

function outcome(output: string, code: number | null = 0): OneShotFailoverOutcome {
  return {
    engine: 'claude-code',
    model: 'm',
    output,
    detailed: { code, stdout: output, stderr: code ? 'boom' : '' },
    failovers: [],
  } as unknown as OneShotFailoverOutcome;
}

function runDeps(output = 'All quiet.', code: number | null = 0) {
  const runFailover = vi.fn().mockResolvedValue(outcome(output, code));
  return {
    runFailover,
    deps: {
      config: {} as AppConfig,
      cwd: tmpdir(),
      broadcast: vi.fn(),
      findProject: (id: string) => (id === project.id ? project : null),
      getProjects: () => [project],
      ownerCanViewProject: () => true,
      resolveEngine: vi.fn().mockResolvedValue({ engine: 'claude-code', model: 'm' }) as never,
      runFailover,
      log: () => undefined,
    },
  };
}

function channelWithDigest(
  extra: Partial<import('./hub-chat-digests-store.js').UpsertChannelDigestInput> = {},
) {
  const channel = chat.createChannel({
    orgId: 'acme',
    kind: 'channel',
    name: 'ops',
    createdByUserId: alice,
    memberUserIds: [bob],
  });
  const digest = digestStore.upsertChannelDigest({
    channelId: channel.id,
    enabled: true,
    cron: '0 9 * * *',
    timeZone: 'UTC',
    scope: 'channel',
    projectId: null,
    ownerUserId: alice,
    ...extra,
  });
  return { channel, digest };
}

function setCreatedAt(messageId: string, iso: string) {
  getDb().prepare('UPDATE hub_chat_messages SET created_at = ? WHERE id = ?').run(iso, messageId);
}

describe('digestWindow', () => {
  const now = new Date('2026-10-14T09:00:00.000Z');

  it('runs from the stored cursor to now', () => {
    expect(digests.digestWindow(row({ window_start: '2026-10-14T08:00:00.000Z' }), now)).toEqual({
      start: '2026-10-14T08:00:00.000Z',
      end: '2026-10-14T09:00:00.000Z',
    });
  });

  it('does not cut off a cursor that has been stuck for a long time', () => {
    const w = digests.digestWindow(row({ window_start: '2026-01-01T00:00:00.000Z' }), now);
    expect(w.start).toBe('2026-01-01T00:00:00.000Z');
  });

  it('never starts after it ends', () => {
    const w = digests.digestWindow(row({ window_start: '2027-01-01T00:00:00.000Z' }), now);
    expect(w).toEqual({ start: now.toISOString(), end: now.toISOString() });
  });
});

describe('digest cursor', () => {
  it('a new digest starts one default lookback before it was saved', () => {
    const { digest } = channelWithDigest({ now: new Date('2026-10-14T09:00:00.000Z') });
    expect(digest.window_start).toBe('2026-10-13T09:00:00.000Z');
  });

  it('editing keeps the cursor; re-enabling a paused digest restarts it', () => {
    const { channel } = channelWithDigest({ now: new Date('2026-10-01T00:00:00.000Z') });
    const base = {
      channelId: channel.id,
      cron: '0 17 * * *',
      timeZone: 'UTC',
      scope: 'channel' as const,
      projectId: null,
      ownerUserId: alice,
    };
    const edited = digestStore.upsertChannelDigest({
      ...base,
      enabled: true,
      now: new Date('2026-10-14T09:00:00.000Z'),
    });
    expect(edited.window_start).toBe('2026-09-30T00:00:00.000Z');
    digestStore.upsertChannelDigest({ ...base, enabled: false });
    const resumed = digestStore.upsertChannelDigest({
      ...base,
      enabled: true,
      now: new Date('2026-10-14T09:00:00.000Z'),
    });
    expect(resumed.window_start).toBe('2026-10-13T09:00:00.000Z');
  });

  it('a failed first run is retried over the same span on the next scheduled day', async () => {
    // Daily at 09:00. Created Oct 14 08:00, so the first window opens Oct 13 08:00.
    const { channel, digest } = channelWithDigest({ now: new Date('2026-10-14T08:00:00.000Z') });
    const early = chat.appendMessage({
      channelId: channel.id,
      authorKind: 'user',
      authorUserId: bob,
      body: 'Oct 13 incident report',
    });
    setCreatedAt(early.id, '2026-10-13T12:00:00.000Z');

    const failing = runDeps('', 1);
    const first = await digests.runChannelDigest(
      digest,
      new Date('2026-10-14T09:00:00.000Z'),
      failing.deps,
    );
    expect(first.status).toBe('error');
    const stuck = digestStore.getChannelDigest(channel.id) as Row;
    expect(stuck.window_start).toBe('2026-10-13T08:00:00.000Z');

    const retry = runDeps('Incident on Oct 13.');
    const second = await digests.runChannelDigest(
      stuck,
      new Date('2026-10-15T09:00:00.000Z'),
      retry.deps,
    );
    expect(second.status).toBe('posted');
    const prompt = retry.runFailover.mock.calls[0]?.[0].prompt as string;
    expect(prompt).toContain('between 2026-10-13T08:00:00.000Z and 2026-10-15T09:00:00.000Z');
    expect(prompt).toContain('Oct 13 incident report');
    expect(digestStore.getChannelDigest(channel.id)?.window_start).toBe('2026-10-15T09:00:00.000Z');
  });

  it('a run whose window no longer starts at the cursor changes nothing', async () => {
    const { channel, digest } = channelWithDigest();
    // Another run already closed this window.
    expect(
      digestStore.advanceChannelDigestWindow(channel.id, digest.window_start, {
        status: 'skipped',
        windowEnd: new Date().toISOString(),
      }),
    ).toBe(true);
    const { deps } = runDeps();
    const result = await digests.runChannelDigest(digest, new Date(Date.now() + 1000), deps);
    expect(result.status).toBe('cancelled');
  });
});

describe('selectDueChannelDigests', () => {
  const now = new Date('2026-10-14T16:00:30Z'); // 09:00 in Los Angeles

  it('fires digests whose cron matches the minute in their own timezone', () => {
    const due = digests.selectDueChannelDigests(now, [
      row({ channel_id: 'la', time_zone: 'America/Los_Angeles' }),
      row({ channel_id: 'utc' }),
      row({ channel_id: 'off', enabled: 0, time_zone: 'America/Los_Angeles' }),
      row({ channel_id: 'bad', cron: 'nope', time_zone: 'America/Los_Angeles' }),
    ]);
    expect(due.map((d) => d.channel_id)).toEqual(['la']);
  });

  it('does not fire twice in the same minute', () => {
    const due = digests.selectDueChannelDigests(now, [
      row({ time_zone: 'America/Los_Angeles', last_run_at: '2026-10-14T16:00:05.000Z' }),
    ]);
    expect(due).toEqual([]);
  });
});

describe('collectChannelDigestFacts', () => {
  it('includes live messages in the window and leaves out earlier digests', () => {
    const { channel } = channelWithDigest();
    const inWindow = chat.appendMessage({
      channelId: channel.id,
      authorKind: 'user',
      authorUserId: bob,
      body: 'deploy is green',
    });
    const before = chat.appendMessage({
      channelId: channel.id,
      authorKind: 'user',
      authorUserId: bob,
      body: 'too old',
    });
    const deleted = chat.appendMessage({
      channelId: channel.id,
      authorKind: 'user',
      authorUserId: bob,
      body: 'gone',
    });
    const digest = chat.appendMessage({
      channelId: channel.id,
      authorKind: 'system',
      body: 'previous digest',
      payload: { type: digests.CHANNEL_DIGEST_PAYLOAD_TYPE },
    });
    setCreatedAt(inWindow.id, '2026-10-14T08:30:00.000Z');
    setCreatedAt(before.id, '2026-10-14T07:59:59.000Z');
    setCreatedAt(deleted.id, '2026-10-14T08:31:00.000Z');
    setCreatedAt(digest.id, '2026-10-14T08:32:00.000Z');
    chat.softDeleteMessage(deleted.id);

    const facts = digests.collectChannelDigestFacts(channel.id, {
      start: '2026-10-14T08:00:00.000Z',
      end: '2026-10-14T09:00:00.000Z',
    });
    expect(facts.items.map((i) => i.line)).toEqual([
      '[2026-10-14T08:30:00.000Z] bob: deploy is green',
    ]);
  });
});

describe('runChannelDigest', () => {
  it('skips an empty window without calling the model and advances the cursor', async () => {
    const { channel, digest } = channelWithDigest();
    const { deps, runFailover } = runDeps();
    const now = new Date();
    const result = await digests.runChannelDigest(digest, now, deps);
    expect(result).toEqual({ status: 'skipped', reason: 'empty_window' });
    expect(runFailover).not.toHaveBeenCalled();
    expect(chat.listMessages(channel.id)).toHaveLength(0);
    const after = digestStore.getChannelDigest(channel.id);
    expect(after?.last_status).toBe('skipped');
    expect(after?.last_run_at).toBe(now.toISOString());
  });

  it('a digest alone does not count as activity for the next one', async () => {
    const { channel, digest } = channelWithDigest();
    chat.appendMessage({
      channelId: channel.id,
      authorKind: 'user',
      authorUserId: bob,
      body: 'hi',
    });
    const { deps, runFailover } = runDeps('Bob said hi.');
    const first = await digests.runChannelDigest(digest, new Date(Date.now() + 1000), deps);
    expect(first.status).toBe('posted');
    const next = digestStore.getChannelDigest(channel.id) as Row;
    const second = await digests.runChannelDigest(next, new Date(Date.now() + 61_000), deps);
    expect(second.status).toBe('skipped');
    expect(runFailover).toHaveBeenCalledTimes(1);
  });

  it('posts a project digest as a system message with ref chips', async () => {
    const db = getDb();
    db.prepare(
      'INSERT INTO kanban_boards (id, project_id, name, card_prefix) VALUES (?, ?, ?, ?)',
    ).run('b1', 'web', 'Board', 'WEB');
    db.prepare('INSERT INTO kanban_columns (id, board_id, name, position) VALUES (?, ?, ?, ?)').run(
      'col1',
      'b1',
      'In Progress',
      0,
    );
    db.prepare('INSERT INTO kanban_cards (id, column_id, board_id, title) VALUES (?, ?, ?, ?)').run(
      'card1',
      'col1',
      'b1',
      'Fix login',
    );
    const { channel, digest } = channelWithDigest({ scope: 'project', projectId: 'web' });
    // The model drops the token, so the footer carries the chip.
    const { deps, runFailover } = runDeps('Login work started.');
    const result = await digests.runChannelDigest(digest, new Date(Date.now() + 1000), deps);
    expect(result.status).toBe('posted');
    const prompt = runFailover.mock.calls[0]?.[0].prompt as string;
    expect(prompt).toContain('(card:card1)');
    expect(prompt).toContain('Fix login');

    const [message] = chat.listMessages(channel.id);
    expect(message?.author_kind).toBe('system');
    expect(message?.body).toContain('Login work started.');
    expect(message?.body).toMatch(/Refs: @\[[^\]]+\]\(card:card1\)/);
    expect(chat.listRefs(message!.id).map((r) => [r.kind, r.target_id])).toEqual([
      ['card', 'card1'],
    ]);
    expect(JSON.parse(message!.payload_json!)).toMatchObject({
      type: digests.CHANNEL_DIGEST_PAYLOAD_TYPE,
      scope: 'project',
      projectId: 'web',
    });
    expect(deps.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'hub_chat_message' }),
    );
    expect(digestStore.getChannelDigest(channel.id)?.last_message_id).toBe(message!.id);
  });

  it('keeps the cursor when the model fails, so the window is retried', async () => {
    const { channel, digest } = channelWithDigest();
    chat.appendMessage({
      channelId: channel.id,
      authorKind: 'user',
      authorUserId: bob,
      body: 'hi',
    });
    const { deps } = runDeps('', 1);
    const result = await digests.runChannelDigest(digest, new Date(Date.now() + 1000), deps);
    expect(result.status).toBe('error');
    const after = digestStore.getChannelDigest(channel.id);
    expect(after?.last_status).toBe('error');
    expect(after?.last_run_at).toBeNull();
    expect(after?.window_start).toBe(digest.window_start);
    expect(chat.listMessages(channel.id).map((m) => m.author_kind)).toEqual(['user']);
  });

  it('refuses to run once the owner has left the channel', async () => {
    const { channel, digest } = channelWithDigest();
    chat.appendMessage({
      channelId: channel.id,
      authorKind: 'user',
      authorUserId: bob,
      body: 'hi',
    });
    chat.removeMember(channel.id, alice);
    const { deps, runFailover } = runDeps();
    const result = await digests.runChannelDigest(digest, new Date(), deps);
    expect(result.status).toBe('error');
    expect(runFailover).not.toHaveBeenCalled();
  });

  it('refuses a project digest the owner can no longer view', async () => {
    const { digest } = channelWithDigest({ scope: 'project', projectId: 'web' });
    const { deps, runFailover } = runDeps();
    const result = await digests.runChannelDigest(digest, new Date(), {
      ...deps,
      ownerCanViewProject: () => false,
    });
    expect(result.status).toBe('error');
    expect(runFailover).not.toHaveBeenCalled();
  });
});

describe('runChannelDigest after a slow model run', () => {
  function deferredDeps() {
    let resolve!: (o: OneShotFailoverOutcome) => void;
    const pending = new Promise<OneShotFailoverOutcome>((r) => {
      resolve = r;
    });
    const { deps } = runDeps();
    return {
      deps: { ...deps, runFailover: vi.fn(() => pending) },
      finish: () => resolve(outcome('Bob said hi.')),
    };
  }

  async function raceWith(change: (channelId: string) => void, extra = {}) {
    const { channel, digest } = channelWithDigest(extra);
    chat.appendMessage({
      channelId: channel.id,
      authorKind: 'user',
      authorUserId: bob,
      body: 'hi',
    });
    const { deps, finish } = deferredDeps();
    const running = digests.runChannelDigest(digest, new Date(Date.now() + 1000), deps);
    await vi.waitFor(() => expect(deps.runFailover).toHaveBeenCalled());
    change(channel.id);
    finish();
    const result = await running;
    const systemPosts = chat.listMessages(channel.id).filter((m) => m.author_kind === 'system');
    return { result, systemPosts, after: digestStore.getChannelDigest(channel.id), deps };
  }

  it('does not post when the digest is removed mid-run', async () => {
    const { result, systemPosts } = await raceWith((id) => digestStore.deleteChannelDigest(id));
    expect(result.status).toBe('cancelled');
    expect(systemPosts).toHaveLength(0);
  });

  it('does not post when the digest is disabled mid-run', async () => {
    const { result, systemPosts } = await raceWith((id) => {
      const d = digestStore.getChannelDigest(id)!;
      getDb()
        .prepare('UPDATE hub_chat_channel_digests SET enabled = 0 WHERE channel_id = ?')
        .run(d.channel_id);
    });
    expect(result.status).toBe('cancelled');
    expect(systemPosts).toHaveLength(0);
  });

  it("leaves a replacement digest's cursor and status alone", async () => {
    const { result, systemPosts, after } = await raceWith((id) => {
      getDb()
        .prepare(
          `UPDATE hub_chat_channel_digests SET owner_user_id = ?, cron = '0 17 * * *',
             updated_at = '2099-01-01T00:00:00.000Z' WHERE channel_id = ?`,
        )
        .run(bob, id);
    });
    expect(result.status).toBe('cancelled');
    expect(systemPosts).toHaveLength(0);
    expect(after?.last_run_at).toBeNull();
    expect(after?.last_status).toBeNull();
  });

  it('does not post when the owner leaves the channel mid-run', async () => {
    const { result, systemPosts, after } = await raceWith((id) => chat.removeMember(id, alice));
    expect(result.status).toBe('cancelled');
    expect(systemPosts).toHaveLength(0);
    expect(after?.last_run_at).toBeNull();
  });

  it('does not post when the owner loses project access mid-run', async () => {
    getDb()
      .prepare('INSERT INTO kanban_boards (id, project_id, name, card_prefix) VALUES (?, ?, ?, ?)')
      .run('b9', 'web', 'Board', 'WEB');
    getDb()
      .prepare('INSERT INTO kanban_columns (id, board_id, name, position) VALUES (?, ?, ?, ?)')
      .run('col9', 'b9', 'To Do', 0);
    getDb()
      .prepare('INSERT INTO kanban_cards (id, column_id, board_id, title) VALUES (?, ?, ?, ?)')
      .run('card9', 'col9', 'b9', 'Thing');
    const { channel, digest } = channelWithDigest({ scope: 'project', projectId: 'web' });
    let allowed = true;
    const { deps, finish } = deferredDeps();
    const running = digests.runChannelDigest(digest, new Date(Date.now() + 1000), {
      ...deps,
      ownerCanViewProject: () => allowed,
    });
    await vi.waitFor(() => expect(deps.runFailover).toHaveBeenCalled());
    allowed = false;
    finish();
    expect((await running).status).toBe('cancelled');
    expect(chat.listMessages(channel.id)).toHaveLength(0);
  });

  it('still posts when nothing changed during the run', async () => {
    const { result, systemPosts } = await raceWith(() => undefined);
    expect(result.status).toBe('posted');
    expect(systemPosts).toHaveLength(1);
  });
});

describe('schedule tick', () => {
  it('runs due digests from the daily-summary ticker', async () => {
    const { channel } = channelWithDigest({ cron: '30 16 * * *' });
    const run = vi.fn().mockResolvedValue({ status: 'skipped', reason: 'empty_window' });
    const now = new Date('2026-10-14T16:30:10Z');
    await runDailySummaryScheduleTick({
      routeDeps: {} as never,
      listSchedules: () => [],
      generate: vi.fn(),
      now: () => now,
      onTick: (t) => digests.runChannelDigestTick(t, { ...runDeps().deps, run }),
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[0].channel_id).toBe(channel.id);
    // A second tick in the same minute does not start it again.
    await digests.runChannelDigestTick(now, { ...runDeps().deps, run });
    expect(run).toHaveBeenCalledTimes(1);
  });
});
