/**
 * Wiki documentation sessions: the replacement for the retired docs heartbeat.
 *
 * Forward path: when a PR merges, spawn the project's docs agent to review
 * the landed change and write or update at most one wiki page (or skip).
 * Historical cards stay undocumented until a human asks; that is
 * `POST /wiki/document-backfill`, not a scheduled drain.
 *
 * `documented = 1` means "reviewed for the wiki", not "has its own article".
 * The wiki is not a changelog; git already is.
 */
import { v4 as uuidv4 } from 'uuid';
import { randomUUID } from 'crypto';
import type {
  Agent,
  AgentLookup,
  AppConfig,
  BroadcastFn,
  ChatMessage,
  KanbanBoardRow,
  KanbanCardRow,
  Project,
  SessionRow,
  Stmts,
} from './types.js';
import { setSessionOwner } from './session-ownership.js';
import { broadcastSessionCreated } from './session-checkpoint-rewind.js';
import { resolveEffectiveModel } from './effective-model.js';

/** Session name prefix stamped on every wiki-doc session (idempotency key). */
export const WIKI_DOC_SESSION_PREFIX = '[Wiki]';

export function wikiDocSessionNameForCard(cardId: string): string {
  return `${WIKI_DOC_SESSION_PREFIX} ${cardId}`;
}

/**
 * True for any session whose name carries the wiki-doc prefix. These are
 * ephemeral, no-worktree docs-agent sessions (see `kickWikiDocSession`): they
 * review a merged change, write/update at most one wiki page through the wiki
 * API, and are done. They never wait on a human, so they must be excluded from
 * the org "active sessions" queue and self-archived when their turn ends.
 */
export function isWikiDocSessionName(name: string | null | undefined): boolean {
  return typeof name === 'string' && name.startsWith(WIKI_DOC_SESSION_PREFIX);
}

export function wikiDocBackfillSessionName(): string {
  return `${WIKI_DOC_SESSION_PREFIX} backfill`;
}

export function resolveDocsAgent(project: Project): Agent | null {
  const agents = project.agents ?? [];
  return agents.find((a) => (a.role ?? '').trim().toLowerCase() === 'docs') ?? null;
}

export interface WikiDocDispatchDeps {
  stmts: Stmts;
  config: AppConfig;
  findProject: (projectId: string) => Project | null;
  findAgent: (agentId: string) => AgentLookup | null;
  handleChat: (ws: unknown, msg: ChatMessage) => Promise<void>;
  broadcast?: BroadcastFn;
}

export type WikiDocSkipReason =
  | 'no_hook'
  | 'no_project'
  | 'no_docs_agent'
  | 'already_documented'
  | 'none_undocumented'
  | 'no_card'
  | 'dispatch_error';

export interface WikiDocDispatchResult {
  sessionId: string;
  session: SessionRow;
  agentId: string;
  reused: boolean;
  kind: 'merge' | 'backfill';
  cardId?: string;
}

export interface WikiDocSkip {
  skipped: true;
  reason: WikiDocSkipReason;
  /** Present when `reason` is `dispatch_error` so callers can see the real cause. */
  message?: string;
}

export type WikiDocOutcome = WikiDocDispatchResult | WikiDocSkip;

export function isWikiDocSkip(value: WikiDocOutcome): value is WikiDocSkip {
  return 'skipped' in value && value.skipped === true;
}

export interface WikiDocMergeEvent {
  projectId: string;
  card?: KanbanCardRow | null;
  prNumber?: number | null;
  prTitle?: string | null;
  prUrl?: string | null;
}

export interface WikiDocBackfillCard {
  id: string;
  title: string;
  description?: string | null;
  updated_at?: string | null;
}

export function buildWikiDocOnMergePrompt(args: {
  projectId: string;
  projectName: string;
  card: { id: string; title: string; description?: string | null };
  prNumber?: number | null;
  prTitle?: string | null;
  prUrl?: string | null;
}): string {
  const prLine = args.prNumber
    ? `PR #${args.prNumber}${args.prTitle ? ` - ${args.prTitle}` : ''}${args.prUrl ? ` (${args.prUrl})` : ''}`
    : args.prUrl || 'No PR metadata.';
  return [
    `A change just merged in the "${args.projectName}" project. Review it for the wiki.`,
    '',
    '## Landed work',
    `- Card id: ${args.card.id}`,
    `- Card title: ${args.card.title}`,
    args.card.description?.trim() ? `- Description:\n${args.card.description.trim()}` : null,
    `- ${prLine}`,
    '',
    '## What to do',
    '1. Search the wiki first (`wiki-search.sh "<topic>"`). Prefer updating an existing page over creating a new one.',
    '2. Write or update **at most one** page, and only if this change is a durable decision, convention, API contract, architecture note, or gotcha that would be lost otherwise.',
    '3. **Skip** (do not mint a page) for bugfixes, copy, chores, one-off tickets, and anything already covered. The wiki is not a changelog; git already is.',
    '4. Mark the card reviewed either way:',
    `   ah-api.sh POST /api/projects/${args.projectId}/board/cards/${args.card.id}/documented`,
    '5. Comment on the card with the wiki slug you wrote/updated, or `skipped: <one-line reason>`.',
    '',
    'Do not open a PR. Do not edit application code. Stop after the one page (or the skip).',
  ]
    .filter((line) => line !== null)
    .join('\n');
}

export function buildWikiDocBackfillPrompt(args: {
  projectId: string;
  projectName: string;
  cards: WikiDocBackfillCard[];
}): string {
  const list = args.cards
    .map((c, i) => {
      const when = c.updated_at ? ` (updated ${c.updated_at})` : '';
      return `${i + 1}. ${c.id} - ${c.title}${when}`;
    })
    .join('\n');
  return [
    `The operator asked you to backfill wiki coverage for the "${args.projectName}" project.`,
    `Review the ${args.cards.length} oldest undocumented Done card(s) below.`,
    '',
    '## Queue',
    list,
    '',
    '## What to do',
    '1. For each card, search the wiki first (`wiki-search.sh`). Prefer updating an existing page.',
    '2. **Skip-and-mark** if the card is a bugfix, copy, chore, already covered, or otherwise not wiki material. Comment `skipped: <reason>` on the card.',
    '3. If a card *does* need a page, write or update **at most one** page, comment the slug, then **stop**. Do not keep minting pages in this run.',
    '4. Mark every card you reviewed (written or skipped):',
    `   \`ah-api.sh POST /api/projects/${args.projectId}/board/cards/<cardId>/documented\``,
    '5. Work oldest-first. Cap skip-marks to this list so the tail actually moves.',
    '',
    '`documented = 1` means "reviewed for the wiki", not "has its own article".',
    'The wiki is not a changelog. Do not open a PR. Do not edit application code.',
  ].join('\n');
}

/**
 * Find a running wiki-doc session for this project. Pass `cardId` to match
 * the merge session for that card; pass `backfill: true` to match the
 * on-demand backfill session. Used to stop a double-merge / double-click
 * from spawning two docs agents over the same work.
 */
export function findActiveWikiDocSession(
  stmts: Stmts,
  project: Project,
  opts: { cardId?: string; backfill?: boolean } = {},
): SessionRow | null {
  const agentIds = new Set((project.agents ?? []).map((a) => a.id));
  if (agentIds.size === 0) return null;
  const needle = opts.backfill
    ? wikiDocBackfillSessionName()
    : opts.cardId
      ? wikiDocSessionNameForCard(opts.cardId)
      : WIKI_DOC_SESSION_PREFIX;
  const running = stmts.getRunningBackgroundTasks.all() as Array<{
    session_id: string;
    agent_id: string;
  }>;
  for (const task of running) {
    if (!agentIds.has(task.agent_id)) continue;
    const session = stmts.getSession.get(task.session_id) as SessionRow | undefined;
    if (!session || session.deleted_at) continue;
    if (typeof session.name !== 'string' || !session.name.startsWith(WIKI_DOC_SESSION_PREFIX)) {
      continue;
    }
    if (opts.backfill || opts.cardId) {
      if (session.name === needle || session.name.startsWith(`${needle} `)) return session;
    } else {
      return session;
    }
  }
  return null;
}

function kickWikiDocSession(
  deps: WikiDocDispatchDeps,
  args: {
    docsAgent: Agent;
    sessionName: string;
    prompt: string;
    kind: 'merge' | 'backfill';
    cardId?: string;
    ownerUserId?: string | null;
    modelOverride?: string | null;
  },
): WikiDocDispatchResult {
  const sessionId = uuidv4();
  const taskId = uuidv4();
  const engine = args.docsAgent.engine || 'claude-code';
  // An explicit override (e.g. from a scheduled background agent's config)
  // wins; otherwise resolve the docs agent's effective model as usual.
  const model =
    args.modelOverride?.trim() ||
    resolveEffectiveModel(deps.config, engine, {
      agentModel: args.docsAgent.model,
      ownerUserId: args.ownerUserId ?? null,
      agentId: args.docsAgent.id,
    });

  // No worktree: docs write through the wiki API, and after merge the
  // project checkout already has the landed change. This also keeps
  // Finalize / auto-ship from treating the session as code work.
  deps.stmts.createSession.run(
    sessionId,
    args.docsAgent.id,
    args.sessionName,
    engine,
    model,
    0,
    0,
    1,
  );
  setSessionOwner(sessionId, args.ownerUserId ?? null);
  deps.stmts.insertBackgroundTask.run(taskId, sessionId, args.docsAgent.id, args.prompt);

  void deps
    .handleChat(null, {
      type: 'chat',
      agentId: args.docsAgent.id,
      sessionId,
      content: args.prompt,
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[wiki-doc] session ${sessionId} kickoff failed: ${msg}`);
      try {
        // CHECK(status IN ('running','done','error')) — 'failed' is rejected.
        deps.stmts.updateBackgroundTaskStatus.run('error', taskId);
      } catch {
        /* best-effort */
      }
    });

  const session = deps.stmts.getSession.get(sessionId) as SessionRow;
  if (deps.broadcast) {
    broadcastSessionCreated(deps.broadcast, args.docsAgent.id, session, deps.stmts);
  }
  return {
    sessionId,
    session,
    agentId: args.docsAgent.id,
    reused: false,
    kind: args.kind,
    cardId: args.cardId,
  };
}

export function dispatchWikiDocOnMerge(
  deps: WikiDocDispatchDeps,
  args: WikiDocMergeEvent & { ownerUserId?: string | null },
): WikiDocOutcome {
  const project = deps.findProject(args.projectId);
  if (!project) return { skipped: true, reason: 'no_project' };
  const docsAgent = resolveDocsAgent(project);
  if (!docsAgent) return { skipped: true, reason: 'no_docs_agent' };
  const card = args.card;
  if (!card) return { skipped: true, reason: 'no_card' };
  if (Number(card.documented) === 1) return { skipped: true, reason: 'already_documented' };

  const found = deps.findAgent(docsAgent.id);
  if (!found) return { skipped: true, reason: 'no_docs_agent' };

  const active = findActiveWikiDocSession(deps.stmts, project, { cardId: card.id });
  if (active) {
    return {
      sessionId: active.id,
      session: active,
      agentId: active.agent_id,
      reused: true,
      kind: 'merge',
      cardId: card.id,
    };
  }

  const prompt = buildWikiDocOnMergePrompt({
    projectId: project.id,
    projectName: project.name,
    card: { id: card.id, title: card.title, description: card.description },
    prNumber: args.prNumber,
    prTitle: args.prTitle,
    prUrl: args.prUrl,
  });
  const result = kickWikiDocSession(deps, {
    docsAgent: found.agent,
    sessionName: wikiDocSessionNameForCard(card.id),
    prompt,
    kind: 'merge',
    cardId: card.id,
    ownerUserId: args.ownerUserId,
  });

  try {
    deps.stmts.createKanbanCardComment.run(
      randomUUID(),
      card.id,
      'agenthub',
      `Wiki review started (session ${result.sessionId})`,
    );
    deps.broadcast?.({ type: 'kanban_update', projectId: project.id });
  } catch (err: unknown) {
    console.warn(
      `[wiki-doc] comment failed for card ${card.id}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  return result;
}

export function dispatchWikiDocBackfill(
  deps: WikiDocDispatchDeps,
  args: {
    project: Project;
    cards: WikiDocBackfillCard[];
    ownerUserId?: string | null;
    modelOverride?: string | null;
  },
): WikiDocOutcome {
  if (args.cards.length === 0) return { skipped: true, reason: 'none_undocumented' };
  const docsAgent = resolveDocsAgent(args.project);
  if (!docsAgent) return { skipped: true, reason: 'no_docs_agent' };
  const found = deps.findAgent(docsAgent.id);
  if (!found) return { skipped: true, reason: 'no_docs_agent' };

  const active = findActiveWikiDocSession(deps.stmts, args.project, { backfill: true });
  if (active) {
    return {
      sessionId: active.id,
      session: active,
      agentId: active.agent_id,
      reused: true,
      kind: 'backfill',
    };
  }

  const prompt = buildWikiDocBackfillPrompt({
    projectId: args.project.id,
    projectName: args.project.name,
    cards: args.cards,
  });
  return kickWikiDocSession(deps, {
    docsAgent: found.agent,
    sessionName: wikiDocBackfillSessionName(),
    prompt,
    kind: 'backfill',
    ownerUserId: args.ownerUserId,
    modelOverride: args.modelOverride,
  });
}

/**
 * When a wiki page is written from a session that is linked to a kanban
 * card, stamp the card documented so the merge hook does not spawn a
 * redundant docs session.
 */
export function maybeMarkLinkedCardDocumented(
  stmts: Stmts,
  sessionId: string | null | undefined,
): { marked: boolean; cardId?: string } {
  if (!sessionId?.trim()) return { marked: false };
  const card = stmts.getKanbanCardBySession.get(sessionId.trim()) as KanbanCardRow | undefined;
  if (!card) return { marked: false };
  if (Number(card.documented) === 1) return { marked: false, cardId: card.id };
  stmts.markCardDocumented.run(card.id);
  return { marked: true, cardId: card.id };
}

/**
 * Self-archive an ephemeral wiki-doc session once its turn ends. No-op for any
 * session that is not a `[Wiki]` session, already deleted, or unknown. Marks a
 * still-running background task terminal (so the sidebar stops showing it as
 * busy), then soft-deletes the session and broadcasts `session_deleted` so it
 * drops out of the active-sessions queue instead of lingering "waiting for user
 * input" forever. Never throws — chat turn teardown must not fail on cleanup.
 */
export function maybeArchiveWikiDocSession(
  deps: { stmts: Stmts; broadcast?: BroadcastFn },
  args: { sessionId: string; agentId?: string; error?: string | null },
): { archived: boolean } {
  try {
    const session = deps.stmts.getSession.get(args.sessionId) as SessionRow | undefined;
    if (!session || session.deleted_at) return { archived: false };
    if (!isWikiDocSessionName(session.name)) return { archived: false };

    try {
      const bgTask = deps.stmts.getBackgroundTaskBySession.get(args.sessionId) as
        | { id: string; status: string }
        | undefined;
      if (bgTask?.status === 'running') {
        const terminal = args.error?.trim() ? 'error' : 'done';
        deps.stmts.updateBackgroundTaskStatus.run(terminal, bgTask.id);
        deps.broadcast?.({
          type: 'task_complete',
          taskId: bgTask.id,
          sessionId: args.sessionId,
          agentId: args.agentId ?? session.agent_id,
          status: terminal,
        });
      }
    } catch {
      /* best-effort */
    }

    deps.stmts.softDeleteSession.run(args.sessionId);
    deps.broadcast?.({ type: 'session_deleted', sessionId: args.sessionId });
    return { archived: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[wiki-doc] session archival failed for ${args.sessionId}: ${msg}`);
    return { archived: false };
  }
}

// ─── Late-bound merge hook (avoids a chat.ts import cycle) ────────

let mergeHook: WikiDocDispatchDeps | null = null;

export function initWikiDocMergeHook(deps: WikiDocDispatchDeps): void {
  mergeHook = deps;
}

export function resetWikiDocMergeHook(): void {
  mergeHook = null;
}

/**
 * Fire-and-forget from native / GitHub card-on-merge. No-ops when the
 * hook has not been wired (unit tests that never boot index.ts) or when
 * the project has no docs agent / the card is already reviewed.
 */
export function maybeDispatchWikiDocOnMerge(event: WikiDocMergeEvent): WikiDocOutcome {
  if (!mergeHook) return { skipped: true, reason: 'no_hook' };
  try {
    return dispatchWikiDocOnMerge(mergeHook, event);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[wiki-doc] merge dispatch failed for ${event.projectId}: ${message}`);
    return { skipped: true, reason: 'dispatch_error', message };
  }
}

/**
 * Scheduled wiki-maintenance entry point for the `wiki` background agent.
 * Loads the project's undocumented Done cards and dispatches the same doc
 * backfill the operator-triggered `POST /wiki/document-backfill` route uses,
 * but on a cadence and as the configured background-agent owner. Reuses the
 * late-bound hook deps (no chat.ts import cycle) and no-ops cleanly when the
 * hook is unwired, the project is gone, or there is nothing to document.
 */
export function maybeDispatchScheduledWikiBackfill(args: {
  projectId: string;
  ownerUserId?: string | null;
  model?: string | null;
  limit?: number;
}): WikiDocOutcome {
  if (!mergeHook) return { skipped: true, reason: 'no_hook' };
  const deps = mergeHook;
  try {
    const project = deps.findProject(args.projectId);
    if (!project) return { skipped: true, reason: 'no_project' };

    const board = deps.stmts.getKanbanBoard.get(args.projectId) as KanbanBoardRow | undefined;
    const limit = Math.max(1, Math.min(50, Math.trunc(args.limit ?? 10)));
    const cards = board
      ? (deps.stmts.listUndocumentedCards.all(board.id, limit) as KanbanCardRow[])
      : [];

    return dispatchWikiDocBackfill(deps, {
      project,
      cards: cards.map((c) => ({
        id: c.id,
        title: c.title,
        description: c.description,
        updated_at: c.updated_at,
      })),
      ownerUserId: args.ownerUserId ?? null,
      modelOverride: args.model ?? null,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[wiki-doc] scheduled backfill failed for ${args.projectId}: ${message}`);
    return { skipped: true, reason: 'dispatch_error', message };
  }
}
