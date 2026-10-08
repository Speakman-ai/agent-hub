/**
 * SideBar: one side conversation per session, shown in a panel next to the
 * main chat. Behind the scenes it is a hidden child session that:
 *
 * - runs in Consult mode (no code edits, no Finalize),
 * - shares the parent's checkout as its cwd (no worktree of its own),
 * - on Claude Code, forks the parent's CLI conversation on its first turn
 *   (`--resume <parent> --fork-session`), so it sees everything the parent
 *   saw, tool results included, without writing to the parent's history,
 * - on other engines (or a parent with no CLI session yet), gets the parent's
 *   transcript as a one-shot system-prompt suffix instead.
 *
 * The child is excluded from session lists by `sidebar_parent_id`. Opening a
 * new SideBar archives the previous one, so a parent has at most one live.
 */
import { v4 as uuidv4 } from 'uuid';
import type { MessageRow, SessionRow, Stmts } from './types.js';
import type { ActiveChatProcess } from './active-chat-process.js';
import { inheritOwnerFromSession } from './session-ownership.js';
import { cancelSessionChatRun } from './session-chat-cancel.js';
import { getDb } from './db.js';

/** Byte cap for the transcript seed used when a CLI fork is not possible. */
export const SIDEBAR_SEED_MAX_BYTES = 200_000;

export function isSidebarSession(
  session: { sidebar_parent_id?: string | null } | null | undefined,
): boolean {
  return typeof session?.sidebar_parent_id === 'string' && session.sidebar_parent_id !== '';
}

/**
 * The parent's Claude Code session id to fork, or null when the SideBar has to
 * fall back to a transcript seed (other engine, or no CLI turn has run yet).
 */
export function sidebarForkSource(
  parent: Pick<SessionRow, 'engine' | 'engine_session_id'>,
): string | null {
  if (parent.engine !== 'claude-code') return null;
  const id = typeof parent.engine_session_id === 'string' ? parent.engine_session_id.trim() : '';
  return id || null;
}

/**
 * Claude Code argv for a SideBar turn. The first turn forks the parent into a
 * new CLI session whose id is the SideBar's own session id, so every later
 * turn resumes it the normal way. `--session-id` is only accepted alongside
 * `--resume` when `--fork-session` is also passed.
 */
export function claudeSidebarForkArgs(forkFrom: string, sidebarSessionId: string): string[] {
  return ['--resume', forkFrom, '--fork-session', '--session-id', sidebarSessionId];
}

/**
 * cwd for a SideBar spawn: the parent's checkout. Claude Code keys its on-disk
 * conversation by cwd, so a fork only finds the parent when both run in the
 * same directory.
 */
export function sidebarSpawnCwd(
  parent: Pick<SessionRow, 'worktree_path'> | null | undefined,
  projectCwd: string,
): string {
  const wt = typeof parent?.worktree_path === 'string' ? parent.worktree_path.trim() : '';
  return wt || projectCwd;
}

/**
 * Transcript seed for engines that cannot fork. Keeps the newest messages that
 * fit in `maxBytes`, oldest first.
 */
export function buildSidebarSeedContext(
  messages: Array<Pick<MessageRow, 'role' | 'content'>>,
  opts: { agentName: string; maxBytes?: number },
): string {
  const maxBytes = opts.maxBytes ?? SIDEBAR_SEED_MAX_BYTES;
  const blocks: string[] = [];
  let used = 0;
  let dropped = 0;
  const relevant = messages.filter((m) => m.role === 'user' || m.role === 'assistant');
  for (let i = relevant.length - 1; i >= 0; i--) {
    const m = relevant[i]!;
    const label = m.role === 'user' ? 'User' : opts.agentName;
    const block = `[${label}]:\n${m.content}`;
    const size = Buffer.byteLength(block, 'utf8') + 2;
    if (used + size > maxBytes) {
      dropped = i + 1;
      break;
    }
    blocks.unshift(block);
    used += size;
  }
  const header = [
    '## SideBar context',
    '',
    'You are answering side questions in a SideBar next to the main session below.',
    'The main session continues independently; nothing you say here is added to it.',
    ...(dropped > 0 ? [`(${dropped} older message(s) omitted.)`] : []),
    '',
    '--- Main session transcript ---',
  ].join('\n');
  const body = blocks.length ? blocks.join('\n\n') : '(The main session has no messages yet.)';
  return `${header}\n\n${body}\n\n--- End of main session transcript ---`;
}

export interface SidebarStmts {
  getSession: Stmts['getSession'];
  getMessages: Stmts['getMessages'];
  createSession: Stmts['createSession'];
  updateSessionMode: Stmts['updateSessionMode'];
  updateSessionNameWithTitleSource: Stmts['updateSessionNameWithTitleSource'];
  updateSessionPendingSkillContext: Stmts['updateSessionPendingSkillContext'];
  getLiveSidebarSession: Stmts['getLiveSidebarSession'];
  getLiveSidebarSessions: Stmts['getLiveSidebarSessions'];
  markSessionAsSidebar: Stmts['markSessionAsSidebar'];
  softDeleteSession: Stmts['softDeleteSession'];
}

export function getLiveSidebar(stmts: SidebarStmts, parentId: string): SessionRow | null {
  return (stmts.getLiveSidebarSession.get(parentId) as SessionRow | undefined) ?? null;
}

/** Archive every live SideBar of `parentId`, stopping any turn in flight. */
export function closeSidebars(args: {
  stmts: SidebarStmts;
  parentId: string;
  activeProcesses?: Map<string, ActiveChatProcess>;
}): string[] {
  const rows = args.stmts.getLiveSidebarSessions.all(args.parentId) as SessionRow[];
  // Archive first: a failed write must not leave a live SideBar whose turn
  // was already killed.
  for (const row of rows) args.stmts.softDeleteSession.run(row.id);
  if (args.activeProcesses) {
    for (const row of rows) {
      cancelSessionChatRun({ sessionId: row.id, activeProcesses: args.activeProcesses });
    }
  }
  return rows.map((r) => r.id);
}

/**
 * Replace the parent's SideBar with a fresh fork. Same agent, engine, and model
 * as the parent; Consult mode; no worktree; same owner.
 */
export function openSidebar(args: {
  stmts: SidebarStmts;
  parent: SessionRow;
  agentName: string;
  activeProcesses?: Map<string, ActiveChatProcess>;
  /** Runs the swap atomically. Defaults to a SQLite transaction. */
  transaction?: <T>(fn: () => T) => T;
}): { session: SessionRow; closedIds: string[]; forked: boolean } {
  const { stmts, parent } = args;
  if (isSidebarSession(parent)) {
    throw new SidebarError(400, 'A SideBar session cannot open its own SideBar');
  }
  const transaction = args.transaction ?? (<T>(fn: () => T): T => getDb().transaction(fn)());
  const forkFrom = sidebarForkSource(parent);
  // Archive the old SideBar and create the new one together: if creation
  // fails, the old one must still be live.
  const { session, closedIds } = transaction(() => {
    const old = stmts.getLiveSidebarSessions.all(parent.id) as SessionRow[];
    for (const row of old) stmts.softDeleteSession.run(row.id);

    const id = uuidv4();
    const name = `SideBar: ${parent.name || 'session'}`.slice(0, 200);
    stmts.createSession.run(id, parent.agent_id, name, parent.engine, parent.model, 0, 0, 1);
    // Manual title source keeps auto-title from renaming a session nobody sees.
    stmts.updateSessionNameWithTitleSource.run(name, 'manual', id);
    stmts.updateSessionMode.run('consult', id);
    stmts.markSessionAsSidebar.run(parent.id, forkFrom, parent.id, id);
    if (!forkFrom) {
      const messages = stmts.getMessages.all(parent.id) as MessageRow[];
      stmts.updateSessionPendingSkillContext.run(
        buildSidebarSeedContext(messages, { agentName: args.agentName }),
        id,
      );
    }
    inheritOwnerFromSession(id, parent.id);
    return {
      session: stmts.getSession.get(id) as SessionRow,
      closedIds: old.map((r) => r.id),
    };
  });
  // Only stop the old SideBar's turn once the replacement is committed.
  if (args.activeProcesses) {
    for (const id of closedIds) {
      cancelSessionChatRun({ sessionId: id, activeProcesses: args.activeProcesses });
    }
  }
  return { session, closedIds, forked: forkFrom !== null };
}

export class SidebarError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Session id a broadcast payload is about (`message` events carry it on the row). */
export function broadcastSessionIdOf(data: Record<string, unknown>): string | null {
  if (typeof data.sessionId === 'string' && data.sessionId) return data.sessionId;
  const msg = data.message as { session_id?: unknown } | undefined;
  return msg && typeof msg.session_id === 'string' && msg.session_id ? msg.session_id : null;
}

const SIDEBAR_PARENT_CACHE_MAX = 5000;

/**
 * Tags every broadcast about a SideBar session with `sidebarParentId`, so a
 * client can route it to the SideBar panel without having opened that panel
 * first (e.g. after a reload while a SideBar turn is still running).
 *
 * A session's SideBar status is fixed at creation (`openSidebar` marks the
 * row before anything broadcasts about it), so lookups are cached both ways.
 */
export function createSidebarBroadcastTagger(
  lookupParent: (sessionId: string) => string | null,
): (data: Record<string, unknown>) => Record<string, unknown> {
  const cache = new Map<string, string | null>();
  return (data) => {
    if (typeof data.sidebarParentId === 'string') return data;
    const sid = broadcastSessionIdOf(data);
    if (!sid) return data;
    let parent = cache.get(sid);
    if (parent === undefined) {
      try {
        parent = lookupParent(sid);
      } catch {
        return data;
      }
      if (cache.size >= SIDEBAR_PARENT_CACHE_MAX) cache.clear();
      cache.set(sid, parent);
    }
    return parent ? { ...data, sidebarParentId: parent } : data;
  };
}
