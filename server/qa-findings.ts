/**
 * QA finding cards: when a run finishes, every fail / needs_change result gets
 * a `qa-finding` kanban card on the plan's epic, assigned to the project's
 * main dev agent through the normal card-assign path so a fix session starts.
 *
 * One card per failing case per iteration. A case that still fails on a later
 * run, while the card filed for it earlier is not Done, gets a comment on that
 * card instead of a duplicate. A Done card means the fix landed and did not
 * hold, so the case gets a fresh card.
 */
import { v4 as uuidv4 } from 'uuid';
import { getDb, getStmts } from './db.js';
import { getOrCreateBoard } from './routes/board.js';
import { isColumnDone } from './kanban-blockers.js';
import { recomputeEpicState } from './epic-state.js';
import { pickMainDevAgent } from './routing.js';
import { assignKanbanCard, type AssignCardDeps } from './kanban-assign.js';
import { getSessionOwner } from './session-ownership.js';
import { parseQaArtifactIds, qaScreenshotsBySession, type QaScreenshot } from './qa-results.js';
import type {
  KanbanCardRow,
  KanbanColumnRow,
  Project,
  QaCaseRow,
  QaPlanRow,
  QaResultRow,
  QaRunRow,
} from './types.js';

export const QA_FINDING_LABEL = 'qa-finding';
const QA_FINDING_AUTHOR = 'QA';

const isFinding = (r: Pick<QaResultRow, 'verdict'>) =>
  r.verdict === 'fail' || r.verdict === 'needs_change';

const VERDICT_TEXT = { fail: 'fail', needs_change: 'needs change' } as const;

function screenshotLines(
  run: Pick<QaRunRow, 'session_id'>,
  result: Pick<QaResultRow, 'screenshot_artifact_ids'>,
  screenshots: Map<string, QaScreenshot>,
): string[] {
  const ids = parseQaArtifactIds(result.screenshot_artifact_ids);
  if (!run.session_id || ids.length === 0) return ['_No screenshots attached._'];
  return ids.map((id) => {
    const name = screenshots.get(id)?.filename ?? id;
    const path = `/api/sessions/${encodeURIComponent(run.session_id!)}/artifacts/${encodeURIComponent(id)}/content`;
    return `- [${name}](${path})`;
  });
}

/** Title and markdown body for a new finding card. Pure. */
export function buildQaFindingCard(args: {
  plan: Pick<QaPlanRow, 'id' | 'project_id' | 'title' | 'target_url'>;
  run: Pick<QaRunRow, 'id' | 'iteration' | 'session_id'>;
  qaCase: Pick<QaCaseRow, 'title' | 'steps' | 'expected' | 'version'>;
  result: Pick<QaResultRow, 'verdict' | 'actual' | 'notes' | 'screenshot_artifact_ids'>;
  screenshots: Map<string, QaScreenshot>;
}): { title: string; description: string } {
  const { plan, run, qaCase, result, screenshots } = args;
  const verdict = VERDICT_TEXT[result.verdict as keyof typeof VERDICT_TEXT] ?? result.verdict;
  const planPath = `/api/projects/${encodeURIComponent(plan.project_id)}/qa/plans/${encodeURIComponent(plan.id)}`;
  const lines = [
    `QA case **${qaCase.title}** got verdict **${verdict}** in run #${run.iteration} of the QA plan **${plan.title}**.`,
    '',
    `Target: ${plan.target_url}`,
    '',
    '## Steps',
    qaCase.steps.trim() || '_No steps recorded._',
    '',
    '## Expected',
    qaCase.expected.trim() || '_No expected result recorded._',
    '',
    '## Actual',
    result.actual.trim() || '_No actual result recorded._',
  ];
  if (result.notes.trim()) lines.push('', '## Notes', result.notes.trim());
  lines.push(
    '',
    '## Screenshots',
    ...screenshotLines(run, result, screenshots),
    '',
    '## QA plan',
    `Plan \`${plan.id}\` (case version ${qaCase.version}, run \`${run.id}\`): [${plan.title}](${planPath}). Open it from the project's QA page.`,
    '',
    'Fix the behavior so the expected result holds. The QA agent reruns the case once the fix reaches the target.',
  );
  return { title: `QA: ${qaCase.title}`.slice(0, 200), description: lines.join('\n') };
}

/** Comment posted on an open finding card when its case fails again. Pure. */
export function buildQaFindingRepeatComment(args: {
  run: Pick<QaRunRow, 'id' | 'iteration' | 'session_id'>;
  result: Pick<QaResultRow, 'verdict' | 'actual' | 'notes' | 'screenshot_artifact_ids'>;
  screenshots: Map<string, QaScreenshot>;
}): string {
  const { run, result, screenshots } = args;
  const verdict = VERDICT_TEXT[result.verdict as keyof typeof VERDICT_TEXT] ?? result.verdict;
  const lines = [
    `Still failing in QA run #${run.iteration} (verdict: ${verdict}).`,
    '',
    `**Actual:** ${result.actual.trim() || '_not recorded_'}`,
  ];
  if (result.notes.trim()) lines.push('', `**Notes:** ${result.notes.trim()}`);
  lines.push('', '**Screenshots:**', ...screenshotLines(run, result, screenshots));
  return lines.join('\n');
}

/**
 * The open finding card filed for this case by an earlier run of the same
 * plan, if any. Cards that were deleted, moved off the project board, or
 * reached Done do not count.
 */
function openFindingCardForCase(
  plan: QaPlanRow,
  caseId: string,
  excludeRunId: string,
): KanbanCardRow | null {
  const s = getStmts();
  const rows = getDb()
    .prepare(
      `SELECT res.finding_card_id AS card_id FROM qa_results res
         JOIN qa_runs r ON r.id = res.run_id
        WHERE r.plan_id = ? AND res.case_id = ? AND res.run_id != ?
          AND res.finding_card_id IS NOT NULL
        ORDER BY r.iteration DESC`,
    )
    .all(plan.id, caseId, excludeRunId) as Array<{ card_id: string }>;
  const board = s.getKanbanBoard.get(plan.project_id) as { id: string } | undefined;
  for (const { card_id } of rows) {
    const card = s.getKanbanCard.get(card_id) as KanbanCardRow | undefined;
    if (!card || !board || card.board_id !== board.id) continue;
    const column = s.getKanbanColumn.get(card.column_id) as KanbanColumnRow | undefined;
    if (column && !isColumnDone(column.name)) return card;
  }
  return null;
}

export type QaFindingOutcome =
  | { caseId: string; action: 'filed'; cardId: string; sessionId: string | null; error?: string }
  | { caseId: string; action: 'commented'; cardId: string };

/**
 * File or update finding cards for a finished run. Results that already carry
 * a finding card are skipped, so calling this twice for a run is harmless.
 * Card writes are synchronous; assignment (which spawns the fix session) runs
 * after, and a failed assignment leaves the card in To Do with a comment.
 */
export async function fileQaFindingCards(
  deps: AssignCardDeps,
  runId: string,
): Promise<QaFindingOutcome[]> {
  const s = getStmts();
  const run = s.getQaRun.get(runId);
  if (!run || (run.status !== 'passed' && run.status !== 'failed')) return [];
  const plan = s.getQaPlan.get(run.plan_id);
  if (!plan) return [];
  const project = deps.findProject(plan.project_id);
  if (!project) return [];

  const findings = s.listQaResultsByRun.all(run.id).filter((r) => isFinding(r));
  if (findings.length === 0) return [];
  const cases = new Map(s.listQaCasesByPlan.all(plan.id).map((c) => [c.id, c]));
  const screenshots = qaScreenshotsBySession(
    run.session_id,
    findings.flatMap((r) => parseQaArtifactIds(r.screenshot_artifact_ids)),
  );
  const ownerUserId =
    (run.session_id ? getSessionOwner(run.session_id) : null) ?? run.started_by ?? plan.created_by;

  const claimResult = getDb().prepare(
    `UPDATE qa_results SET finding_card_id = ?, updated_at = datetime('now')
      WHERE id = ? AND finding_card_id IS NULL`,
  );

  const outcomes: QaFindingOutcome[] = [];
  const toAssign: Array<{ caseId: string; card: KanbanCardRow }> = [];

  getDb().transaction(() => {
    for (const result of findings) {
      if (result.finding_card_id) continue;
      const qaCase = cases.get(result.case_id);
      if (!qaCase) continue;

      const open = openFindingCardForCase(plan, result.case_id, run.id);
      if (open) {
        if (claimResult.run(open.id, result.id).changes === 0) continue;
        s.createKanbanCardComment.run(
          uuidv4(),
          open.id,
          QA_FINDING_AUTHOR,
          buildQaFindingRepeatComment({ run, result, screenshots }),
        );
        outcomes.push({ caseId: result.case_id, action: 'commented', cardId: open.id });
        continue;
      }

      const { board, columns } = getOrCreateBoard(s, plan.project_id);
      const todo =
        columns.find((c) => c.name.toLowerCase() === 'to do') ??
        [...columns].sort((a, b) => a.position - b.position)[0];
      if (!todo) {
        console.warn(`[qa] board for ${plan.project_id} has no columns; finding card not filed`);
        continue;
      }
      const siblings = s.getKanbanCardsByColumn.all(todo.id) as KanbanCardRow[];
      const position = siblings.length > 0 ? Math.max(...siblings.map((c) => c.position)) + 1 : 0;
      const { title, description } = buildQaFindingCard({
        plan,
        run,
        qaCase,
        result,
        screenshots,
      });
      const cardId = uuidv4();
      s.createKanbanCard.run(
        cardId,
        todo.id,
        board.id,
        title,
        description,
        'high',
        null,
        QA_FINDING_LABEL,
        null,
        null,
        ownerUserId,
        null,
        position,
      );
      if (plan.epic_id) {
        s.updateKanbanCardEpic.run(plan.epic_id, cardId);
        recomputeEpicState(s, plan.epic_id);
      }
      claimResult.run(cardId, result.id);
      toAssign.push({ caseId: result.case_id, card: s.getKanbanCard.get(cardId) as KanbanCardRow });
    }
  })();

  if (outcomes.length > 0 || toAssign.length > 0) {
    deps.broadcast({ type: 'kanban_update', projectId: plan.project_id });
  }

  const devAgent = pickMainDevAgent(project as Project);
  for (const { caseId, card } of toAssign) {
    const outcome = await assignFinding(deps, {
      card,
      projectId: plan.project_id,
      agentId: devAgent?.id ?? null,
      ownerUserId,
    });
    outcomes.push({ caseId, action: 'filed', cardId: card.id, ...outcome });
  }
  return outcomes;
}

async function assignFinding(
  deps: AssignCardDeps,
  args: {
    card: KanbanCardRow;
    projectId: string;
    agentId: string | null;
    ownerUserId: string | null;
  },
): Promise<{ sessionId: string | null; error?: string }> {
  const note = (error: string) => {
    getStmts().createKanbanCardComment.run(
      uuidv4(),
      args.card.id,
      QA_FINDING_AUTHOR,
      `Could not start a fix session: ${error}. Assign this card to start one.`,
    );
    deps.broadcast({ type: 'kanban_update', projectId: args.projectId });
    return { sessionId: null, error };
  };
  if (!args.agentId) return note('this project has no dev agent');
  try {
    const result = await assignKanbanCard(deps, {
      card: args.card,
      projectId: args.projectId,
      agentId: args.agentId,
      ownerUserId: args.ownerUserId,
    });
    if (result.ok) return { sessionId: result.sessionId };
    const body = result.body as { message?: unknown; error?: unknown };
    return note(String(body.message ?? body.error ?? `assign failed (${result.status})`));
  } catch (err) {
    console.error('[qa] finding card assign failed:', err);
    return note(err instanceof Error ? err.message : String(err));
  }
}
