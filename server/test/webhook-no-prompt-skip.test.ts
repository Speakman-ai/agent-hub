import crypto from 'crypto';
import type supertest from 'supertest';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getRequest, createProject, drainWebhookQueue } from './helpers.js';
import type { Stmts } from '../types.js';

interface WebhookConfigResponse {
  id: number;
  secret: string;
}

interface WebhookEventQueueRow {
  id: number;
  status: string;
  error_message: string | null;
}

function signBody(secret: string, body: unknown): { raw: string; signature: string } {
  const raw = JSON.stringify(body);
  const signature = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
  return { raw, signature };
}

describe('Webhook handler skips Claude when event is enabled without prompt', () => {
  let request: supertest.Agent;
  let webhookSecret: string;
  let deps: any;
  let stmts: Stmts;
  let savedRunClaude: unknown;

  beforeAll(async () => {
    request = await getRequest();
    const project = await createProject();
    const projectId = project.id as string;

    const createRes = await request
      .post('/api/webhooks')
      .send({
        projectId,
        repoUrl: 'https://github.com/no-prompt-org/no-prompt-repo',
        events: {
          'pull_request.opened': {
            enabled: true,
          },
        },
        enabled: true,
      })
      .expect(200);
    const created = createRes.body as WebhookConfigResponse;
    webhookSecret = created.secret;

    const { webhookHandlerDeps } = await import('../index.js');
    deps = webhookHandlerDeps;
    stmts = webhookHandlerDeps.stmts;
    savedRunClaude = webhookHandlerDeps.runClaude;
  });

  afterAll(() => {
    deps.runClaude = savedRunClaude;
  });

  it('does not invoke runClaude and leaves the queue row non-error', async () => {
    let callCount = 0;
    deps.runClaude = async () => {
      callCount += 1;
      return { stdout: 'unexpected', stderr: '', code: 0 };
    };

    const deliveryId = 'no-prompt-opened-1';
    const body = {
      action: 'opened',
      repository: {
        full_name: 'no-prompt-org/no-prompt-repo',
        html_url: 'https://github.com/no-prompt-org/no-prompt-repo',
      },
      sender: { login: 'human-author' },
      pull_request: {
        number: 7,
        title: 'No prompt test',
        html_url: 'https://github.com/no-prompt-org/no-prompt-repo/pull/7',
        head: { ref: 'feat/no-prompt', sha: 'abc123' },
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

    expect(callCount).toBe(0);
    const rowId = stmts.getWebhookEventByDelivery.get(deliveryId) as { id: number } | undefined;
    expect(rowId).toBeDefined();
    const row = stmts.getWebhookEventById.get(rowId!.id) as WebhookEventQueueRow | undefined;
    expect(row).toBeDefined();
    expect(row!.status).toBe('done');
    expect(row!.error_message).toBeNull();
  });
});
