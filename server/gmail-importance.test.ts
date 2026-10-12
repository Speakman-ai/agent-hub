import { describe, it, expect, beforeEach, vi } from 'vitest';
import { tmpdir } from 'os';
import { mkdtempSync } from 'fs';
import path from 'path';
import type { gmail_v1 } from 'googleapis';

let TMP_DIR = '';
vi.mock('./config.js', () => ({
  default: {
    apiKey: null,
    get dataDir() {
      return TMP_DIR;
    },
  },
}));
vi.mock('./hub-assistant.js', () => ({
  resolveHubEngineAndModel: () => ({ engine: 'claude-code', model: 'sonnet' }),
}));
vi.mock('./per-user-cli-spawn.js', () => ({
  resolveSessionCliSpawnEnv: ({ engine }: { engine: string }) => ({ ENGINE_ENV: engine }),
}));

const { initOrgsDb, setOrgsDbPathForTests } = await import('./orgs.js');
const { createUser } = await import('./users-store.js');
const store = await import('./gmail-importance-store.js');
const scan = await import('./gmail-importance.js');

import type { AppConfig } from './types.js';
import type { OneShotFailoverOutcome } from './one-shot-failover.js';

const NOW = Date.parse('2026-10-12T12:00:00.000Z');
const config = {} as AppConfig;

function thread(
  id: string,
  historyId: string,
  opts: { from?: string; subject?: string; minutesAgo?: number } = {},
): gmail_v1.Schema$Thread {
  const ts = NOW - (opts.minutesAgo ?? 60) * 60_000;
  return {
    id,
    historyId,
    messages: [
      {
        id: `${id}-m1`,
        internalDate: String(ts),
        labelIds: ['INBOX', 'UNREAD'],
        snippet: `snippet for ${id}`,
        payload: {
          headers: [
            { name: 'From', value: opts.from ?? 'Alice <alice@example.com>' },
            { name: 'Subject', value: opts.subject ?? `Subject ${id}` },
          ],
        },
      },
    ],
  };
}

function fakeSource(
  threads: gmail_v1.Schema$Thread[],
  labels: Record<string, string[] | null> = {},
) {
  const byId = new Map(threads.map((t) => [t.id as string, t]));
  return {
    listThreadIds: vi.fn(async () => threads.map((t) => t.id as string)),
    getThread: vi.fn(async (id: string) => byId.get(id) as gmail_v1.Schema$Thread),
    getThreadLabels: vi.fn(async (id: string) => (id in labels ? labels[id] : ['INBOX'])),
  };
}

function outcome(
  output: string,
  extra: Partial<OneShotFailoverOutcome> = {},
): OneShotFailoverOutcome {
  return {
    engine: 'claude-code',
    model: 'sonnet',
    detailed: { stdout: output, stderr: '', code: 0, timedOut: false },
    output,
    failovers: [],
    ...extra,
  };
}

const resolveEngine = vi.fn(async () => ({ engine: 'claude-code', model: 'sonnet' })) as never;

describe('parseImportanceOutput', () => {
  const ids = new Set(['t1', 't2']);

  it('reads a fenced JSON reply, drops unknown ids and duplicates, clamps scores', () => {
    const raw =
      '```json\n{"threads":[{"id":"t1","important":true,"score":140,"reason":"Boss asks for numbers"},' +
      '{"id":"t1","important":false,"score":1},{"id":"evil","important":true,"score":99},' +
      '{"id":"t2","important":"yes","score":"12"}]}\n```';
    expect(scan.parseImportanceOutput(raw, ids)).toEqual([
      { threadId: 't1', important: true, score: 100, reason: 'Boss asks for numbers' },
      { threadId: 't2', important: false, score: 12, reason: null },
    ]);
  });

  it('throws when the reply has no JSON object', () => {
    expect(() => scan.parseImportanceOutput('I cannot help with that', ids)).toThrow(/JSON/);
  });
});

describe('shapeThreadCandidate', () => {
  it('uses the first subject, the latest sender, and the latest message time', () => {
    const t = thread('t1', 'h1', { minutesAgo: 30 });
    t.messages!.push({
      id: 't1-m2',
      internalDate: String(NOW),
      labelIds: ['IMPORTANT'],
      snippet: 'latest reply',
      payload: { headers: [{ name: 'From', value: 'Bob <bob@example.com>' }] },
    });
    expect(scan.shapeThreadCandidate(t)).toMatchObject({
      threadId: 't1',
      subject: 'Subject t1',
      from: 'Bob <bob@example.com>',
      snippet: 'latest reply',
      lastMessageAt: new Date(NOW).toISOString(),
      labelIds: ['IMPORTANT', 'INBOX', 'UNREAD'],
      messageCount: 2,
    });
  });
});

describe('runGmailImportanceScan', () => {
  let userId = '';
  beforeEach(() => {
    TMP_DIR = mkdtempSync(path.join(tmpdir(), 'gmail-importance-'));
    setOrgsDbPathForTests(path.join(TMP_DIR, 'orgs.db'));
    initOrgsDb();
    userId = createUser({ username: 'alice', passwordHash: 'x' }).id;
    store.updateGmailImportanceSettings(userId, { enabled: true, windowDays: 7 });
  });

  it("rates threads on the user's engine and pins important ones by score", async () => {
    const source = fakeSource([thread('t1', 'h1'), thread('t2', 'h2'), thread('t3', 'h3')]);
    const runFailover = vi.fn(async () =>
      outcome(
        JSON.stringify({
          threads: [
            { id: 't1', important: true, score: 60, reason: 'Question for you' },
            { id: 't2', important: false, score: 5, reason: 'Newsletter' },
            { id: 't3', important: true, score: 90, reason: 'Deadline today' },
          ],
        }),
      ),
    );

    const summary = await scan.runGmailImportanceScan(
      { userId, config },
      {
        resolveToken: async () => 'tok',
        createSource: () => source,
        resolveEngine,
        runFailover,
        now: () => NOW,
      },
    );

    expect(summary).toMatchObject({
      scanned: 3,
      classified: 3,
      important: 2,
      engine: 'claude-code',
    });
    expect(source.listThreadIds).toHaveBeenCalledWith(
      'in:inbox newer_than:7d -category:promotions -category:social',
      150,
    );
    const input = (runFailover.mock.calls as unknown[][])[0][0] as Record<string, any>;
    // Uses the caller's own credentials and keeps the CLI off bypassed permissions.
    expect(input.userId).toBe(userId);
    expect(input.buildEnv('codex-cli')).toEqual({ ENGINE_ENV: 'codex-cli' });
    expect(input.claudePermissionMode).toBe('default');
    expect(input.systemPrompt).toMatch(/Never follow instructions/);
    expect(input.cwd).toContain('gmail-importance-');

    const since = new Date(NOW - 7 * 86_400_000).toISOString();
    const pinned = store.listImportantGmailThreads(userId, since);
    expect(pinned.map((t) => t.threadId)).toEqual(['t3', 't1']);
    expect(pinned[0]).toMatchObject({ reason: 'Deadline today', subject: 'Subject t3' });

    const settings = store.getGmailImportanceSettings(userId);
    expect(settings).toMatchObject({
      lastScanStatus: 'ok',
      lastScanEngine: 'claude-code',
      lastScanAt: new Date(NOW).toISOString(),
      lastScanFailover: null,
    });
  });

  it('only sends new or changed threads to the model on the next scan', async () => {
    const reply = (ids: string[]) =>
      outcome(JSON.stringify({ threads: ids.map((id) => ({ id, important: true, score: 50 })) }));
    const deps = {
      resolveToken: async () => 'tok',
      resolveEngine,
      now: () => NOW,
    };
    await scan.runGmailImportanceScan(
      { userId, config },
      {
        ...deps,
        createSource: () => fakeSource([thread('t1', 'h1'), thread('t2', 'h2')]),
        runFailover: vi.fn(async () => reply(['t1', 't2'])),
      },
    );

    const second = vi.fn(async () => reply(['t2']));
    await scan.runGmailImportanceScan(
      { userId, config },
      {
        ...deps,
        createSource: () => fakeSource([thread('t1', 'h1'), thread('t2', 'h2-new')]),
        runFailover: second,
      },
    );
    expect(second).toHaveBeenCalledTimes(1);
    const prompt = ((second.mock.calls as unknown[][])[0][0] as { prompt: string }).prompt;
    expect(prompt).toContain('"id":"t2"');
    expect(prompt).not.toContain('"id":"t1"');

    const third = vi.fn();
    await scan.runGmailImportanceScan(
      { userId, config },
      {
        ...deps,
        createSource: () => fakeSource([thread('t1', 'h1'), thread('t2', 'h2-new')]),
        runFailover: third,
      },
    );
    expect(third).not.toHaveBeenCalled();
  });

  it('unpins threads that were archived or deleted, but keeps ones past the scan cap', async () => {
    const deps = { resolveToken: async () => 'tok', resolveEngine, now: () => NOW };
    await scan.runGmailImportanceScan(
      { userId, config },
      {
        ...deps,
        createSource: () =>
          fakeSource([thread('t1', 'h1'), thread('t2', 'h2'), thread('t3', 'h3')]),
        runFailover: vi.fn(async () =>
          outcome(
            JSON.stringify({
              threads: ['t1', 't2', 't3'].map((id) => ({ id, important: true, score: 50 })),
            }),
          ),
        ),
      },
    );
    const since = new Date(NOW - 7 * 86_400_000).toISOString();
    expect(store.listImportantGmailThreads(userId, since)).toHaveLength(3);

    // None come back from the inbox query: t1 was archived, t2 deleted, and t3
    // is still in the inbox but fell past the thread cap.
    const source = fakeSource([], { t1: ['CATEGORY_UPDATES'], t2: null, t3: ['INBOX', 'UNREAD'] });
    const runFailover = vi.fn();
    await scan.runGmailImportanceScan(
      { userId, config },
      { ...deps, createSource: () => source, runFailover },
    );
    expect(runFailover).not.toHaveBeenCalled();
    expect(source.getThreadLabels).toHaveBeenCalledTimes(3);
    expect(store.listImportantGmailThreads(userId, since).map((t) => t.threadId)).toEqual(['t3']);
  });

  it('rotates reconcile across more pins than one scan can check, so none starve', async () => {
    const day = 86_400_000;
    // 120 pins: 119 newer inbox threads plus one older, top-scoring thread
    // that has since been archived.
    store.upsertGmailImportanceVerdicts(userId, [
      ...Array.from({ length: 119 }, (_, i) => ({
        threadId: `n${String(i).padStart(3, '0')}`,
        historyId: 'h',
        important: true,
        score: 50,
        reason: null,
        subject: null,
        from: null,
        snippet: null,
        lastMessageAt: new Date(NOW - day + i * 1000).toISOString(),
      })),
      {
        threadId: 'archived-old',
        historyId: 'h',
        important: true,
        score: 99,
        reason: 'Old but urgent',
        subject: null,
        from: null,
        snippet: null,
        lastMessageAt: new Date(NOW - 5 * day).toISOString(),
      },
    ]);
    const since = new Date(NOW - 7 * day).toISOString();
    expect(store.listImportantGmailThreads(userId, since)[0].threadId).toBe('archived-old');

    let clock = NOW;
    const checked: string[][] = [];
    const runScan = async () => {
      const source = fakeSource([thread('n000', 'h')], { 'archived-old': ['CATEGORY_UPDATES'] });
      await scan.runGmailImportanceScan(
        { userId, config },
        {
          resolveToken: async () => 'tok',
          createSource: () => source,
          resolveEngine,
          runFailover: vi.fn(async () =>
            outcome(JSON.stringify({ threads: [{ id: 'n000', important: true, score: 50 }] })),
          ),
          now: () => clock,
        },
      );
      checked.push(source.getThreadLabels.mock.calls.map((c) => c[0] as string));
      clock += 60_000;
    };

    await runScan();
    await runScan();
    // Each scan stays within the cap and never re-checks the listed thread.
    for (const ids of checked) {
      expect(ids.length).toBeLessThanOrEqual(scan.GMAIL_IMPORTANCE_RECONCILE_CAP);
      expect(ids).not.toContain('n000');
    }
    // Two scans cover all 119 absent pins: the second picks up the rest.
    expect(new Set(checked.flat()).size).toBe(119);
    expect(checked.flat()).toContain('archived-old');
    expect(store.listImportantGmailThreads(userId, since).map((t) => t.threadId)).not.toContain(
      'archived-old',
    );
  });

  it('unpins listed threads deleted or archived before their fetch, without failing the scan', async () => {
    const pin = (threadId: string) => ({
      threadId,
      historyId: 'old',
      important: true,
      score: 80,
      reason: 'Pinned earlier',
      subject: null,
      from: null,
      snippet: null,
      lastMessageAt: new Date(NOW - 3_600_000).toISOString(),
    });
    store.upsertGmailImportanceVerdicts(userId, [pin('gone'), pin('archived')]);

    const archived = thread('archived', 'h3');
    archived.messages![0].labelIds = ['CATEGORY_UPDATES'];
    const source = fakeSource([thread('t1', 'h1'), thread('gone', 'h2'), archived]);
    source.getThread.mockImplementation(async (id: string) => {
      if (id === 'gone') throw Object.assign(new Error('Not Found'), { code: 404 });
      return id === 'archived' ? archived : thread('t1', 'h1');
    });
    const runFailover = vi.fn(async () =>
      outcome(JSON.stringify({ threads: [{ id: 't1', important: true, score: 40 }] })),
    );
    const summary = await scan.runGmailImportanceScan(
      { userId, config },
      {
        resolveToken: async () => 'tok',
        createSource: () => source,
        resolveEngine,
        runFailover,
        now: () => NOW,
      },
    );
    expect(summary).toMatchObject({ scanned: 1, important: 1 });
    expect(store.getGmailImportanceSettings(userId).lastScanStatus).toBe('ok');
    // The archived thread is never sent to the model.
    const prompt = ((runFailover.mock.calls as unknown[][])[0][0] as { prompt: string }).prompt;
    expect(prompt).not.toContain('"id":"archived"');
    const since = new Date(NOW - 7 * 86_400_000).toISOString();
    expect(store.listImportantGmailThreads(userId, since).map((t) => t.threadId)).toEqual(['t1']);
  });

  it('builds the candidate from live messages only when a newer reply was trashed', () => {
    const t = thread('mixed', 'h1', { minutesAgo: 3 * 24 * 60, subject: 'Contract renewal' });
    t.messages!.push(
      {
        id: 'mixed-trashed',
        internalDate: String(NOW - 60_000),
        labelIds: ['TRASH'],
        snippet: 'URGENT wire money now',
        payload: {
          headers: [
            { name: 'From', value: 'Scammer <x@evil.example>' },
            { name: 'Subject', value: 'Re: Contract renewal' },
          ],
        },
      },
      {
        id: 'mixed-spam',
        internalDate: String(NOW - 30_000),
        labelIds: ['SPAM', 'INBOX'],
        snippet: 'spam reply',
        payload: { headers: [{ name: 'From', value: 'Spam <s@spam.example>' }] },
      },
    );
    t.snippet = 'URGENT wire money now';
    expect(scan.shapeThreadCandidate(t)).toEqual({
      threadId: 'mixed',
      historyId: 'h1',
      subject: 'Contract renewal',
      from: 'Alice <alice@example.com>',
      snippet: 'snippet for mixed',
      lastMessageAt: new Date(NOW - 3 * 86_400_000).toISOString(),
      labelIds: ['INBOX', 'UNREAD'],
      messageCount: 1,
    });
  });

  it('gives a fully trashed thread no content and no labels', () => {
    const t = thread('gone', 'h1');
    t.messages![0].labelIds = ['TRASH'];
    expect(scan.shapeThreadCandidate(t)).toMatchObject({
      subject: null,
      from: null,
      snippet: null,
      lastMessageAt: null,
      labelIds: [],
      messageCount: 0,
    });
  });

  it('orders live messages by time even if Gmail returns them out of order', () => {
    const older = { id: 'a', internalDate: '1000', labelIds: ['INBOX'] };
    const newer = { id: 'b', internalDate: '2000', labelIds: ['INBOX'] };
    expect(scan.liveMessages([newer, older]).map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('ignores trashed and spammed messages when reading thread labels', () => {
    expect(
      scan
        .liveThreadLabels([{ labelIds: ['INBOX', 'UNREAD'] }, { labelIds: ['TRASH', 'INBOX'] }])
        .sort(),
    ).toEqual(['INBOX', 'UNREAD']);
    expect(scan.liveThreadLabels([{ labelIds: ['TRASH'] }, { labelIds: ['SPAM'] }])).toEqual([]);
  });

  it('treats only non-trashed, non-spam inbox threads as eligible', () => {
    expect(scan.isInboxEligible(['INBOX'])).toBe(true);
    expect(scan.isInboxEligible(['INBOX', 'TRASH'])).toBe(false);
    expect(scan.isInboxEligible(['SPAM'])).toBe(false);
    expect(scan.isInboxEligible(null)).toBe(false);
  });

  it('records an engine failover note when the run switched engines', async () => {
    const runFailover = vi.fn(async () =>
      outcome(JSON.stringify({ threads: [{ id: 't1', important: true, score: 70 }] }), {
        engine: 'codex-cli',
        model: 'gpt-5',
        failovers: [
          {
            from: 'claude-code',
            fromModel: 'sonnet',
            to: 'codex-cli',
            toModel: 'gpt-5',
            trigger: 'usage-exhausted',
            errorText: '5-hour limit reached',
          },
        ],
      }),
    );
    await scan.runGmailImportanceScan(
      { userId, config },
      {
        resolveToken: async () => 'tok',
        createSource: () => fakeSource([thread('t1', 'h1')]),
        resolveEngine,
        runFailover: runFailover as never,
        now: () => NOW,
      },
    );
    expect(store.getGmailImportanceSettings(userId)).toMatchObject({
      lastScanEngine: 'codex-cli',
      lastScanFailover: 'Switched engines: claude-code → codex-cli (usage-exhausted)',
    });
  });

  it('records the error and rethrows when every engine fails', async () => {
    await expect(
      scan.runGmailImportanceScan(
        { userId, config, windowDays: 1 },
        {
          resolveToken: async () => 'tok',
          createSource: () => fakeSource([thread('t1', 'h1')]),
          resolveEngine,
          runFailover: vi.fn(async () => {
            throw new Error('every engine in the failover chain failed');
          }),
          now: () => NOW,
        },
      ),
    ).rejects.toThrow(/failover chain/);
    expect(store.getGmailImportanceSettings(userId)).toMatchObject({
      lastScanStatus: 'error',
      lastScanError: 'every engine in the failover chain failed',
      lastScanAt: new Date(NOW).toISOString(),
    });
    expect(scan.isGmailImportanceScanRunning(userId)).toBe(false);
  });

  it('refuses a second concurrent scan for the same user', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const first = scan.runGmailImportanceScan(
      { userId, config },
      {
        resolveToken: async () => {
          await gate;
          return 'tok';
        },
        createSource: () => fakeSource([]),
        resolveEngine,
        runFailover: vi.fn(),
        now: () => NOW,
      },
    );
    expect(scan.isGmailImportanceScanRunning(userId)).toBe(true);
    await expect(scan.runGmailImportanceScan({ userId, config })).rejects.toMatchObject({
      code: 'scan_in_progress',
    });
    release();
    await first;
  });
});

describe('runGmailImportanceAutoScanTick', () => {
  beforeEach(() => {
    TMP_DIR = mkdtempSync(path.join(tmpdir(), 'gmail-importance-tick-'));
    setOrgsDbPathForTests(path.join(TMP_DIR, 'orgs.db'));
    initOrgsDb();
  });

  async function twoDueUsers() {
    const a = createUser({ username: 'auto-a', passwordHash: 'x' }).id;
    const b = createUser({ username: 'auto-b', passwordHash: 'x' }).id;
    for (const id of [a, b]) {
      store.updateGmailImportanceSettings(id, { enabled: true, autoScan: 'hourly' });
    }
    let releaseA: (t: string) => void = () => {};
    const gateA = new Promise<string>((r) => (releaseA = r));
    const scannedUsers: string[] = [];
    const deps = {
      resolveToken: async (userId: string) => {
        scannedUsers.push(userId);
        return userId === a ? gateA : 'tok';
      },
      createSource: () => fakeSource([]),
      resolveEngine,
      runFailover: vi.fn(),
      now: () => NOW,
    };
    return { a, b, releaseA, scannedUsers, deps };
  }

  it("skips a queued user who turned auto-scan off while an earlier user's scan ran", async () => {
    const { a, b, releaseA, scannedUsers, deps } = await twoDueUsers();
    const tick = scan.runGmailImportanceAutoScanTick(config, deps);
    await vi.waitFor(() => expect(scan.isGmailImportanceScanRunning(a)).toBe(true));

    store.updateGmailImportanceSettings(b, { autoScan: 'off' });
    releaseA('tok');

    expect(await tick).toEqual([a]);
    expect(scannedUsers).toEqual([a]);
    expect(store.getGmailImportanceSettings(b).lastScanAt).toBeNull();
  });

  it('skips a queued user who disabled the feature or just finished a manual scan', async () => {
    const { a, b, releaseA, scannedUsers, deps } = await twoDueUsers();
    const tick = scan.runGmailImportanceAutoScanTick(config, deps);
    await vi.waitFor(() => expect(scan.isGmailImportanceScanRunning(a)).toBe(true));

    // B ran a manual scan meanwhile, so it is no longer due.
    store.recordGmailImportanceScanResult(
      b,
      { ok: true, engine: null, model: null, failover: null },
      new Date(NOW).toISOString(),
    );
    releaseA('tok');
    expect(await tick).toEqual([a]);
    expect(scannedUsers).toEqual([a]);

    // And a disabled user is never picked even when overdue.
    store.updateGmailImportanceSettings(b, { enabled: false });
    store.recordGmailImportanceScanResult(
      b,
      { ok: true, engine: null, model: null, failover: null },
      new Date(NOW - 2 * 3_600_000).toISOString(),
    );
    store.recordGmailImportanceScanResult(
      a,
      { ok: true, engine: null, model: null, failover: null },
      new Date(NOW).toISOString(),
    );
    expect(await scan.runGmailImportanceAutoScanTick(config, deps)).toEqual([]);
  });
});

describe('selectDueGmailImportanceScans', () => {
  it('picks never-scanned users and users past their cadence, skipping running ones', () => {
    const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
    const due = scan.selectDueGmailImportanceScans(
      [
        { userId: 'never', autoScan: 'hourly', lastScanAt: null },
        { userId: 'hourly-due', autoScan: 'hourly', lastScanAt: iso(61 * 60_000) },
        { userId: 'hourly-fresh', autoScan: 'hourly', lastScanAt: iso(30 * 60_000) },
        { userId: 'six-due', autoScan: 'every6h', lastScanAt: iso(7 * 3_600_000) },
        { userId: 'daily-fresh', autoScan: 'daily', lastScanAt: iso(23 * 3_600_000) },
        { userId: 'busy', autoScan: 'hourly', lastScanAt: null },
      ],
      NOW,
      (id) => id === 'busy',
    );
    expect(due).toEqual(['never', 'hourly-due', 'six-due']);
  });
});
