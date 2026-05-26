import type supertest from 'supertest';
import {
  getRequest,
  createProject,
  createAgent,
  createSession,
  drainWebhookQueue,
} from './helpers.js';
import { getStmts } from '../db.js';

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
      repoUrl: 'https://github.com/branch-link-org/branch-link-repo',
      events: ['pull_request.opened'],
      enabled: true,
    })
    .expect(200);
});

/**
 * Regression: PR titles from `buildPrTitle` use commit subjects, not card titles.
 * Branch `agent-hub/<agent>/session-<8>` must still link the kanban card.
 */
describe('Webhook PR opened links card by session branch when title differs', () => {
  it('sets pr_url on the session-linked card', async () => {
    const agent = await createAgent({ projectId, id: 'link-test-agent' });
    const session = await createSession({ agentId: agent.id as string });
    const sessionId = session.id as string;
    const shortId = sessionId.slice(0, 8);
    const branchName = `agent-hub/${agent.id}/session-${shortId}`;

    const stmts = getStmts();
    stmts.updateSessionWorktreePath.run('/tmp/worktree', branchName, sessionId);

    const boardRes = await request.get(`/api/projects/${projectId}/board`).expect(200);
    const columnId = (boardRes.body as { columns: Array<{ id: string }> }).columns[0].id;

    const cardRes = await request
      .post(`/api/projects/${projectId}/board/cards`)
      .send({
        title: 'PRs do not get detected sometimes',
        columnId,
        session_id: sessionId,
      })
      .expect(200);
    const cardId = (cardRes.body as { id: string }).id;

    await request
      .post('/api/webhooks/github')
      .set('x-github-event', 'pull_request')
      .set('x-github-delivery', `branch-link-${Date.now()}`)
      .send({
        action: 'opened',
        repository: {
          full_name: 'branch-link-org/branch-link-repo',
          html_url: 'https://github.com/branch-link-org/branch-link-repo',
        },
        sender: { login: 'dev-user' },
        pull_request: {
          number: 77,
          title: 'fix: normalize PEM keys for GitHub App JWT',
          html_url: 'https://github.com/branch-link-org/branch-link-repo/pull/77',
          head: { ref: branchName, sha: 'abc123' },
          base: { ref: 'main' },
        },
      })
      .expect(202);

    await drainWebhookQueue();

    const boardAfter = await request.get(`/api/projects/${projectId}/board`).expect(200);
    const card = (
      boardAfter.body as { cards: Array<{ id: string; pr_url: string | null }> }
    ).cards.find((c) => c.id === cardId);
    expect(card?.pr_url).toBe('https://github.com/branch-link-org/branch-link-repo/pull/77');
  });
});
