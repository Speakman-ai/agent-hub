import type supertest from 'supertest';
import { getRequest, createProject, drainWebhookQueue } from './helpers.js';

let request: supertest.Agent;
let projectId: string;

beforeAll(async () => {
  request = await getRequest();
  const project = await createProject();
  projectId = project.id as string;
});

// ═══════════════════════════════════════════════════════════════════
// Webhook PR opened → does NOT auto-create kanban card
//
// Background: the webhook used to auto-create a card on `pull_request.opened`
// when no existing card matched by pr_url / branch session-id / title. That
// raced with agent-authored flows (agents link pr_url *after* `gh pr create`)
// and produced duplicate cards. Cards are now created exclusively by agents
// or the "Create PR" button; external PRs that don't match a card simply
// won't appear on the board.
// ═══════════════════════════════════════════════════════════════════

describe('Webhook PR opened does not auto-create a kanban card', () => {
  beforeAll(async () => {
    // Register a webhook config for this project
    await request
      .post('/api/webhooks')
      .send({
        projectId,
        repoUrl: 'https://github.com/test-org/test-repo',
        events: ['pull_request.opened'],
        enabled: true,
      })
      .expect(200);
  });

  it('does NOT create a card when PR opens and no card matches', async () => {
    const boardBefore = await request.get(`/api/projects/${projectId}/board`).expect(200);
    const cardCountBefore = (boardBefore.body as { cards: unknown[] }).cards.length;

    // Send a pull_request.opened webhook with no pre-existing card
    const res = await request
      .post('/api/webhooks/github')
      .set('x-github-event', 'pull_request')
      .set('x-github-delivery', 'no-autocreate-delivery-1')
      .send({
        action: 'opened',
        repository: {
          full_name: 'test-org/test-repo',
          html_url: 'https://github.com/test-org/test-repo',
        },
        sender: { login: 'test-user' },
        pull_request: {
          number: 42,
          title: 'Fix login button not responding',
          html_url: 'https://github.com/test-org/test-repo/pull/42',
          head: { ref: 'fix/login-button', sha: 'abc123' },
          base: { ref: 'main' },
          body: 'The login button was not firing the onClick handler.',
        },
      });

    // 202 Accepted: fast-ack enqueues the event, worker processes it next.
    expect(res.status).toBe(202);
    await drainWebhookQueue();

    // No card with this PR URL should exist
    const boardAfter = await request.get(`/api/projects/${projectId}/board`).expect(200);
    const board = boardAfter.body as {
      cards: Array<{ pr_url: string | null }>;
    };
    const matching = board.cards.filter(
      (c) => c.pr_url === 'https://github.com/test-org/test-repo/pull/42',
    );
    expect(matching.length).toBe(0);

    // Card count should be unchanged
    expect(board.cards.length).toBe(cardCountBefore);
  });

  it('does NOT create a card even when PR body has rich content', async () => {
    const boardBefore = await request.get(`/api/projects/${projectId}/board`).expect(200);
    const cardCountBefore = (boardBefore.body as { cards: unknown[] }).cards.length;

    await request
      .post('/api/webhooks/github')
      .set('x-github-event', 'pull_request')
      .set('x-github-delivery', 'no-autocreate-delivery-2')
      .send({
        action: 'opened',
        repository: {
          full_name: 'test-org/test-repo',
          html_url: 'https://github.com/test-org/test-repo',
        },
        sender: { login: 'dev-user' },
        pull_request: {
          number: 99,
          title: 'Add dark mode toggle',
          html_url: 'https://github.com/test-org/test-repo/pull/99',
          head: { ref: 'feature/dark-mode', sha: 'def456' },
          base: { ref: 'main' },
          body: '## Summary\nUsers requested a dark mode toggle in settings.\n\nCloses #45',
        },
      })
      .expect(202);
    await drainWebhookQueue();

    const boardAfter = await request.get(`/api/projects/${projectId}/board`).expect(200);
    const board = boardAfter.body as { cards: Array<{ pr_url: string | null }> };
    const matching = board.cards.filter(
      (c) => c.pr_url === 'https://github.com/test-org/test-repo/pull/99',
    );
    expect(matching.length).toBe(0);
    expect(board.cards.length).toBe(cardCountBefore);
  });
});
