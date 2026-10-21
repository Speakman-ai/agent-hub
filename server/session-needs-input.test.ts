import { describe, it, expect, vi, beforeEach } from 'vitest';

const pending = vi.hoisted(() => ({ approval: false, login: false }));
vi.mock('./approval-requests.js', () => ({
  hasPendingApprovalForSession: () => pending.approval,
}));
vi.mock('./browser-login-handoff.js', () => ({
  getPendingBrowserLogin: () => (pending.login ? { requestId: 'l1', domain: 'x.com' } : null),
}));

const {
  computeSessionNeedsInput,
  noteBroadcastForNeedsInput,
  publishSessionNeedsInput,
  buildNeedsInputSnapshot,
  __resetNeedsInputForTests,
} = await import('./session-needs-input.js');

type Msg = { role: string; content: string; metadata?: string | null };

function makeStmts(opts: { messages?: Msg[]; active?: boolean; finalizeStatus?: string | null }) {
  const messages = opts.messages ?? [];
  return {
    getActiveTask: { get: vi.fn(() => (opts.active ? { status: 'running' } : undefined)) },
    // Newest first, like the real keyset query.
    getMessagesPageLatest: {
      all: vi.fn((_id: string, limit: number) => messages.slice(-limit).reverse()),
    },
    getLatestFinalizeRunForSession: {
      get: vi.fn(() => (opts.finalizeStatus ? { status: opts.finalizeStatus } : undefined)),
    },
    getSession: {
      get: vi.fn(() => ({ agent_id: 'a1', owner_user_id: 'u1', name: 'Ship it' })),
    },
    getRecentLiveSessions: { all: vi.fn(() => [{ id: 's1' }, { id: 's2' }]) },
  } as never;
}

const ASK =
  '```agenthub:ask\n{"askId":"q1","question":"Which?","header":"Pick","options":[{"label":"A"},{"label":"B"}]}\n```';
const CRED =
  '```agenthub:credential-request\n{"requestId":"login","service":"Acme","purpose":"p","fields":[{"key":"password","label":"Password","type":"password"}]}\n```';

beforeEach(() => {
  pending.approval = false;
  pending.login = false;
  __resetNeedsInputForTests();
});

describe('computeSessionNeedsInput', () => {
  it('reports an unanswered question and an unsubmitted credential card', () => {
    expect(
      computeSessionNeedsInput(makeStmts({ messages: [{ role: 'assistant', content: ASK }] }), 's'),
    ).toBe('question');
    expect(
      computeSessionNeedsInput(
        makeStmts({ messages: [{ role: 'assistant', content: CRED }] }),
        's',
      ),
    ).toBe('credential');
  });

  it('clears once the user replies', () => {
    const stmts = makeStmts({
      messages: [
        { role: 'assistant', content: CRED },
        { role: 'user', content: 'Acme credentials were submitted securely.' },
      ],
    });
    expect(computeSessionNeedsInput(stmts, 's')).toBeNull();
  });

  it('reports approvals and sign-ins even while the turn is running', () => {
    pending.approval = true;
    expect(computeSessionNeedsInput(makeStmts({ active: true }), 's')).toBe('approval');
    pending.approval = false;
    pending.login = true;
    expect(computeSessionNeedsInput(makeStmts({ active: true }), 's')).toBe('sign_in');
  });

  it('ignores a pending question while a turn is running', () => {
    expect(
      computeSessionNeedsInput(
        makeStmts({ active: true, messages: [{ role: 'assistant', content: ASK }] }),
        's',
      ),
    ).toBeNull();
  });

  it('reports a disputed Finalize run', () => {
    expect(computeSessionNeedsInput(makeStmts({ finalizeStatus: 'disputed' }), 's')).toBe(
      'review_disputed',
    );
    expect(computeSessionNeedsInput(makeStmts({ finalizeStatus: 'failed' }), 's')).toBeNull();
  });
});

describe('session_needs_input broadcasts', () => {
  it('broadcasts only when the answer changes', () => {
    const broadcast = vi.fn();
    const stmts = makeStmts({ messages: [{ role: 'assistant', content: CRED }] });
    publishSessionNeedsInput('s', stmts, broadcast);
    publishSessionNeedsInput('s', stmts, broadcast);
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast.mock.calls[0][0]).toMatchObject({
      type: 'session_needs_input',
      sessionId: 's',
      needsInput: 'credential',
      sessionName: 'Ship it',
      ownerUserId: 'u1',
      at: expect.any(Number),
    });
  });

  it('recomputes after trigger events and ignores unrelated ones', async () => {
    const broadcast = vi.fn();
    const stmts = makeStmts({ messages: [{ role: 'assistant', content: ASK }] });
    noteBroadcastForNeedsInput({ type: 'chat_delta', sessionId: 's' }, { stmts, broadcast });
    noteBroadcastForNeedsInput({ type: 'awaiting_input', sessionId: 's' }, { stmts, broadcast });
    await Promise.resolve();
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast.mock.calls[0][0]).toMatchObject({ needsInput: 'question' });
  });
});

describe('buildNeedsInputSnapshot', () => {
  it('lists every recent session with its current reason, null included', () => {
    const stmts = makeStmts({ messages: [{ role: 'assistant', content: CRED }] });
    expect(buildNeedsInputSnapshot(stmts)).toEqual([
      { sessionId: 's1', needsInput: 'credential', at: expect.any(Number) },
      { sessionId: 's2', needsInput: 'credential', at: expect.any(Number) },
    ]);
    expect(buildNeedsInputSnapshot(makeStmts({}))).toEqual([
      { sessionId: 's1', needsInput: null, at: expect.any(Number) },
      { sessionId: 's2', needsInput: null, at: expect.any(Number) },
    ]);
  });
});
