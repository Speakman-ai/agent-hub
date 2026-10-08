import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import SessionSideBarPane from './SessionSideBarPane';
import { SIDEBAR_WS_EVENT } from '@shared/utils/sessionSidebar';
import { sidebarStore } from '@shared/utils/sessionSidebarStore';

vi.mock('../utils/api', () => ({
  api: {
    getSessionSidebar: vi.fn(),
    getMessages: vi.fn(() => Promise.resolve([])),
    openSessionSidebar: vi.fn(),
    closeSessionSidebar: vi.fn(() => Promise.resolve({ ok: true, closedSessionIds: [] })),
  },
}));

import { api } from '../utils/api';

function renderPane(send = vi.fn(), onSidebarSessionChange = vi.fn()) {
  render(
    <SessionSideBarPane
      parentSessionId="main-1"
      agentId="agent-1"
      agentName="Dev"
      connected
      send={send}
      onSidebarSessionChange={onSidebarSessionChange}
      onClose={vi.fn()}
    />,
  );
  return { send, onSidebarSessionChange };
}

function ws(detail: Record<string, unknown>) {
  act(() => {
    window.dispatchEvent(new CustomEvent(SIDEBAR_WS_EVENT, { detail }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  sidebarStore.clear();
});

describe('SessionSideBarPane', () => {
  it('opens the fork with the first question when no SideBar exists', async () => {
    vi.mocked(api.getSessionSidebar).mockResolvedValue({ session: null });
    vi.mocked(api.openSessionSidebar).mockResolvedValue({
      session: { id: 'sb-1' } as never,
      forked: true,
      closedSessionIds: [],
    });
    const { send, onSidebarSessionChange } = renderPane();
    await waitFor(() => expect(screen.getByText(/Ask Dev anything/)).toBeTruthy());

    fireEvent.change(screen.getByTestId('sidebar-input'), { target: { value: 'what is X?' } });
    fireEvent.keyDown(screen.getByTestId('sidebar-input'), { key: 'Enter' });

    await waitFor(() =>
      expect(api.openSessionSidebar).toHaveBeenCalledWith('main-1', 'what is X?'),
    );
    expect(send).not.toHaveBeenCalled();
    await waitFor(() => expect(onSidebarSessionChange).toHaveBeenLastCalledWith('main-1', 'sb-1'));
    expect(screen.getByText('what is X?')).toBeTruthy();
  });

  it('sends follow-ups over the WebSocket and renders the streamed answer', async () => {
    vi.mocked(api.getSessionSidebar).mockResolvedValue({ session: { id: 'sb-2' } as never });
    vi.mocked(api.getMessages).mockResolvedValue([
      { id: 'm1', role: 'user', content: 'earlier q' },
      { id: 'm2', role: 'assistant', content: 'earlier a' },
    ] as never);
    const { send } = renderPane();
    await waitFor(() => expect(screen.getByText('earlier a')).toBeTruthy());

    fireEvent.change(screen.getByTestId('sidebar-input'), { target: { value: 'and Y?' } });
    fireEvent.click(screen.getByTestId('sidebar-send'));
    expect(send).toHaveBeenCalledWith({
      type: 'chat',
      agentId: 'agent-1',
      sessionId: 'sb-2',
      content: 'and Y?',
    });
    expect(api.openSessionSidebar).not.toHaveBeenCalled();

    ws({ type: 'stream', sessionId: 'sb-2', content: 'Y is streaming' });
    expect(screen.getByText('Y is streaming')).toBeTruthy();
    ws({
      type: 'done',
      sessionId: 'sb-2',
      message: { id: 'm4', role: 'assistant', content: 'Y is done' },
    });
    expect(screen.getByText('Y is done')).toBeTruthy();
    expect(screen.getByTestId('sidebar-send')).toBeTruthy();
  });

  it('ignores stream events from the main session', async () => {
    vi.mocked(api.getSessionSidebar).mockResolvedValue({ session: { id: 'sb-3' } as never });
    renderPane();
    await waitFor(() => expect(api.getMessages).toHaveBeenCalled());
    ws({ type: 'stream', sessionId: 'main-1', content: 'main chat text' });
    expect(screen.queryByText('main chat text')).toBeNull();
  });

  it('New re-forks the session and clears the conversation', async () => {
    vi.mocked(api.getSessionSidebar).mockResolvedValue({ session: { id: 'sb-4' } as never });
    vi.mocked(api.getMessages).mockResolvedValue([
      { id: 'm1', role: 'assistant', content: 'old answer' },
    ] as never);
    vi.mocked(api.openSessionSidebar).mockResolvedValue({
      session: { id: 'sb-5' } as never,
      forked: true,
      closedSessionIds: ['sb-4'],
    });
    const { onSidebarSessionChange } = renderPane();
    await waitFor(() => expect(screen.getByText('old answer')).toBeTruthy());
    fireEvent.click(screen.getByTestId('sidebar-new'));
    await waitFor(() => expect(screen.queryByText('old answer')).toBeNull());
    expect(api.openSessionSidebar).toHaveBeenCalledWith('main-1', undefined);
    expect(onSidebarSessionChange).toHaveBeenLastCalledWith('main-1', 'sb-5');
  });

  it('does not open a replacement SideBar while the lookup is still pending', async () => {
    let resolveLookup: (v: { session: { id: string }; running: boolean }) => void = () => {};
    vi.mocked(api.getSessionSidebar).mockReturnValue(
      new Promise((r) => {
        resolveLookup = r;
      }) as never,
    );
    const { send } = renderPane();
    const input = screen.getByTestId('sidebar-input') as HTMLTextAreaElement;
    expect(input.disabled).toBe(true);
    fireEvent.change(input, { target: { value: 'too early' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.click(screen.getByTestId('sidebar-send'));
    expect(api.openSessionSidebar).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();

    await act(async () => {
      resolveLookup({ session: { id: 'sb-live' }, running: false });
    });
    await waitFor(() => expect(input.disabled).toBe(false));
    fireEvent.change(input, { target: { value: 'now' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'sb-live' }));
    expect(api.openSessionSidebar).not.toHaveBeenCalled();
  });

  it('stays blocked after a failed lookup until Retry succeeds', async () => {
    vi.mocked(api.getSessionSidebar)
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce({ session: { id: 'sb-r' } as never, running: false });
    const { send } = renderPane();
    await waitFor(() => expect(screen.getByTestId('sidebar-load-error')).toBeTruthy());
    const input = screen.getByTestId('sidebar-input') as HTMLTextAreaElement;
    expect(input.disabled).toBe(true);
    fireEvent.click(screen.getByTestId('sidebar-send'));
    expect(api.openSessionSidebar).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('sidebar-retry'));
    await waitFor(() => expect(input.disabled).toBe(false));
    fireEvent.change(input, { target: { value: 'q' } });
    fireEvent.click(screen.getByTestId('sidebar-send'));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'sb-r' }));
    expect(api.openSessionSidebar).not.toHaveBeenCalled();
  });

  it('shows a turn that is still running after a reload', async () => {
    vi.mocked(api.getSessionSidebar).mockResolvedValue({
      session: { id: 'sb-run' } as never,
      running: true,
    });
    renderPane();
    await waitFor(() => expect(screen.getByTestId('sidebar-stop')).toBeTruthy());
    ws({ type: 'stream', sessionId: 'sb-run', sidebarParentId: 'main-1', content: 'still going' });
    expect(screen.getByText('still going')).toBeTruthy();
  });

  it('a done during a slow history load is not undone by the running snapshot', async () => {
    vi.mocked(api.getSessionSidebar).mockResolvedValue({
      session: { id: 'sb-race' } as never,
      running: true,
    });
    let resolveHistory: (v: unknown) => void = () => {};
    vi.mocked(api.getMessages).mockReturnValue(
      new Promise((r) => {
        resolveHistory = r;
      }) as never,
    );
    renderPane();
    await waitFor(() => expect(api.getMessages).toHaveBeenCalledWith('sb-race'));
    ws({
      type: 'done',
      sessionId: 'sb-race',
      sidebarParentId: 'main-1',
      message: { id: 'a2', role: 'assistant', content: 'final answer' },
    });
    await act(async () => {
      resolveHistory([{ id: 'u1', role: 'user', content: 'earlier question' }]);
    });
    await waitFor(() => expect(screen.getByText('earlier question')).toBeTruthy());
    expect(screen.getByText('final answer')).toBeTruthy();
    expect(screen.queryByTestId('sidebar-stop')).toBeNull();
    expect((screen.getByTestId('sidebar-input') as HTMLTextAreaElement).disabled).toBe(false);
    expect((screen.getByTestId('sidebar-new') as HTMLButtonElement).disabled).toBe(false);
  });

  it('a rejected discard keeps the SideBar and its conversation', async () => {
    vi.mocked(api.getSessionSidebar).mockResolvedValue({ session: { id: 'sb-keep' } as never });
    vi.mocked(api.getMessages).mockResolvedValue([
      { id: 'm1', role: 'assistant', content: 'keep me' },
    ] as never);
    vi.mocked(api.closeSessionSidebar)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ ok: true, closedSessionIds: ['sb-keep'] });
    const { send, onSidebarSessionChange } = renderPane();
    await waitFor(() => expect(screen.getByText('keep me')).toBeTruthy());

    fireEvent.click(screen.getByTestId('sidebar-discard'));
    await waitFor(() => expect(screen.getByTestId('sidebar-error').textContent).toMatch(/offline/));
    expect(screen.getByText('keep me')).toBeTruthy();
    expect(onSidebarSessionChange).not.toHaveBeenLastCalledWith('main-1', null);
    // Still bound to the live SideBar: its events render, follow-ups go to it.
    ws({ type: 'stream', sessionId: 'sb-keep', sidebarParentId: 'main-1', content: 'still live' });
    expect(screen.getByText('still live')).toBeTruthy();
    ws({ type: 'done', sessionId: 'sb-keep', sidebarParentId: 'main-1' });
    fireEvent.change(screen.getByTestId('sidebar-input'), { target: { value: 'next' } });
    fireEvent.click(screen.getByTestId('sidebar-send'));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'sb-keep' }));
    ws({ type: 'done', sessionId: 'sb-keep', sidebarParentId: 'main-1' });

    // Retrying the discard succeeds and only then clears the panel.
    fireEvent.click(screen.getByTestId('sidebar-discard'));
    await waitFor(() => expect(screen.queryByText('keep me')).toBeNull());
    expect(onSidebarSessionChange).toHaveBeenLastCalledWith('main-1', null);
  });

  it('keeps the question, retryable, when opening the SideBar fails', async () => {
    vi.mocked(api.getSessionSidebar).mockResolvedValue({ session: null });
    vi.mocked(api.openSessionSidebar)
      .mockRejectedValueOnce(new Error('server down'))
      .mockResolvedValueOnce({
        session: { id: 'sb-ok', sidebar_seq: 1 } as never,
        forked: true,
        closedSessionIds: [],
      });
    renderPane();
    const input = screen.getByTestId('sidebar-input') as HTMLTextAreaElement;
    await waitFor(() => expect(input.disabled).toBe(false));
    fireEvent.change(input, { target: { value: 'lost?' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() =>
      expect(screen.getByTestId('sidebar-error').textContent).toMatch(/server down/),
    );
    expect(screen.getAllByText('lost?')).toHaveLength(1);
    expect(screen.getByTestId('sidebar-undelivered')).toBeTruthy();
    fireEvent.click(screen.getByTestId('sidebar-retry-question'));
    await waitFor(() => expect(api.openSessionSidebar).toHaveBeenLastCalledWith('main-1', 'lost?'));
    await waitFor(() => expect(screen.queryByTestId('sidebar-undelivered')).toBeNull());
    expect(screen.getAllByText('lost?')).toHaveLength(1);
  });

  it('reconciles a turn that finished while the socket was down', async () => {
    vi.mocked(api.getSessionSidebar)
      .mockResolvedValueOnce({ session: { id: 'sb-off' } as never, running: false })
      .mockResolvedValueOnce({ session: { id: 'sb-off' } as never, running: false });
    vi.mocked(api.getMessages)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: 'u1', role: 'user', content: 'asked before the drop' },
        { id: 'a1', role: 'assistant', content: 'answered while offline' },
      ] as never);
    const send = vi.fn();
    const props = {
      parentSessionId: 'main-1',
      agentId: 'agent-1',
      send,
      onSidebarSessionChange: vi.fn(),
      onClose: vi.fn(),
    };
    const { rerender } = render(<SessionSideBarPane {...props} connected />);
    const input = screen.getByTestId('sidebar-input') as HTMLTextAreaElement;
    await waitFor(() => expect(input.disabled).toBe(false));
    fireEvent.change(input, { target: { value: 'asked before the drop' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    ws({ type: 'thinking', sessionId: 'sb-off', sidebarParentId: 'main-1' });
    expect(screen.getByTestId('sidebar-stop')).toBeTruthy();

    // Socket drops; the turn's done event is never delivered.
    rerender(<SessionSideBarPane {...props} connected={false} />);
    rerender(<SessionSideBarPane {...props} connected />);

    await waitFor(() => expect(screen.getByText('answered while offline')).toBeTruthy());
    expect(api.getSessionSidebar).toHaveBeenCalledTimes(2);
    // The question's WS echo never arrived; it must show once, not faded.
    const question = screen.getAllByText('asked before the drop');
    expect(question).toHaveLength(1);
    expect(question[0]!.className).not.toContain('opacity-70');
    expect(screen.queryByTestId('sidebar-stop')).toBeNull();
    expect(input.disabled).toBe(false);
    expect((screen.getByTestId('sidebar-new') as HTMLButtonElement).disabled).toBe(false);
  });

  it('an obsolete history failure does not disable the replacement SideBar', async () => {
    vi.mocked(api.getSessionSidebar).mockResolvedValue({
      session: { id: 'sb-A', sidebar_seq: 1 } as never,
      running: false,
    });
    let rejectHistory: (e: Error) => void = () => {};
    vi.mocked(api.getMessages).mockReturnValue(
      new Promise((_, rej) => {
        rejectHistory = rej;
      }) as never,
    );
    const { send } = renderPane();
    await waitFor(() => expect(api.getMessages).toHaveBeenCalledWith('sb-A'));
    ws({ type: 'sidebar_closed', sessionId: 'sb-A', sidebarParentId: 'main-1' });
    ws({
      type: 'sidebar_opened',
      sessionId: 'sb-B',
      parentSessionId: 'main-1',
      session: { id: 'sb-B', sidebar_seq: 2 },
    });
    await act(async () => {
      rejectHistory(new Error('network'));
    });
    expect(screen.queryByTestId('sidebar-load-error')).toBeNull();
    const input = screen.getByTestId('sidebar-input') as HTMLTextAreaElement;
    expect(input.disabled).toBe(false);
    fireEvent.change(input, { target: { value: 'to B' } });
    fireEvent.click(screen.getByTestId('sidebar-send'));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'sb-B' }));
  });

  it('a question lost during a disconnect becomes retryable after the resync', async () => {
    vi.mocked(api.getSessionSidebar).mockResolvedValue({
      session: { id: 'sb-lost', sidebar_seq: 1 } as never,
      running: false,
    });
    vi.mocked(api.getMessages).mockResolvedValue([]);
    const send = vi.fn();
    const props = {
      parentSessionId: 'main-1',
      agentId: 'agent-1',
      send,
      onSidebarSessionChange: vi.fn(),
      onClose: vi.fn(),
    };
    const { rerender } = render(<SessionSideBarPane {...props} connected />);
    const input = screen.getByTestId('sidebar-input') as HTMLTextAreaElement;
    await waitFor(() => expect(input.disabled).toBe(false));
    fireEvent.change(input, { target: { value: 'did this arrive?' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(send).toHaveBeenCalledTimes(1);

    // The frame never reached the server; reconnect and resync.
    rerender(<SessionSideBarPane {...props} connected={false} />);
    rerender(<SessionSideBarPane {...props} connected />);
    await waitFor(() => expect(screen.getByTestId('sidebar-undelivered')).toBeTruthy());
    expect(screen.getAllByText('did this arrive?')).toHaveLength(1);
    expect(screen.queryByTestId('sidebar-stop')).toBeNull();
    expect(input.disabled).toBe(false);

    fireEvent.click(screen.getByTestId('sidebar-retry-question'));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionId: 'sb-lost', content: 'did this arrive?' }),
    );
    expect(screen.queryByTestId('sidebar-undelivered')).toBeNull();
    expect(screen.getAllByText('did this arrive?')).toHaveLength(1);
  });

  it('a Retry that cannot send keeps the undelivered question', async () => {
    vi.mocked(api.getSessionSidebar).mockResolvedValue({
      session: { id: 'sb-r2', sidebar_seq: 1 } as never,
      running: false,
    });
    vi.mocked(api.getMessages).mockResolvedValue([]);
    const send = vi.fn(() => false);
    const props = {
      parentSessionId: 'main-1',
      agentId: 'agent-1',
      send,
      onSidebarSessionChange: vi.fn(),
      onClose: vi.fn(),
    };
    render(<SessionSideBarPane {...props} connected />);
    const input = screen.getByTestId('sidebar-input') as HTMLTextAreaElement;
    await waitFor(() => expect(input.disabled).toBe(false));
    fireEvent.change(input, { target: { value: 'only copy' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(screen.getByTestId('sidebar-undelivered')).toBeTruthy());

    // The socket is still not sending: Retry fails again.
    fireEvent.click(screen.getByTestId('sidebar-retry-question'));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(screen.getAllByText('only copy')).toHaveLength(1);
    expect(screen.getByTestId('sidebar-undelivered')).toBeTruthy();
    expect(screen.getByTestId('sidebar-retry-question')).toBeTruthy();
  });

  it('Discard clears a question whose first open failed', async () => {
    vi.mocked(api.getSessionSidebar).mockResolvedValue({ session: null });
    vi.mocked(api.openSessionSidebar).mockRejectedValueOnce(new Error('server down'));
    vi.mocked(api.closeSessionSidebar).mockResolvedValueOnce({ ok: true, closedSessionIds: [] });
    renderPane();
    const input = screen.getByTestId('sidebar-input') as HTMLTextAreaElement;
    await waitFor(() => expect(input.disabled).toBe(false));
    fireEvent.change(input, { target: { value: 'never opened' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(screen.getByTestId('sidebar-undelivered')).toBeTruthy());

    fireEvent.click(screen.getByTestId('sidebar-discard'));
    await waitFor(() => expect(screen.queryByText('never opened')).toBeNull());
    expect(api.closeSessionSidebar).toHaveBeenCalledWith('main-1');
    expect(screen.queryByTestId('sidebar-error')).toBeNull();
    expect(screen.queryByTestId('sidebar-discard')).toBeNull();
  });

  it('a lost POST response after the echo does not mark the question undelivered', async () => {
    vi.mocked(api.getSessionSidebar).mockResolvedValue({ session: null });
    let rejectOpen: (e: Error) => void = () => {};
    vi.mocked(api.openSessionSidebar).mockReturnValueOnce(
      new Promise((_, rej) => {
        rejectOpen = rej;
      }) as never,
    );
    renderPane();
    const input = screen.getByTestId('sidebar-input') as HTMLTextAreaElement;
    await waitFor(() => expect(input.disabled).toBe(false));
    fireEvent.change(input, { target: { value: 'got through?' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(api.openSessionSidebar).toHaveBeenCalled());
    ws({
      type: 'sidebar_opened',
      sessionId: 'sb-new',
      parentSessionId: 'main-1',
      session: { id: 'sb-new', sidebar_seq: 1 },
    });
    ws({
      type: 'message',
      sidebarParentId: 'main-1',
      message: { id: 'u1', session_id: 'sb-new', role: 'user', content: 'got through?' },
    });
    await act(async () => {
      rejectOpen(new Error('response lost'));
    });
    expect(screen.getAllByText('got through?')).toHaveLength(1);
    expect(screen.queryByTestId('sidebar-undelivered')).toBeNull();
    expect(screen.queryByTestId('sidebar-error')).toBeNull();
  });

  describe('state survives the pane unmounting', () => {
    const paneFor = (parentSessionId: string) => (
      <SessionSideBarPane
        key={parentSessionId}
        parentSessionId={parentSessionId}
        agentId="agent-1"
        connected
        send={vi.fn()}
        onSidebarSessionChange={vi.fn()}
        onClose={vi.fn()}
      />
    );

    async function failFirstSend(text: string) {
      vi.mocked(api.getSessionSidebar).mockResolvedValue({ session: null });
      vi.mocked(api.openSessionSidebar).mockRejectedValueOnce(new Error('server down'));
      const utils = render(paneFor('main-1'));
      const input = screen.getByTestId('sidebar-input') as HTMLTextAreaElement;
      await waitFor(() => expect(input.disabled).toBe(false));
      fireEvent.change(input, { target: { value: text } });
      fireEvent.keyDown(input, { key: 'Enter' });
      await waitFor(() => expect(screen.getByTestId('sidebar-undelivered')).toBeTruthy());
      return utils;
    }

    it('a failed first question is still retryable after hide and reopen', async () => {
      const { unmount } = await failFirstSend('keep me across hide');
      unmount(); // Hide
      render(paneFor('main-1')); // Reopen
      await waitFor(() => expect(screen.getByText('keep me across hide')).toBeTruthy());
      expect(screen.getByTestId('sidebar-undelivered')).toBeTruthy();
      vi.mocked(api.openSessionSidebar).mockResolvedValueOnce({
        session: { id: 'sb-ok', sidebar_seq: 1 } as never,
        forked: true,
        closedSessionIds: [],
      });
      await waitFor(() =>
        expect((screen.getByTestId('sidebar-retry-question') as HTMLButtonElement).disabled).toBe(
          false,
        ),
      );
      fireEvent.click(screen.getByTestId('sidebar-retry-question'));
      await waitFor(() =>
        expect(api.openSessionSidebar).toHaveBeenLastCalledWith('main-1', 'keep me across hide'),
      );
    });

    it('a failed first question survives switching sessions and back', async () => {
      const { rerender } = await failFirstSend('keep me across switch');
      rerender(paneFor('main-2'));
      await waitFor(() => expect(screen.queryByText('keep me across switch')).toBeNull());
      rerender(paneFor('main-1'));
      await waitFor(() => expect(screen.getByText('keep me across switch')).toBeTruthy());
      expect(screen.getByTestId('sidebar-undelivered')).toBeTruthy();
    });

    it('unsent composer text survives hide and stays per session', async () => {
      vi.mocked(api.getSessionSidebar).mockResolvedValue({ session: null });
      const { unmount, rerender } = render(paneFor('main-1'));
      const input = () => screen.getByTestId('sidebar-input') as HTMLTextAreaElement;
      await waitFor(() => expect(input().disabled).toBe(false));
      fireEvent.change(input(), { target: { value: 'half-typed thought' } });
      rerender(paneFor('main-2'));
      await waitFor(() => expect(input().value).toBe(''));
      rerender(paneFor('main-1'));
      await waitFor(() => expect(input().value).toBe('half-typed thought'));
      unmount();
      render(paneFor('main-1'));
      await waitFor(() => expect(input().value).toBe('half-typed thought'));
    });

    it('an open that completes while the pane is hidden is applied', async () => {
      vi.mocked(api.getSessionSidebar).mockResolvedValue({ session: null });
      let resolveOpen: (v: unknown) => void = () => {};
      vi.mocked(api.openSessionSidebar).mockReturnValueOnce(
        new Promise((res) => {
          resolveOpen = res;
        }) as never,
      );
      const { unmount } = render(paneFor('main-1'));
      const input = screen.getByTestId('sidebar-input') as HTMLTextAreaElement;
      await waitFor(() => expect(input.disabled).toBe(false));
      fireEvent.change(input, { target: { value: 'asked then hidden' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      await waitFor(() => expect(api.openSessionSidebar).toHaveBeenCalled());
      unmount();
      await act(async () => {
        resolveOpen({
          session: { id: 'sb-bg', sidebar_seq: 1 },
          forked: true,
          closedSessionIds: [],
        });
      });
      expect(sidebarStore.get('main-1').conv.id).toBe('sb-bg');
      expect(sidebarStore.get('main-1').pendingOp).toBeNull();
      vi.mocked(api.getSessionSidebar).mockResolvedValue({
        session: { id: 'sb-bg', sidebar_seq: 1 } as never,
        running: true,
      });
      vi.mocked(api.getMessages).mockResolvedValue([
        { id: 'u1', role: 'user', content: 'asked then hidden' },
      ] as never);
      render(paneFor('main-1'));
      await waitFor(() => expect(screen.getAllByText('asked then hidden')).toHaveLength(1));
      expect(screen.queryByTestId('sidebar-undelivered')).toBeNull();
    });
  });
});
