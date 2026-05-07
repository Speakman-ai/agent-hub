import crypto from 'crypto';
import type supertest from 'supertest';
import {
  expectedGithubWebhookSignature256,
  verifyGithubWebhookSignature256,
} from '../routes/webhooks.js';
import { getRequest, createProject } from './helpers.js';

describe('GitHub webhook HMAC over exact raw bytes', () => {
  it('reports mismatch when verifying against JSON.stringify(JSON.parse(buf)) instead of raw bytes', () => {
    const secret = 'fixture-secret-byte-exact-hmac-xx';
    const raw = Buffer.from(
      '{"repository":{"full_name":"o/r"},"action":"opened","pull_request":{"number":1}} \t\n',
      'utf8',
    );
    const signature = expectedGithubWebhookSignature256(secret, raw);

    expect(verifyGithubWebhookSignature256(secret, raw, signature)).toBe(true);

    const reserialized = Buffer.from(JSON.stringify(JSON.parse(raw.toString('utf8'))), 'utf8');
    expect(reserialized.equals(raw)).toBe(false);
    expect(verifyGithubWebhookSignature256(secret, reserialized, signature)).toBe(false);
  });

  it('accepts signatures for UTF-8 multi-byte payloads without re-encoding drift', () => {
    const secret = 'fixture-secret-utf8-hmac-xxxxxx';
    const raw = Buffer.from(
      '{"repository":{"full_name":"acct/répo"},"action":"completed","check_run":{"name":"λ","status":"completed","pull_requests":[{"number":42}]}}',
      'utf8',
    );
    const signature = expectedGithubWebhookSignature256(secret, raw);
    expect(verifyGithubWebhookSignature256(secret, raw, signature)).toBe(true);
  });
});

describe('GitHub webhook handler — event-type HMAC smoke (integration)', () => {
  let request: supertest.Agent;
  let webhookSecret: string;
  const REPO_URL = 'https://github.com/raw-hmac-org/raw-hmac-repo';
  const REPO_FULL_NAME = 'raw-hmac-org/raw-hmac-repo';

  function signRaw(secret: string, raw: string): string {
    return 'sha256=' + crypto.createHmac('sha256', secret).update(raw, 'utf8').digest('hex');
  }

  beforeAll(async () => {
    request = await getRequest();
    const project = await createProject();
    const res = await request
      .post('/api/webhooks')
      .send({
        projectId: project.id,
        repoUrl: REPO_URL,
        events: { ping: { enabled: false } },
        enabled: true,
      })
      .expect(200);
    webhookSecret = (res.body as { secret: string }).secret;
  });

  const cases: Array<{ event: string; raw: string; delivery: string }> = [
    {
      event: 'pull_request',
      delivery: 'raw-hmac-pr-1',
      raw: `{"action":"opened","repository":{"full_name":"${REPO_FULL_NAME}","html_url":"${REPO_URL}"},"pull_request":{"number":1,"title":"t","html_url":"${REPO_URL}/pull/1"}}`,
    },
    {
      event: 'check_run',
      delivery: 'raw-hmac-run-1',
      raw: `{"action":"completed","repository":{"full_name":"${REPO_FULL_NAME}","html_url":"${REPO_URL}"},"check_run":{"id":9001,"name":"ci","status":"completed","pull_requests":[{"number":1}]}}`,
    },
    {
      event: 'check_suite',
      delivery: 'raw-hmac-suite-1',
      raw: `{"action":"completed","repository":{"full_name":"${REPO_FULL_NAME}","html_url":"${REPO_URL}"},"check_suite":{"id":8002,"status":"completed","pull_requests":[{"number":1}]}}`,
    },
    {
      event: 'pull_request_review',
      delivery: 'raw-hmac-review-1',
      raw: `{"action":"submitted","repository":{"full_name":"${REPO_FULL_NAME}","html_url":"${REPO_URL}"},"pull_request":{"number":1},"review":{"user":{"login":"reviewer"},"state":"commented","body":"lgtm"}}`,
    },
  ];

  it.each(cases)(
    'accepts $event with a fixed UTF-8 raw body + signature',
    async ({ event, raw, delivery }) => {
      const signature = signRaw(webhookSecret, raw);
      const res = await request
        .post('/api/webhooks/github')
        .set('content-type', 'application/json; charset=utf-8')
        .set('x-github-event', event)
        .set('x-github-delivery', delivery)
        .set('x-hub-signature-256', signature)
        .send(raw);

      expect(res.status).toBe(202);
      expect(res.body).toMatchObject({ status: 'queued' });
    },
  );
});
