/**
 * Agent channels: a chat channel (`kind='agent'`) bound to one project agent.
 *
 * A member's post runs in the channel's linked session: the first post
 * dispatches a session (owned by the channel creator, so every post in the
 * channel shares one conversation), later posts continue it. When the session
 * settles (no process, nothing queued), its latest assistant message is posted
 * back as `author_kind='agent'` with a session chip.
 *
 * Only turns started from the channel are relayed (see the turn tracking
 * below). A human chatting in the session directly does not echo into the
 * channel.
 *
 * `handleChat` lives in chat.ts, which would import this module back through
 * the routes, so deps are late-bound from index.ts (the
 * `background-agent-session.ts` pattern). The broadcast tap is
 * `observeBroadcastForAgentChannels`, called for every server broadcast.
 */
import { randomUUID } from 'crypto';
import type {
  BroadcastFn,
  ChatMessage,
  HubChatChannelRow,
  HubChatMessageRow,
  Project,
  SessionRow,
  Stmts,
  ActiveTaskRow,
} from './types.js';
import {
  BackgroundSessionDispatchError,
  dispatchBackgroundAgentSession,
} from './background-agent-session.js';
import { getDb } from './db.js';
import {
  appendMessage,
  getChannel,
  listAgentChannelsForSession,
  listMembers,
  setChannelSession,
} from './hub-chat-store.js';
import { isSessionChatBusy } from './session-chat-busy.js';
import {
  clearSessionCurrentTurn,
  countAgentTurnsForSession,
  deleteAgentTurn,
  getAgentTurn,
  getSessionCurrentTurn,
  insertAgentTurn,
  listAgentTurnsForSession,
  listOrphanedAgentTurns,
  listSessionsWithAgentTurns,
  setAgentTurnReply,
  setSessionCurrentTurn,
  updateAgentTurn,
} from './hub-chat-agent-turns-store.js';
import { broadcastHubChatMessage, agentDisplayName } from './hub-chat-broadcast.js';
import {
  HUB_CHAT_CHANNEL_UPDATE_EVENT,
  HUB_CHAT_MESSAGE_EVENT,
  recipientsOf,
} from './hub-chat-events.js';
import { formatHubChatRefToken } from '../shared/utils/hubChatRefTokens.js';

/** How long a turn end must stay quiet before the reply is posted. */
const DEFAULT_SETTLE_MS = 1500;
/** Session reply text cap, so one long transcript cannot blow up the channel. */
const MAX_REPLY_CHARS = 18_000;
/** How long restored turns wait before an idle session counts as settled. */
const RESTORE_GRACE_MS = 60_000;

export interface AgentChannelDeps {
  stmts: Pick<Stmts, 'getSession' | 'getActiveTask' | 'countQueuedMessages'>;
  broadcast: BroadcastFn;
  findProject: (projectId: string) => Project | null;
  handleChat: (ws: unknown, msg: ChatMessage) => Promise<void>;
  activeProcesses: ReadonlyMap<string, unknown>;
  /** Overridable for tests. */
  dispatch?: typeof dispatchBackgroundAgentSession;
  settleMs?: number;
  restoreGraceMs?: number;
}

let deps: AgentChannelDeps | null = null;

/*
 * Turns are told apart by the id of the user message that started them. A
 * channel post stores its message under an id chosen here, and the turn-start
 * broadcasts (`message` for an immediate turn, `queue_item_processing` for a
 * queued one) say which turn a session is running. A `done` is recorded only
 * when the session's current turn is a channel turn, so a turn someone starts
 * in the session directly never reaches the channel, however it interleaves.
 *
 * The db is the only record of that correlation
 * (`hub-chat-agent-turns-store.ts`), because the turns outlive the process: a
 * post queued or in flight when the server restarts resumes from the session
 * queue or the crash-resume path and must still be recognised. Every change
 * that spans more than one row (a post and its turn, a reply and the turn it
 * closes, a dropped turn and its notice) commits in one transaction through
 * `commit`, and broadcasts run only after the commit. A crash or a failed
 * write therefore leaves either the old state or the new one, never a turn
 * whose record is gone while its message was not written. Only the settle
 * timers are in memory; `initAgentChannels` re-arms them.
 */
const timers = new Map<string, ReturnType<typeof setTimeout>>();

/** Side effects (broadcasts) queued inside a transaction, run after it commits. */
type Outbox = Array<() => void>;

/**
 * Runs `work` in one transaction (a savepoint when nested), then runs the
 * broadcasts it queued. A throw rolls everything back and nothing is sent.
 */
function commit<T>(work: (out: Outbox) => T): T {
  const out: Outbox = [];
  const result = getDb().transaction(() => work(out))();
  for (const send of out) {
    try {
      send();
    } catch (err) {
      console.error('[hub-chat] agent channel broadcast failed:', (err as Error).message);
    }
  }
  return result;
}

export function initAgentChannels(d: AgentChannelDeps): void {
  deps = d;
  restoreAgentChannelTurns();
}

/**
 * Picks up turns that were outstanding when the server stopped. A turn that
 * never reached its session (not started, not queued) cannot run any more, so
 * it is closed with a notice telling the channel to post again.
 */
function restoreAgentChannelTurns(): void {
  try {
    commit((out) => {
      for (const turn of listOrphanedAgentTurns()) {
        deleteAgentTurn(turn.turn_id);
        const channel = getChannel(turn.channel_id);
        if (channel && !channel.archived_at) {
          postSystemNotice(
            channel,
            'A message did not reach the agent before the server restarted. Post it again.',
            out,
          );
        }
      }
    });
    // The grace covers the boot crash-resume (it re-drives an interrupted
    // turn a few seconds after start); until then the session looks idle.
    const grace = deps?.restoreGraceMs ?? RESTORE_GRACE_MS;
    for (const sessionId of listSessionsWithAgentTurns()) scheduleSettle(sessionId, grace);
  } catch (err) {
    console.error('[hub-chat] agent channel turn restore failed:', (err as Error).message);
  }
}

export function resetAgentChannels(): void {
  deps = null;
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
}

function isAwaiting(sessionId: string): boolean {
  return countAgentTurnsForSession(sessionId) > 0;
}

export class AgentChannelError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function liveSession(sessionId: string | null): SessionRow | null {
  if (!sessionId || !deps) return null;
  const row = deps.stmts.getSession.get(sessionId) as
    | (SessionRow & { deleted_at?: string | null })
    | undefined;
  if (!row || row.deleted_at) return null;
  return row;
}

function sessionBusy(sessionId: string): boolean {
  if (!deps) return false;
  const task = deps.stmts.getActiveTask.get(sessionId) as ActiveTaskRow | undefined;
  if (isSessionChatBusy(sessionId, deps.activeProcesses, task)) return true;
  const queued = deps.stmts.countQueuedMessages.get(sessionId) as { n?: number } | undefined;
  return (queued?.n ?? 0) > 0;
}

export interface AgentChannelState {
  sessionId: string | null;
  sessionName: string | null;
  /** True while a channel post is being worked on. */
  running: boolean;
}

/** Header state for an agent channel; null for every other kind. */
export function agentChannelState(channel: HubChatChannelRow): AgentChannelState | null {
  if (channel.kind !== 'agent') return null;
  const session = liveSession(channel.session_id);
  const sessionId = session?.id ?? null;
  return {
    sessionId,
    sessionName: session?.name ?? null,
    running: sessionId ? isAwaiting(sessionId) : false,
  };
}

function emitAgentState(channelId: string): void {
  // Read at send time, after the commit, so the state is the committed one.
  const channel = getChannel(channelId);
  if (!channel || !deps) return;
  const recipientUserIds = recipientsOf(listMembers(channel.id));
  if (recipientUserIds.length === 0) return;
  deps.broadcast({
    type: HUB_CHAT_CHANNEL_UPDATE_EVENT,
    recipientUserIds,
    orgId: channel.org_id,
    channelId: channel.id,
    reason: 'agent_state',
    agentState: agentChannelState(channel),
  });
}

function sendMessage(channel: HubChatChannelRow, message: HubChatMessageRow): void {
  broadcastHubChatMessage(deps?.broadcast, HUB_CHAT_MESSAGE_EVENT, channel, message);
}

function sessionTitle(channel: HubChatChannelRow): string {
  return `#${channel.name || agentDisplayName(channel.agent_id ?? '')}`;
}

function firstPrompt(channel: HubChatChannelRow, authorName: string, body: string): string {
  return [
    `You are taking part in the Agent Hub chat channel ${sessionTitle(channel)}.`,
    'Each message comes from a channel member. Your final reply of each turn is',
    'posted back into the channel, so answer in the reply itself.',
    '',
    `**${authorName}:** ${body}`,
  ].join('\n');
}

/**
 * Records a member's post as a turn of the channel's session. Call it in the
 * same transaction that stores the post, so a stored post always has its turn
 * (and a restart can tell the channel it was not delivered).
 */
export function reserveAgentChannelTurn(channel: HubChatChannelRow): string {
  const turnId = randomUUID();
  insertAgentTurn(turnId, channel.id, liveSession(channel.session_id)?.id ?? null);
  return turnId;
}

/**
 * Hands a reserved turn to the channel's session: continues the linked
 * session when it is still live, otherwise dispatches a new one and links it.
 * A turn that cannot start is closed with a notice in the channel.
 */
export function runAgentChannelPost(args: {
  channel: HubChatChannelRow;
  turnId: string;
  authorName: string;
  body: string;
}): { sessionId: string | null; dispatched: boolean } {
  const { channel, turnId } = args;
  try {
    if (!deps) throw new AgentChannelError('no_hook', 'Agent channels are not initialised');
    if (channel.kind !== 'agent' || !channel.project_id || !channel.agent_id) {
      throw new AgentChannelError('not_agent_channel', 'This is not an agent channel');
    }
    const existing = liveSession(getAgentTurn(turnId)?.session_id ?? null);
    if (existing) {
      void deps
        .handleChat(null, {
          type: 'chat',
          agentId: existing.agent_id,
          sessionId: existing.id,
          content: `**${args.authorName}:** ${args.body}`,
          _userMessageId: turnId,
          // Dropped (queue full): the turn will never run, so stop waiting on it.
          _onUserMessagePersisted: (accepted) => {
            if (!accepted) turnFailed(channel.id, turnId, 'the session queue is full');
          },
        })
        .catch((err: unknown) => turnFailed(channel.id, turnId, err));
      emitAgentState(channel.id);
      return { sessionId: existing.id, dispatched: false };
    }

    const project = deps.findProject(channel.project_id);
    if (!project) throw new AgentChannelError('project_not_found', 'The channel project is gone');
    const dispatch = deps.dispatch ?? dispatchBackgroundAgentSession;
    let result: ReturnType<typeof dispatchBackgroundAgentSession>;
    try {
      result = dispatch(
        project,
        {
          id: randomUUID(),
          name: sessionTitle(channel),
          prompt: firstPrompt(channel, args.authorName, args.body),
          ownerUserId: channel.created_by_user_id,
          sessionAgentId: channel.agent_id,
          runAsSession: true,
        },
        {
          sessionName: sessionTitle(channel),
          userMessageId: turnId,
          onKickoffError: (msg) => turnFailed(channel.id, turnId, msg),
        },
      );
    } catch (err) {
      if (err instanceof BackgroundSessionDispatchError) {
        throw new AgentChannelError(err.code, err.message);
      }
      throw err;
    }
    commit((out) => {
      // The turn may already have started (recording the session) or failed.
      const turn = getAgentTurn(turnId);
      if (turn) updateAgentTurn(turnId, result.sessionId, turn.started === 1);
      setChannelSession(channel.id, result.sessionId);
      out.push(() => emitAgentState(channel.id));
    });
    return { sessionId: result.sessionId, dispatched: true };
  } catch (err) {
    turnFailed(channel.id, turnId, err);
    return { sessionId: null, dispatched: false };
  }
}

/** Closes a turn that could not run, with a notice in its channel. */
function turnFailed(channelId: string, turnId: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[hub-chat] agent channel ${channelId} turn failed to start: ${msg}`);
  try {
    commit((out) => {
      deleteAgentTurn(turnId);
      const channel = getChannel(channelId);
      if (!channel) return;
      postSystemNotice(channel, `The agent could not start: ${msg}`, out);
      out.push(() => emitAgentState(channelId));
    });
  } catch (e) {
    // The turn stays recorded; the next settle or restart closes it.
    console.error('[hub-chat] could not record the failed turn:', (e as Error).message);
  }
}

function postSystemNotice(channel: HubChatChannelRow, body: string, out: Outbox): void {
  const message = appendMessage({ channelId: channel.id, authorKind: 'system', body });
  out.push(() => sendMessage(channel, message));
}

function scheduleSettle(sessionId: string, delayMs?: number): void {
  const existing = timers.get(sessionId);
  if (existing) clearTimeout(existing);
  const t = setTimeout(() => settle(sessionId), delayMs ?? deps?.settleMs ?? DEFAULT_SETTLE_MS);
  t.unref?.();
  timers.set(sessionId, t);
}

/**
 * Posts the replies of a session's finished channel turns, oldest first. Each
 * reply and the deletion of its turn are one write: a failed post keeps the
 * turn, so a later settle (or a restart) posts it.
 */
function flushReplies(sessionId: string, out: Outbox, exceptTurnId: string | null = null): void {
  const session = liveSession(sessionId);
  for (const turn of listAgentTurnsForSession(sessionId)) {
    if (turn.turn_id === exceptTurnId || turn.reply_content == null) continue;
    const channel = getChannel(turn.channel_id);
    if (channel && !channel.archived_at) {
      postAgentReply(
        channel,
        sessionId,
        session?.name ?? sessionTitle(channel),
        { messageId: turn.reply_message_id ?? '', content: turn.reply_content },
        out,
      );
      out.push(() => emitAgentState(channel.id));
    }
    deleteAgentTurn(turn.turn_id);
  }
}

function settle(sessionId: string): void {
  timers.delete(sessionId);
  if (!deps) return;
  // Still working (ReAct step, queued follow-up): a later turn end decides.
  if (sessionBusy(sessionId)) {
    scheduleSettle(sessionId);
    return;
  }
  try {
    commit((out) => {
      flushReplies(sessionId, out);
      // Started channel turns that ended without a reply (error, cancel) are
      // over. A turn not started yet may still be on its way into the session.
      for (const turn of listAgentTurnsForSession(sessionId)) {
        if (turn.started === 1) deleteAgentTurn(turn.turn_id);
      }
      if (!isAwaiting(sessionId)) clearSessionCurrentTurn(sessionId);
      for (const channel of listAgentChannelsForSession(sessionId)) {
        out.push(() => emitAgentState(channel.id));
      }
    });
  } catch (err) {
    // Nothing was written; the turns and their replies are intact. Retry.
    console.error(
      `[hub-chat] agent channel settle failed for ${sessionId}:`,
      (err as Error).message,
    );
    scheduleSettle(sessionId);
  }
}

/** A session started the turn of user message `turnId`. */
function onTurnStart(sessionId: string, turnId: string): void {
  const turn = getAgentTurn(turnId);
  if (!turn && !getSessionCurrentTurn(sessionId)) return;
  // The previous turn is over; a channel reply it left is final now. If the
  // post fails it stays recorded and the next settle posts it.
  try {
    commit((out) => flushReplies(sessionId, out, turnId));
  } catch (err) {
    console.error(
      `[hub-chat] agent channel reply failed for ${sessionId}:`,
      (err as Error).message,
    );
    scheduleSettle(sessionId);
  }
  // Which turn is running must be recorded regardless, or this turn's reply
  // would be credited to the previous one.
  commit(() => {
    setSessionCurrentTurn(sessionId, turnId);
    if (turn) updateAgentTurn(turnId, sessionId, true);
  });
}

/** Body of the relayed reply: the agent's text plus a chip for its session. */
export function agentReplyBody(content: string, sessionName: string, sessionId: string): string {
  let text = content.trim();
  if (text.length > MAX_REPLY_CHARS) text = `${text.slice(0, MAX_REPLY_CHARS).trimEnd()}\n\n…`;
  const chip = formatHubChatRefToken(sessionName, 'session', sessionId);
  if (!chip) return text;
  return text ? `${text}\n\n${chip}` : chip;
}

function postAgentReply(
  channel: HubChatChannelRow,
  sessionId: string,
  sessionName: string,
  reply: { messageId: string; content: string },
  out: Outbox,
): void {
  const message = appendMessage({
    channelId: channel.id,
    authorKind: 'agent',
    authorAgentId: channel.agent_id,
    body: agentReplyBody(reply.content, sessionName, sessionId),
    refs: [{ kind: 'session', targetId: sessionId, projectId: channel.project_id }],
    payload: { sessionId, sessionMessageId: reply.messageId },
  });
  out.push(() => sendMessage(channel, message));
}

/**
 * Broadcast tap. Turn starts set which turn a session is running; a `done`
 * during a channel turn records the reply to post; any turn end (`done`,
 * `error`, `interrupted`) in a session with channel turns arms the settle
 * timer.
 */
export function observeBroadcastForAgentChannels(data: Record<string, unknown>): void {
  if (!deps) return;
  const type = data.type;
  if (type === 'message') {
    const m = data.message as
      | {
          id?: unknown;
          session_id?: unknown;
          role?: unknown;
          queued?: unknown;
          interrupted?: unknown;
        }
      | undefined;
    if (
      m?.role === 'user' &&
      !m.queued &&
      !m.interrupted &&
      typeof m.id === 'string' &&
      typeof m.session_id === 'string' &&
      // A crash-resume continues the interrupted turn, whose id stays current.
      data.autoResume !== true
    ) {
      onTurnStart(m.session_id, m.id);
    }
    return;
  }
  if (type === 'queue_item_processing') {
    if (typeof data.sessionId === 'string' && typeof data.messageId === 'string') {
      onTurnStart(data.sessionId, data.messageId);
    }
    return;
  }
  if (type !== 'done' && type !== 'error' && type !== 'interrupted') return;
  const sessionId = typeof data.sessionId === 'string' ? data.sessionId : null;
  if (!sessionId || !isAwaiting(sessionId)) return;
  const turnId = getSessionCurrentTurn(sessionId);
  if (type === 'done' && turnId && getAgentTurn(turnId)) {
    const message = data.message as { id?: unknown; content?: unknown } | undefined;
    const content = typeof message?.content === 'string' ? message.content : '';
    const messageId =
      typeof data.messageId === 'string'
        ? data.messageId
        : typeof message?.id === 'string'
          ? message.id
          : '';
    if (content.trim()) setAgentTurnReply(turnId, messageId, content);
  }
  scheduleSettle(sessionId);
}
