/**
 * Daily summary schedules become my_work digests on the user's Summaries
 * channel: cron collapsing, idempotency, and exactly one post on the day the
 * conversion happens. Also covers the scope CHECK rebuild that lets an
 * existing `hub_chat_digests` table hold `my_work` rows. The model is mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { tmpdir } from 'os';
import { mkdtempSync } from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import type { AppConfig } from './types.js';
import type { OneShotFailoverOutcome } from './one-shot-failover.js';

const { initDb, getDb } = await import('./db.js');
const { initOrgsDb, setOrgsDbPathForTests, createOrg, setActiveOrgId } = await import('./orgs.js');
const { createUser } = await import('./users-store.js');
const { createMembership } = await import('./memberships-store.js');
const { mergeUserPreferencesJson } = await import('./user-preferences-store.js');
const chat = await import('./hub-chat-store.js');
const { findSummaryChannel } = await import('./hub-chat-summaries.js');
const digestStore = await import('./hub-chat-digests-store.js');
const digests = await import('./hub-chat-digests.js');
const { runDailySummaryScheduleTick } = await import('./daily-summary-schedule.js');
const { HUB_CHAT_SCHEMA, migrateHubChatDigestsScopeCheck } = await import('./hub-chat-schema.js');
const { splitDigestCron } = await import('../shared/utils/chatDigest.js');
const {
  DAILY_SUMMARY_MIGRATION_BLOCKED_PAYLOAD_TYPE,
  LEGACY_DAILY_SUMMARY_PAYLOAD_TYPE,
  dailySummaryTimesToCrons,
  migrateDailySummarySchedules,
  isDailySummaryScheduleMigrated,
} = await import('./hub-chat-daily-summary-migration.js');

let alice = '';
let bob = '';

beforeEach(() => {
  const dir = mkdtempSync(path.join(tmpdir(), 'daily-summary-migration-'));
  initDb(dir);
  setOrgsDbPathForTests(path.join(dir, 'orgs.db'));
  initOrgsDb();
  createOrg({ id: 'acme', name: 'Acme', mode: 'remote' });
  setActiveOrgId('acme');
  alice = createUser({ username: 'alice', passwordHash: 'x' }).id;
  bob = createUser({ username: 'bob', passwordHash: 'x' }).id;
  createMembership(alice, 'acme', 'User');
  createMembership(bob, 'acme', 'User');
  digests.resetChannelDigestGuards();
});

function schedule(userId: string, times: string[], enabled = true, timeZone = 'UTC') {
  mergeUserPreferencesJson(userId, { hubDailySummarySchedule: { enabled, timeZone, times } });
}

function summaryDigests(userId: string) {
  const channel = findSummaryChannel('acme', userId);
  return channel ? digestStore.listChannelDigests(channel.id) : [];
}

describe('dailySummaryTimesToCrons', () => {
  it('collapses times that share a minute into one cron', () => {
    expect(dailySummaryTimesToCrons(['17:00', '08:00'])).toEqual(['0 8,17 * * *']);
  });

  it('gives each other minute its own cron', () => {
    expect(dailySummaryTimesToCrons(['08:00', '09:30', '17:00', '18:30'])).toEqual([
      '0 8,17 * * *',
      '30 9,18 * * *',
    ]);
  });

  it('ignores malformed times', () => {
    expect(dailySummaryTimesToCrons(['8am', '07:15'])).toEqual(['15 7 * * *']);
  });

  it('groups by hour when that needs fewer crons', () => {
    expect(dailySummaryTimesToCrons(['08:00', '08:15', '08:30', '08:45'])).toEqual([
      '0,15,30,45 8 * * *',
    ]);
  });

  it('mixes hour and minute groupings when neither alone is smallest', () => {
    expect(
      dailySummaryTimesToCrons(['08:00', '08:15', '09:00', '09:15', '09:30', '10:30']),
    ).toEqual(['0,15 8,9 * * *', '30 9,10 * * *']);
  });

  it('never fires a time twice or a time that was not configured', () => {
    const times = ['06:05', '06:40', '07:05', '07:40', '07:50', '11:50', '13:05', '23:59'];
    const fired: string[] = [];
    for (const cron of dailySummaryTimesToCrons(times)) {
      const [minutes, hours] = cron.split(' ');
      for (const h of hours.split(','))
        for (const m of minutes.split(','))
          fired.push(`${h.padStart(2, '0')}:${m.padStart(2, '0')}`);
    }
    expect(fired.sort()).toEqual([...times].sort());
  });

  it('merges groups that share the same set, so every cron fires only at given times', () => {
    expect(dailySummaryTimesToCrons(['08:00', '08:30', '17:00', '17:30'])).toEqual([
      '0,30 8,17 * * *',
    ]);
  });
});

describe('migrateDailySummarySchedules', () => {
  it('creates the Summaries channel and one my_work digest holding every time', () => {
    schedule(alice, ['08:00', '17:00', '12:30'], true, 'America/New_York');
    expect(findSummaryChannel('acme', alice)).toBeNull();

    expect(migrateDailySummarySchedules()).toEqual([alice]);

    const rows = summaryDigests(alice);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      cron: '0 8,17 * * * | 30 12 * * *',
      scope: 'my_work',
      enabled: 1,
      time_zone: 'America/New_York',
      owner_user_id: alice,
      prompt: null,
      name: 'Daily summary',
    });
    expect(isDailySummaryScheduleMigrated(alice)).toBe(true);
  });

  it('converts 12 times that share no hour or minute into one digest', () => {
    const times = Array.from(
      { length: 12 },
      (_, i) => `${String(i * 2).padStart(2, '0')}:${String(i * 5 + 1).padStart(2, '0')}`,
    );
    schedule(alice, times);

    expect(migrateDailySummarySchedules()).toEqual([alice]);

    const rows = summaryDigests(alice);
    expect(rows).toHaveLength(1);
    expect(splitDigestCron(rows[0].cron)).toHaveLength(12);
    // Every configured time fires, and only those.
    for (const t of times) {
      const due = digests.selectDueChannelDigests(new Date(`2026-10-15T${t}:20.000Z`), rows);
      expect(due.map((d) => d.id)).toEqual([rows[0].id]);
    }
    expect(digests.selectDueChannelDigests(new Date('2026-10-15T00:02:00.000Z'), rows)).toEqual([]);
  });

  it('reuses an existing Summaries channel and keeps a paused schedule paused', () => {
    const channel = chat.createChannel({
      orgId: 'acme',
      kind: 'summary',
      name: 'Summaries',
      createdByUserId: bob,
    });
    schedule(bob, ['07:00'], false);

    migrateDailySummarySchedules();

    const rows = digestStore.listChannelDigests(channel.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ scope: 'my_work', enabled: 0, cron: '0 7 * * *' });
  });

  it('is idempotent and does not bring back a digest the user removed', () => {
    schedule(alice, ['08:00']);
    migrateDailySummarySchedules();
    migrateDailySummarySchedules();
    const rows = summaryDigests(alice);
    expect(rows).toHaveLength(1);

    digestStore.deleteChannelDigest(rows[0].id);
    expect(migrateDailySummarySchedules()).toEqual([]);
    expect(summaryDigests(alice)).toHaveLength(0);
  });

  it("one user's failure does not stop the others", () => {
    schedule(alice, ['08:00']);
    schedule(bob, ['09:00']);
    const migrated = migrateDailySummarySchedules({
      orgForUser: (userId) => {
        if (userId === alice) throw new Error('orgs store down');
        return 'acme';
      },
      log: () => undefined,
    });
    expect(migrated).toEqual([bob]);
    expect(isDailySummaryScheduleMigrated(alice)).toBe(false);
    // Retried on the next call.
    expect(migrateDailySummarySchedules()).toEqual([alice]);
  });

  it('skips users without a schedule', () => {
    expect(migrateDailySummarySchedules()).toEqual([]);
    expect(findSummaryChannel('acme', alice)).toBeNull();
  });
});

describe('a Summaries channel without room', () => {
  function fill(userId: string, count: number) {
    const channel = chat.createChannel({
      orgId: 'acme',
      kind: 'summary',
      name: 'Summaries',
      createdByUserId: userId,
    });
    for (let i = 0; i < count; i += 1) {
      digestStore.createChannelDigest(channel.id, {
        name: `Other ${i}`,
        enabled: true,
        cron: '0 12 * * *',
        timeZone: 'UTC',
        scope: 'channel',
        projectIds: [],
        prompt: null,
        ownerUserId: userId,
      });
    }
    return channel;
  }

  const notices = (channelId: string) =>
    chat
      .listMessages(channelId, { limit: 50 })
      .filter(
        (m) =>
          JSON.parse(m.payload_json ?? '{}').type === DAILY_SUMMARY_MIGRATION_BLOCKED_PAYLOAD_TYPE,
      );

  it('writes nothing on a full channel, and converts once a slot frees', () => {
    const channel = fill(alice, 10);
    schedule(alice, ['08:00', '09:30']);
    const broadcast = vi.fn();

    expect(migrateDailySummarySchedules({ broadcast, log: () => undefined })).toEqual([]);
    migrateDailySummarySchedules({ broadcast, log: () => undefined });

    const scopes = digestStore.listChannelDigests(channel.id).map((d) => d.scope);
    expect(scopes).toHaveLength(10);
    expect(scopes).not.toContain('my_work');
    expect(isDailySummaryScheduleMigrated(alice)).toBe(false);
    // One notice, announced once, however many ticks retry.
    expect(notices(channel.id)).toHaveLength(1);
    expect(notices(channel.id)[0].body).toContain('remove a digest');
    expect(broadcast).toHaveBeenCalledTimes(1);

    digestStore.deleteChannelDigest(digestStore.listChannelDigests(channel.id)[0].id);
    expect(migrateDailySummarySchedules()).toEqual([alice]);
    const crons = digestStore
      .listChannelDigests(channel.id)
      .filter((d) => d.scope === 'my_work')
      .map((d) => d.cron);
    expect(crons).toEqual(['0 8 * * * | 30 9 * * *']);
    expect(isDailySummaryScheduleMigrated(alice)).toBe(true);
  });

  it('converts any schedule into the last free slot', () => {
    const channel = fill(alice, 9);
    schedule(alice, ['08:00', '08:15', '09:00', '09:15', '09:30', '10:30']);
    expect(migrateDailySummarySchedules({ log: () => undefined })).toEqual([alice]);
    const mine = digestStore.listChannelDigests(channel.id).filter((d) => d.scope === 'my_work');
    expect(mine.map((d) => d.cron)).toEqual(['0,15 8,9 * * * | 30 9,10 * * *']);
    expect(digestStore.listChannelDigests(channel.id)).toHaveLength(10);
    expect(notices(channel.id)).toHaveLength(0);
  });
});

describe('the day a schedule is converted', () => {
  function session(id: string, name: string, at: string) {
    getDb()
      .prepare(
        `INSERT INTO sessions (id, agent_id, name, owner_user_id, session_mode, created_at, updated_at)
         VALUES (?, 'agent-a', ?, ?, 'chat', ?, ?)`,
      )
      .run(id, name, alice, at, at);
  }

  function ticker(output = 'Worked on login.') {
    const runFailover = vi.fn().mockResolvedValue({
      engine: 'claude-code',
      model: 'm',
      output,
      detailed: { code: 0, stdout: output, stderr: '' },
      failovers: [],
    } as unknown as OneShotFailoverOutcome);
    const tick = (iso: string) => {
      const now = new Date(iso);
      return runDailySummaryScheduleTick({
        migrateSchedules: () => {
          migrateDailySummarySchedules({ now });
        },
        onTick: (t: Date) =>
          digests.runChannelDigestTick(t, {
            config: {} as AppConfig,
            cwd: tmpdir(),
            broadcast: vi.fn(),
            getProjects: () => [],
            resolveEngine: vi
              .fn()
              .mockResolvedValue({ engine: 'claude-code', model: 'm' }) as never,
            runFailover,
            log: () => undefined,
          }),
        now: () => now,
      });
    };
    return { runFailover, tick };
  }

  const digestPosts = (channelId: string) =>
    chat
      .listMessages(channelId, { limit: 50 })
      .filter(
        (m) => JSON.parse(m.payload_json ?? '{}').type === digests.CHANNEL_DIGEST_PAYLOAD_TYPE,
      );

  it('posts the 08:00 summary exactly once, through the digest', async () => {
    schedule(alice, ['08:00']);
    session('s1', 'Fix login', '2026-10-15T07:00:00.000Z');
    const { runFailover, tick } = ticker();

    await tick('2026-10-15T08:00:10.000Z');
    // Ticker jitter: the same minute again, then a later minute.
    await tick('2026-10-15T08:00:40.000Z');
    await tick('2026-10-15T08:01:00.000Z');

    const channel = findSummaryChannel('acme', alice)!;
    const posts = chat.listMessages(channel.id, { limit: 50 });
    expect(posts).toHaveLength(1);
    expect(posts[0].author_kind).toBe('system');
    expect(JSON.parse(posts[0].payload_json ?? '{}')).toMatchObject({
      type: digests.CHANNEL_DIGEST_PAYLOAD_TYPE,
      scope: 'my_work',
    });
    expect(posts[0].body).toContain('Worked on login.');
    expect(runFailover).toHaveBeenCalledTimes(1);
    expect(runFailover.mock.calls[0]?.[0].prompt).toContain('Fix login');
  });

  it('does not repost an occurrence the previous scheduler already posted, and keeps later runs', async () => {
    schedule(alice, ['08:00']);
    session('s1', 'Fix login', '2026-10-15T07:00:00.000Z');
    // The previous scheduler posted today's 08:00 summary before the upgrade.
    const channel = chat.createChannel({
      orgId: 'acme',
      kind: 'summary',
      name: 'Summaries',
      createdByUserId: alice,
    });
    const legacy = chat.appendMessage({
      channelId: channel.id,
      authorKind: 'system',
      body: 'Daily summary for 2026-10-15',
      payload: { type: LEGACY_DAILY_SUMMARY_PAYLOAD_TYPE, date: '2026-10-15' },
    });
    getDb()
      .prepare('UPDATE hub_chat_messages SET created_at = ? WHERE id = ?')
      .run('2026-10-15T08:00:05.000Z', legacy.id);
    const { runFailover, tick } = ticker('Shipped the API.');

    await tick('2026-10-15T08:00:30.000Z');

    expect(runFailover).not.toHaveBeenCalled();
    expect(digestPosts(channel.id)).toHaveLength(0);
    const [digest] = digestStore.listChannelDigests(channel.id);
    expect(digest).toMatchObject({
      scope: 'my_work',
      last_run_at: '2026-10-15T08:00:05.000Z',
      window_start: '2026-10-15T08:00:05.000Z',
      last_status: 'posted',
      last_message_id: legacy.id,
    });

    // Tomorrow's 08:00 still runs, covering only what came after that post.
    session('s2', 'Ship the API', '2026-10-15T15:00:00.000Z');
    await tick('2026-10-16T08:00:10.000Z');

    expect(runFailover).toHaveBeenCalledTimes(1);
    const prompt = runFailover.mock.calls[0]?.[0].prompt as string;
    expect(prompt).toContain('Ship the API');
    expect(prompt).not.toContain('Fix login');
    expect(digestPosts(channel.id)).toHaveLength(1);
  });
});

describe('migrateHubChatDigestsScopeCheck', () => {
  const CURRENT = HUB_CHAT_SCHEMA.match(
    /CREATE TABLE IF NOT EXISTS hub_chat_digests \([\s\S]*?\n {2}\);/,
  )![0];
  /** The digests table before agent digests: no agent columns or statuses. */
  const PRE_AGENT = CURRENT.replace(
    "'channel','project','my_work','agent'",
    "'channel','project','my_work'",
  )
    .replace("'posted','skipped','started','error'", "'posted','skipped','error'")
    .replace(/\n\s*--[^\n]*\n\s*--[^\n]*\n\s*agent_id\s+TEXT,\n\s*skills[^\n]*/, '');
  /** The digests table as it shipped before my_work. */
  const PRE_MY_WORK = PRE_AGENT.replace("'channel','project','my_work'", "'channel','project'");

  function oldDb(): Database.Database {
    const conn = new Database(':memory:');
    conn.exec(`CREATE TABLE hub_chat_channels (id TEXT PRIMARY KEY)`);
    conn.exec(PRE_MY_WORK);
    conn.exec(`INSERT INTO hub_chat_channels (id) VALUES ('c1')`);
    conn.exec(
      `INSERT INTO hub_chat_digests (id, channel_id, cron, scope, owner_user_id, window_start)
       VALUES ('d1', 'c1', '0 9 * * *', 'channel', 'u1', '2026-10-14T00:00:00.000Z')`,
    );
    return conn;
  }

  const insertMyWork = (conn: Database.Database) =>
    conn.exec(
      `INSERT INTO hub_chat_digests (id, channel_id, cron, scope, owner_user_id, window_start)
       VALUES ('d2', 'c1', '0 8 * * *', 'my_work', 'u1', '2026-10-14T00:00:00.000Z')`,
    );

  it('lets an existing table hold my_work rows and keeps its rows', () => {
    const conn = oldDb();
    expect(() => insertMyWork(conn)).toThrow(/CHECK/);

    migrateHubChatDigestsScopeCheck(conn);
    migrateHubChatDigestsScopeCheck(conn);

    insertMyWork(conn);
    const rows = conn.prepare('SELECT id, scope FROM hub_chat_digests ORDER BY id').all();
    expect(rows).toEqual([
      { id: 'd1', scope: 'channel' },
      { id: 'd2', scope: 'my_work' },
    ]);
    const index = conn
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'hub_chat_digests'`,
      )
      .all();
    expect(index).toContainEqual({ name: 'idx_hub_chat_digests_channel' });
    expect(() =>
      conn.exec(
        `INSERT INTO hub_chat_digests (id, channel_id, cron, scope, owner_user_id, window_start)
         VALUES ('d3', 'c1', '0 8 * * *', 'bogus', 'u1', '2026-10-14T00:00:00.000Z')`,
      ),
    ).toThrow(/CHECK/);
  });

  it('upgrades a table from before agent digests and keeps its rows', () => {
    const conn = new Database(':memory:');
    conn.exec(`CREATE TABLE hub_chat_channels (id TEXT PRIMARY KEY)`);
    conn.exec(PRE_AGENT);
    expect(PRE_AGENT).not.toContain('agent_id');
    conn.exec(`INSERT INTO hub_chat_channels (id) VALUES ('c1')`);
    insertMyWork(conn);

    migrateHubChatDigestsScopeCheck(conn);
    migrateHubChatDigestsScopeCheck(conn);

    conn.exec(
      `INSERT INTO hub_chat_digests
         (id, channel_id, cron, scope, project_ids, prompt, agent_id, skills, owner_user_id,
          window_start, last_status)
       VALUES ('d3', 'c1', '0 9 * * *', 'agent', '["web"]', 'Check the logs', 'web-dev',
               '["support-logs"]', 'u1', '2026-10-14T00:00:00.000Z', 'started')`,
    );
    const rows = conn
      .prepare('SELECT id, scope, agent_id, skills FROM hub_chat_digests ORDER BY id')
      .all();
    expect(rows).toEqual([
      { id: 'd2', scope: 'my_work', agent_id: null, skills: '[]' },
      { id: 'd3', scope: 'agent', agent_id: 'web-dev', skills: '["support-logs"]' },
    ]);
  });
});
