/**
 * Auto-fix for a red default branch (`Project.ciOnPush.autoFix`).
 *
 * `default-branch-health.ts` opens one breakage card per red streak on the
 * default branch, with the merges in range and the failing step logs. When
 * the project opted in, this assigns that card to an agent, which starts a
 * normal card session (worktree, Finalize automation from the project's merge
 * default) whose prompt is the card itself.
 *
 * Dedup is the card's own `session_id`: once a fix session is linked, later
 * red runs in the same streak only comment on the card. A red run that finds
 * the card still unassigned (the first try had no credentials, or auto-fix was
 * switched on mid-streak) tries again.
 *
 * The session runs as the owner of the newest session behind a merge in range
 * (the person whose change most likely broke it), falling back to the org
 * Owner. Owners without engine credentials are skipped.
 */
import { v4 as uuidv4 } from 'uuid';
import type { Agent, KanbanCardRow, Project } from '../types.js';
import { assignKanbanCard, type AssignCardDeps } from '../kanban-assign.js';
import { pickMainDevAgent } from '../routing.js';
import { getSessionOwner } from '../session-ownership.js';
import { defaultHeartbeatOwnerUserId } from '../heartbeat-ownership.js';
import type { RecordDefaultBranchResult } from './default-branch-health.js';

const CARD_AUTHOR = 'Agent Hub CI';
const FAILURE_COMMENT_PREFIX = 'Could not start a fix session automatically';

export interface DefaultBranchAutofixDeps extends AssignCardDeps {
  /** Test seam: defaults to {@link assignKanbanCard}. */
  assign?: typeof assignKanbanCard;
  /** Test seam: session id → owner user id. */
  sessionOwner?: (sessionId: string) => string | null;
  /** Test seam: the org Owner used when no merge session has an owner. */
  fallbackOwner?: () => string | null;
}

export interface DefaultBranchAutofixArgs {
  project: Project;
  branch: string;
  headSha: string;
  result: RecordDefaultBranchResult;
}

export type DefaultBranchAutofixOutcome =
  | 'dispatched'
  | 'disabled'
  | 'no_breakage'
  | 'no_card'
  | 'already_assigned'
  | 'in_flight'
  | 'no_agent'
  | 'failed';

export interface DefaultBranchAutofixResult {
  outcome: DefaultBranchAutofixOutcome;
  sessionId?: string;
  error?: string;
}

const inFlight = new Set<string>();

/** Test seam. */
export function __resetDefaultBranchAutofixState(): void {
  inFlight.clear();
}

export function defaultBranchAutofixEnabled(project: Project): boolean {
  return project.ciOnPush?.enabled === true && project.ciOnPush?.autoFix === true;
}

/**
 * The configured agent when it is still on the project and active, else the
 * first dev agent, else the project's main dev agent. Never the Reviewer or
 * QA agent: neither commits code.
 */
export function pickDefaultBranchFixAgent(project: Project): Agent | null {
  const agents = (project.agents ?? []) as Agent[];
  const usable = (a: Agent): boolean =>
    a.active !== false && a.role !== 'reviewer' && a.role !== 'qa';
  const configured = project.ciOnPush?.autoFixAgentId;
  if (configured) {
    const match = agents.find((a) => a.id === configured && usable(a));
    if (match) return match;
  }
  return agents.find((a) => usable(a) && a.role === 'dev') ?? pickMainDevAgent(project);
}

/** Owners to try, in order. A trailing null covers engines with no per-user login. */
export function fixSessionOwnerCandidates(
  suspectSessionIds: string[],
  sessionOwner: (id: string) => string | null,
  fallbackOwner: () => string | null,
): Array<string | null> {
  const out: Array<string | null> = [];
  for (const id of suspectSessionIds) {
    let owner: string | null = null;
    try {
      owner = sessionOwner(id);
    } catch {
      owner = null;
    }
    if (owner && !out.includes(owner)) out.push(owner);
  }
  const fallback = fallbackOwner();
  if (fallback && !out.includes(fallback)) out.push(fallback);
  out.push(null);
  return out;
}

function assignmentNote(branch: string, headSha: string): string {
  return [
    `Started automatically: full CI on \`${branch}\` went red at \`${headSha.slice(0, 8)}\`.`,
    'Reproduce the failing jobs from the logs above, find which merge broke them, and fix the',
    'cause. Change a test only when the test itself is wrong. Do not skip or delete failing tests.',
  ].join(' ');
}

/**
 * Start a fix session for the open breakage a default-branch run reported.
 * Never throws; fire-and-forget safe.
 */
export async function maybeDispatchDefaultBranchFix(
  deps: DefaultBranchAutofixDeps,
  args: DefaultBranchAutofixArgs,
): Promise<DefaultBranchAutofixResult> {
  const { project, branch, headSha, result } = args;
  if (!defaultBranchAutofixEnabled(project)) return { outcome: 'disabled' };
  if (result.kind !== 'recorded' || result.failing === 0 || !result.breakageId) {
    return { outcome: 'no_breakage' };
  }
  if (!result.cardId) return { outcome: 'no_card' };
  const cardId = result.cardId;
  if (inFlight.has(cardId)) return { outcome: 'in_flight' };
  inFlight.add(cardId);
  try {
    const card = deps.stmts.getKanbanCard.get(cardId) as KanbanCardRow | undefined;
    if (!card) return { outcome: 'no_card' };
    if (card.session_id) return { outcome: 'already_assigned', sessionId: card.session_id };

    const agent = pickDefaultBranchFixAgent(project);
    if (!agent) {
      return noteFailure(deps, project.id, cardId, {
        outcome: 'no_agent',
        error: 'this project has no dev agent',
      });
    }

    const owners = fixSessionOwnerCandidates(
      result.suspectSessionIds ?? [],
      deps.sessionOwner ?? getSessionOwner,
      deps.fallbackOwner ?? defaultHeartbeatOwnerUserId,
    );
    const assign = deps.assign ?? assignKanbanCard;
    let lastError = 'no session owner has engine credentials';
    for (const ownerUserId of owners) {
      const res = await assign(deps, {
        card,
        projectId: project.id,
        agentId: agent.id,
        ownerUserId,
        comment: assignmentNote(branch, headSha),
      });
      if (res.ok) {
        console.log(
          `[default-branch-autofix] ${project.id}: breakage ${result.breakageId} card=${cardId} ` +
            `→ session ${res.sessionId} (agent=${agent.id}, owner=${ownerUserId ?? 'none'})`,
        );
        return { outcome: 'dispatched', sessionId: res.sessionId };
      }
      lastError = String(res.body.error ?? `HTTP ${res.status}`);
      // Only a missing login is owner-specific; anything else fails the same
      // way for every owner.
      if (res.body.code !== 'no_account_credentials') break;
    }
    return noteFailure(deps, project.id, cardId, {
      outcome: 'failed',
      error: lastError,
    });
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    return noteFailure(deps, project.id, cardId, { outcome: 'failed', error });
  } finally {
    inFlight.delete(cardId);
  }
}

/**
 * Comment once per breakage card, so a retry on every later red run doesn't
 * spam it. The card's own comments are the record, which survives restarts.
 */
function noteFailure(
  deps: DefaultBranchAutofixDeps,
  projectId: string,
  cardId: string,
  res: DefaultBranchAutofixResult,
): DefaultBranchAutofixResult {
  console.warn(`[default-branch-autofix] ${projectId}: card ${cardId} not assigned: ${res.error}`);
  try {
    const comments = deps.stmts.getKanbanCardComments.all(cardId) as Array<{
      author: string;
      content: string;
    }>;
    const alreadyNoted = comments.some(
      (c) => c.author === CARD_AUTHOR && c.content.startsWith(FAILURE_COMMENT_PREFIX),
    );
    if (!alreadyNoted) {
      deps.stmts.createKanbanCardComment.run(
        uuidv4(),
        cardId,
        CARD_AUTHOR,
        `${FAILURE_COMMENT_PREFIX}: ${res.error}. Assign this card to start one.`,
      );
      deps.broadcast({ type: 'kanban_update', projectId });
    }
  } catch {
    // The card stays in To Do either way.
  }
  return res;
}
