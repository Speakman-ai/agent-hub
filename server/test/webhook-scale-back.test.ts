/**
 * Webhook scale-back regression tests.
 *
 * Two behaviours are pinned here after the 2026-04-16 webhook storm:
 *
 *   1. Default-on event seed. When a project gets a `githubRepo` attached
 *      (PATCH /api/projects/:id with `{ githubRepo: "org/repo" }`), the
 *      seeded webhook config's `events` JSON enables only the three events
 *      the autonomous-mode polling safety net does NOT already cover. The
 *      other three are seeded `enabled: false` so they appear in the UI
 *      but don't spawn Claude runs by default.
 *
 *   2. Self-origin filter on processWebhookEvent. When the sender's login
 *      matches the configured GitHub App bot user (or the authenticated
 *      `gh` CLI user, or `github-actions[bot]`), the expensive LLM
 *      handler is skipped — the kanban lifecycle handler still ran
 *      upstream. Without this, bot-authored pushes / reviews re-trigger
 *      autofix and create a feedback loop.
 *
 * Scope note: these tests exercise the SQLite-backed worker pipeline
 * (fast-ack → enqueue → worker claim → processWebhookEvent) via
 * `drainWebhookQueue()`. They do NOT require a real Claude binary because
 * the assertions only inspect webhook_logs status rows and the seeded
 * webhook config — the skip paths never reach `runClaude`.
 */
import crypto from 'crypto';
import type supertest from 'supertest';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getRequest, createProject, drainWebhookQueue } from './helpers.js';
import type { Stmts } from '../types.js';

interface WebhookConfigResponse {
  id: number;
  project_id: string;
  repo_url: string;
  secret: string;
  events: string;
  enabled: number;
}

interface WebhookLogRow {
  id: number;
  webhook_config_id: number;
  event_type: string;
  action: string;
  delivery_id: string;
  status: string;
  result: string | null;
  duration_ms: number | null;
}

function signBody(secret: string, body: unknown): { raw: string; signature: string } {
  const raw = JSON.stringify(body);
  const signature = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
  return { raw, signature };
}

// ═══════════════════════════════════════════════════════════════════
// 1. Default-on event seed
// ═══════════════════════════════════════════════════════════════════

describe('Webhook config default events when seeded via PATCH githubRepo', () => {
  let request: supertest.Agent;
  let projectId: string;

  beforeAll(async () => {
    request = await getRequest();
    const project = await createProject();
    projectId = project.id as string;

    // Attaching a githubRepo triggers the default webhook config seed in
    // projects.ts. The repo slug is unique-per-test to avoid colliding with
    // any webhook config another test in the suite may have registered.
    await request
      .patch(`/api/projects/${projectId}`)
      .send({ githubRepo: `scale-back-org/scale-back-repo-${projectId}` })
      .expect(200);
  });

  it('enables only the three events not covered by the polling safety net', async () => {
    const res = await request.get(`/api/webhooks/project/${projectId}`).expect(200);
    const configs = res.body as WebhookConfigResponse[];
    expect(configs.length).toBe(1);
    const events = JSON.parse(configs[0].events) as Record<string, { enabled?: boolean }>;

    // Default-on: bootstrap, reviewer dispatch, inline review comments.
    expect(events['pull_request.opened']?.enabled).toBe(true);
    expect(events['pull_request.synchronize']?.enabled).toBe(true);
    expect(events['pull_request_review_comment.created']?.enabled).toBe(true);
  });

  it('seeds the three storm-prone events as enabled:false (pre-wired, off)', async () => {
    const res = await request.get(`/api/webhooks/project/${projectId}`).expect(200);
    const events = JSON.parse((res.body as WebhookConfigResponse[])[0].events) as Record<
      string,
      { enabled?: boolean }
    >;

    // Covered by `reconcileKanbanWithGitHub` — merged PRs sweep to Done
    // every 3 minutes regardless of webhook delivery.
    expect(events['pull_request.closed']).toBeDefined();
    expect(events['pull_request.closed']?.enabled).toBe(false);

    // Covered by `pollForMissedReviews` — changes_requested is picked up
    // from the polling loop with a max 3-minute latency.
    expect(events['pull_request_review.submitted']).toBeDefined();
    expect(events['pull_request_review.submitted']?.enabled).toBe(false);

    // Autofix-on-CI is now explicitly opt-in per repo. check_suite.completed
    // fires on every CI run (including passes) — leaving it on by default
    // was ~24% of the 1,079-invocation storm.
    expect(events['check_suite.completed']).toBeDefined();
    expect(events['check_suite.completed']?.enabled).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 2. Self-origin filter on processWebhookEvent
// ═══════════════════════════════════════════════════════════════════

describe('Webhook handler self-origin filter', () => {
  let request: supertest.Agent;
  let projectId: string;
  let webhookSecret: string;
  let webhookConfigId: number;
  let stmts: Stmts;
  let savedGhBotUser: string | null;
  let setGhBotUser: (v: string | null) => void;

  const REPO_URL = 'https://github.com/self-origin-org/self-origin-repo';
  const REPO_FULL_NAME = 'self-origin-org/self-origin-repo';
  const BOT_LOGIN = 'agent-hub-bot[bot]';

  beforeAll(async () => {
    request = await getRequest();
    const project = await createProject();
    projectId = project.id as string;

    // Register a webhook config with an enabled handler for the event we'll
    // test. Without an enabled handler the processor short-circuits on the
    // `handler.enabled` gate before reaching the self-origin check, so the
    // test wouldn't prove anything.
    const createRes = await request
      .post('/api/webhooks')
      .send({
        projectId,
        repoUrl: REPO_URL,
        events: {
          'pull_request.synchronize': {
            enabled: true,
            // Prompt is never executed in this test — the self-origin skip
            // fires before runClaude would be invoked.
            prompt: 'should-never-run',
          },
        },
        enabled: true,
      })
      .expect(200);
    const created = createRes.body as WebhookConfigResponse;
    webhookSecret = created.secret;
    webhookConfigId = created.id;

    const { webhookHandlerDeps } = await import('../index.js');
    stmts = webhookHandlerDeps.stmts;
    setGhBotUser = webhookHandlerDeps.setGhBotUser;
    savedGhBotUser = webhookHandlerDeps.getGhBotUser();
    setGhBotUser(BOT_LOGIN);
  });

  afterAll(() => {
    // Don't leak test state into sibling tests.
    setGhBotUser(savedGhBotUser);
  });

  function logByDelivery(deliveryId: string): WebhookLogRow | undefined {
    // created_at in webhook_logs is second-resolution CURRENT_TIMESTAMP, so
    // ORDER BY DESC ties are non-deterministic. Look up the specific row
    // by delivery_id to keep assertions unambiguous across fast tests.
    const logs = stmts.getWebhookLogs.all(webhookConfigId, 100) as WebhookLogRow[];
    return logs.find((l) => l.delivery_id === deliveryId);
  }

  async function postSynchronize(senderLogin: string, deliveryId: string): Promise<void> {
    const body = {
      action: 'synchronize',
      repository: { full_name: REPO_FULL_NAME, html_url: REPO_URL },
      sender: { login: senderLogin },
      pull_request: {
        number: 101,
        title: 'Scale-back test PR',
        html_url: `${REPO_URL}/pull/101`,
        head: { ref: 'feat/scale-back', sha: 'deadbeef' },
        base: { ref: 'main' },
      },
    };
    const { raw, signature } = signBody(webhookSecret, body);
    await request
      .post('/api/webhooks/github')
      .set('content-type', 'application/json')
      .set('x-github-event', 'pull_request')
      .set('x-github-delivery', deliveryId)
      .set('x-hub-signature-256', signature)
      .send(raw)
      .expect(202);
    await drainWebhookQueue();
  }

  it('skips the handler with result=self-origin when sender matches the bot user', async () => {
    const deliveryId = 'self-origin-delivery-bot';
    await postSynchronize(BOT_LOGIN, deliveryId);

    const log = logByDelivery(deliveryId);
    expect(log).toBeDefined();
    // addWebhookLog stores `eventKey` (event.action) in the event_type
    // column, not the raw event — so a synchronize shows up as
    // "pull_request.synchronize".
    expect(log!.event_type).toBe('pull_request.synchronize');
    expect(log!.action).toBe('synchronize');
    // `skipped` is whitelisted by the webhook_logs CHECK constraint; the
    // `result` column carries the reason so operators can distinguish
    // no-handler skips from self-origin skips in the admin log view.
    expect(log!.status).toBe('skipped');
    expect(log!.result).toContain('self-origin');
    expect(log!.result).toContain(BOT_LOGIN);
  });

  it('skips the handler when sender is github-actions[bot]', async () => {
    const deliveryId = 'self-origin-delivery-ghactions';
    await postSynchronize('github-actions[bot]', deliveryId);

    const log = logByDelivery(deliveryId);
    expect(log).toBeDefined();
    expect(log!.status).toBe('skipped');
    expect(log!.result).toContain('self-origin');
    expect(log!.result).toContain('github-actions[bot]');
  });

  it('runs the handler when sender is a real user (falls through to the running path)', async () => {
    const deliveryId = 'self-origin-delivery-human';
    await postSynchronize('real-human-user', deliveryId);

    const log = logByDelivery(deliveryId);
    expect(log).toBeDefined();
    // The LLM dispatch runs; since tests have no real Claude binary wired
    // up, it ends up status='error' with the runClaude ENOENT in `result`.
    // Key assertion: we did NOT take the self-origin skip branch.
    expect(log!.status).not.toBe('skipped');
    if (log!.result) {
      expect(log!.result).not.toContain('self-origin:');
    }
  });
});
