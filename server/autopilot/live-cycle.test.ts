import '../test/setup.js';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { getStmts } from '../db.js';
import { createAutopilotBoardAdapter } from './adapters.js';
import { runLiveBaselineCycle } from './fixtures/baseline-cycle.js';
import { validateTodoApp } from './fixtures/validate-todo-app.js';
import { buildBoardOps } from './wiring.js';

const TODO_APP = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'todo-app');

describe('autopilot live adapters + disposable fixture app', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('ships a browser-testable add-and-list fixture app', () => {
    expect(validateTodoApp(TODO_APP)).toEqual({ ok: true, reasons: [] });
  });

  it('drives live planner/board/session/finalize adapters without a real CLI', async () => {
    // Canned deterministic path only. Real createChatHandler + Finalize
    // kickoff lives in fixtures/run-baseline-cycle.ts (outside Vitest).
    const fixtureRepo = mkdtempSync(path.join(os.tmpdir(), 'autopilot-live-cycle-'));
    dirs.push(fixtureRepo);
    const stmts = getStmts();
    const result = await runLiveBaselineCycle({ fixtureRepo });

    expect(result.mergedSha).toMatch(/^[0-9a-f]{40}$/);
    expect(result.mergedSha).not.toBe(result.baselineSha);
    expect(result.deploymentId).toBe('dep-fixture');
    expect(validateTodoApp(fixtureRepo, { requireComplete: true }).ok).toBe(true);

    const epic = stmts.getKanbanEpic.get(result.epicId) as { labels?: string } | undefined;
    expect(epic?.labels).toContain(`autopilot-key:autopilot:${result.runId}:cycle-1`);
    const cards = stmts.getKanbanCardsByEpic.all(result.epicId) as { id: string }[];
    expect(cards).toHaveLength(2);
    const journey = cards.find((c) => c.id !== result.cardId);
    expect(journey).toBeTruthy();
    expect(stmts.getBlocker.get(journey!.id, result.cardId)).toBeTruthy();
    const order = await createAutopilotBoardAdapter({
      ops: buildBoardOps(stmts),
    }).validatePhaseOrder({ projectId: 'autopilot-fixture-app', epicId: result.epicId });
    expect(order.ok).toBe(true);
  });
});
