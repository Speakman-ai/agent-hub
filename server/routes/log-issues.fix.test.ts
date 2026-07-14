import '../test/setup.js';
import express from 'express';
import supertest from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDb, stmts } from '../db.js';
import { getLogsDb, initLogsDb, closeLogsDb, insertLogRecords } from '../logs/logs-db.js';
import { deriveIssueGrouping } from '../logs/log-fingerprint.js';
import { claimIssueFixSession, getIssue, listIssues } from '../logs/log-issues-store.js';
import { SEVERITY_NUMBER } from '../logs/logs-schema.js';
import createLogIssueRoutes from './log-issues.js';
import type { Project, RouteDeps } from '../types.js';

vi.mock('../effective-model.js', () => ({
  resolveEffectiveEngineAndModel: vi.fn(() => ({ engine: 'claude-code', model: 'sonnet' })),
}));

const PROJECT_ID = 'project-fix-route';

function makeIssue() {
  const grouping = deriveIssueGrouping({
    projectId: PROJECT_ID,
    sourceId: 'source-1',
    serviceName: 'checkout',
    environment: 'production',
    severityNumber: SEVERITY_NUMBER.ERROR,
    body: 'database connection failed',
    attributes: { 'exception.type': 'DatabaseError' },
    resource: {},
  });
  insertLogRecords(
    [
      {
        projectId: PROJECT_ID,
        sourceId: 'source-1',
        timeUnixNano: 1_800_000_000_000_000_000,
        severityNumber: SEVERITY_NUMBER.ERROR,
        severityText: 'ERROR',
        serviceName: 'checkout',
        environment: 'production',
        body: 'database connection failed',
        fingerprint: grouping?.fingerprint ?? null,
        grouping,
      },
    ],
    1_800_000_000_000,
  );
  return listIssues({ projectId: PROJECT_ID }).issues[0]!;
}

function makeHarness(chat: (...args: unknown[]) => Promise<void> | void = async () => undefined) {
  const project = {
    id: PROJECT_ID,
    name: 'Fix project',
    cwd: '/tmp/fix-project',
    agents: [
      { id: 'dev-1', name: 'Developer', role: 'dev', engine: 'claude-code', model: 'sonnet' },
    ],
  } as unknown as Project;
  const agent = project.agents[0]!;
  const handleChat = vi.fn(chat);
  const broadcast = vi.fn();
  const deps = {
    stmts: stmts!,
    broadcast,
    findProject: (id: string) => (id === PROJECT_ID ? project : null),
    findAgent: (id: string) => (id === agent.id ? { project, agent } : null),
    handleChat,
    config: {},
  } as unknown as RouteDeps;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const auth = req as unknown as Record<string, unknown>;
    auth.authRole = 'Owner';
    auth.authUserId = 'user-123';
    auth.authViaApiKey = true;
    next();
  });
  app.use(createLogIssueRoutes(deps));
  return { app, handleChat, broadcast, project };
}

describe('POST /logs/issues/:issueId/fix', () => {
  let dir: string;

  beforeEach(async () => {
    await import('../index.js');
    dir = mkdtempSync(path.join(os.tmpdir(), 'log-fix-route-'));
    initLogsDb(dir);
    getDb().prepare('DELETE FROM user_project_settings').run();
    getDb().prepare('DELETE FROM kanban_cards').run();
    getDb().prepare('DELETE FROM kanban_columns').run();
    getDb().prepare('DELETE FROM kanban_boards').run();
  });

  afterEach(() => {
    closeLogsDb();
    getDb().prepare('DELETE FROM user_project_settings').run();
    getDb().prepare('DELETE FROM sessions').run();
    getDb().prepare('DELETE FROM kanban_cards').run();
    getDb().prepare('DELETE FROM kanban_columns').run();
    getDb().prepare('DELETE FROM kanban_boards').run();
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates one In Progress card/session, inherits the user default, and reuses duplicate clicks', async () => {
    stmts!.upsertUserProjectDefaultFinalizeAutomation.run('user-123', PROJECT_ID, 'push');
    const issue = makeIssue();
    const harness = makeHarness();
    const endpoint = `/api/projects/${PROJECT_ID}/logs/issues/${issue.id}/fix`;

    const first = await supertest(harness.app).post(endpoint).expect(200);
    const second = await supertest(harness.app).post(endpoint).expect(200);

    expect(first.body).toMatchObject({ reused: false, automation: 'push' });
    expect(second.body).toMatchObject({
      reused: true,
      cardId: first.body.cardId,
      sessionId: first.body.sessionId,
    });
    expect(harness.handleChat).toHaveBeenCalledTimes(1);
    const card = stmts!.getKanbanCard.get(first.body.cardId) as {
      source_type: string;
      source_id: string;
      session_id: string;
      column_id: string;
    };
    expect(card.source_type).toBe('log_issue');
    expect(card.source_id).toBe(issue.id);
    expect(card.session_id).toBe(first.body.sessionId);
    expect((stmts!.getKanbanColumn.get(card.column_id) as { name: string }).name).toBe(
      'In Progress',
    );
    expect(
      (stmts!.getSession.get(first.body.sessionId) as { finalize_automation: string })
        .finalize_automation,
    ).toBe('push');
    expect(getIssue(PROJECT_ID, issue.id)?.fix_session_id).toBe(first.body.sessionId);
    const prompt = harness.handleChat.mock.calls[0]![1] as { content: string };
    expect(prompt.content).toContain('regression test');
    expect(prompt.content).toContain('BEGIN UNTRUSTED LOG DATA');
  });

  it('falls back to manual and rolls the linked workflow back on synchronous chat failure', async () => {
    const issue = makeIssue();
    const harness = makeHarness(() => {
      throw new Error('engine unavailable');
    });
    const endpoint = `/api/projects/${PROJECT_ID}/logs/issues/${issue.id}/fix`;

    await supertest(harness.app).post(endpoint).expect(500);
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n).toBe(
      0,
    );
    expect(
      (getDb().prepare('SELECT COUNT(*) AS n FROM kanban_cards').get() as { n: number }).n,
    ).toBe(0);
    expect(getIssue(PROJECT_ID, issue.id)?.fix_session_id).toBeNull();

    // The failed claim is released, so a retry can create a fresh workflow.
    const retry = makeHarness();
    await supertest(retry.app).post(endpoint).expect(200);
  });

  it('replaces the claim after the existing Fix card reaches Done', async () => {
    const issue = makeIssue();
    const firstHarness = makeHarness();
    const endpoint = `/api/projects/${PROJECT_ID}/logs/issues/${issue.id}/fix`;
    const first = await supertest(firstHarness.app).post(endpoint).expect(200);
    const board = stmts!.getKanbanBoard.get(PROJECT_ID) as { id: string };
    const done = (
      stmts!.getKanbanColumns.all(board.id) as Array<{ id: string; name: string }>
    ).find((column) => column.name === 'Done')!;
    stmts!.moveKanbanCard.run(done.id, 0, first.body.cardId);

    const retry = await supertest(makeHarness().app).post(endpoint).expect(200);
    expect(retry.body.reused).toBe(false);
    expect(retry.body.cardId).not.toBe(first.body.cardId);
    expect(retry.body.sessionId).not.toBe(first.body.sessionId);
  });

  it('replaces the claim after the linked session is archived', async () => {
    const issue = makeIssue();
    const first = await supertest(makeHarness().app)
      .post(`/api/projects/${PROJECT_ID}/logs/issues/${issue.id}/fix`)
      .expect(200);
    stmts!.softDeleteSession.run(first.body.sessionId);

    const retry = await supertest(makeHarness().app)
      .post(`/api/projects/${PROJECT_ID}/logs/issues/${issue.id}/fix`)
      .expect(200);
    expect(retry.body.reused).toBe(false);
    expect(retry.body.sessionId).not.toBe(first.body.sessionId);
  });

  it('does not expire an in-flight claim solely because context preparation is old', async () => {
    const issue = makeIssue();
    claimIssueFixSession(PROJECT_ID, issue.id, 'slow-card', 'slow-session');
    getLogsDb()
      .prepare(
        'UPDATE log_issue_fix_claims SET claimed_at = ? WHERE project_id = ? AND issue_id = ?',
      )
      .run(Date.now() - 60_000, PROJECT_ID, issue.id);

    await supertest(makeHarness().app)
      .post(`/api/projects/${PROJECT_ID}/logs/issues/${issue.id}/fix`)
      .expect(409);
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n).toBe(
      0,
    );
  });
});
