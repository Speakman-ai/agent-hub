import '../test/setup.js';
import express from 'express';
import supertest from 'supertest';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { initLogsDb, closeLogsDb, insertLogRecords } from '../logs/logs-db.js';
import { deriveIssueGrouping } from '../logs/log-fingerprint.js';
import { claimIssueAnalyzeSession, getIssue, listIssues } from '../logs/log-issues-store.js';
import { listLogContextAudit } from '../logs/log-context-audit-store.js';
import { SEVERITY_NUMBER } from '../logs/logs-schema.js';
import createLogIssueRoutes from './log-issues.js';
import type { Agent, Project, RouteDeps, SessionRow, Stmts } from '../types.js';
import { setSessionOwner } from '../session-ownership.js';
import { markSessionFinalizeAutomation } from '../session-ship.js';

vi.mock('../effective-model.js', () => ({
  resolveEffectiveEngineAndModel: vi.fn(() => ({ engine: 'claude-code', model: 'sonnet' })),
}));
vi.mock('../session-ownership.js', () => ({
  resolveOwnerUserId: vi.fn(() => 'user-123'),
  setSessionOwner: vi.fn(),
}));
vi.mock('../session-ship.js', () => ({
  markSessionFinalizeAutomation: vi.fn(),
}));
vi.mock('../session-checkpoint-rewind.js', () => ({
  enrichSessionForClient: vi.fn((row: SessionRow) => row),
}));

const PROJECT_ID = 'project-analyze';

function makeIssue() {
  const body = 'database connection failed: password=hunter2';
  const grouping = deriveIssueGrouping({
    projectId: PROJECT_ID,
    sourceId: 'source-1',
    serviceName: 'checkout',
    environment: 'production',
    severityNumber: SEVERITY_NUMBER.ERROR,
    body,
    attributes: {},
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
        body,
        fingerprint: grouping?.fingerprint ?? null,
        grouping,
      },
    ],
    1_800_000_000_000,
  );
  return listIssues({ projectId: PROJECT_ID }).issues[0]!;
}

function makeProject(agents: Array<Partial<Agent>>): Project {
  return {
    id: PROJECT_ID,
    name: 'Analyze project',
    cwd: '/tmp/analyze-project',
    agents: agents as Agent[],
  } as unknown as Project;
}

function makeRouteHarness(
  project: Project,
  chat: (...args: unknown[]) => Promise<void> | void = async (..._args: unknown[]) => undefined,
) {
  const sessions = new Map<string, SessionRow>();
  const createSession = vi.fn((...args: unknown[]) => {
    const [id, agentId, name, engine, model, useWorktree, askMode] = args as [
      string,
      string,
      string,
      string,
      string,
      number,
      number,
    ];
    sessions.set(id, {
      id,
      agent_id: agentId,
      name,
      engine,
      model,
      use_worktree: useWorktree,
      ask_mode: askMode,
      deleted_at: null,
    } as SessionRow);
  });
  const getSession = { get: vi.fn((id: string) => sessions.get(id)) };
  const handleChat = vi.fn(chat);
  const broadcast = vi.fn();
  const deleteSession = vi.fn((id: string) => sessions.delete(id));
  const stmts = {
    createSession: { run: createSession },
    getSession,
    deleteSession: { run: deleteSession },
    updateSessionFinalizeAutomation: { run: vi.fn() },
  } as unknown as Stmts;
  const agentById = new Map(
    project.agents.map((agent) => [
      agent.id,
      {
        project,
        agent: { ...agent, engine: 'claude-code', model: 'sonnet' },
      },
    ]),
  );
  const deps = {
    stmts,
    broadcast,
    findProject: (id: string) => (id === PROJECT_ID ? project : null),
    findAgent: (id: string) => agentById.get(id) ?? null,
    handleChat,
    config: {},
  } as unknown as RouteDeps;
  const app = express();
  app.use((req, _res, next) => {
    const auth = req as unknown as {
      authRole: string;
      authUserId: string;
      authViaApiKey: boolean;
    };
    auth.authRole = 'Owner';
    auth.authUserId = 'user-123';
    auth.authViaApiKey = true;
    next();
  });
  app.use(createLogIssueRoutes(deps));
  return { app, createSession, getSession, handleChat, broadcast, deleteSession, sessions };
}

describe('POST /logs/issues/:issueId/analyze', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'log-analyze-route-test-'));
    initLogsDb(dir);
  });

  afterEach(() => {
    closeLogsDb();
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates an owned isolated manual session with a safe analysis prompt and exposes the link', async () => {
    const lead = { id: 'lead-1', name: 'Lead', role: 'lead' } as Partial<Agent>;
    const project = makeProject([lead]);
    const issue = makeIssue();
    const harness = makeRouteHarness(project);

    const response = await supertest(harness.app)
      .post(`/api/projects/${PROJECT_ID}/logs/issues/${issue.id}/analyze`)
      .expect(200);

    expect(response.body).toMatchObject({
      reused: false,
      agentId: 'lead-1',
      issue: { analyzeSessionId: expect.any(String) },
    });
    expect(harness.createSession).toHaveBeenCalledWith(
      expect.any(String),
      'lead-1',
      expect.stringContaining('Analyze:'),
      'claude-code',
      'sonnet',
      1,
      0,
      1,
    );
    expect(setSessionOwner).toHaveBeenCalledWith(response.body.sessionId, 'user-123');
    expect(markSessionFinalizeAutomation).toHaveBeenCalledWith(
      expect.anything(),
      response.body.sessionId,
      'manual',
    );
    expect(listLogContextAudit(PROJECT_ID, issue.id)[0]).toMatchObject({
      action: 'analyze',
      actorUserId: 'user-123',
      recordIds: [1],
    });
    expect(harness.handleChat).toHaveBeenCalledTimes(1);
    const message = harness.handleChat.mock.calls[0]![1] as { content: string };
    expect(message.content).toContain('read-only');
    expect(message.content).toContain('No file edits');
    expect(message.content).toContain('No kanban cards');
    expect(message.content).toContain('Root cause');
    expect(message.content).toContain('Evidence');
    expect(message.content).toContain('Confidence');
    expect(message.content).toContain('ask the user how they want to');
    expect(message.content).toContain('BEGIN UNTRUSTED LOG DATA');
    expect(message.content).not.toContain('hunter2');

    const linked = await supertest(harness.app)
      .get(`/api/projects/${PROJECT_ID}/logs/issues/${issue.id}`)
      .expect(200);
    expect(linked.body.analyzeSessionId).toBe(response.body.sessionId);
    expect(harness.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'session_created',
        agentId: 'lead-1',
        session: expect.objectContaining({ id: response.body.sessionId }),
      }),
    );
  });

  it('falls back from a missing lead to a non-reviewer dev agent', async () => {
    const dev = { id: 'dev-1', name: 'Developer', role: 'dev' } as Partial<Agent>;
    const reviewer = { id: 'reviewer-1', name: 'Reviewer', role: 'reviewer' } as Partial<Agent>;
    const project = makeProject([reviewer, dev]);
    const issue = makeIssue();
    const harness = makeRouteHarness(project);

    const response = await supertest(harness.app)
      .post(`/api/projects/${PROJECT_ID}/logs/issues/${issue.id}/analyze`)
      .expect(200);

    expect(response.body.agentId).toBe('dev-1');
    expect(harness.createSession.mock.calls[0]?.[1]).toBe('dev-1');
  });

  it('reuses the linked live session on repeat clicks without another chat or CLI spawn', async () => {
    const lead = { id: 'lead-1', name: 'Lead', role: 'lead' } as Partial<Agent>;
    const project = makeProject([lead]);
    const issue = makeIssue();
    const harness = makeRouteHarness(project);
    const endpoint = `/api/projects/${PROJECT_ID}/logs/issues/${issue.id}/analyze`;

    const first = await supertest(harness.app).post(endpoint).expect(200);
    const second = await supertest(harness.app).post(endpoint).expect(200);

    expect(second.body).toMatchObject({
      reused: true,
      sessionId: first.body.sessionId,
      agentId: 'lead-1',
    });
    expect(harness.createSession).toHaveBeenCalledTimes(1);
    expect(harness.handleChat).toHaveBeenCalledTimes(1);
  });

  it('replaces a deleted linked session through the atomic claim', async () => {
    const lead = { id: 'lead-1', name: 'Lead', role: 'lead' } as Partial<Agent>;
    const project = makeProject([lead]);
    const issue = makeIssue();
    const harness = makeRouteHarness(project);
    const staleId = 'stale-analysis-session';
    claimIssueAnalyzeSession(PROJECT_ID, issue.id, staleId);
    harness.sessions.set(staleId, {
      id: staleId,
      agent_id: 'lead-1',
      deleted_at: 'archived',
    } as SessionRow);

    const response = await supertest(harness.app)
      .post(`/api/projects/${PROJECT_ID}/logs/issues/${issue.id}/analyze`)
      .expect(200);

    expect(response.body.reused).toBe(false);
    expect(response.body.sessionId).not.toBe(staleId);
    expect(harness.createSession).toHaveBeenCalledTimes(1);
  });

  it('cleans up the session and claim when the initial chat handler throws', async () => {
    const lead = { id: 'lead-1', name: 'Lead', role: 'lead' } as Partial<Agent>;
    const project = makeProject([lead]);
    const issue = makeIssue();
    const harness = makeRouteHarness(project, () => {
      throw new Error('engine unavailable');
    });

    await supertest(harness.app)
      .post(`/api/projects/${PROJECT_ID}/logs/issues/${issue.id}/analyze`)
      .expect(500);
    const sessionId = harness.createSession.mock.calls[0]![0] as string;

    await vi.waitFor(() =>
      expect(harness.broadcast).toHaveBeenCalledWith({
        type: 'session_deleted',
        sessionId,
      }),
    );
    expect(harness.deleteSession).toHaveBeenCalledWith(sessionId);
    expect(harness.sessions.has(sessionId)).toBe(false);
    expect(getIssue(PROJECT_ID, issue.id)?.analyze_session_id).toBeNull();
    expect(harness.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        sessionId,
      }),
    );
  });
});
