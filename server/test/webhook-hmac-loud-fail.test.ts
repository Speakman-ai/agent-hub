/**
 * Loud-fail + self-heal coverage for the webhook HMAC handler.
 *
 * Companion to `webhook-hmac.test.ts` (which only proved the dual-secret
 * acceptance path). This file proves the *failure* side-effects:
 *
 *   1. A rejected delivery becomes visible via GET /api/webhooks/hmac-failures.
 *   2. When the failed delivery is App-flagged AND we have a local App
 *      secret, the handler asynchronously pushes our secret to GitHub
 *      via PATCH /app/hook/config (mocked here).
 *   3. The push is throttled — a burst of bad deliveries triggers at
 *      most one PATCH per 60-second window.
 *   4. Per-repo deliveries (no App header) never trigger a PATCH even if
 *      App config exists.
 */

import crypto from 'crypto';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import type supertest from 'supertest';
import { generateKeyPairSync } from 'crypto';
import { getRequest, createProject } from './helpers.js';
import { clearHmacFailures, resetHealThrottle } from '../webhook-hmac-failures.js';

const REPO_URL = 'https://github.com/loud-fail-org/loud-fail-repo';
const REPO_FULL_NAME = 'loud-fail-org/loud-fail-repo';

const { privateKey: appPrivateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
});

let request: supertest.Agent;
let originalGithubApp: unknown;

function signBody(secret: string, body: unknown): { raw: string; signature: string } {
  const raw = JSON.stringify(body);
  const signature = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
  return { raw, signature };
}

function payload(): Record<string, unknown> {
  return {
    action: 'opened',
    repository: { full_name: REPO_FULL_NAME, html_url: REPO_URL },
    sender: { login: 'loud-fail-user' },
    pull_request: { number: 1, title: 'x', html_url: 'x' },
  };
}

beforeAll(async () => {
  request = await getRequest();
  const project = await createProject();
  await request
    .post('/api/webhooks')
    .send({
      projectId: project.id,
      repoUrl: REPO_URL,
      events: { pull_request: { enabled: false } },
      enabled: true,
    })
    .expect(200);

  const { default: config } = await import('../config.js');
  originalGithubApp = (config as { githubApp: unknown }).githubApp;
});

afterAll(async () => {
  const { default: config } = await import('../config.js');
  (config as unknown as { githubApp: unknown }).githubApp = originalGithubApp;
});

beforeEach(() => {
  clearHmacFailures();
  resetHealThrottle();
});

describe('HMAC failure loud-fail surface', () => {
  it('records a rejected delivery in the in-memory ring buffer', async () => {
    const body = payload();
    const { raw, signature } = signBody('wrong-secret', body);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await request
        .post('/api/webhooks/github')
        .set('content-type', 'application/json')
        .set('x-github-event', 'pull_request')
        .set('x-github-delivery', 'loud-fail-delivery-1')
        .set('x-hub-signature-256', signature)
        .send(raw)
        .expect(401);
    } finally {
      warnSpy.mockRestore();
    }

    const listRes = await request.get('/api/webhooks/hmac-failures').expect(200);
    const failures = (listRes.body as { failures: Array<Record<string, unknown>> }).failures;
    expect(failures.length).toBeGreaterThan(0);
    const newest = failures[0];
    expect(newest.repoFullName).toBe(REPO_FULL_NAME);
    expect(newest.deliveryId).toBe('loud-fail-delivery-1');
    expect(newest.eventLabel).toBe('pull_request.opened');
    expect(newest.isAppDelivery).toBe(false);
  });

  it('respects the `limit` query parameter', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (let i = 0; i < 3; i++) {
        const body = payload();
        const { raw, signature } = signBody('wrong-secret', body);
        await request
          .post('/api/webhooks/github')
          .set('content-type', 'application/json')
          .set('x-github-event', 'pull_request')
          .set('x-github-delivery', `loud-fail-delivery-limit-${i}`)
          .set('x-hub-signature-256', signature)
          .send(raw)
          .expect(401);
      }
    } finally {
      warnSpy.mockRestore();
    }

    const listRes = await request.get('/api/webhooks/hmac-failures?limit=2').expect(200);
    const failures = (listRes.body as { failures: unknown[] }).failures;
    expect(failures).toHaveLength(2);
  });
});

describe('HMAC failure self-heal — PATCH /app/hook/config', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { default: config } = await import('../config.js');
    (config as unknown as { githubApp: unknown }).githubApp = {
      appId: '999',
      privateKey: appPrivateKey,
      webhookSecret: 'local-known-good-secret',
    };
  });

  afterEach(async () => {
    fetchSpy.mockRestore();
    warnSpy.mockRestore();
    const { default: config } = await import('../config.js');
    (config as unknown as { githubApp: unknown }).githubApp = originalGithubApp;
  });

  it('PATCHes /app/hook/config when an App-flagged delivery fails HMAC', async () => {
    fetchSpy.mockResolvedValue(new Response('', { status: 200 }));

    const body = payload();
    const { raw, signature } = signBody('wrong-secret', body);

    await request
      .post('/api/webhooks/github')
      .set('content-type', 'application/json')
      .set('x-github-event', 'pull_request')
      .set('x-github-delivery', 'app-heal-delivery-1')
      .set('x-github-hook-installation-target-type', 'integration')
      .set('x-hub-signature-256', signature)
      .send(raw)
      .expect(401);

    // self-heal kicks off asynchronously (we don't await it inside the
    // handler), so give the microtask queue a tick to flush.
    await new Promise((resolve) => setImmediate(resolve));

    const patchCalls = fetchSpy.mock.calls.filter(
      (c: unknown[]) =>
        String(c[0]).endsWith('/app/hook/config') && (c[1] as RequestInit)?.method === 'PATCH',
    );
    expect(patchCalls).toHaveLength(1);
    const body0 = JSON.parse((patchCalls[0][1] as RequestInit).body as string);
    expect(body0).toEqual({ secret: 'local-known-good-secret' });

    const failures = (
      (await request.get('/api/webhooks/hmac-failures').expect(200)).body as {
        failures: Array<Record<string, unknown>>;
      }
    ).failures;
    expect(failures[0]).toMatchObject({
      isAppDelivery: true,
      healAttempted: true,
    });
  });

  it('does NOT PATCH when the delivery is a per-repo webhook (no App header)', async () => {
    fetchSpy.mockResolvedValue(new Response('', { status: 200 }));

    const body = payload();
    const { raw, signature } = signBody('wrong-secret', body);

    await request
      .post('/api/webhooks/github')
      .set('content-type', 'application/json')
      .set('x-github-event', 'pull_request')
      .set('x-github-delivery', 'no-app-header-delivery-1')
      .set('x-hub-signature-256', signature)
      .send(raw)
      .expect(401);

    await new Promise((resolve) => setImmediate(resolve));

    const patchCalls = fetchSpy.mock.calls.filter(
      (c: unknown[]) =>
        String(c[0]).endsWith('/app/hook/config') && (c[1] as RequestInit)?.method === 'PATCH',
    );
    expect(patchCalls).toHaveLength(0);
  });

  it('throttles to one PATCH per window even on a burst of bad App deliveries', async () => {
    fetchSpy.mockResolvedValue(new Response('', { status: 200 }));

    const sendBad = async (deliveryId: string): Promise<void> => {
      const body = payload();
      const { raw, signature } = signBody('wrong-secret', body);
      await request
        .post('/api/webhooks/github')
        .set('content-type', 'application/json')
        .set('x-github-event', 'pull_request')
        .set('x-github-delivery', deliveryId)
        .set('x-github-hook-installation-target-type', 'integration')
        .set('x-hub-signature-256', signature)
        .send(raw)
        .expect(401);
    };

    await sendBad('burst-1');
    await sendBad('burst-2');
    await sendBad('burst-3');
    await new Promise((resolve) => setImmediate(resolve));

    const patchCalls = fetchSpy.mock.calls.filter(
      (c: unknown[]) =>
        String(c[0]).endsWith('/app/hook/config') && (c[1] as RequestInit)?.method === 'PATCH',
    );
    expect(patchCalls).toHaveLength(1);
  });
});
