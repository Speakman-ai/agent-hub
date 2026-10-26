/**
 * QA run evidence: screenshot ownership, screenshot metadata for the plan
 * detail gallery, and the chat summary a run session gets when the run ends.
 */
import { randomUUID } from 'crypto';
import { getDb, getStmts } from './db.js';
import { qaRunCaseIds } from './qa-status.js';
import type {
  BroadcastFn,
  MessageRow,
  Project,
  QaCaseRow,
  QaPlanRow,
  QaResultRow,
  QaRunRow,
  QaVerdict,
} from './types.js';

export interface QaScreenshot {
  id: string;
  filename: string;
  contentType: string;
}

/** Artifact metadata by id, for the given run session. Deleted artifacts are absent. */
export function qaScreenshotsBySession(
  sessionId: string | null,
  ids: string[],
): Map<string, QaScreenshot> {
  const unique = [...new Set(ids)];
  if (!sessionId || unique.length === 0) return new Map();
  const rows = getDb()
    .prepare(
      `SELECT id, filename, content_type FROM artifacts
        WHERE session_id = ? AND id IN (${unique.map(() => '?').join(',')})`,
    )
    .all(sessionId, ...unique) as Array<{ id: string; filename: string; content_type: string }>;
  return new Map(
    rows.map((r) => [r.id, { id: r.id, filename: r.filename, contentType: r.content_type }]),
  );
}

export function parseQaArtifactIds(raw: string): string[] {
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

const VERDICT_TEXT: Record<QaVerdict, string> = {
  pass: 'pass',
  fail: 'fail',
  needs_change: 'needs change',
  blocked: 'blocked',
};

/** Board deep link the web client resolves to the card on its project board. */
export function qaCardPath(projectId: string, cardId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/board?card=${encodeURIComponent(cardId)}`;
}

/**
 * Markdown summary of a finished run: verdict counts, then one line per
 * in-scope case with its finding card link and screenshot names. Pure.
 */
export function buildQaRunSummary(args: {
  project: Pick<Project, 'id'>;
  plan: Pick<QaPlanRow, 'id' | 'title'>;
  run: Pick<QaRunRow, 'id' | 'iteration' | 'status' | 'scope'>;
  /** In-scope cases, in run order. */
  cases: Array<Pick<QaCaseRow, 'id' | 'title'>>;
  results: QaResultRow[];
  screenshots: Map<string, QaScreenshot>;
  findingCards: Map<string, { title: string }>;
}): string {
  const { project, plan, run, cases, results, screenshots, findingCards } = args;
  const byCase = new Map(results.map((r) => [r.case_id, r]));
  const counts: Record<QaVerdict, number> = { pass: 0, fail: 0, needs_change: 0, blocked: 0 };
  let missing = 0;
  for (const c of cases) {
    const r = byCase.get(c.id);
    if (r) counts[r.verdict] += 1;
    else missing += 1;
  }
  const tally = [
    `${counts.pass} passed`,
    `${counts.fail} failed`,
    counts.needs_change ? `${counts.needs_change} needs change` : null,
    counts.blocked ? `${counts.blocked} blocked` : null,
    missing ? `${missing} without a result` : null,
  ]
    .filter(Boolean)
    .join(', ');

  const lines = cases.map((c, i) => {
    const r = byCase.get(c.id);
    if (!r) return `${i + 1}. **${c.title}**: no result`;
    const parts = [`${i + 1}. **${c.title}**: ${VERDICT_TEXT[r.verdict]}`];
    if (r.finding_card_id) {
      const title = findingCards.get(r.finding_card_id)?.title ?? 'finding card';
      parts.push(`[${title}](${qaCardPath(project.id, r.finding_card_id)})`);
    }
    const shots = parseQaArtifactIds(r.screenshot_artifact_ids)
      .map((id) => screenshots.get(id)?.filename)
      .filter((n): n is string => !!n);
    if (shots.length > 0) parts.push(`screenshots: ${shots.map((n) => `\`${n}\``).join(', ')}`);
    return parts.join(' · ');
  });

  return [
    `**QA run #${run.iteration} ${run.status}** · ${plan.title}`,
    '',
    `${cases.length} case(s)${run.scope === 'failed_only' ? ' (failed only)' : ''}: ${tally}.`,
    '',
    ...lines,
    '',
    `Screenshots are in this session's Artifacts panel. Plan \`${plan.id}\`, run \`${run.id}\`.`,
  ].join('\n');
}

/**
 * Post the run summary into the run's session as a QA-agent message and
 * broadcast it. Does not start a model turn. Best-effort: a failure is logged
 * and never undoes the run transition that triggered it.
 */
export function postQaRunSummary(
  deps: { broadcast: BroadcastFn; project: Project },
  runId: string,
): void {
  try {
    const s = getStmts();
    const run = s.getQaRun.get(runId);
    if (!run?.session_id || (run.status !== 'passed' && run.status !== 'failed')) return;
    const session = s.getSession.get(run.session_id) as
      | { id: string; agent_id: string; deleted_at?: string | null }
      | undefined;
    if (!session || session.deleted_at) return;
    const plan = s.getQaPlan.get(run.plan_id);
    if (!plan) return;
    const scope = new Set(qaRunCaseIds(run));
    const cases = s.listQaCasesByPlan.all(plan.id).filter((c) => scope.has(c.id));
    const results = s.listQaResultsByRun.all(run.id);
    const screenshots = qaScreenshotsBySession(
      run.session_id,
      results.flatMap((r) => parseQaArtifactIds(r.screenshot_artifact_ids)),
    );
    const cardIds = [
      ...new Set(results.map((r) => r.finding_card_id).filter((id): id is string => !!id)),
    ];
    const findingCards = new Map(
      cardIds.length === 0
        ? []
        : (
            getDb()
              .prepare(
                `SELECT id, title FROM kanban_cards WHERE id IN (${cardIds.map(() => '?').join(',')})`,
              )
              .all(...cardIds) as Array<{ id: string; title: string }>
          ).map((c) => [c.id, { title: c.title }]),
    );
    const content = buildQaRunSummary({
      project: deps.project,
      plan,
      run,
      cases,
      results,
      screenshots,
      findingCards,
    });
    const agent = deps.project.agents?.find((a) => a.id === session.agent_id);
    const msgId = randomUUID();
    s.addMessage.run(
      msgId,
      session.id,
      'assistant',
      content,
      null,
      null,
      null,
      JSON.stringify({ kind: 'qa_run_summary', planId: plan.id, runId: run.id }),
      session.agent_id,
      agent?.name ?? null,
      agent?.color ?? null,
    );
    const message = s.getMessageById.get(msgId) as MessageRow | undefined;
    if (message) deps.broadcast({ type: 'message_added', sessionId: session.id, message });
  } catch (err) {
    console.warn(
      `[qa] failed to post run summary run=${runId}:`,
      err instanceof Error ? err.message : err,
    );
  }
}
