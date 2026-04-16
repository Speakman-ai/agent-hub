/**
 * Integration test: `check_run.rerequested` and `check_suite.rerequested`
 *
 * Both fire when a user clicks "Re-run" in GitHub's Checks tab (the former for
 * a single check, the latter for the whole suite). Agent Hub re-dispatches the
 * Reviewer agent for every PR listed in the event. This test pins that the
 * webhook endpoint accepts those event shapes without throwing — we can't
 * assert the reviewer ran (no Claude CLI in CI), but the routing layer is the
 * load-bearing surface.
 */
import type supertest from 'supertest';
import { getRequest, createProject, drainWebhookQueue } from './helpers.js';

let request: supertest.Agent;
let projectId: string;

beforeAll(async () => {
  request = await getRequest();
  const project = await createProject();
  projectId = project.id as string;

  await request
    .post('/api/webhooks')
    .send({
      projectId,
      repoUrl: 'https://github.com/rerun-org/rerun-repo',
      events: ['pull_request.opened', 'check_run.rerequested', 'check_suite.rerequested'],
      enabled: true,
    })
    .expect(200);
});

describe('Webhook check_run.rerequested', () => {
  it('accepts a check_run.rerequested payload without error', async () => {
    const res = await request
      .post('/api/webhooks/github')
      .set('x-github-event', 'check_run')
      .set('x-github-delivery', 'rerun-delivery-1')
      .send({
        action: 'rerequested',
        repository: {
          full_name: 'rerun-org/rerun-repo',
          html_url: 'https://github.com/rerun-org/rerun-repo',
        },
        sender: { login: 'test-user' },
        check_run: {
          id: 12345,
          head_sha: 'deadbeef1234',
          status: 'completed',
          conclusion: 'neutral',
          pull_requests: [{ number: 77, head: { sha: 'deadbeef1234' }, base: { sha: 'cafebabe' } }],
        },
      })
      .expect(202);

    // Fast-ack: handler enqueues the event and returns 202 `{status:'queued'}`.
    // The worker subsequently processes it; we drain to exercise that path.
    expect(res.body).toMatchObject({ status: 'queued' });
    await drainWebhookQueue();
  });

  it('accepts a check_suite.rerequested payload without error', async () => {
    const res = await request
      .post('/api/webhooks/github')
      .set('x-github-event', 'check_suite')
      .set('x-github-delivery', 'rerun-suite-1')
      .send({
        action: 'rerequested',
        repository: {
          full_name: 'rerun-org/rerun-repo',
          html_url: 'https://github.com/rerun-org/rerun-repo',
        },
        sender: { login: 'test-user' },
        check_suite: {
          id: 67890,
          head_sha: 'abc12300',
          status: 'completed',
          conclusion: 'failure',
          pull_requests: [{ number: 88, head: { sha: 'abc12300' }, base: { sha: 'aaa111' } }],
        },
      })
      .expect(202);

    expect(res.body).toMatchObject({ status: 'queued' });
    await drainWebhookQueue();
  });

  it('does not crash on a check_suite.rerequested with empty pull_requests[] (fork)', async () => {
    // GitHub sends empty `pull_requests` when the suite is on a fork's branch
    // — the handler must not throw.
    const res = await request
      .post('/api/webhooks/github')
      .set('x-github-event', 'check_suite')
      .set('x-github-delivery', 'rerun-fork-1')
      .send({
        action: 'rerequested',
        repository: {
          full_name: 'rerun-org/rerun-repo',
          html_url: 'https://github.com/rerun-org/rerun-repo',
        },
        sender: { login: 'test-user' },
        check_suite: {
          id: 11111,
          head_sha: 'forkysha',
          status: 'completed',
          pull_requests: [],
        },
      })
      .expect(202);

    expect(res.body).toMatchObject({ status: 'queued' });
    await drainWebhookQueue();
  });
});
