import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb, getStmts, initDb } from './db.js';
import { getOrCreateBoard } from './routes/board.js';
import {
  approveQaPlan,
  completeQaRunIfCovered,
  markQaRunRunning,
  recordQaResult,
  startQaRun,
} from './qa-status.js';
import { buildQaFindingCard, fileQaFindingCards, QA_FINDING_LABEL } from './qa-findings.js';
import type { AssignCardDeps } from './kanban-assign.js';
import type {
  Agent,
  ChatMessage,
  KanbanCardRow,
  KanbanColumnRow,
  Project,
  QaVerdict,
  SessionRow,
} from './types.js';

// Engine creds live on disk per user; the assign path checks them before spawning.
vi.mock('./per-user-cli-spawn.js', async (orig) => ({
  ...(await orig<typeof import('./per-user-cli-spawn.js')>()),
  assertEngineCredsOrThrow: () => {},
}));

const PROJECT = 'qa-findings-proj';
const project: Project = {
  id: PROJECT,
  name: 'QA Findings',
  cwd: '/tmp/qa-findings',
  ahw: '/tmp/qa-findings-ahw',
  agents: [
    { id: 'qf-qa', name: 'QA', role: 'qa' } as Agent,
    { id: 'qf-dev', name: 'Dev', role: 'dev', engine: 'claude-code' } as Agent,
  ],
};

const broadcast = vi.fn();
// Stands in for the chat path: the fix session is never actually spawned.
const handleChat = vi.fn(async (_ws: unknown, _msg: ChatMessage) => {});

let deps: AssignCardDeps;
let epicId: string;

beforeAll(() => {
  initDb(mkdtempSync(path.join(tmpdir(), 'ah-qa-findings-')));
  deps = {
    stmts: getStmts(),
    config: { dataDir: '/tmp/qa-findings-data', engineValidModels: {} },
    findProject: (id: string) => (id === PROJECT ? project : null),
    findAgent: (id: string) => {
      const agent = project.agents!.find((a) => a.id === id);
      return agent ? { agent, project } : null;
    },
    handleChat,
    broadcast,
  } as unknown as AssignCardDeps;
  const { board } = getOrCreateBoard(getStmts(), PROJECT);
  epicId = randomUUID();
  getStmts().createKanbanEpic.run(epicId, board.id, 'Checkout epic', '', '#fff', 0, null);
});

beforeEach(() => {
  getDb().exec('DELETE FROM qa_plans');
  getDb().exec('DELETE FROM kanban_card_comments');
  getDb().exec(`DELETE FROM kanban_cards WHERE labels = '${QA_FINDING_LABEL}'`);
  broadcast.mockClear();
  handleChat.mockClear();
});

function approvedPlan(withEpic = true): { planId: string; caseIds: string[] } {
  const s = getStmts();
  const planId = randomUUID();
  s.insertQaPlan.run(
    planId,
    PROJECT,
    'Checkout',
    'Buy things',
    'https://staging.example.com',
    withEpic ? epicId : null,
    null,
    null,
    1,
    5,
    'user-1',
  );
  const caseIds = ['Login', 'Pay'].map((title, i) => {
    const id = randomUUID();
    s.insertQaCase.run(id, planId, i, title, `1. Open ${title}`, `${title} works`);
    return id;
  });
  approveQaPlan(planId, 'user-1');
  return { planId, caseIds };
}

/** Run every case with the given verdicts and let the run finish. */
function finishedRun(planId: string, verdicts: Record<string, QaVerdict>, scope = 'full') {
  const { run } = startQaRun(planId, {
    scope: scope as 'full' | 'failed_only',
    startedBy: 'user-1',
  });
  markQaRunRunning(run.id);
  for (const [caseId, verdict] of Object.entries(verdicts)) {
    recordQaResult(run.id, caseId, { verdict, actual: `${verdict} observed` });
  }
  expect(completeQaRunIfCovered(run.id)).not.toBeNull();
  return run.id;
}

const card = (id: string) => getStmts().getKanbanCard.get(id) as KanbanCardRow;
const columnName = (c: KanbanCardRow) =>
  (getStmts().getKanbanColumn.get(c.column_id) as KanbanColumnRow).name;
const resultsOf = (runId: string) => getStmts().listQaResultsByRun.all(runId);
const comments = (cardId: string) =>
  getDb()
    .prepare('SELECT author, content FROM kanban_card_comments WHERE card_id = ?')
    .all(cardId) as Array<{ author: string; content: string }>;

describe('buildQaFindingCard', () => {
  it('carries steps, expected, actual, screenshot links, and the plan link', () => {
    const { title, description } = buildQaFindingCard({
      plan: { id: 'p1', project_id: 'proj', title: 'Checkout', target_url: 'https://x.test' },
      run: { id: 'r1', iteration: 2, session_id: 's1' },
      qaCase: { title: 'Pay', steps: '1. Press Pay', expected: 'Receipt shows', version: 3 },
      result: {
        verdict: 'needs_change',
        actual: 'Spinner forever',
        notes: '',
        screenshot_artifact_ids: '["a1"]',
      },
      screenshots: new Map([['a1', { id: 'a1', filename: 'pay.png', contentType: 'image/png' }]]),
    });
    expect(title).toBe('QA: Pay');
    expect(description).toContain('1. Press Pay');
    expect(description).toContain('Receipt shows');
    expect(description).toContain('Spinner forever');
    expect(description).toContain('needs change');
    expect(description).toContain('[pay.png](/api/sessions/s1/artifacts/a1/content)');
    expect(description).toContain('/api/projects/proj/qa/plans/p1');
  });
});

describe('fileQaFindingCards', () => {
  it('files one qa-finding card per failing case on the plan epic and links it', async () => {
    const { planId, caseIds } = approvedPlan();
    const runId = finishedRun(planId, { [caseIds[0]]: 'pass', [caseIds[1]]: 'fail' });

    const outcomes = await fileQaFindingCards(deps, runId);

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ caseId: caseIds[1], action: 'filed' });
    const results = resultsOf(runId);
    expect(results.find((r) => r.case_id === caseIds[0])!.finding_card_id).toBeNull();
    const cardId = results.find((r) => r.case_id === caseIds[1])!.finding_card_id!;
    const filed = card(cardId);
    expect(filed).toMatchObject({
      title: 'QA: Pay',
      labels: QA_FINDING_LABEL,
      epic_id: epicId,
      priority: 'high',
    });
    expect(filed.description).toContain('fail observed');
    expect(filed.description).toContain('1. Open Pay');
  });

  it('assigns the card to the dev agent through the assign path, spawning a fix session', async () => {
    const { planId, caseIds } = approvedPlan();
    const runId = finishedRun(planId, { [caseIds[0]]: 'needs_change', [caseIds[1]]: 'pass' });

    const [outcome] = await fileQaFindingCards(deps, runId);

    expect(outcome.action).toBe('filed');
    const sessionId = (outcome as { sessionId: string | null }).sessionId!;
    expect(sessionId).toBeTruthy();
    const assigned = card(outcome.cardId);
    expect(assigned.session_id).toBe(sessionId);
    expect(assigned.assignee).toBe('Dev');
    expect(columnName(assigned)).toBe('In Progress');
    const session = getStmts().getSession.get(sessionId) as SessionRow;
    expect(session.agent_id).toBe('qf-dev');
    expect(handleChat).toHaveBeenCalledTimes(1);
    const msg = handleChat.mock.calls[0][1];
    expect(msg).toMatchObject({ agentId: 'qf-dev', sessionId });
    expect(msg.content).toContain('QA: Login');
  });

  it('comments on the open card when the case fails again instead of filing a duplicate', async () => {
    const { planId, caseIds } = approvedPlan();
    const first = finishedRun(planId, { [caseIds[0]]: 'pass', [caseIds[1]]: 'fail' });
    const [filed] = await fileQaFindingCards(deps, first);
    handleChat.mockClear();

    const second = finishedRun(planId, { [caseIds[1]]: 'fail' }, 'failed_only');
    const outcomes = await fileQaFindingCards(deps, second);

    expect(outcomes).toEqual([{ caseId: caseIds[1], action: 'commented', cardId: filed.cardId }]);
    expect(resultsOf(second)[0].finding_card_id).toBe(filed.cardId);
    expect(handleChat).not.toHaveBeenCalled();
    const qaComments = comments(filed.cardId).filter((c) => c.author === 'QA');
    expect(qaComments).toHaveLength(1);
    expect(qaComments[0].content).toContain('Still failing in QA run #2');
    const n = getDb()
      .prepare(`SELECT COUNT(*) AS n FROM kanban_cards WHERE labels = ?`)
      .get(QA_FINDING_LABEL) as { n: number };
    expect(n.n).toBe(1);
  });

  it('files a fresh card when the earlier card already reached Done', async () => {
    const { planId, caseIds } = approvedPlan();
    const first = finishedRun(planId, { [caseIds[0]]: 'pass', [caseIds[1]]: 'fail' });
    const [filed] = await fileQaFindingCards(deps, first);
    const s = getStmts();
    const cols = s.getKanbanColumns.all(card(filed.cardId).board_id) as KanbanColumnRow[];
    s.moveKanbanCard.run(cols.find((c) => c.name === 'Done')!.id, 0, filed.cardId);

    const second = finishedRun(planId, { [caseIds[1]]: 'fail' }, 'failed_only');
    const [again] = await fileQaFindingCards(deps, second);

    expect(again.action).toBe('filed');
    expect(again.cardId).not.toBe(filed.cardId);
  });

  it('is idempotent for a run whose findings are already filed', async () => {
    const { planId, caseIds } = approvedPlan();
    const runId = finishedRun(planId, { [caseIds[0]]: 'fail', [caseIds[1]]: 'pass' });
    await fileQaFindingCards(deps, runId);
    handleChat.mockClear();

    expect(await fileQaFindingCards(deps, runId)).toEqual([]);
    expect(handleChat).not.toHaveBeenCalled();
  });

  it('leaves the card in To Do with a comment when the project has no dev agent', async () => {
    const saved = project.agents;
    project.agents = [saved![0]];
    try {
      const { planId, caseIds } = approvedPlan(false);
      const runId = finishedRun(planId, { [caseIds[0]]: 'fail', [caseIds[1]]: 'pass' });
      const [outcome] = await fileQaFindingCards(deps, runId);

      expect(outcome).toMatchObject({ action: 'filed', sessionId: null });
      const filed = card(outcome.cardId);
      expect(filed.epic_id).toBeNull();
      expect(columnName(filed)).toBe('To Do');
      expect(comments(outcome.cardId)[0].content).toContain('no dev agent');
      expect(handleChat).not.toHaveBeenCalled();
    } finally {
      project.agents = saved;
    }
  });
});
