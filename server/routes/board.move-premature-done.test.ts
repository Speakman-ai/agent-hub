import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import type supertest from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { getDb } from '../db.js';
import {
  getRequest,
  createAgent,
  createCard,
  createProject,
  createSession,
} from '../test/helpers.js';

let request: supertest.Agent;
let projectId: string;
let doneColumnId: string;
let inProgressColumnId: string;
let gatedSessionId: string;
let plainSessionId: string;

/** Worktree with `.agent-hub/ci.yaml` — Finalize-gated. */
function makeGatedWorktree(): string {
  const wt = mkdtempSync(path.join(tmpdir(), 'premature-done-wt-'));
  mkdirSync(path.join(wt, '.agent-hub'), { recursive: true });
  writeFileSync(path.join(wt, '.agent-hub', 'ci.yaml'), 'version: 2\njobs: []\n');
  return wt;
}

beforeAll(async () => {
  request = await getRequest();
  const project = await createProject();
  projectId = project.id as string;

  const boardRes = await request.get(`/api/projects/${projectId}/board`).expect(200);
  const columns = (boardRes.body as { columns: Array<{ id: string; name: string }> }).columns;
  doneColumnId = columns.find((c) => c.name === 'Done')!.id;
  inProgressColumnId = columns.find((c) => c.name === 'In Progress')!.id;

  const agent = await createAgent();
  const gated = await createSession({ agentId: agent.id as string });
  gatedSessionId = gated.id as string;
  getDb()
    .prepare('UPDATE sessions SET worktree_path = ? WHERE id = ?')
    .run(makeGatedWorktree(), gatedSessionId);

  const plain = await createSession({ agentId: agent.id as string });
  plainSessionId = plain.id as string;
  getDb()
    .prepare('UPDATE sessions SET worktree_path = ? WHERE id = ?')
    .run(mkdtempSync(path.join(tmpdir(), 'premature-done-plain-')), plainSessionId);
});

function moveCard(
  cardId: string,
  columnId: string,
  extra: Record<string, unknown> = {},
): supertest.Test {
  return request
    .post(`/api/projects/${projectId}/board/cards/${cardId}/move`)
    .send({ columnId, ...extra });
}

describe('POST /board/cards/:cardId/move — premature Done guard', () => {
  it('rejects a Done move while the linked Finalize-gated session has not pushed', async () => {
    const card = await createCard(projectId, { sessionId: gatedSessionId });
    const res = await moveCard(card.id as string, doneColumnId);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('premature_done_move');
    expect(String(res.body.message)).toMatch(/written on merge/i);
    // Card did not move.
    const board = await request.get(`/api/projects/${projectId}/board`).expect(200);
    const after = (board.body as { cards: Array<{ id: string; column_id: string }> }).cards.find(
      (c) => c.id === card.id,
    );
    expect(after!.column_id).not.toBe(doneColumnId);
  });

  it('still allows non-Done moves for the same card', async () => {
    const card = await createCard(projectId, { sessionId: gatedSessionId });
    await moveCard(card.id as string, inProgressColumnId).expect(200);
  });

  it('force: true bypasses the guard', async () => {
    const card = await createCard(projectId, { sessionId: gatedSessionId });
    const res = await moveCard(card.id as string, doneColumnId, { force: true });
    expect(res.status).toBe(200);
    expect((res.body as { column_id: string }).column_id).toBe(doneColumnId);
  });

  it('allows Done for cards not linked to any session', async () => {
    const card = await createCard(projectId, {});
    await moveCard(card.id as string, doneColumnId).expect(200);
  });

  it('allows Done when the linked session is not Finalize-gated', async () => {
    const card = await createCard(projectId, { sessionId: plainSessionId });
    await moveCard(card.id as string, doneColumnId).expect(200);
  });

  it('allows Done once the linked session pushed through Finalize', async () => {
    const card = await createCard(projectId, { sessionId: gatedSessionId });
    getDb()
      .prepare(
        `INSERT INTO finalize_runs (id, card_id, session_id, project_id, branch, head_sha,
           idempotency_key, status, trigger_source, triggered_by_user_id, author_name,
           author_email, started_at)
         VALUES (?, ?, ?, ?, 'b', 'sha', ?, 'pushed', 'ui_button', 'test', 'Test', 't@t', ?)`,
      )
      .run(
        'run-premature-done-test',
        card.id as string,
        gatedSessionId,
        projectId,
        'idem-premature-done-test',
        Date.now(),
      );
    try {
      await moveCard(card.id as string, doneColumnId).expect(200);
    } finally {
      getDb().prepare('DELETE FROM finalize_runs WHERE id = ?').run('run-premature-done-test');
    }
  });
});
