/**
 * Integration tests for webhook P1 — dedup + per-key concurrency cap.
 *
 * Card `2c4a0d06`. Layered on top of the P0 webhook_events queue + worker:
 *
 *   1. Coalesce — when N pending rows share (event_type, action, pr_key),
 *      only the latest stays 'pending'; the rest flip to 'skipped' and
 *      record `superseded_by` pointing at the survivor.
 *   2. Per-PR concurrency — claimPendingWebhookEvent never returns two
 *      rows with the same pr_key concurrently. Different PRs are not
 *      affected.
 *   3. Persistent debounce — `deferred_until` makes the in-memory
 *      `reviewerDebounceTimers` map durable across server restarts.
 *      Worker won't claim a row whose deferred_until is still in the
 *      future, but will once the deadline passes.
 *   4. Check-run double-click — `check_run.rerequested` for the same PR
 *      coalesces the same way pull_request.synchronize does.
 *
 * The pure helpers (`makePrKey`, `extractPrNumberFromPayload`,
 * `computeWebhookCoalesceMeta`) live in `routes/webhooks.ts` and are unit
 * tested inline below — no DB/express needed for those.
 */
import crypto from 'crypto';
import type supertest from 'supertest';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getRequest, createProject } from './helpers.js';
import type { WebhookEventRow, Stmts } from '../types.js';
import {
  makePrKey,
  extractPrNumberFromPayload,
  computeWebhookCoalesceMeta,
  QUEUE_REVIEWER_DEFER_MS,
} from '../routes/webhooks.js';

let request: supertest.Agent;
let projectId: string;
let webhookSecret: string;
let stmts: Stmts;

const REPO_URL = 'https://github.com/dedup-test-org/dedup-test-repo';
const REPO_FULL_NAME = 'dedup-test-org/dedup-test-repo';

function signBody(secret: string, body: unknown): { raw: string; signature: string } {
  const raw = JSON.stringify(body);
  const signature = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
  return { raw, signature };
}

interface PrSyncBody {
  action: string;
  number: number;
  pull_request: { number: number; html_url: string; head: { sha: string } };
  repository: { full_name: string; html_url: string };
  sender: { login: string };
}

function prSyncBody(prNumber: number, sha: string): PrSyncBody {
  return {
    action: 'synchronize',
    number: prNumber,
    pull_request: {
      number: prNumber,
      html_url: `${REPO_URL}/pull/${prNumber}`,
      head: { sha },
    },
    repository: { full_name: REPO_FULL_NAME, html_url: REPO_URL },
    sender: { login: 'dedup-test-user' },
  };
}

interface CheckRunBody {
  action: string;
  check_run: { id: number; pull_requests: Array<{ number: number }> };
  repository: { full_name: string; html_url: string };
  sender: { login: string };
}

function checkRunRerequestedBody(prNumber: number, runId: number): CheckRunBody {
  return {
    action: 'rerequested',
    check_run: { id: runId, pull_requests: [{ number: prNumber }] },
    repository: { full_name: REPO_FULL_NAME, html_url: REPO_URL },
    sender: { login: 'dedup-test-user' },
  };
}

async function postWebhook(
  event: string,
  body: object,
  deliveryId: string,
): Promise<{ status: number; id?: number; webhookStatus?: string }> {
  const { raw, signature } = signBody(webhookSecret, body);
  const res = await request
    .post('/api/webhooks/github')
    .set('content-type', 'application/json')
    .set('x-github-event', event)
    .set('x-github-delivery', deliveryId)
    .set('x-hub-signature-256', signature)
    .send(raw);
  return {
    status: res.status,
    id: (res.body as { id?: number }).id,
    webhookStatus: (res.body as { status?: string }).status,
  };
}

function getEventById(id: number): WebhookEventRow | undefined {
  return stmts.getWebhookEventById.get(id) as WebhookEventRow | undefined;
}

beforeAll(async () => {
  request = await getRequest();
  const project = await createProject();
  projectId = project.id as string;

  const res = await request
    .post('/api/webhooks')
    .send({
      projectId,
      repoUrl: REPO_URL,
      // No enabled handlers — we're testing queue-side dedup, not dispatch.
      events: {},
      enabled: true,
    })
    .expect(200);
  webhookSecret = (res.body as { secret: string }).secret;

  const { webhookHandlerDeps } = await import('../index.js');
  stmts = webhookHandlerDeps.stmts;
});

afterAll(async () => {
  // Drain anything left so we don't leak rows into later test files.
  const worker = await import('../webhook-worker.js');
  for (let i = 0; i < 100; i++) {
    const didWork = await worker.processOnce();
    if (!didWork) break;
  }
});

// ─── Pure helpers (no DB / no HTTP) ──────────────────────────────────

describe('webhook coalesce — pure helpers', () => {
  it('makePrKey builds <repo>:<num> for valid inputs', () => {
    expect(makePrKey('owner/repo', 42)).toBe('owner/repo:42');
    expect(makePrKey('owner/repo', '42')).toBe('owner/repo:42');
  });

  it('makePrKey returns null when inputs are unusable', () => {
    expect(makePrKey(undefined, 1)).toBeNull();
    expect(makePrKey('', 1)).toBeNull();
    expect(makePrKey('owner/repo', undefined)).toBeNull();
    expect(makePrKey('owner/repo', 0)).toBeNull();
    expect(makePrKey('owner/repo', -1)).toBeNull();
    expect(makePrKey('owner/repo', 'not-a-number')).toBeNull();
  });

  it('extractPrNumberFromPayload reads pull_request.number for pull_request events', () => {
    const num = extractPrNumberFromPayload('pull_request', {
      pull_request: { number: 7 },
    } as never);
    expect(num).toBe(7);
  });

  it('extractPrNumberFromPayload reads check_run.pull_requests[0].number', () => {
    const num = extractPrNumberFromPayload('check_run', {
      check_run: { pull_requests: [{ number: 19 }] },
    } as never);
    expect(num).toBe(19);
  });

  it('extractPrNumberFromPayload returns null for repo-level events', () => {
    expect(extractPrNumberFromPayload('push', { ref: 'refs/heads/main' } as never)).toBeNull();
    expect(extractPrNumberFromPayload('ping', {} as never)).toBeNull();
  });

  it('computeWebhookCoalesceMeta defers pull_request.synchronize by the reviewer window', () => {
    const meta = computeWebhookCoalesceMeta('pull_request', 'synchronize', {
      pull_request: { number: 5 },
      repository: { full_name: 'a/b' },
    } as never);
    expect(meta.prKey).toBe('a/b:5');
    // Reviewer debounce is 30s; the modifier string is `+30 seconds`.
    expect(meta.deferredUntilSql).toBe(`+${Math.floor(QUEUE_REVIEWER_DEFER_MS / 1000)} seconds`);
  });

  it('computeWebhookCoalesceMeta defers check_run.rerequested briefly', () => {
    const meta = computeWebhookCoalesceMeta('check_run', 'rerequested', {
      check_run: { pull_requests: [{ number: 11 }] },
      repository: { full_name: 'a/b' },
    } as never);
    expect(meta.prKey).toBe('a/b:11');
    expect(meta.deferredUntilSql).toBe('+5 seconds');
  });

  it('computeWebhookCoalesceMeta does not defer non-PR events', () => {
    const meta = computeWebhookCoalesceMeta('push', '', {
      ref: 'refs/heads/main',
      repository: { full_name: 'a/b' },
    } as never);
    expect(meta.prKey).toBeNull();
    expect(meta.deferredUntilSql).toBeNull();
  });
});

// ─── Coalesce — burst of synchronize for the same PR ─────────────────

describe('webhook coalesce — burst', () => {
  it('marks older pending rows as skipped on insert; only the latest stays pending', async () => {
    const PR = 1001;
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await postWebhook(
        'pull_request',
        prSyncBody(PR, `sha-burst-${i}`),
        `dedup-burst-${i}`,
      );
      expect(r.status).toBe(202);
      expect(r.webhookStatus).toBe('queued');
      if (r.id !== undefined) ids.push(r.id);
    }
    expect(ids.length).toBe(5);

    const survivor = ids[ids.length - 1];
    const survivorRow = getEventById(survivor)!;
    expect(survivorRow.status).toBe('pending');
    expect(survivorRow.pr_key).toBe(`${REPO_FULL_NAME}:${PR}`);

    // All earlier rows should have been swept to 'skipped' with their
    // superseded_by pointing at *some* later row in the chain (each insert
    // sweeps anything older than itself, so the chain converges on the last).
    for (let i = 0; i < ids.length - 1; i++) {
      const row = getEventById(ids[i])!;
      expect(row.status).toBe('skipped');
      expect(row.completed_at).not.toBeNull();
      expect(row.superseded_by).not.toBeNull();
      // superseded_by points at a row that arrived AFTER us.
      expect(row.superseded_by!).toBeGreaterThan(ids[i]);
    }
  });

  it('does not coalesce across different PRs', async () => {
    const idsByPr: Record<number, number> = {};
    for (const pr of [2001, 2002, 2003]) {
      const r = await postWebhook('pull_request', prSyncBody(pr, `sha-${pr}`), `dedup-cross-${pr}`);
      expect(r.status).toBe(202);
      idsByPr[pr] = r.id!;
    }
    // None of the three should have superseded each other — they have
    // different pr_keys.
    for (const id of Object.values(idsByPr)) {
      const row = getEventById(id)!;
      expect(row.status).toBe('pending');
      expect(row.superseded_by).toBeNull();
    }
  });

  it('does not coalesce across different actions on the same PR', async () => {
    // pull_request.opened and pull_request.synchronize share pr_key but
    // have different `action` values — coalescePendingForKey scopes by
    // action, so an opened event must not supersede a synchronize.
    const PR = 3001;
    const openedBody = { ...prSyncBody(PR, 'sha-opened'), action: 'opened' };
    const syncBody = prSyncBody(PR, 'sha-sync');

    const opened = await postWebhook('pull_request', openedBody, `dedup-action-opened`);
    const sync = await postWebhook('pull_request', syncBody, `dedup-action-sync`);
    expect(opened.status).toBe(202);
    expect(sync.status).toBe(202);

    expect(getEventById(opened.id!)!.status).toBe('pending');
    expect(getEventById(sync.id!)!.status).toBe('pending');
  });
});

// ─── Persistent debounce — deferred_until honored by the worker ──────

describe('webhook persistent debounce', () => {
  it('claim skips rows whose deferred_until is still in the future', async () => {
    const PR = 4001;
    const r = await postWebhook('pull_request', prSyncBody(PR, 'sha-defer'), `dedup-defer-${PR}`);
    expect(r.status).toBe(202);
    const id = r.id!;

    const row = getEventById(id)!;
    expect(row.status).toBe('pending');
    // The synchronize action defers by the reviewer window. The exact value
    // depends on the DB clock, but it MUST be non-null and in the future.
    expect(row.deferred_until).not.toBeNull();
    const dt = new Date(row.deferred_until + 'Z').getTime();
    expect(Number.isFinite(dt)).toBe(true);
    expect(dt).toBeGreaterThan(Date.now() - 1000); // SQLite DB clock can drift slightly

    // Asking the worker to claim a row right now must NOT pick this row up
    // — its deferred_until is in the future. Drain anything else first so
    // we know what's at the head.
    let claimed: WebhookEventRow | undefined;
    for (let i = 0; i < 100; i++) {
      claimed = stmts.claimPendingWebhookEvent.get() as WebhookEventRow | undefined;
      if (!claimed) break;
      // Roll any non-deferred rows back to done so they don't block this loop.
      stmts.markWebhookEventDone.run(claimed.id);
      if (claimed.id === id) {
        throw new Error('worker claimed a deferred row before its deadline');
      }
    }
    // Our deferred row should still be pending.
    expect(getEventById(id)!.status).toBe('pending');
  });

  it('survives a simulated server restart — deferred row eventually claimable', async () => {
    // Persistence here means: if the in-memory worker is reset (stop +
    // re-init, mimicking a server restart), the queue still knows about
    // the deferred row, and the row's deferred_until still gates claim.
    const PR = 4002;
    const r = await postWebhook(
      'pull_request',
      prSyncBody(PR, 'sha-restart'),
      `dedup-restart-${PR}`,
    );
    expect(r.status).toBe(202);
    const id = r.id!;
    expect(getEventById(id)!.deferred_until).not.toBeNull();

    // Simulate restart.
    const worker = await import('../webhook-worker.js');
    worker.stopWebhookWorker();
    const { webhookHandlerDeps } = await import('../index.js');
    worker.initWebhookWorker({
      stmts: webhookHandlerDeps.stmts,
      routeDeps: webhookHandlerDeps,
    });

    // After restart, the row is still pending and still deferred.
    const post = getEventById(id)!;
    expect(post.status).toBe('pending');
    expect(post.deferred_until).not.toBeNull();

    // Force the deadline into the past to prove the claim predicate is
    // what's gating us, not some other state. This mimics the post-window
    // path without sleeping for the real 30s in CI.
    const { getDb } = await import('../db.js');
    getDb()
      .prepare(
        "UPDATE webhook_events SET deferred_until = datetime('now','-1 second') WHERE id = ?",
      )
      .run(id);

    // Now drain — within a finite number of claims, our row must be picked.
    let foundOurs = false;
    for (let i = 0; i < 50; i++) {
      const claimed = stmts.claimPendingWebhookEvent.get() as WebhookEventRow | undefined;
      if (!claimed) break;
      if (claimed.id === id) {
        foundOurs = true;
        stmts.markWebhookEventDone.run(claimed.id);
        break;
      }
      stmts.markWebhookEventDone.run(claimed.id);
    }
    expect(foundOurs).toBe(true);
  });
});

// ─── Per-PR concurrency cap ──────────────────────────────────────────

describe('webhook per-PR concurrency', () => {
  it('does not claim a second row for the same pr_key while one is processing', async () => {
    // Insert two synchronize events for the same PR. Force their
    // deferred_until into the past so both are eligible.
    const PR = 5001;
    const idA = (
      await postWebhook('pull_request', prSyncBody(PR, 'sha-conc-a'), `dedup-conc-a-${PR}`)
    ).id!;
    const idB = (
      await postWebhook('pull_request', prSyncBody(PR, 'sha-conc-b'), `dedup-conc-b-${PR}`)
    ).id!;

    // The second insert should have coalesced the first to 'skipped'. To
    // exercise the per-key concurrency predicate (not the coalesce), put
    // the first row back into 'pending' so we have two pending siblings.
    const { getDb } = await import('../db.js');
    const db = getDb();
    db.prepare(
      "UPDATE webhook_events SET status = 'pending', superseded_by = NULL WHERE id = ?",
    ).run(idA);

    // Both rows eligible.
    db.prepare(
      "UPDATE webhook_events SET deferred_until = datetime('now','-1 second') WHERE id IN (?, ?)",
    ).run(idA, idB);

    const first = stmts.claimPendingWebhookEvent.get() as WebhookEventRow | undefined;
    expect(first).toBeDefined();
    expect([idA, idB]).toContain(first!.id);

    // The DB now has one row in 'processing' with our pr_key. A second
    // claim must NOT pick the sibling — same pr_key.
    const second = stmts.claimPendingWebhookEvent.get() as WebhookEventRow | undefined;
    if (second) {
      // If we get something, it had better not share the pr_key.
      expect(second.pr_key).not.toBe(first!.pr_key);
      stmts.markWebhookEventDone.run(second.id);
    }

    // After we mark the first done, the sibling becomes claimable.
    stmts.markWebhookEventDone.run(first!.id);
    const third = stmts.claimPendingWebhookEvent.get() as WebhookEventRow | undefined;
    if (third) {
      // It can be the sibling now.
      stmts.markWebhookEventDone.run(third.id);
    }
  });

  it('does not gate different PRs against each other', async () => {
    // Two distinct PRs, both pending and eligible — both should be
    // claimable in succession (one in processing for each pr_key).
    const idA = (
      await postWebhook('pull_request', prSyncBody(6001, 'sha-distinct-a'), `dedup-dist-6001`)
    ).id!;
    const idB = (
      await postWebhook('pull_request', prSyncBody(6002, 'sha-distinct-b'), `dedup-dist-6002`)
    ).id!;
    const { getDb } = await import('../db.js');
    getDb()
      .prepare(
        "UPDATE webhook_events SET deferred_until = datetime('now','-1 second') WHERE id IN (?, ?)",
      )
      .run(idA, idB);

    const first = stmts.claimPendingWebhookEvent.get() as WebhookEventRow | undefined;
    const second = stmts.claimPendingWebhookEvent.get() as WebhookEventRow | undefined;

    // We don't care about ordering; we care that both pr_keys end up
    // claimable across the two calls.
    const claimed = [first, second].filter((x): x is WebhookEventRow => !!x);
    const keys = claimed.map((r) => r.pr_key);
    expect(keys).toContain(`${REPO_FULL_NAME}:6001`);
    expect(keys).toContain(`${REPO_FULL_NAME}:6002`);

    for (const r of claimed) stmts.markWebhookEventDone.run(r.id);
  });
});

// ─── Check-run double-click ──────────────────────────────────────────

describe('webhook check_run.rerequested dedup', () => {
  it('coalesces double-rerun clicks for the same PR', async () => {
    const PR = 7001;
    const ids: number[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await postWebhook(
        'check_run',
        checkRunRerequestedBody(PR, 9000 + i),
        `dedup-checkrun-${i}`,
      );
      expect(r.status).toBe(202);
      ids.push(r.id!);
    }

    // All three share pr_key (PR 7001) and (event_type, action) =
    // (check_run, rerequested) — only the last should remain pending.
    expect(getEventById(ids[ids.length - 1])!.status).toBe('pending');
    for (let i = 0; i < ids.length - 1; i++) {
      const row = getEventById(ids[i])!;
      expect(row.status).toBe('skipped');
      expect(row.superseded_by).not.toBeNull();
    }
  });
});
