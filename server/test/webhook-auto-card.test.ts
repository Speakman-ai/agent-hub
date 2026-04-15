import type supertest from 'supertest';
import { getRequest, createProject } from './helpers.js';

let request: supertest.Agent;
let projectId: string;

beforeAll(async () => {
  request = await getRequest();
  const project = await createProject();
  projectId = project.id as string;
});

// ═══════════════════════════════════════════════════════════════════
// Webhook PR opened → auto-create kanban card
// ═══════════════════════════════════════════════════════════════════

describe('Webhook auto-creates kanban card on PR opened', () => {
  let webhookConfigId: string;

  beforeAll(async () => {
    // Register a webhook config for this project
    const res = await request
      .post('/api/webhooks')
      .send({
        projectId,
        repoUrl: 'https://github.com/test-org/test-repo',
        events: ['pull_request.opened'],
        enabled: true,
      })
      .expect(200);
    webhookConfigId = (res.body as { id: string }).id;
  });

  it('creates a card when PR opened and no existing card', async () => {
    // Send a pull_request.opened webhook
    const res = await request
      .post('/api/webhooks/github')
      .set('x-github-event', 'pull_request')
      .set('x-github-delivery', 'test-delivery-1')
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
          body: 'The login button was not firing the onClick handler.\n\n## Changes\n- Fixed event binding',
        },
      });

    // Webhook should succeed (200)
    expect(res.status).toBe(200);

    // Verify a card was created on the board
    const boardRes = await request.get(`/api/projects/${projectId}/board`).expect(200);
    const board = boardRes.body as {
      columns: Array<{ name: string; id: string }>;
      cards: Array<{ title: string; pr_url: string; assignee: string }>;
    };

    const card = board.cards.find(
      (c) => c.pr_url === 'https://github.com/test-org/test-repo/pull/42',
    );
    expect(card).toBeDefined();
    expect(card!.title).toBe('Fix login button not responding');
    expect(card!.assignee).toBe('test-user');

    // Card should be in "In Progress" column
    const inProgressCol = board.columns.find((c) => c.name === 'In Progress');
    expect(inProgressCol).toBeDefined();
  });

  it('does NOT create a duplicate card for the same PR', async () => {
    // Send the same webhook again
    await request
      .post('/api/webhooks/github')
      .set('x-github-event', 'pull_request')
      .set('x-github-delivery', 'test-delivery-2')
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
        },
      })
      .expect(200);

    // Should still be only one card with this PR URL
    const boardRes = await request.get(`/api/projects/${projectId}/board`).expect(200);
    const board = boardRes.body as {
      cards: Array<{ pr_url: string }>;
    };
    const matching = board.cards.filter(
      (c) => c.pr_url === 'https://github.com/test-org/test-repo/pull/42',
    );
    expect(matching.length).toBe(1);
  });

  it('uses PR body first line as card description', async () => {
    await request
      .post('/api/webhooks/github')
      .set('x-github-event', 'pull_request')
      .set('x-github-delivery', 'test-delivery-3')
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
      .expect(200);

    const boardRes = await request.get(`/api/projects/${projectId}/board`).expect(200);
    const board = boardRes.body as {
      cards: Array<{ title: string; pr_url: string; description: string }>;
    };
    const card = board.cards.find(
      (c) => c.pr_url === 'https://github.com/test-org/test-repo/pull/99',
    );
    expect(card).toBeDefined();
    // Should skip the "## Summary" header and use the first non-header line
    expect(card!.description).toBe('Users requested a dark mode toggle in settings.');
  });
});
