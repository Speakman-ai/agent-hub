import crypto from 'crypto';
import { vi } from 'vitest';
import type supertest from 'supertest';
import { getRequest, createProject } from './helpers.js';

let request: supertest.Agent;
let projectId: string;
let webhookSecret: string;
let originalGithubApp: unknown;

const REPO_URL = 'https://github.com/hmac-test-org/hmac-test-repo';
const REPO_FULL_NAME = 'hmac-test-org/hmac-test-repo';

function signBody(secret: string, body: unknown): { raw: string; signature: string } {
  const raw = JSON.stringify(body);
  const signature = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
  return { raw, signature };
}

function pingPayload(): Record<string, unknown> {
  return {
    zen: 'Responsive is better than fast.',
    hook_id: 12345,
    repository: { full_name: REPO_FULL_NAME, html_url: REPO_URL },
    sender: { login: 'test-user' },
  };
}

beforeAll(async () => {
  request = await getRequest();
  const project = await createProject();
  projectId = project.id as string;

  // Create a webhook config — the server generates a random secret we capture.
  const res = await request
    .post('/api/webhooks')
    .send({
      projectId,
      repoUrl: REPO_URL,
      events: { ping: { enabled: false } }, // not dispatching — HMAC is what we test
      enabled: true,
    })
    .expect(200);
  webhookSecret = (res.body as { secret: string }).secret;
  if (!webhookSecret || webhookSecret.length < 16) {
    throw new Error('Webhook creation did not return a usable secret');
  }

  // Save original githubApp config so tests can mutate and restore.
  const { default: config } = await import('../config.js');
  originalGithubApp = (config as { githubApp: unknown }).githubApp;
});

afterAll(async () => {
  const { default: config } = await import('../config.js');
  (config as unknown as { githubApp: unknown }).githubApp = originalGithubApp;
});

// ═══════════════════════════════════════════════════════════════════
// Webhook HMAC verification — dual-secret acceptance
//
// Background: GitHub Apps deliver webhook events to the same endpoint
// as repo-level webhooks but sign them with the App's webhook_secret
// rather than the per-repo secret stored in Agent Hub's DB. Previously
// only the repo secret was verified, so every App-delivered event
// failed with "[Webhook] HMAC verification failed" even though the
// signature was legitimate. The handler now accepts either secret.
// ═══════════════════════════════════════════════════════════════════

describe('Webhook HMAC verification', () => {
  it('accepts requests signed with the per-repo webhook secret', async () => {
    const body = pingPayload();
    const { raw, signature } = signBody(webhookSecret, body);

    const res = await request
      .post('/api/webhooks/github')
      .set('content-type', 'application/json')
      .set('x-github-event', 'ping')
      .set('x-github-delivery', 'hmac-test-delivery-repo-1')
      .set('x-hub-signature-256', signature)
      .send(raw);

    // 202 Accepted: fast-ack design enqueues the event for background
    // processing instead of handling it inline. See webhook-worker.ts.
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ status: 'queued' });
    expect(res.body).not.toHaveProperty('error', 'Invalid signature');
  });

  it('rejects requests signed with a wrong secret', async () => {
    const body = pingPayload();
    const { raw, signature } = signBody('totally-wrong-secret', body);

    const warnings: string[] = [];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args) => {
      warnings.push(args.map((a) => String(a)).join(' '));
    });

    try {
      const res = await request
        .post('/api/webhooks/github')
        .set('content-type', 'application/json')
        .set('x-github-event', 'pull_request')
        .set('x-github-delivery', 'hmac-test-delivery-bad-1')
        .set('x-hub-signature-256', signature)
        .send(raw);

      expect(res.status).toBe(401);
      expect(res.body).toHaveProperty('error', 'Invalid signature');

      // Log is enriched with event, delivery id, and which secrets were tried.
      const hmacWarnings = warnings.filter((w) => w.includes('HMAC verification failed'));
      expect(hmacWarnings.length).toBeGreaterThan(0);
      const combined = hmacWarnings.join('\n');
      expect(combined).toContain('event=pull_request');
      expect(combined).toContain('delivery=hmac-test-delivery-bad-1');
      expect(combined).toMatch(/tried=repo(\s|\b)/);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('includes the action in the enriched log when the payload carries one', async () => {
    const body = { ...pingPayload(), action: 'opened' };
    const { raw, signature } = signBody('totally-wrong-secret', body);

    const warnings: string[] = [];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args) => {
      warnings.push(args.map((a) => String(a)).join(' '));
    });

    try {
      await request
        .post('/api/webhooks/github')
        .set('content-type', 'application/json')
        .set('x-github-event', 'pull_request')
        .set('x-github-delivery', 'hmac-test-delivery-action-1')
        .set('x-hub-signature-256', signature)
        .send(raw)
        .expect(401);

      const combined = warnings.filter((w) => w.includes('HMAC verification failed')).join('\n');
      expect(combined).toContain('event=pull_request.opened');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('accepts requests signed with the GitHub App webhook secret when configured', async () => {
    const { default: config } = await import('../config.js');
    const mutableConfig = config as unknown as { githubApp: unknown };
    const appSecret = 'app-webhook-secret-abcdef1234567890';
    mutableConfig.githubApp = { webhookSecret: appSecret };

    try {
      const body = pingPayload();
      const { raw, signature } = signBody(appSecret, body);

      const res = await request
        .post('/api/webhooks/github')
        .set('content-type', 'application/json')
        .set('x-github-event', 'ping')
        .set('x-github-delivery', 'hmac-test-delivery-app-1')
        .set('x-hub-signature-256', signature)
        .send(raw);

      // 202 Accepted: fast-ack design (see webhook-worker.ts).
      expect(res.status).toBe(202);
      expect(res.body).toMatchObject({ status: 'queued' });
      expect(res.body).not.toHaveProperty('error', 'Invalid signature');
    } finally {
      mutableConfig.githubApp = originalGithubApp;
    }
  });

  it('rejects with "tried=repo + github-app" when the App secret is set but both fail', async () => {
    const { default: config } = await import('../config.js');
    const mutableConfig = config as unknown as { githubApp: unknown };
    const appSecret = 'app-webhook-secret-abcdef1234567890';
    mutableConfig.githubApp = { webhookSecret: appSecret };

    const warnings: string[] = [];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args) => {
      warnings.push(args.map((a) => String(a)).join(' '));
    });

    try {
      const body = pingPayload();
      const { raw, signature } = signBody('some-third-wrong-secret', body);

      await request
        .post('/api/webhooks/github')
        .set('content-type', 'application/json')
        .set('x-github-event', 'push')
        .set('x-github-delivery', 'hmac-test-delivery-app-bad-1')
        .set('x-hub-signature-256', signature)
        .send(raw)
        .expect(401);

      const combined = warnings.filter((w) => w.includes('HMAC verification failed')).join('\n');
      expect(combined).toContain('tried=repo + github-app');
    } finally {
      warnSpy.mockRestore();
      mutableConfig.githubApp = originalGithubApp;
    }
  });
});
