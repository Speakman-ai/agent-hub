/**
 * Integration tests for the webhook fast-ack + SQLite-backed worker.
 *
 * Covers the P0 acceptance criteria from kanban card
 * `60744936-371b-4fcb-a7f3-085b1d4dfb89` (webhook starvation incident,
 * 2026-04-16):
 *
 *   1. Fast-ack — POST returns 202 quickly with `{status:'queued', id}` and
 *      a `pending` row in `webhook_events`.
 *   2. Idempotency — a second POST with the same `x-github-delivery`
 *      returns 200 `{status:'duplicate'}` and no second row is inserted.
 *   3. Worker tick — a queued row processed via `processOnce()` transitions
 *      pending → done (and error path is separately covered).
 *   4. Concurrency cap — when multiple events are enqueued, the worker
 *      never has more than `WEBHOOK_WORKER_CONCURRENCY` rows in-flight.
 *   5. Stale-claim recovery — rows left in 'processing' from a prior run
 *      are reset to 'pending' when the worker re-initializes.
 */
import crypto from 'crypto';
import type supertest from 'supertest';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getRequest, createProject } from './helpers.js';
import type { WebhookEventRow, Stmts } from '../types.js';

let request: supertest.Agent;
let projectId: string;
let webhookSecret: string;
let stmts: Stmts;

const REPO_URL = 'https://github.com/queue-test-org/queue-test-repo';
const REPO_FULL_NAME = 'queue-test-org/queue-test-repo';

function signBody(secret: string, body: unknown): { raw: string; signature: string } {
  const raw = JSON.stringify(body);
  const signature = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
  return { raw, signature };
}

interface PingBody {
  zen: string;
  hook_id: number;
  repository: { full_name: string; html_url: string };
  sender: { login: string };
}

function pingBody(suffix = ''): PingBody {
  return {
    zen: `Responsive is better than fast.${suffix}`,
    hook_id: 42,
    repository: { full_name: REPO_FULL_NAME, html_url: REPO_URL },
    sender: { login: 'queue-test-user' },
  };
}

async function enqueuePingWithSecret(suffix: string, deliveryId: string): Promise<number> {
  const body = pingBody(suffix);
  const { raw, signature } = signBody(webhookSecret, body);
  const res = await request
    .post('/api/webhooks/github')
    .set('content-type', 'application/json')
    .set('x-github-event', 'ping')
    .set('x-github-delivery', deliveryId)
    .set('x-hub-signature-256', signature)
    .send(raw)
    .expect(202);
  return (res.body as { id: number }).id;
}

function getEventById(id: number): WebhookEventRow | undefined {
  return stmts.getWebhookEventById.get(id) as WebhookEventRow | undefined;
}

function countByStatus(): Record<string, number> {
  const rows = stmts.countWebhookEventsByStatus.all() as Array<{ status: string; n: number }>;
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}

async function restoreDefaultWorker(): Promise<void> {
  const worker = await import('../webhook-worker.js');
  worker.stopWebhookWorker();
  const { webhookHandlerDeps } = await import('../index.js');
  worker.initWebhookWorker({
    stmts: webhookHandlerDeps.stmts,
    routeDeps: webhookHandlerDeps,
  });
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
      // No enabled handler — we only exercise queue + worker plumbing, not
      // the Claude CLI dispatch (which isn't available in CI).
      events: {},
      enabled: true,
    })
    .expect(200);
  webhookSecret = (res.body as { secret: string }).secret;

  const { webhookHandlerDeps } = await import('../index.js');
  stmts = webhookHandlerDeps.stmts;
});

afterAll(async () => {
  // Leave the worker in the real/default state for any sibling tests.
  await restoreDefaultWorker();
});

// ─── 1. Fast-ack ────────────────────────────────────────────────────

describe('Webhook fast-ack', () => {
  it('responds 202 quickly and inserts a pending row', async () => {
    const deliveryId = 'queue-ack-1';
    const t0 = Date.now();
    const id = await enqueuePingWithSecret(' ack1', deliveryId);
    const elapsed = Date.now() - t0;

    // Loose budget: individual POSTs should be fast, but CI latency is
    // variable. 500ms is a sane upper bound that still catches the old
    // in-handler blocking (which used to hold for tens of seconds).
    expect(elapsed).toBeLessThan(500);

    const row = getEventById(id);
    expect(row).toBeDefined();
    expect(row!.status).toBe('pending');
    expect(row!.delivery_id).toBe(deliveryId);
    expect(row!.event_type).toBe('ping');
    const parsed = JSON.parse(row!.payload) as PingBody;
    expect(parsed.hook_id).toBe(42);
  });

  it('stays under a loose p95 budget across a small burst', async () => {
    // 20 sequential POSTs — catches any single-call stall in the max.
    // Smoke test, not a load test.
    const timings: number[] = [];
    for (let i = 0; i < 20; i++) {
      const t0 = Date.now();
      await enqueuePingWithSecret(` burst-${i}`, `queue-burst-${i}`);
      timings.push(Date.now() - t0);
    }
    timings.sort((a, b) => a - b);
    const p95 = timings[Math.floor(timings.length * 0.95)];
    // Generous 1s p95 — real prod budget is tighter, but CI VMs are noisy.
    // Anything near the old multi-second handler trivially fails this.
    expect(p95).toBeLessThan(1000);
  });
});

// ─── 2. Idempotency by x-github-delivery ────────────────────────────

describe('Webhook idempotency', () => {
  it('returns 200 duplicate on re-delivery and does not insert a second row', async () => {
    const deliveryId = 'queue-idem-1';
    const firstId = await enqueuePingWithSecret(' idem', deliveryId);

    const body = pingBody(' idem');
    const { raw, signature } = signBody(webhookSecret, body);
    const second = await request
      .post('/api/webhooks/github')
      .set('content-type', 'application/json')
      .set('x-github-event', 'ping')
      .set('x-github-delivery', deliveryId)
      .set('x-hub-signature-256', signature)
      .send(raw);

    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ status: 'duplicate', id: firstId });

    // The partial unique index on delivery_id enforces single-row-per-delivery
    // at the DB layer too — verify via direct lookup.
    const existing = stmts.getWebhookEventByDelivery.get(deliveryId) as { id: number } | undefined;
    expect(existing?.id).toBe(firstId);
  });
});

// ─── 3. Worker tick — process a pending row ─────────────────────────

describe('Webhook worker tick', () => {
  it('transitions a pending row to done when processed', async () => {
    const id = await enqueuePingWithSecret(' tick', 'queue-tick-1');
    expect(getEventById(id)!.status).toBe('pending');

    // Drain until the specific row we enqueued is processed. Because
    // the beforeAll runs sequentially across test files, other pending
    // rows from earlier tests may exist — drain until ours is done.
    const { processOnce } = await import('../webhook-worker.js');
    for (let i = 0; i < 50; i++) {
      if (getEventById(id)!.status !== 'pending') break;
      const didWork = await processOnce();
      if (!didWork) break;
    }

    const row = getEventById(id)!;
    // `ping` has no enabled handler and no kanban effect — the worker
    // still transitions the row to 'done' after processWebhookEvent
    // returns normally.
    expect(row.status).toBe('done');
    expect(row.completed_at).not.toBeNull();
    expect(row.attempts).toBeGreaterThanOrEqual(1);
  });

  it('marks the row as error and stores the message when processing throws', async () => {
    // Re-initialize the singleton worker with an injected processEvent
    // that throws, so we can exercise the failure path without depending
    // on a real handler configuration.
    const worker = await import('../webhook-worker.js');
    worker.stopWebhookWorker();

    const { webhookHandlerDeps } = await import('../index.js');
    worker.initWebhookWorker({
      stmts: webhookHandlerDeps.stmts,
      routeDeps: webhookHandlerDeps,
      processEvent: async () => {
        throw new Error('synthetic failure');
      },
    });

    try {
      const id = await enqueuePingWithSecret(' err', 'queue-err-1');

      // Drain until our row is no longer pending — the injected failing
      // processEvent will be called for every claimed row.
      for (let i = 0; i < 50; i++) {
        if (getEventById(id)!.status !== 'pending') break;
        const didWork = await worker.processOnce();
        if (!didWork) break;
      }

      const row = getEventById(id)!;
      expect(row.status).toBe('error');
      expect(row.error_message).toContain('synthetic failure');
      expect(row.completed_at).not.toBeNull();
    } finally {
      await restoreDefaultWorker();
    }
  });
});

// ─── 4. Concurrency cap ─────────────────────────────────────────────

describe('Webhook worker concurrency cap', () => {
  it('never exceeds WEBHOOK_WORKER_CONCURRENCY rows in-flight', async () => {
    const worker = await import('../webhook-worker.js');
    const { WEBHOOK_WORKER_CONCURRENCY } = worker;
    worker.stopWebhookWorker();

    // Gate that releases on demand so we can inspect in-flight state.
    let releaseAll: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseAll = resolve;
    });

    let observedMax = 0;
    let concurrent = 0;

    const { webhookHandlerDeps } = await import('../index.js');
    worker.initWebhookWorker({
      stmts: webhookHandlerDeps.stmts,
      routeDeps: webhookHandlerDeps,
      processEvent: async () => {
        concurrent++;
        if (concurrent > observedMax) observedMax = concurrent;
        try {
          await gate;
        } finally {
          concurrent--;
        }
      },
    });

    try {
      // Enqueue 5 events with a unique delivery prefix so they don't
      // collide with other tests' IDs.
      for (let i = 0; i < 5; i++) {
        await enqueuePingWithSecret(` cap-${i}`, `queue-cap-${i}`);
      }

      // Kick the worker: tickForTest fires up to CONCURRENCY_CAP claims.
      worker.tickForTest();
      // Brief wait for claims to land in-flight (they block on `gate`).
      await new Promise((r) => setTimeout(r, 100));

      const byStatus = countByStatus();
      const processingCount = byStatus.processing ?? 0;

      // In-memory counter is the authoritative view for the worker.
      expect(worker.getInFlightCount()).toBeLessThanOrEqual(WEBHOOK_WORKER_CONCURRENCY);
      // DB view matches — what an operator would see.
      expect(processingCount).toBeLessThanOrEqual(WEBHOOK_WORKER_CONCURRENCY);
      expect(observedMax).toBeLessThanOrEqual(WEBHOOK_WORKER_CONCURRENCY);
      // And at least one should be in flight, proving we actually started.
      expect(worker.getInFlightCount()).toBeGreaterThan(0);

      // Release everything so the in-flight completes.
      releaseAll();
      // Wait out the setImmediate chain that runOneClaim uses to refill.
      await new Promise((r) => setTimeout(r, 200));
    } finally {
      releaseAll();
      await restoreDefaultWorker();
      // Drain any remaining 'pending' rows with the real worker so we
      // don't leak state to later tests in this file.
      const { processOnce } = await import('../webhook-worker.js');
      for (let i = 0; i < 20; i++) {
        const didWork = await processOnce();
        if (!didWork) break;
      }
    }
  });
});

// ─── 5. Stale-claim recovery on boot ────────────────────────────────

describe('Webhook worker stale-claim recovery', () => {
  it('resets processing rows back to pending on init', async () => {
    // Drain existing pending rows first so our fixture is the only one.
    const worker = await import('../webhook-worker.js');
    for (let i = 0; i < 20; i++) {
      const didWork = await worker.processOnce();
      if (!didWork) break;
    }

    const id = await enqueuePingWithSecret(' stale', 'queue-stale-1');

    // Simulate a row stuck in 'processing' (e.g., SIGKILL mid-job):
    // claim it but don't mark it done.
    const claimed = stmts.claimPendingWebhookEvent.get() as WebhookEventRow | undefined;
    expect(claimed?.id).toBe(id);
    expect(getEventById(id)!.status).toBe('processing');

    // Re-init the worker — stale-claim recovery should reset our row.
    await restoreDefaultWorker();

    expect(getEventById(id)!.status).toBe('pending');

    // Clean up so we don't leak state.
    for (let i = 0; i < 20; i++) {
      const didWork = await worker.processOnce();
      if (!didWork) break;
    }
  });
});
