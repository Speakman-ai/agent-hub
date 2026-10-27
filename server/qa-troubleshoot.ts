/**
 * QA troubleshoot sessions: a human opens a dev-agent session seeded with one
 * failing / blocked result's full context (case, verdict, actual, notes,
 * screenshots, the run session to read, any finding card) so they can dig into
 * it interactively instead of waiting on the finding-card flow.
 *
 * Unlike finding cards, nothing is linked back: the session is a plain chat on
 * the project's main dev agent, with a worktree like any dev session.
 */
import { randomUUID } from 'crypto';
import { getStmts } from './db.js';
import { resolveAgentSpawnEngineAndModel } from './effective-model.js';
import { defaultSessionUseWorktreeFlag } from './project-mode.js';
import { parseQaArtifactIds, qaScreenshotsBySession, type QaScreenshot } from './qa-results.js';
import { pickMainDevAgent } from './routing.js';
import { abandonUnseededSession, kickoffSeededTurn } from './seeded-session-kickoff.js';
import { broadcastSessionCreated } from './session-checkpoint-rewind.js';
import { setSessionOwner } from './session-ownership.js';
import type {
  KanbanCardRow,
  Project,
  QaCaseRow,
  QaPlanRow,
  QaResultRow,
  QaRunRow,
  RouteDeps,
  SessionRow,
} from './types.js';

/** Verdicts the Troubleshoot action is offered for. */
export const QA_TROUBLESHOOT_VERDICTS = ['fail', 'needs_change', 'blocked'] as const;

export const canTroubleshootVerdict = (verdict: string): boolean =>
  (QA_TROUBLESHOOT_VERDICTS as readonly string[]).includes(verdict);

const VERDICT_TEXT: Record<string, string> = {
  fail: 'fail',
  needs_change: 'needs change',
  blocked: 'blocked',
};

/** First user turn of a troubleshoot session. Pure. */
export function buildQaTroubleshootSeed(args: {
  plan: Pick<QaPlanRow, 'id' | 'project_id' | 'title' | 'target_url'>;
  run: Pick<QaRunRow, 'id' | 'iteration' | 'session_id'>;
  qaCase: Pick<QaCaseRow, 'id' | 'title' | 'steps' | 'expected' | 'version'>;
  result: Pick<
    QaResultRow,
    'verdict' | 'actual' | 'notes' | 'screenshot_artifact_ids' | 'case_version'
  >;
  screenshots: Map<string, QaScreenshot>;
  findingCard?: Pick<KanbanCardRow, 'id' | 'title'> | null;
}): string {
  const { plan, run, qaCase, result, screenshots, findingCard } = args;
  const verdict = VERDICT_TEXT[result.verdict] ?? result.verdict;
  const blocked = result.verdict === 'blocked';
  const lines = [
    `[QA troubleshoot] ${qaCase.title}`,
    '',
    `QA case **${qaCase.title}** (\`${qaCase.id}\`) got verdict **${verdict}** in run #${run.iteration} of QA plan **${plan.title}** (\`${plan.id}\`). Help me troubleshoot it.`,
    '',
    `- **Target:** ${plan.target_url}`,
    `- **Run:** \`${run.id}\``,
  ];
  if (result.case_version !== qaCase.version) {
    lines.push(
      `- **Note:** the verdict was recorded against case v${result.case_version}; the case is now v${qaCase.version}.`,
    );
  }
  if (findingCard) {
    lines.push(`- **Finding card:** ${findingCard.title} (\`${findingCard.id}\`)`);
  }
  lines.push(
    '',
    '## Steps',
    qaCase.steps.trim() || '_No steps recorded._',
    '',
    '## Expected',
    qaCase.expected.trim() || '_No expected result recorded._',
    '',
    '## Actual',
    result.actual.trim() || '_No actual result recorded._',
  );
  if (result.notes.trim()) lines.push('', '## QA notes', result.notes.trim());

  const ids = parseQaArtifactIds(result.screenshot_artifact_ids);
  lines.push('', '## Screenshots');
  if (!run.session_id || ids.length === 0) {
    lines.push('_No screenshots attached._');
  } else {
    for (const id of ids) {
      lines.push(`- ${screenshots.get(id)?.filename ?? id} (artifact \`${id}\`)`);
    }
    lines.push(
      '',
      `They are artifacts of the run session; fetch one with \`ah-api.sh GET "/api/sessions/${run.session_id}/artifacts/<artifactId>/content" > shot.png\` and open the file.`,
    );
  }
  if (run.session_id) {
    lines.push(
      '',
      '## Run transcript',
      `The QA agent's run session is \`${run.session_id}\`. Read what it did with \`sessions.sh messages ${run.session_id}\`.`,
    );
  }
  lines.push(
    '',
    '## What to do',
    '',
    blocked
      ? '1. Work out why the case could not be tested: the app (a crash, a missing page, a broken login), the target or environment (not deployed, unreachable, wrong URL, missing data), or the case itself (steps that cannot be followed).'
      : '1. Reproduce the failure and find the root cause in the code. Decide whether it is an app bug or a case whose expected result is wrong.',
    '2. Tell me what you found, with `file:line` references, before changing anything.',
    '3. If it is a code fix, implement it with a regression test and commit it on this session branch. If the case or environment is at fault, say what to change instead.',
  );
  return lines.join('\n');
}

export type QaTroubleshootOutcome =
  | { ok: true; sessionId: string; agentId: string }
  | { ok: false; status: number; error: string; code?: string };

/**
 * Create a dev-agent session for one result and wait until its seeded first
 * turn is accepted. A session whose seed is not accepted is dropped.
 */
export async function startQaTroubleshootSession(
  deps: Pick<RouteDeps, 'config' | 'handleChat' | 'broadcast'>,
  args: {
    project: Project;
    plan: QaPlanRow;
    run: QaRunRow;
    qaCase: QaCaseRow;
    result: QaResultRow;
    ownerUserId: string | null;
  },
): Promise<QaTroubleshootOutcome> {
  const { project, plan, run, qaCase, result, ownerUserId } = args;
  if (!canTroubleshootVerdict(result.verdict)) {
    return {
      ok: false,
      status: 409,
      error: 'Only failed, needs-change, or blocked results can be troubleshot',
      code: 'not_troubleshootable',
    };
  }
  const agent = pickMainDevAgent(project);
  if (!agent) {
    return {
      ok: false,
      status: 409,
      error: 'This project has no dev agent to troubleshoot with.',
      code: 'no_dev_agent',
    };
  }
  if (!deps.handleChat) {
    return { ok: false, status: 503, error: 'Chat is unavailable on this server' };
  }

  const s = getStmts();
  const findingCard = result.finding_card_id
    ? ((s.getKanbanCard.get(result.finding_card_id) as KanbanCardRow | undefined) ?? null)
    : null;
  const seed = buildQaTroubleshootSeed({
    plan,
    run,
    qaCase,
    result,
    screenshots: qaScreenshotsBySession(
      run.session_id,
      parseQaArtifactIds(result.screenshot_artifact_ids),
    ),
    findingCard,
  });

  const sessionId = randomUUID();
  try {
    const { engine, model } = resolveAgentSpawnEngineAndModel(deps.config, agent, ownerUserId);
    s.createSession.run(
      sessionId,
      agent.id,
      `[QA troubleshoot] ${qaCase.title}`.slice(0, 100),
      engine,
      model,
      defaultSessionUseWorktreeFlag(project),
      0,
      1,
    );
    setSessionOwner(sessionId, ownerUserId);
    await kickoffSeededTurn({
      handleChat: deps.handleChat,
      agentId: agent.id,
      sessionId,
      content: seed,
    });
  } catch (e) {
    console.error('[qa] troubleshoot session failed to start:', e);
    abandonUnseededSession(s, sessionId);
    return { ok: false, status: 502, error: 'Failed to start the troubleshoot session' };
  }
  const session = s.getSession.get(sessionId) as SessionRow;
  broadcastSessionCreated(deps.broadcast, agent.id, session, s, project);
  return { ok: true, sessionId, agentId: agent.id };
}
