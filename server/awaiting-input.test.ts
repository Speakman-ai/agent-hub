import { describe, it, expect, vi } from 'vitest';
import type { ActiveTaskRow, MessageRow, SessionRow, Stmts } from './types.js';
import {
  broadcastAwaitingInputForSession,
  buildAwaitingInputSnapshot,
  getSessionAwaitingInputState,
} from './awaiting-input.js';

const ASK_BODY = `\n\`\`\`agenthub:ask\n${JSON.stringify({
  askId: 'ask-1',
  question: 'Pick one',
  header: 'Pick',
  options: [
    { label: 'A', description: '' },
    { label: 'B', description: '' },
  ],
})}\n\`\`\`\n`;

const ANSWER_BODY = `\n\`\`\`agenthub:ask:answer\n${JSON.stringify({
  askId: 'ask-1',
  answers: { 'Pick one': 'A' },
})}\n\`\`\`\n`;

const SESSION_ID = 'sess-awaiting-1';
const AGENT_ID = 'agent-1';

function makeSessionRow(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: SESSION_ID,
    agent_id: AGENT_ID,
    name: 'Pickers',
    engine: 'claude-code',
    model: 'opus',
    engine_session_id: null,
    use_worktree: 0,
    worktree_path: null,
    worktree_branch: null,
    git_worktree_detected: 0,
    changes_ready: null,
    code_changed_at: null,
    stale_pr_notified_at: null,
    pending_skill_context: null,
    ask_mode: 0,
    cron_id: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    deleted_at: null,
    ...overrides,
  } as SessionRow;
}

function makeMessage(role: MessageRow['role'], content: string, id = `m-${role}`): MessageRow {
  return {
    id,
    session_id: SESSION_ID,
    role,
    content,
    engine: null,
    model: null,
    attachments: null,
    metadata: null,
    created_at: '2026-01-01T00:00:00.000Z',
  };
}

function makeStmts(opts: {
  session?: SessionRow | null;
  messages?: MessageRow[];
  activeTask?: ActiveTaskRow | null;
  recentSessions?: SessionRow[];
  allActiveTasks?: ActiveTaskRow[];
}): Stmts {
  const sessionsById = new Map<string, SessionRow>();
  if (opts.session) sessionsById.set(opts.session.id, opts.session);
  for (const s of opts.recentSessions ?? []) sessionsById.set(s.id, s);

  return {
    getActiveTask: { get: vi.fn(() => opts.activeTask ?? undefined) },
    getSession: { get: (id: string) => sessionsById.get(id) },
    getMessages: { all: vi.fn(() => opts.messages ?? []) },
    getRecentLiveSessions: { all: vi.fn(() => opts.recentSessions ?? []) },
    getAllActiveTasks: { all: vi.fn(() => opts.allActiveTasks ?? []) },
  } as unknown as Stmts;
}

describe('getSessionAwaitingInputState', () => {
  it('returns null when no messages exist', () => {
    const stmts = makeStmts({ session: makeSessionRow(), messages: [] });
    expect(getSessionAwaitingInputState(SESSION_ID, stmts)).toBeNull();
  });

  it('returns null when the latest assistant message has no ask block', () => {
    const stmts = makeStmts({
      session: makeSessionRow(),
      messages: [
        makeMessage('user', 'hi', 'u1'),
        makeMessage('assistant', 'plain text reply', 'a1'),
      ],
    });
    expect(getSessionAwaitingInputState(SESSION_ID, stmts)).toBeNull();
  });

  it('returns the unanswered askIds when the assistant emitted a picker with no reply', () => {
    const stmts = makeStmts({
      session: makeSessionRow(),
      messages: [
        makeMessage('user', 'help me pick', 'u1'),
        makeMessage('assistant', `Sure.${ASK_BODY}`, 'a1'),
      ],
    });
    const state = getSessionAwaitingInputState(SESSION_ID, stmts);
    expect(state).not.toBeNull();
    expect(state!.askIds).toEqual(['ask-1']);
    expect(state!.agentId).toBe(AGENT_ID);
    expect(state!.sessionName).toBe('Pickers');
  });

  it('returns null when the user has submitted an answer block', () => {
    const stmts = makeStmts({
      session: makeSessionRow(),
      messages: [
        makeMessage('user', 'help me pick', 'u1'),
        makeMessage('assistant', `Sure.${ASK_BODY}`, 'a1'),
        makeMessage('user', `Picked.${ANSWER_BODY}`, 'u2'),
      ],
    });
    expect(getSessionAwaitingInputState(SESSION_ID, stmts)).toBeNull();
  });

  it('returns null while an active task is in flight (working takes precedence)', () => {
    const stmts = makeStmts({
      session: makeSessionRow(),
      messages: [makeMessage('assistant', `Sure.${ASK_BODY}`, 'a1')],
      activeTask: {
        session_id: SESSION_ID,
        message_id: 'm-running',
        agent_id: AGENT_ID,
        pid: 999,
        prompt: '',
        streamed_output: '',
        engine: 'claude-code',
        model: 'opus',
        status: 'running',
        started_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      },
    });
    expect(getSessionAwaitingInputState(SESSION_ID, stmts)).toBeNull();
  });
});

describe('buildAwaitingInputSnapshot', () => {
  it('emits one entry per session with an unanswered ask, skipping running ones', () => {
    const sA = makeSessionRow({ id: 'sA', name: 'Waiting A' });
    const sB = makeSessionRow({ id: 'sB', name: 'Working B' });
    const sC = makeSessionRow({ id: 'sC', name: 'Idle C' });

    const messagesById: Record<string, MessageRow[]> = {
      sA: [makeMessage('assistant', `hi${ASK_BODY}`, 'a-A')],
      sB: [makeMessage('assistant', `hi${ASK_BODY}`, 'a-B')],
      sC: [makeMessage('assistant', 'no ask here', 'a-C')],
    };

    const stmts = {
      getActiveTask: { get: vi.fn(() => undefined) },
      getSession: { get: () => undefined },
      getMessages: {
        all: (id: string) => messagesById[id] ?? [],
      },
      getRecentLiveSessions: { all: () => [sA, sB, sC] },
      getAllActiveTasks: {
        all: () => [
          {
            session_id: 'sB',
            message_id: 'mb',
            agent_id: AGENT_ID,
            pid: 1,
            prompt: '',
            streamed_output: '',
            engine: 'claude-code',
            model: null,
            status: 'running',
            started_at: '',
            updated_at: '',
          } satisfies ActiveTaskRow,
        ],
      },
    } as unknown as Stmts;

    const snap = buildAwaitingInputSnapshot(stmts);
    expect(snap.map((s) => s.sessionId)).toEqual(['sA']);
    expect(snap[0].askIds).toEqual(['ask-1']);
    expect(snap[0].sessionName).toBe('Waiting A');
  });
});

describe('broadcastAwaitingInputForSession', () => {
  it('emits waiting:true when the session is awaiting input', () => {
    const stmts = makeStmts({
      session: makeSessionRow(),
      messages: [makeMessage('assistant', `Sure.${ASK_BODY}`)],
    });
    const broadcast = vi.fn();
    broadcastAwaitingInputForSession(SESSION_ID, stmts, broadcast);
    expect(broadcast).toHaveBeenCalledTimes(1);
    const payload = broadcast.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.type).toBe('awaiting_input');
    expect(payload.sessionId).toBe(SESSION_ID);
    expect(payload.waiting).toBe(true);
    expect(payload.askIds).toEqual(['ask-1']);
  });

  it('emits waiting:false with empty askIds when the session is no longer waiting', () => {
    const stmts = makeStmts({
      session: makeSessionRow(),
      messages: [makeMessage('assistant', 'idle')],
    });
    const broadcast = vi.fn();
    broadcastAwaitingInputForSession(SESSION_ID, stmts, broadcast);
    expect(broadcast).toHaveBeenCalledTimes(1);
    const payload = broadcast.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.waiting).toBe(false);
    expect(payload.askIds).toEqual([]);
    expect(payload.sessionId).toBe(SESSION_ID);
  });

  // Regression: clients scope the foreground awaiting-input banner to the
  // session owner, so the broadcast MUST carry `ownerUserId`. Without it the
  // web client showed another account's "agent waiting" toast (which 404s on
  // click). Owner resolver is injected so the unit test stays DB-free.
  it('stamps the session owner on the waiting:true broadcast', () => {
    const stmts = makeStmts({
      session: makeSessionRow(),
      messages: [makeMessage('assistant', `Sure.${ASK_BODY}`)],
    });
    const broadcast = vi.fn();
    broadcastAwaitingInputForSession(SESSION_ID, stmts, broadcast, () => 'u-kevin');
    const payload = broadcast.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.waiting).toBe(true);
    expect(payload.ownerUserId).toBe('u-kevin');
  });

  it('stamps the session owner on the waiting:false broadcast', () => {
    const stmts = makeStmts({
      session: makeSessionRow(),
      messages: [makeMessage('assistant', 'idle')],
    });
    const broadcast = vi.fn();
    broadcastAwaitingInputForSession(SESSION_ID, stmts, broadcast, () => 'u-kevin');
    const payload = broadcast.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.waiting).toBe(false);
    expect(payload.ownerUserId).toBe('u-kevin');
  });

  it('stamps ownerUserId null for unowned (cron / system) sessions', () => {
    const stmts = makeStmts({
      session: makeSessionRow(),
      messages: [makeMessage('assistant', `Sure.${ASK_BODY}`)],
    });
    const broadcast = vi.fn();
    broadcastAwaitingInputForSession(SESSION_ID, stmts, broadcast, () => null);
    const payload = broadcast.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.ownerUserId).toBeNull();
  });
});
