import { describe, it, expect } from 'vitest';
import {
  isSidebarSubmitKey,
  isSidebarWsEvent,
  canAskSidebar,
  initialSidebarPanelState,
  sidebarPanelReducer,
  sidebarView,
  type SidebarAction,
  type SidebarPanelState,
  SIDEBAR_REPLACED_ERROR,
} from './sessionSidebar.js';

const SB = 'sidebar-1';

describe('isSidebarWsEvent', () => {
  const ids = new Set([SB]);

  it('routes events for a known SideBar session id', () => {
    expect(isSidebarWsEvent({ type: 'stream', sessionId: SB }, ids)).toBe(true);
    expect(isSidebarWsEvent({ type: 'message', message: { session_id: SB } }, ids)).toBe(true);
  });

  it('routes SideBar lifecycle events even before the id is known', () => {
    expect(isSidebarWsEvent({ type: 'sidebar_opened', sessionId: 'new' }, new Set())).toBe(true);
    expect(isSidebarWsEvent({ type: 'sidebar_closed', sessionId: 'old' }, new Set())).toBe(true);
  });

  it('routes server-tagged events with no ids registered (reload mid-turn)', () => {
    const afterReload = new Set<string>();
    expect(
      isSidebarWsEvent({ type: 'done', sessionId: 'sb-x', sidebarParentId: 'main' }, afterReload),
    ).toBe(true);
    expect(
      isSidebarWsEvent(
        { type: 'stream', sessionId: 'sb-x', sidebarParentId: 'main', content: 'x' },
        afterReload,
      ),
    ).toBe(true);
  });

  it('leaves main-session and unrelated events alone', () => {
    expect(isSidebarWsEvent({ type: 'done', sessionId: 'main' }, ids)).toBe(false);
    expect(isSidebarWsEvent({ type: 'active-tasks-snapshot', tasks: [] }, ids)).toBe(false);
  });
});

describe('isSidebarSubmitKey', () => {
  it('sends on plain Enter only', () => {
    expect(isSidebarSubmitKey({ key: 'Enter' })).toBe(true);
    expect(isSidebarSubmitKey({ key: 'Enter', shiftKey: true })).toBe(false);
    expect(isSidebarSubmitKey({ key: 'a' })).toBe(false);
  });

  it('does not send while confirming an IME candidate', () => {
    expect(isSidebarSubmitKey({ key: 'Enter', nativeEvent: { isComposing: true } })).toBe(false);
    expect(isSidebarSubmitKey({ key: 'Enter', keyCode: 229 })).toBe(false);
  });
});

describe('sidebarPanelReducer', () => {
  const P = 'main-1';
  const tagged = (ev: Record<string, unknown>) => ({ sidebarParentId: P, ...ev });
  const run = (actions: SidebarAction[], start = initialSidebarPanelState(P)) =>
    actions.reduce(sidebarPanelReducer, start);
  const view = (s: SidebarPanelState) => sidebarView(s);
  const ws = (data: Record<string, unknown>): SidebarAction => ({ type: 'ws', data });
  const opened = (id: string, seq: number): SidebarAction =>
    ws({
      type: 'sidebar_opened',
      sessionId: id,
      parentSessionId: P,
      session: { id, sidebar_seq: seq },
    });
  const closed = (id: string): SidebarAction =>
    ws({ type: 'sidebar_closed', sessionId: id, sidebarParentId: P });
  const turn = (type: string, id: string, extra: Record<string, unknown> = {}): SidebarAction =>
    ws(tagged({ type, sessionId: id, ...extra }));
  const loaded = (id: string | null, running = false, seq = 1, token = 1) =>
    run([
      { type: 'load_start', token, parentSessionId: P },
      { type: 'load_result', token, sidebarId: id, seq, running },
      ...(id ? [{ type: 'history', token, sidebarId: id, messages: [] } as SidebarAction] : []),
    ]);

  describe('loading', () => {
    it('a done that lands while history loads is not undone by the running snapshot', () => {
      const s = run([
        { type: 'load_start', token: 1, parentSessionId: P },
        { type: 'load_result', token: 1, sidebarId: 'sb', running: true },
        turn('done', 'sb', { message: { id: 'a2', role: 'assistant', content: 'final answer' } }),
        {
          type: 'history',
          token: 1,
          sidebarId: 'sb',
          messages: [{ id: 'u1', role: 'user', content: 'q' }],
        },
      ]);
      expect(view(s).busy).toBe(false);
      expect(view(s).phase).toBe('ready');
      expect(view(s).messages.map((m) => m.id)).toEqual(['u1', 'a2']);
      expect(canAskSidebar(s)).toBe(true);
    });

    it('replays a done that arrived before the lookup named the SideBar', () => {
      const s = run([
        { type: 'load_start', token: 1, parentSessionId: P },
        turn('done', 'sb'),
        { type: 'load_result', token: 1, sidebarId: 'sb', running: true },
      ]);
      expect(view(s).busy).toBe(false);
      expect(s.buffered).toEqual([]);
    });

    it('does not buffer events for another parent', () => {
      const s = run([
        { type: 'load_start', token: 1, parentSessionId: P },
        ws({ type: 'thinking', sessionId: 'x', sidebarParentId: 'other' }),
      ]);
      expect(s.buffered).toEqual([]);
    });

    it('drops results from a superseded lookup', () => {
      const s = run([
        { type: 'load_start', token: 1, parentSessionId: P },
        { type: 'load_start', token: 2, parentSessionId: P },
        { type: 'load_result', token: 1, sidebarId: 'stale', running: true },
      ]);
      expect(view(s).sidebarId).toBeNull();
      expect(view(s).phase).toBe('loading');
    });

    it('a close before the lookup response retires the child it names', () => {
      const s = run([
        { type: 'load_start', token: 1, parentSessionId: P },
        closed('A'),
        { type: 'load_result', token: 1, sidebarId: 'A', running: true },
        {
          type: 'history',
          token: 1,
          sidebarId: 'A',
          messages: [{ id: 'x', role: 'assistant', content: 'discarded' }],
        },
      ]);
      expect(view(s).sidebarId).toBeNull();
      expect(view(s).phase).toBe('ready');
      expect(view(s).busy).toBe(false);
      expect(view(s).messages).toEqual([]);
    });

    it('a close then reopen before the lookup response lands on the new child', () => {
      const s = run([
        { type: 'load_start', token: 1, parentSessionId: P },
        closed('A'),
        opened('B', 2),
        { type: 'load_result', token: 1, sidebarId: 'A', seq: 1, running: false },
      ]);
      expect(view(s).sidebarId).toBe('B');
      expect(view(s).phase).toBe('ready');
    });

    it('a SideBar replaced mid-history does not stall or show old history', () => {
      const s = run([
        { type: 'load_start', token: 1, parentSessionId: P },
        { type: 'load_result', token: 1, sidebarId: 'A', seq: 1, running: false },
        closed('A'),
        opened('B', 2),
        {
          type: 'history',
          token: 1,
          sidebarId: 'A',
          messages: [{ id: 'o1', role: 'assistant', content: 'old' }],
        },
      ]);
      expect(view(s).sidebarId).toBe('B');
      expect(view(s).phase).toBe('ready');
      expect(view(s).messages).toEqual([]);
    });

    it('an obsolete history failure does not break the replacement SideBar', () => {
      const s = run([
        { type: 'load_start', token: 1, parentSessionId: P },
        { type: 'load_result', token: 1, sidebarId: 'A', seq: 1, running: false },
        closed('A'),
        opened('B', 2),
        turn('done', 'B', { message: { id: 'b1', role: 'assistant', content: 'from B' } }),
        { type: 'history_failed', token: 1, sidebarId: 'A', error: 'network' },
      ]);
      expect(view(s).sidebarId).toBe('B');
      expect(view(s).phase).toBe('ready');
      expect(view(s).loadError).toBeNull();
      expect(view(s).messages.map((m) => m.content)).toEqual(['from B']);
      expect(canAskSidebar(s)).toBe(true);
    });

    it('an obsolete lookup failure does not break a SideBar adopted from an event', () => {
      const s = run([
        { type: 'load_start', token: 1, parentSessionId: P },
        opened('B', 2),
        { type: 'load_failed', token: 1, error: 'network' },
      ]);
      expect(view(s).sidebarId).toBe('B');
      expect(view(s).phase).toBe('ready');
    });

    it('a current history failure shows a retryable load error', () => {
      const s = run([
        { type: 'load_start', token: 1, parentSessionId: P },
        { type: 'load_result', token: 1, sidebarId: 'A', running: false },
        { type: 'history_failed', token: 1, sidebarId: 'A', error: 'network' },
      ]);
      expect(view(s).phase).toBe('load_error');
      expect(view(s).loadError).toBe('network');
    });

    it('blocks asking while loading, during an op, or mid-turn', () => {
      expect(canAskSidebar(run([{ type: 'load_start', token: 1, parentSessionId: P }]))).toBe(
        false,
      );
      const ready = loaded('sb');
      expect(canAskSidebar(ready)).toBe(true);
      expect(canAskSidebar(run([{ type: 'op_start', opId: 1, op: 'discard' }], ready))).toBe(false);
      expect(
        canAskSidebar(run([{ type: 'ask_local', questionId: 'q1', content: 'q' }], ready)),
      ).toBe(false);
    });
  });

  describe('reconnect resync', () => {
    it('clears a turn that finished while offline', () => {
      const offline = run(
        [
          { type: 'ask_local', questionId: 'q1', content: 'q' },
          turn('message', 'sb', {
            message: { id: 'u1', session_id: 'sb', role: 'user', content: 'q' },
          }),
          turn('stream', 'sb', { content: 'partial' }),
        ],
        loaded('sb'),
      );
      expect(view(offline).busy).toBe(true);
      const resyncing = run([{ type: 'load_start', token: 2, parentSessionId: P }], offline);
      expect(view(resyncing).messages.map((m) => m.id)).toEqual(['u1']);
      expect(canAskSidebar(resyncing)).toBe(false);
      const s = run(
        [
          { type: 'load_result', token: 2, sidebarId: 'sb', seq: 1, running: false },
          {
            type: 'history',
            token: 2,
            sidebarId: 'sb',
            messages: [
              { id: 'u1', role: 'user', content: 'q' },
              { id: 'a1', role: 'assistant', content: 'answered while offline' },
            ],
          },
        ],
        resyncing,
      );
      expect(view(s).busy).toBe(false);
      expect(view(s).streamingContent).toBe('');
      expect(view(s).messages.map((m) => m.id)).toEqual(['u1', 'a1']);
      expect(canAskSidebar(s)).toBe(true);
    });

    it('a turn event during the resync beats the lookup snapshot', () => {
      const s = run(
        [
          { type: 'load_start', token: 2, parentSessionId: P },
          turn('thinking', 'sb'),
          { type: 'load_result', token: 2, sidebarId: 'sb', seq: 1, running: false },
        ],
        loaded('sb'),
      );
      expect(view(s).busy).toBe(true);
    });

    it('a question whose echo was missed appears once', () => {
      const asked = run([{ type: 'ask_local', questionId: 'q1', content: 'why?' }], loaded('sb'));
      const s = run(
        [
          { type: 'load_start', token: 2, parentSessionId: P },
          { type: 'load_result', token: 2, sidebarId: 'sb', seq: 1, running: false },
          {
            type: 'history',
            token: 2,
            sidebarId: 'sb',
            messages: [
              { id: 'u1', role: 'user', content: 'why?' },
              { id: 'a1', role: 'assistant', content: 'because' },
            ],
          },
        ],
        asked,
      );
      expect(view(s).messages).toEqual([
        { id: 'u1', role: 'user', content: 'why?' },
        { id: 'a1', role: 'assistant', content: 'because' },
      ]);
      expect(view(s).busy).toBe(false);
    });

    it('a repeated question is not swallowed by an identical earlier one', () => {
      const first = run(
        [
          turn('message', 'sb', {
            message: { id: 'u1', session_id: 'sb', role: 'user', content: 'again?' },
          }),
          { type: 'ask_local', questionId: 'q2', content: 'again?' },
        ],
        loaded('sb'),
      );
      const s = run(
        [
          { type: 'load_start', token: 2, parentSessionId: P },
          { type: 'load_result', token: 2, sidebarId: 'sb', seq: 1, running: true },
          {
            type: 'history',
            token: 2,
            sidebarId: 'sb',
            messages: [{ id: 'u1', role: 'user', content: 'again?' }],
          },
        ],
        first,
      );
      expect(view(s).messages.map((m) => m.id)).toEqual(['u1', 'q2']);
    });

    it('re-adopts the same SideBar at the same seq', () => {
      const s = run(
        [
          { type: 'load_start', token: 2, parentSessionId: P },
          { type: 'load_result', token: 2, sidebarId: 'sb', seq: 1, running: false },
          { type: 'history', token: 2, sidebarId: 'sb', messages: [] },
        ],
        loaded('sb'),
      );
      expect(view(s).sidebarId).toBe('sb');
      expect(view(s).phase).toBe('ready');
    });

    it('a lookup that finds no SideBar drops the old conversation', () => {
      const before = run(
        [turn('done', 'sb', { message: { id: 'a1', role: 'assistant', content: 'old' } })],
        loaded('sb'),
      );
      const s = run(
        [
          { type: 'load_start', token: 2, parentSessionId: P },
          { type: 'load_result', token: 2, sidebarId: null, running: false },
        ],
        before,
      );
      expect(view(s).sidebarId).toBeNull();
      expect(view(s).messages).toEqual([]);
      expect(view(s).phase).toBe('ready');
    });

    it('a lookup naming an archived SideBar lands on none', () => {
      const s = run(
        [
          closed('sb'),
          { type: 'load_start', token: 2, parentSessionId: P },
          { type: 'load_result', token: 2, sidebarId: 'sb', seq: 1, running: true },
        ],
        loaded('sb'),
      );
      expect(view(s).sidebarId).toBeNull();
      expect(view(s).busy).toBe(false);
      expect(view(s).phase).toBe('ready');
    });
  });

  describe('events about a not-yet-adopted SideBar are held, not dropped', () => {
    const withA = () =>
      run(
        [turn('done', 'A', { message: { id: 'a1', role: 'assistant', content: 'from A' } })],
        loaded('A', false, 1),
      );

    it("a replacement's done that beats the resync lookup still clears running", () => {
      const s = run(
        [
          // Reconnect; while offline another window replaced A with B.
          { type: 'load_start', token: 2, parentSessionId: P },
          turn('done', 'B', { message: { id: 'b2', role: 'assistant', content: 'B answer' } }),
          { type: 'load_result', token: 2, sidebarId: 'B', seq: 2, running: true },
          {
            type: 'history',
            token: 2,
            sidebarId: 'B',
            messages: [
              { id: 'b1', role: 'user', content: 'B question' },
              { id: 'b2', role: 'assistant', content: 'B answer' },
            ],
          },
        ],
        withA(),
      );
      expect(view(s).sidebarId).toBe('B');
      expect(view(s).busy).toBe(false);
      expect(canAskSidebar(s)).toBe(true);
      expect(view(s).messages.map((m) => m.id)).toEqual(['b1', 'b2']);
      expect(s.buffered).toEqual([]);
    });

    it("a replacement's turn that is still running shows as running after adoption", () => {
      const s = run(
        [
          { type: 'load_start', token: 2, parentSessionId: P },
          turn('thinking', 'B'),
          turn('stream', 'B', { content: 'B so far' }),
          { type: 'load_result', token: 2, sidebarId: 'B', seq: 2, running: false },
        ],
        withA(),
      );
      expect(view(s).sidebarId).toBe('B');
      expect(view(s).busy).toBe(true);
      expect(view(s).streamingContent).toBe('B so far');
    });

    it('held events replay when the SideBar is adopted from an open response', () => {
      const s = run(
        [
          { type: 'op_start', opId: 1, op: 'fresh' },
          turn('thinking', 'B'),
          { type: 'op_opened', opId: 1, sidebarId: 'B', seq: 2, closedIds: ['A'] },
        ],
        withA(),
      );
      expect(view(s).sidebarId).toBe('B');
      expect(view(s).busy).toBe(true);
    });

    it('events for the current SideBar are not held', () => {
      const s = run([turn('stream', 'A', { content: 'live' })], withA());
      expect(s.buffered).toEqual([]);
      expect(view(s).streamingContent).toBe('live');
    });

    it('closing a SideBar purges what was held for it and nothing else is held for it', () => {
      const s = run([turn('thinking', 'B'), closed('B'), turn('stream', 'B')], withA());
      expect(s.buffered).toEqual([]);
      expect(view(s).sidebarId).toBe('A');
    });
  });

  describe('optimistic questions always settle', () => {
    const undelivered = () =>
      run(
        [
          { type: 'ask_local', questionId: 'q1', content: 'lost in transit?' },
          // Disconnected before the server received the frame; reconnect.
          { type: 'load_start', token: 2, parentSessionId: P },
          { type: 'load_result', token: 2, sidebarId: 'sb', seq: 1, running: false },
          {
            type: 'history',
            token: 2,
            sidebarId: 'sb',
            messages: [{ id: 'a0', role: 'assistant', content: 'earlier answer' }],
          },
        ],
        loaded('sb'),
      );

    it('a question the resync proves undelivered is marked failed, not left busy', () => {
      const s = undelivered();
      expect(view(s).busy).toBe(false);
      expect(canAskSidebar(s)).toBe(true);
      expect(view(s).messages).toEqual([
        { id: 'a0', role: 'assistant', content: 'earlier answer' },
        { id: 'q1', role: 'user', content: 'lost in transit?', pending: false, failed: true },
      ]);
    });

    it('a late echo of an undelivered question replaces it', () => {
      const s = run(
        [
          turn('message', 'sb', {
            message: { id: 'u9', session_id: 'sb', role: 'user', content: 'lost in transit?' },
          }),
        ],
        undelivered(),
      );
      expect(view(s).messages.map((m) => m.id)).toEqual(['a0', 'u9']);
      expect(view(s).messages.some((m) => m.failed)).toBe(false);
    });

    it('an undelivered question survives the SideBar being replaced elsewhere', () => {
      const s = run([closed('sb'), opened('B', 2)], undelivered());
      expect(view(s).sidebarId).toBe('B');
      expect(view(s).messages).toEqual([
        { id: 'q1', role: 'user', content: 'lost in transit?', pending: false, failed: true },
      ]);
      expect(canAskSidebar(s)).toBe(true);
    });

    it('an in-flight question survives a resync that finds a different SideBar', () => {
      const s = run(
        [
          { type: 'ask_local', questionId: 'q5', content: 'mid-air?' },
          { type: 'load_start', token: 2, parentSessionId: P },
          { type: 'load_result', token: 2, sidebarId: 'B', seq: 2, running: false },
          { type: 'history', token: 2, sidebarId: 'B', messages: [] },
        ],
        loaded('sb'),
      );
      expect(view(s).sidebarId).toBe('B');
      expect(view(s).messages).toEqual([
        { id: 'q5', role: 'user', content: 'mid-air?', pending: false, failed: true },
      ]);
      expect(view(s).busy).toBe(false);
    });

    it("this tab's own New still starts clean", () => {
      const s = run(
        [
          { type: 'op_start', opId: 1, op: 'fresh' },
          { type: 'op_opened', opId: 1, sidebarId: 'B', seq: 2, closedIds: ['sb'] },
        ],
        undelivered(),
      );
      expect(view(s).sidebarId).toBe('B');
      expect(view(s).messages).toEqual([]);
    });

    it('Retry re-sends the undelivered question in place', () => {
      const retrying = run([{ type: 'question_retry', questionId: 'q1' }], undelivered());
      expect(view(retrying).messages.find((m) => m.id === 'q1')).toMatchObject({
        pending: true,
        failed: false,
        content: 'lost in transit?',
      });
      expect(view(retrying).busy).toBe(true);
    });

    it('a Retry whose send fails keeps the question, still undelivered', () => {
      const s = run(
        [
          { type: 'question_retry', questionId: 'q1' },
          { type: 'ask_failed', questionId: 'q1', error: 'Not connected. Try again.' },
        ],
        undelivered(),
      );
      const q = view(s).messages.filter((m) => m.content === 'lost in transit?');
      expect(q).toHaveLength(1);
      expect(q[0]).toMatchObject({ id: 'q1', failed: true, pending: false });
      expect(view(s).busy).toBe(false);
      expect(canAskSidebar(s)).toBe(true);
    });

    it('a first send that fails keeps the question as undelivered', () => {
      const s = run(
        [
          { type: 'ask_local', questionId: 'q2', content: 'hello?' },
          { type: 'ask_failed', questionId: 'q2', error: 'Not connected. Try again.' },
        ],
        loaded('sb'),
      );
      expect(view(s).messages).toEqual([
        { id: 'q2', role: 'user', content: 'hello?', pending: false, failed: true },
      ]);
      expect(canAskSidebar(s)).toBe(true);
    });

    it('an undelivered question that actually arrived folds into the persisted row', () => {
      const s = run(
        [
          { type: 'load_start', token: 3, parentSessionId: P },
          { type: 'load_result', token: 3, sidebarId: 'sb', seq: 1, running: false },
          {
            type: 'history',
            token: 3,
            sidebarId: 'sb',
            messages: [
              { id: 'a0', role: 'assistant', content: 'earlier answer' },
              { id: 'u7', role: 'user', content: 'lost in transit?' },
            ],
          },
        ],
        undelivered(),
      );
      expect(view(s).messages.map((m) => m.id)).toEqual(['a0', 'u7']);
    });
  });

  describe('operations', () => {
    it('a failed discard keeps the SideBar, its conversation, and its events', () => {
      const withAnswer = run(
        [turn('done', 'sb', { message: { id: 'a1', role: 'assistant', content: 'kept' } })],
        loaded('sb'),
      );
      const s = run(
        [
          { type: 'op_start', opId: 1, op: 'discard' },
          { type: 'op_failed', opId: 1, error: 'Could not discard' },
          turn('stream', 'sb', { content: 'still live' }),
        ],
        withAnswer,
      );
      expect(view(s).sidebarId).toBe('sb');
      expect(view(s).messages.map((m) => m.content)).toEqual(['kept']);
      expect(view(s).error).toBe('Could not discard');
      expect(view(s).streamingContent).toBe('still live');
      expect(s.pendingOp).toBeNull();
    });

    it('a confirmed discard clears the SideBar', () => {
      const s = run(
        [
          { type: 'op_start', opId: 1, op: 'discard' },
          { type: 'op_discarded', opId: 1, closedIds: ['sb'] },
        ],
        loaded('sb'),
      );
      expect(view(s).sidebarId).toBeNull();
      expect(view(s).messages).toEqual([]);
    });

    it('a failed New keeps the current SideBar', () => {
      const s = run(
        [
          { type: 'op_start', opId: 1, op: 'fresh' },
          { type: 'op_failed', opId: 1, error: 'nope' },
        ],
        loaded('sb'),
      );
      expect(view(s).sidebarId).toBe('sb');
      expect(view(s).error).toBe('nope');
    });

    it('a confirmed New adopts the new SideBar with a clean conversation', () => {
      const s = run(
        [
          turn('done', 'sb', { message: { id: 'a1', role: 'assistant', content: 'old' } }),
          { type: 'op_start', opId: 1, op: 'fresh' },
          { type: 'op_opened', opId: 1, sidebarId: 'sb2', seq: 2, closedIds: ['sb'] },
        ],
        loaded('sb'),
      );
      expect(view(s).sidebarId).toBe('sb2');
      expect(view(s).messages).toEqual([]);
    });

    it('opening with a first question keeps it; a failed open keeps it undelivered', () => {
      const asking = run(
        [
          { type: 'ask_local', questionId: 'q1', content: 'first?' },
          { type: 'op_start', opId: 1, op: 'open', questionId: 'q1' },
        ],
        loaded(null),
      );
      const ok = run(
        [opened('sb', 1), { type: 'op_opened', opId: 1, sidebarId: 'sb', seq: 1 }],
        asking,
      );
      expect(view(ok).sidebarId).toBe('sb');
      expect(view(ok).messages.map((m) => m.content)).toEqual(['first?']);
      const failed = run([{ type: 'op_failed', opId: 1, error: 'boom' }], asking);
      expect(view(failed).messages).toEqual([
        { id: 'q1', role: 'user', content: 'first?', pending: false, failed: true },
      ]);
      expect(view(failed).busy).toBe(false);
      expect(view(failed).sidebarId).toBeNull();
      expect(canAskSidebar(failed)).toBe(true);
    });

    it('ignores a result for an operation that is not the pending one', () => {
      const s = run(
        [
          { type: 'op_start', opId: 1, op: 'discard' },
          { type: 'op_discarded', opId: 7, closedIds: ['sb'] },
        ],
        loaded('sb'),
      );
      expect(view(s).sidebarId).toBe('sb');
      expect(s.pendingOp?.opId).toBe(1);
    });

    it('an op in flight across a reconnect resync still settles', () => {
      const s = run(
        [
          { type: 'op_start', opId: 1, op: 'discard' },
          { type: 'load_start', token: 2, parentSessionId: P },
          { type: 'op_discarded', opId: 1, closedIds: ['sb'] },
        ],
        loaded('sb'),
      );
      expect(s.pendingOp).toBeNull();
      expect(view(s).sidebarId).toBeNull();
    });
  });

  describe('a confirmed question is never resurrected', () => {
    const openedAndEchoed = () =>
      run(
        [
          { type: 'ask_local', questionId: 'q1', content: 'first?' },
          { type: 'op_start', opId: 1, op: 'open', questionId: 'q1' },
          opened('B', 1),
          turn('message', 'B', {
            message: { id: 'u1', session_id: 'B', role: 'user', content: 'first?' },
          }),
        ],
        loaded(null),
      );

    it('an echo before the POST rejection keeps the question delivered', () => {
      const s = run([{ type: 'op_failed', opId: 1, error: 'response lost' }], openedAndEchoed());
      expect(view(s).sidebarId).toBe('B');
      expect(view(s).messages).toEqual([{ id: 'u1', role: 'user', content: 'first?' }]);
      expect(view(s).messages.some((m) => m.failed)).toBe(false);
      expect(view(s).error).toBeNull();
      expect(s.pendingOp).toBeNull();
      expect(s.questions).toEqual({});
    });

    it('an echo before a superseded open response does not re-add it', () => {
      const s = run(
        [
          closed('B'),
          opened('C', 2),
          { type: 'op_opened', opId: 1, sidebarId: 'B', seq: 1, closedIds: [] },
        ],
        openedAndEchoed(),
      );
      expect(view(s).sidebarId).toBe('C');
      expect(view(s).messages).toEqual([]);
      expect(view(s).error).toBeNull();
    });

    it('a question confirmed only by history is not demoted by a late failure', () => {
      const s = run(
        [
          { type: 'ask_local', questionId: 'q1', content: 'first?' },
          { type: 'op_start', opId: 1, op: 'open', questionId: 'q1' },
          // Reconnect resync finds the SideBar the POST created, with the question.
          { type: 'load_start', token: 2, parentSessionId: P },
          { type: 'load_result', token: 2, sidebarId: 'B', seq: 1, running: true },
          {
            type: 'history',
            token: 2,
            sidebarId: 'B',
            messages: [{ id: 'u1', role: 'user', content: 'first?' }],
          },
          { type: 'op_failed', opId: 1, error: 'response lost' },
        ],
        loaded(null),
      );
      expect(view(s).messages).toEqual([{ id: 'u1', role: 'user', content: 'first?' }]);
      expect(view(s).error).toBeNull();
    });

    it('a late ask_failed after the echo is ignored', () => {
      const s = run(
        [
          { type: 'ask_local', questionId: 'q2', content: 'second?' },
          turn('message', 'sb', {
            message: { id: 'u2', session_id: 'sb', role: 'user', content: 'second?' },
          }),
          { type: 'ask_failed', questionId: 'q2', error: 'Not connected. Try again.' },
        ],
        loaded('sb'),
      );
      expect(view(s).messages).toEqual([{ id: 'u2', role: 'user', content: 'second?' }]);
    });

    it('Retry is refused for a question that is not undelivered', () => {
      const s = run(
        [{ type: 'question_retry', questionId: 'q1' }],
        run([{ type: 'op_failed', opId: 1, error: 'x' }], openedAndEchoed()),
      );
      expect(view(s).busy).toBe(false);
      expect(view(s).messages).toEqual([{ id: 'u1', role: 'user', content: 'first?' }]);
    });
  });

  describe('discard clears what the user sees', () => {
    const failedFirstOpen = () =>
      run(
        [
          { type: 'ask_local', questionId: 'q1', content: 'first?' },
          { type: 'op_start', opId: 1, op: 'open', questionId: 'q1' },
          { type: 'op_failed', opId: 1, error: 'server down' },
        ],
        loaded(null),
      );

    it('a failed first open is cleared by a successful Discard with no closed ids', () => {
      const before = failedFirstOpen();
      expect(view(before).messages).toHaveLength(1);
      expect(view(before).error).toBe('server down');
      const s = run(
        [
          { type: 'op_start', opId: 2, op: 'discard' },
          { type: 'op_discarded', opId: 2, closedIds: [] },
        ],
        before,
      );
      expect(view(s).sidebarId).toBeNull();
      expect(view(s).messages).toEqual([]);
      expect(view(s).error).toBeNull();
      expect(s.pendingOp).toBeNull();
      expect(canAskSidebar(s)).toBe(true);
    });

    it('a SideBar adopted during the Discard request is left alone', () => {
      const s = run(
        [
          { type: 'op_start', opId: 2, op: 'discard' },
          opened('C', 2),
          turn('thinking', 'C'),
          { type: 'op_discarded', opId: 2, closedIds: [] },
        ],
        failedFirstOpen(),
      );
      expect(view(s).sidebarId).toBe('C');
      expect(view(s).busy).toBe(true);
    });

    it('a failed Discard of a draft keeps its question', () => {
      const s = run(
        [
          { type: 'op_start', opId: 2, op: 'discard' },
          { type: 'op_failed', opId: 2, error: 'offline' },
        ],
        failedFirstOpen(),
      );
      expect(view(s).messages.map((m) => m.content)).toEqual(['first?']);
      expect(view(s).error).toBe('offline');
    });

    it('our own close event before the response still ends empty, with no carry-over', () => {
      const asked = run(
        [
          { type: 'ask_local', questionId: 'q9', content: 'unsent' },
          { type: 'ask_failed', questionId: 'q9', error: 'x' },
        ],
        loaded('sb'),
      );
      const s = run(
        [
          { type: 'op_start', opId: 3, op: 'discard' },
          closed('sb'),
          { type: 'op_discarded', opId: 3, closedIds: ['sb'] },
        ],
        asked,
      );
      expect(view(s).sidebarId).toBeNull();
      expect(view(s).messages).toEqual([]);
      expect(view(s).error).toBeNull();
    });
  });

  describe('lifecycle facts are order-independent', () => {
    const loadedA = () => loaded('A', false, 1);

    it('a late DELETE response does not clear a replacement opened elsewhere', () => {
      const s = run(
        [
          { type: 'op_start', opId: 1, op: 'discard' },
          closed('A'),
          opened('C', 2),
          { type: 'op_discarded', opId: 1, closedIds: ['A'] },
        ],
        loadedA(),
      );
      expect(view(s).sidebarId).toBe('C');
      expect(s.pendingOp).toBeNull();
    });

    it('a DELETE response before the events ends on the replacement too', () => {
      const s = run(
        [
          { type: 'op_start', opId: 1, op: 'discard' },
          { type: 'op_discarded', opId: 1, closedIds: ['A'] },
          closed('A'),
          opened('C', 2),
        ],
        loadedA(),
      );
      expect(view(s).sidebarId).toBe('C');
    });

    it('a late POST response cannot re-adopt a SideBar already archived elsewhere', () => {
      const s = run(
        [
          { type: 'op_start', opId: 1, op: 'fresh' },
          closed('A'),
          opened('B', 2),
          closed('B'),
          opened('C', 3),
          { type: 'op_opened', opId: 1, sidebarId: 'B', seq: 2, closedIds: ['A'] },
        ],
        loadedA(),
      );
      expect(view(s).sidebarId).toBe('C');
      expect(s.pendingOp).toBeNull();
    });

    it('a POST response before the events still ends on the newest SideBar', () => {
      const s = run(
        [
          { type: 'op_start', opId: 1, op: 'fresh' },
          { type: 'op_opened', opId: 1, sidebarId: 'B', seq: 2, closedIds: ['A'] },
          closed('A'),
          opened('B', 2),
          closed('B'),
          opened('C', 3),
        ],
        loadedA(),
      );
      expect(view(s).sidebarId).toBe('C');
    });

    it('an older open never replaces a newer one, in either order', () => {
      expect(view(run([opened('C', 3), opened('B', 2)], loadedA())).sidebarId).toBe('C');
      expect(view(run([opened('B', 2), opened('C', 3)], loadedA())).sidebarId).toBe('C');
    });

    it("a stale open response leaves the running replacement's turn alone", () => {
      const s = run(
        [
          { type: 'ask_local', questionId: 'q1', content: 'first?' },
          { type: 'op_start', opId: 1, op: 'open', questionId: 'q1' },
          closed('B'),
          opened('C', 3),
          turn('thinking', 'C'),
          turn('stream', 'C', { content: 'C is working' }),
          { type: 'op_opened', opId: 1, sidebarId: 'B', seq: 2, closedIds: [] },
        ],
        loaded(null),
      );
      expect(view(s).sidebarId).toBe('C');
      expect(view(s).busy).toBe(true);
      expect(view(s).streamingContent).toBe('C is working');
      // The question never ran: kept, undelivered, for a retry on C.
      expect(view(s).messages.find((m) => m.id === 'q1')).toMatchObject({ failed: true });
      expect(view(s).error).toBe(SIDEBAR_REPLACED_ERROR);
      expect(canAskSidebar(s)).toBe(false);
    });

    it('a superseded first question survives even when its draft was replaced', () => {
      const s = run(
        [
          { type: 'ask_local', questionId: 'q1', content: 'first?' },
          { type: 'op_start', opId: 1, op: 'open', questionId: 'q1' },
          opened('X', 2),
          closed('X'),
          opened('C', 3),
          { type: 'op_opened', opId: 1, sidebarId: 'B', seq: 1, closedIds: [] },
        ],
        loaded(null),
      );
      expect(view(s).sidebarId).toBe('C');
      expect(view(s).messages).toEqual([
        { id: 'q1', role: 'user', content: 'first?', pending: false, failed: true },
      ]);
    });

    it('a superseded first question is kept for retry when the replacement is idle', () => {
      const s = run(
        [
          { type: 'ask_local', questionId: 'q1', content: 'first?' },
          { type: 'op_start', opId: 1, op: 'open', questionId: 'q1' },
          opened('C', 2),
          { type: 'op_opened', opId: 1, sidebarId: 'B', seq: 1, closedIds: [] },
        ],
        loaded(null),
      );
      expect(view(s).sidebarId).toBe('C');
      expect(view(s).messages.some((m) => m.pending)).toBe(false);
      expect(view(s).messages.find((m) => m.id === 'q1')).toMatchObject({ failed: true });
      expect(view(s).busy).toBe(false);
      expect(canAskSidebar(s)).toBe(true);
      expect(view(s).error).toBe(SIDEBAR_REPLACED_ERROR);
    });
  });
});
