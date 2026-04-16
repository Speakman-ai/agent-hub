import type supertest from 'supertest';
import { getRequest, createProject, createCard, drainWebhookQueue } from './helpers.js';

let request: supertest.Agent;
let projectId: string;

beforeAll(async () => {
  request = await getRequest();
  const project = await createProject();
  projectId = project.id as string;

  // Register a webhook config for this project
  await request
    .post('/api/webhooks')
    .send({
      projectId,
      repoUrl: 'https://github.com/dedup-org/dedup-repo',
      events: ['pull_request.opened'],
      enabled: true,
    })
    .expect(200);
});

// ═══════════════════════════════════════════════════════════════════
// Webhook auto-create skips when card with same title exists
// ═══════════════════════════════════════════════════════════════════

describe('Webhook PR opened deduplication by title', () => {
  it('does not create a duplicate when card with same title exists', async () => {
    const title = 'Add pagination to user list';

    // Pre-create a card with this title (simulates agent creating card before PR)
    await createCard(projectId, { title });

    // Now fire a webhook with a PR that has the same title
    await request
      .post('/api/webhooks/github')
      .set('x-github-event', 'pull_request')
      .set('x-github-delivery', 'dedup-delivery-1')
      .send({
        action: 'opened',
        repository: {
          full_name: 'dedup-org/dedup-repo',
          html_url: 'https://github.com/dedup-org/dedup-repo',
        },
        sender: { login: 'bot-user' },
        pull_request: {
          number: 100,
          title,
          html_url: 'https://github.com/dedup-org/dedup-repo/pull/100',
          head: { ref: 'feature/pagination', sha: 'aaa111' },
          base: { ref: 'main' },
        },
      })
      .expect(202);

    // Fast-ack queues the event; kanban linkage happens in the worker.
    await drainWebhookQueue();

    // Board should have only one card with this title
    const boardRes = await request.get(`/api/projects/${projectId}/board`).expect(200);
    const board = boardRes.body as { cards: Array<{ title: string; pr_url: string }> };
    const matching = board.cards.filter((c) => c.title === title);
    expect(matching.length).toBe(1);

    // The existing card should now have the PR URL linked
    expect(matching[0].pr_url).toBe('https://github.com/dedup-org/dedup-repo/pull/100');
  });
});
