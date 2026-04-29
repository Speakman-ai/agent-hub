/**
 * Webhook CLI exit-code regression test.
 *
 * `processWebhookEvent` was switched to the `detailed: true` overload of
 * `runClaude` so timeouts and CLI errors surface partial stdout/stderr
 * for diagnostics. That overload, however, **always resolves on close**
 * regardless of exit code (heartbeat.ts:244-251) — unlike the
 * non-detailed overload, which rejected when `code !== 0 && !output`.
 *
 * Without explicit handling, a Claude CLI run that exits with code 1
 * (auth failure, internal panic, malformed prompt rejection) would
 * silently flip webhook_logs.status to 'success' and broadcast
 * `webhook_event` with status='success', breaking any UI / alert that
 * filters on `status = 'error'`.
 *
 * This file pins the post-fix contract: a non-zero CLI exit must
 * - write webhook_logs.status = 'error'
 * - re-throw so the worker marks the webhook_events row 'error' too
 *
 * The test patches `webhookHandlerDeps.runClaude` for the duration of
 * the test so we don't need a real Claude binary.
 */
import crypto from 'crypto';
import type supertest from 'supertest';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getRequest, createProject, drainWebhookQueue } from './helpers.js';
import type { Stmts } from '../types.js';

interface WebhookConfigResponse {
  id: number;
  secret: string;
}

interface WebhookLogRow {
  id: number;
  status: string;
  result: string | null;
  duration_ms: number | null;
}

interface WebhookEventQueueRow {
  id: number;
  delivery_id: string | null;
  status: string;
  error_message: string | null;
}

function signBody(secret: string, body: unknown): { raw: string; signature: string } {
  const raw = JSON.stringify(body);
  const signature = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
  return { raw, signature };
}

describe('Webhook handler — non-zero CLI exit code surfaces as error', () => {
  let request: supertest.Agent;
  let webhookSecret: string;
  let webhookConfigId: number;
  let stmts: Stmts;
  let savedRunClaude: unknown;

  let deps: any;

  const REPO_URL = 'https://github.com/exit-code-org/exit-code-repo';
  const REPO_FULL_NAME = 'exit-code-org/exit-code-repo';

  beforeAll(async () => {
    request = await getRequest();
    const project = await createProject();
    const projectId = project.id as string;

    const createRes = await request
      .post('/api/webhooks')
      .send({
        projectId,
        repoUrl: REPO_URL,
        events: {
          'pull_request.synchronize': {
            enabled: true,
            prompt: 'irrelevant — runClaude is mocked',
          },
        },
        enabled: true,
      })
      .expect(200);
    const created = createRes.body as WebhookConfigResponse;
    webhookSecret = created.secret;
    webhookConfigId = created.id;

    const { webhookHandlerDeps } = await import('../index.js');
    deps = webhookHandlerDeps;
    stmts = webhookHandlerDeps.stmts;
    savedRunClaude = webhookHandlerDeps.runClaude;
  });

  afterAll(() => {
    deps.runClaude = savedRunClaude;
  });

  function findLog(deliveryId: string): WebhookLogRow | undefined {
    const logs = stmts.getWebhookLogs.all(webhookConfigId, 100) as WebhookLogRow[];
    return logs.find((l) => (l as unknown as { delivery_id: string }).delivery_id === deliveryId);
  }

  function findQueueRow(deliveryId: string): WebhookEventQueueRow | undefined {
    // `webhook_events` is the worker's queue table; status='error' there
    // is what surfaces on the operator dashboard's "stuck" view. Look up
    // by delivery_id via the indexed lookup, then fetch the full row.
    const idRow = stmts.getWebhookEventByDelivery.get(deliveryId) as { id: number } | undefined;
    if (!idRow) return undefined;
    return stmts.getWebhookEventById.get(idRow.id) as WebhookEventQueueRow | undefined;
  }

  async function postSynchronize(deliveryId: string): Promise<void> {
    const body = {
      action: 'synchronize',
      repository: { full_name: REPO_FULL_NAME, html_url: REPO_URL },
      sender: { login: 'real-human' },
      pull_request: {
        number: 42,
        title: 'CLI-exit regression test PR',
        html_url: `${REPO_URL}/pull/42`,
        head: { ref: 'feat/exit', sha: 'cafef00d' },
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

  it('records webhook_logs.status=error when the CLI exits non-zero in detailed mode', async () => {
    // Detailed mode resolves with a result instead of rejecting. Simulate
    // a Claude run that completes with exit code 1 + stderr (the auth-failure
    // / panic shape).
    deps.runClaude = async () => ({
      stdout: 'partial analysis output...',
      stderr: 'Error: invalid API key',
      code: 1,
    });

    const deliveryId = 'cli-exit-nonzero';
    await postSynchronize(deliveryId);

    const log = findLog(deliveryId);
    expect(log).toBeDefined();
    expect(log!.status).toBe('error');
    // The error result captures stdout|stderr (whichever is non-empty)
    // truncated to 10 000 chars — operators see what the CLI emitted.
    expect(log!.result).toMatch(/partial analysis output|invalid API key/);
  });

  it('records webhook_logs.status=success when the CLI exits 0', async () => {
    // Sanity: the new code path didn't accidentally flip every result to
    // 'error'. A clean exit still goes green.
    deps.runClaude = async () => ({
      stdout: 'all good',
      stderr: '',
      code: 0,
    });

    const deliveryId = 'cli-exit-zero';
    await postSynchronize(deliveryId);

    const log = findLog(deliveryId);
    expect(log).toBeDefined();
    expect(log!.status).toBe('success');
    expect(log!.result).toContain('all good');
  });

  it('marks the webhook_events queue row as error when the CLI exits non-zero', async () => {
    // The worker uses the *thrown* exception from processWebhookEvent to
    // mark the queue row error. The success/error branch in
    // processWebhookEvent funnels through `handlerError` → re-throw, so
    // a non-zero exit must propagate.
    deps.runClaude = async () => ({
      stdout: '',
      stderr: 'CLI panicked: ETIMEDOUT contacting model',
      code: 2,
    });

    const deliveryId = 'cli-exit-queue-error';
    await postSynchronize(deliveryId);

    const queueRow = findQueueRow(deliveryId);
    expect(queueRow).toBeDefined();
    expect(queueRow!.status).toBe('error');
    expect(queueRow!.error_message).toMatch(/exited with code 2/);
  });
});
