import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ExtractedForward } from '@shared/utils/extractForwardBlocks';
import { orchestrateLaunch, setOrchestrateSessionActive } from '../utils/orchestrateLaunchSettings';

const { dispatchSession, cancelOrchestrateAutoStart, getOrchestrateLaunch } = vi.hoisted(() => ({
  dispatchSession: vi.fn(),
  cancelOrchestrateAutoStart: vi.fn(),
  getOrchestrateLaunch: vi.fn(),
}));
vi.mock('../utils/api', () => ({
  api: { dispatchSession, cancelOrchestrateAutoStart, getOrchestrateLaunch },
}));

/** The server's settings for a chat, as its broadcast delivers them. */
function serverSettings(sessionId: string, mode: string, autoStart: boolean, revision = 1) {
  act(() => {
    orchestrateLaunch.handleEvent({
      type: 'orchestrate_launch_updated',
      sessionId,
      settings: { mode, autoStart, configured: true, revision },
    });
  });
}

/** The server started counting down this card, with `remainingMs` left. */
function serverCountdown(dispatchKey: string, remainingMs: number) {
  act(() => {
    orchestrateLaunch.handleEvent({
      type: 'orchestrate_auto_start_scheduled',
      sessionId: 'chat-1',
      dispatchKey,
      remainingMs,
    });
  });
}

const CARD_KEY = 'session-forward:chat-1:m-1:fwd-test:0';

const {
  default: SessionForwardCard,
  forwardStore,
  forwardDock,
  SessionForwardSlot,
  SessionForwardDock,
  SessionForwardDockContext,
} = await import('./SessionForwardCard');

const forward: ExtractedForward = {
  forwardId: 'fwd-test',
  projectId: 'app',
  agentId: 'ada',
  name: 'Fix login',
  summary: 'Repair the redirect.',
  prompt: 'Fix the login redirect and add a test.',
  mode: 'manual',
};

describe('SessionForwardCard', () => {
  beforeEach(() => {
    dispatchSession.mockReset();
    cancelOrchestrateAutoStart.mockReset().mockResolvedValue({});
    localStorage.clear();
    forwardStore.clear();
    forwardDock.clear();
    orchestrateLaunch.resetForTests();
    vi.useRealTimers();
  });

  it('dismisses without starting anything and stays dismissed on reload', async () => {
    const card = <SessionForwardCard forward={forward} sessionId="chat-1" messageId="m-1" />;
    const view = render(card);
    fireEvent.click(screen.getByTestId('session-forward-dismiss'));
    await waitFor(() => expect(screen.getByTestId('session-forward-dismissed')).toBeTruthy());
    // Auto start must not start a dismissed card later either.
    expect(cancelOrchestrateAutoStart).toHaveBeenCalledWith('chat-1', {
      messageId: 'm-1',
      forwardId: 'fwd-test',
      occurrence: 0,
    });
    expect(screen.queryByTestId('session-forward')).toBeNull();
    expect(dispatchSession).not.toHaveBeenCalled();
    view.unmount();
    forwardStore.clear();

    render(card);
    expect(screen.getByTestId('session-forward-dismissed')).toBeTruthy();
  });

  it('starts the session with the dropdown level and then offers to open it', async () => {
    dispatchSession.mockResolvedValue({
      sessionId: 'sess-1',
      agentId: 'ada',
      projectId: 'app',
      name: 'Fix login',
      skippedSkills: [],
      ref: '@[Fix login](session:sess-1)',
    });
    const onOpenSession = vi.fn();
    render(
      <SessionForwardCard
        forward={forward}
        agents={[{ id: 'ada', name: 'Ada' }]}
        onOpenSession={onOpenSession}
      />,
    );
    expect(screen.getByTestId('session-forward-summary').textContent).toContain(
      'Repair the redirect.',
    );
    expect(screen.getByText('For Ada')).toBeTruthy();
    fireEvent.change(screen.getByTestId('session-forward-mode'), { target: { value: 'merge' } });
    fireEvent.click(screen.getByTestId('session-forward'));
    await waitFor(() => expect(screen.getByTestId('session-forward-open')).toBeTruthy());
    expect(dispatchSession).toHaveBeenCalledWith('app', {
      prompt: forward.prompt,
      agentId: 'ada',
      name: 'Fix login',
      mode: 'merge',
    });
    fireEvent.click(screen.getByTestId('session-forward-open'));
    expect(onOpenSession).toHaveBeenCalledWith('ada', 'sess-1');
    expect(screen.queryByTestId('session-forward')).toBeNull();
  });

  it('shows the dispatch error and does not mark the card forwarded', async () => {
    dispatchSession.mockRejectedValue(new Error('Agent not found'));
    render(<SessionForwardCard forward={forward} />);
    fireEvent.click(screen.getByTestId('session-forward'));
    expect(await screen.findByTestId('session-forward-error')).toHaveTextContent('Agent not found');
    expect(screen.getByTestId('session-forward')).toBeTruthy();
  });

  it('keeps identical requests in different messages separate and restores each on reload', async () => {
    dispatchSession.mockResolvedValue({
      sessionId: 'sess-1',
      agentId: 'ada',
      projectId: 'app',
      name: 'Fix login',
      skippedSkills: [],
      ref: '',
    });
    const first = render(
      <SessionForwardCard
        forward={forward}
        sessionId="chat-1"
        messageId="m-1"
        onOpenSession={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId('session-forward'));
    await waitFor(() => expect(screen.getByTestId('session-forward-open')).toBeTruthy());
    first.unmount();

    // Same payload, later message: a fresh card that can start new work.
    const second = render(
      <SessionForwardCard
        forward={forward}
        sessionId="chat-1"
        messageId="m-2"
        onOpenSession={() => {}}
      />,
    );
    expect(screen.getByTestId('session-forward')).toBeTruthy();
    expect(screen.queryByTestId('session-forward-open')).toBeNull();
    second.unmount();

    // Same payload, another chat: also fresh.
    const third = render(
      <SessionForwardCard
        forward={forward}
        sessionId="chat-2"
        messageId="m-1"
        onOpenSession={() => {}}
      />,
    );
    expect(screen.getByTestId('session-forward')).toBeTruthy();
    third.unmount();

    // Reloading the original message restores its own result.
    render(
      <SessionForwardCard
        forward={forward}
        sessionId="chat-1"
        messageId="m-1"
        onOpenSession={() => {}}
      />,
    );
    expect(await screen.findByTestId('session-forward-open')).toBeTruthy();
    expect(screen.queryByTestId('session-forward')).toBeNull();
    expect(dispatchSession).toHaveBeenCalledTimes(1);
  });

  it('offers Consult only and dispatches it for a workflow project', async () => {
    dispatchSession.mockResolvedValue({
      sessionId: 'sess-wf',
      agentId: 'ops',
      projectId: 'ops',
      name: 'Triage',
      skippedSkills: [],
      ref: '',
    });
    render(
      <SessionForwardCard
        forward={{ ...forward, projectId: 'ops', agentId: 'ops', mode: 'push' }}
        projects={[{ id: 'ops', mode: 'workflow' }]}
        sessionId="hub-1"
        messageId="m-1"
      />,
    );
    const select = screen.getByTestId('session-forward-mode') as HTMLSelectElement;
    expect(Array.from(select.options).map((option) => option.value)).toEqual(['consult']);
    expect(select.value).toBe('consult');
    fireEvent.click(screen.getByTestId('session-forward'));
    await waitFor(() => expect(dispatchSession).toHaveBeenCalledTimes(1));
    expect(dispatchSession).toHaveBeenCalledWith(
      'ops',
      {
        prompt: forward.prompt,
        agentId: 'ops',
        name: 'Fix login',
        mode: 'consult',
        idempotencyKey: `session-forward:hub-1:m-1:${forward.forwardId}:0`,
      },
      { parentSessionId: 'hub-1' },
    );
  });

  it('keeps the ship levels for a dev project', () => {
    render(<SessionForwardCard forward={forward} projects={[{ id: 'app', mode: 'dev' }]} />);
    const select = screen.getByTestId('session-forward-mode') as HTMLSelectElement;
    expect(Array.from(select.options).map((option) => option.value)).toEqual([
      'manual',
      'review',
      'push',
      'merge',
    ]);
  });

  it('resets its claim when the same component is reused for another card', async () => {
    dispatchSession
      .mockResolvedValueOnce({
        sessionId: 'sess-a',
        agentId: 'ada',
        projectId: 'app',
        name: 'A',
        skippedSkills: [],
        ref: '',
      })
      .mockResolvedValueOnce({
        sessionId: 'sess-b',
        agentId: 'ada',
        projectId: 'app',
        name: 'B',
        skippedSkills: [],
        ref: '',
      });
    const next = { ...forward, forwardId: 'fwd-next', name: 'Add logout', prompt: 'Add logout.' };
    const view = render(
      <SessionForwardCard
        forward={forward}
        sessionId="chat-1"
        messageId="m-1"
        onOpenSession={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId('session-forward'));
    await waitFor(() => expect(screen.getByTestId('session-forward-open')).toBeTruthy());

    view.rerender(
      <SessionForwardCard
        forward={next}
        sessionId="chat-1"
        messageId="m-2"
        onOpenSession={() => {}}
      />,
    );
    const button = await screen.findByTestId('session-forward');
    expect(button).not.toBeDisabled();
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByTestId('session-forward-open')).toBeTruthy());
    expect(dispatchSession).toHaveBeenCalledTimes(2);
    expect(dispatchSession).toHaveBeenLastCalledWith(
      'app',
      expect.objectContaining({ prompt: 'Add logout.' }),
      { parentSessionId: 'chat-1' },
    );
  });

  it('does not show an in-flight dispatch result on the card that replaced it', async () => {
    let finish!: (value: unknown) => void;
    dispatchSession.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const next = { ...forward, forwardId: 'fwd-next', prompt: 'Add logout.' };
    const view = render(
      <SessionForwardCard
        forward={forward}
        sessionId="chat-1"
        messageId="m-1"
        onOpenSession={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId('session-forward'));
    expect(screen.getByTestId('session-forward')).toHaveTextContent('Starting…');

    view.rerender(
      <SessionForwardCard
        forward={next}
        sessionId="chat-1"
        messageId="m-2"
        onOpenSession={() => {}}
      />,
    );
    expect(screen.getByTestId('session-forward')).toHaveTextContent('Session forward');
    finish({
      sessionId: 'sess-a',
      agentId: 'ada',
      projectId: 'app',
      name: 'A',
      skippedSkills: [],
      ref: '',
    });
    await waitFor(() => expect(localStorage.length).toBe(1));
    expect(screen.queryByTestId('session-forward-open')).toBeNull();
    expect(screen.getByTestId('session-forward')).not.toBeDisabled();

    // The first card's own result was still saved for when it is shown again.
    view.rerender(
      <SessionForwardCard
        forward={forward}
        sessionId="chat-1"
        messageId="m-1"
        onOpenSession={() => {}}
      />,
    );
    expect(await screen.findByTestId('session-forward-open')).toBeTruthy();
  });

  it('starts one session when the card unmounts and remounts mid-dispatch', async () => {
    let finish!: (value: unknown) => void;
    dispatchSession.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const card = (
      <SessionForwardCard
        forward={forward}
        sessionId="chat-1"
        messageId="m-1"
        onOpenSession={() => {}}
      />
    );
    const first = render(card);
    fireEvent.click(screen.getByTestId('session-forward'));
    first.unmount();

    render(card);
    const button = screen.getByTestId('session-forward');
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent('Starting…');
    fireEvent.click(button);
    expect(dispatchSession).toHaveBeenCalledTimes(1);

    finish({
      sessionId: 'sess-1',
      agentId: 'ada',
      projectId: 'app',
      name: 'Fix login',
      skippedSkills: [],
      ref: '',
    });
    expect(await screen.findByTestId('session-forward-open')).toBeTruthy();
    expect(screen.queryByTestId('session-forward')).toBeNull();
    expect(dispatchSession).toHaveBeenCalledTimes(1);
  });

  describe('pinned to the end of the chat', () => {
    // The open card leaves its message and renders in the dock after every
    // later message; launching or dismissing it puts it back in its message.
    function chat(extra: string) {
      return (
        <SessionForwardDockContext.Provider value>
          <div data-testid="message-1">
            <SessionForwardSlot
              forward={forward}
              sessionId="chat-1"
              messageId="m-1"
              onOpenSession={() => {}}
            />
          </div>
          <div data-testid="message-2">{extra}</div>
          <SessionForwardDock chatSessionId="chat-1" onOpenSession={() => {}} />
        </SessionForwardDockContext.Provider>
      );
    }

    it('stays below later messages until dismissed, then returns to its message', async () => {
      render(chat('a later reply'));
      const dock = screen.getByTestId('session-forward-dock');
      expect(screen.getByTestId('message-1').childElementCount).toBe(0);
      expect(dock.querySelector('[data-testid="session-forward-card"]')).toBeTruthy();
      // The dock is after the later message in document order.
      expect(
        screen.getByTestId('message-2').compareDocumentPosition(dock) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();

      fireEvent.click(screen.getByTestId('session-forward-dismiss'));
      await waitFor(() => expect(screen.queryByTestId('session-forward-dock')).toBeNull());
      expect(
        screen.getByTestId('message-1').querySelector('[data-testid="session-forward-dismissed"]'),
      ).toBeTruthy();
    });

    it('leaves the dock once launched', async () => {
      dispatchSession.mockResolvedValue({
        sessionId: 'sess-1',
        agentId: 'ada',
        projectId: 'app',
        name: 'Fix login',
        skippedSkills: [],
        ref: '',
      });
      render(chat(''));
      fireEvent.click(screen.getByTestId('session-forward'));
      await waitFor(() => expect(screen.queryByTestId('session-forward-dock')).toBeNull());
      expect(
        screen.getByTestId('message-1').querySelector('[data-testid="session-forward-open"]'),
      ).toBeTruthy();
    });

    it('does not pin a card in a streaming message or a chat without a dock', () => {
      render(
        <>
          <SessionForwardDockContext.Provider value>
            <SessionForwardSlot forward={forward} sessionId="chat-1" messageId="m-1" streaming />
          </SessionForwardDockContext.Provider>
          <SessionForwardSlot forward={forward} sessionId="chat-1" messageId="m-2" />
        </>,
      );
      expect(screen.getAllByTestId('session-forward-card')).toHaveLength(2);
      expect(forwardDock.snapshot()).toHaveLength(0);
    });

    it('only shows the cards of the chat it belongs to', () => {
      forwardDock.pin({
        identity: 'other',
        chatSessionId: 'chat-2',
        messageId: 'm-9',
        forward,
        occurrence: 0,
      });
      render(<SessionForwardDock chatSessionId="chat-1" />);
      expect(screen.queryByTestId('session-forward-dock')).toBeNull();
    });
  });

  describe('server Auto start', () => {
    const props = {
      forward,
      sessionId: 'chat-1',
      messageId: 'm-1',
      projects: [{ id: 'app', mode: 'dev' }],
    };

    it("shows the server's time left at the chat's Default build and never starts it itself", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      setOrchestrateSessionActive('chat-1', true);
      serverSettings('chat-1', 'push', true);
      // The server began counting 20 seconds before the chat was opened.
      serverCountdown(CARD_KEY, 10_000);
      render(<SessionForwardCard {...props} />);
      expect(screen.getByTestId('session-forward-countdown').textContent).toBe(
        'Starting in 10s as Build and Push',
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(11_000);
      });
      expect(screen.getByTestId('session-forward-countdown').textContent).toBe('Starting…');
      expect(dispatchSession).not.toHaveBeenCalled();

      // The server starts it and says so.
      act(() => {
        orchestrateLaunch.handleEvent({
          type: 'session_forward_started',
          sessionId: 'chat-1',
          dispatchKey: CARD_KEY,
          started: { sessionId: 'srv-1', agentId: 'ada', name: 'Fix login', mode: 'push' },
        });
      });
      expect(screen.getByText('Forwarded as Build and Push.')).toBeTruthy();
      vi.useRealTimers();
    });

    it('shows no countdown without one from the server or outside Orchestrate', () => {
      serverSettings('chat-1', 'push', true);
      setOrchestrateSessionActive('chat-1', true);
      const view = render(<SessionForwardCard {...props} />);
      expect(screen.queryByTestId('session-forward-countdown')).toBeNull();
      view.unmount();

      setOrchestrateSessionActive('chat-1', false);
      serverCountdown(CARD_KEY, 20_000);
      render(<SessionForwardCard {...props} />);
      expect(screen.queryByTestId('session-forward-countdown')).toBeNull();
    });

    it('cancels on the server, and says so when the server did not take it', async () => {
      setOrchestrateSessionActive('chat-1', true);
      serverCountdown(CARD_KEY, 20_000);
      render(<SessionForwardCard {...props} />);

      cancelOrchestrateAutoStart.mockRejectedValueOnce(new Error('offline'));
      fireEvent.click(screen.getByTestId('session-forward-cancel-auto'));
      await waitFor(() =>
        expect(screen.getByTestId('session-forward-cancel-error').textContent).toMatch(
          /may still start it/,
        ),
      );
      expect(screen.getByTestId('session-forward-countdown')).toBeTruthy();

      fireEvent.click(screen.getByTestId('session-forward-cancel-auto'));
      await waitFor(() => expect(screen.queryByTestId('session-forward-countdown')).toBeNull());
      expect(cancelOrchestrateAutoStart).toHaveBeenLastCalledWith('chat-1', {
        messageId: 'm-1',
        forwardId: 'fwd-test',
        occurrence: 0,
      });
      expect(screen.getByTestId('session-forward')).toBeTruthy();
      expect(dispatchSession).not.toHaveBeenCalled();
    });

    it('stops showing the countdown when another device cancels the card', () => {
      setOrchestrateSessionActive('chat-1', true);
      serverCountdown(CARD_KEY, 20_000);
      render(<SessionForwardCard {...props} />);
      act(() => {
        orchestrateLaunch.handleEvent({
          type: 'orchestrate_auto_start_cancelled',
          sessionId: 'chat-1',
          dispatchKey: CARD_KEY,
        });
      });
      expect(screen.queryByTestId('session-forward-countdown')).toBeNull();
    });

    it('starts at once on Start, with the same key the server would use', async () => {
      dispatchSession.mockResolvedValue({
        sessionId: 'sess-1',
        agentId: 'ada',
        projectId: 'app',
        name: 'Fix login',
        mode: 'push',
        skippedSkills: [],
        ref: '',
      });
      setOrchestrateSessionActive('chat-1', true);
      serverSettings('chat-1', 'push', true);
      serverCountdown(CARD_KEY, 20_000);
      render(<SessionForwardCard {...props} />);
      fireEvent.click(screen.getByTestId('session-forward-start-now'));
      await waitFor(() => expect(screen.getByText('Forwarded as Build and Push.')).toBeTruthy());
      expect(dispatchSession).toHaveBeenCalledWith(
        'app',
        expect.objectContaining({ mode: 'push', idempotencyKey: CARD_KEY }),
        { parentSessionId: 'chat-1' },
      );
    });

    it('stops counting when Auto start is turned off during the countdown', () => {
      setOrchestrateSessionActive('chat-1', true);
      serverSettings('chat-1', 'push', true, 1);
      serverCountdown(CARD_KEY, 20_000);
      render(<SessionForwardCard {...props} />);
      expect(screen.getByTestId('session-forward-countdown')).toBeTruthy();
      // The server stops the countdown and says so for the card.
      serverSettings('chat-1', 'push', false, 2);
      act(() => {
        orchestrateLaunch.handleEvent({
          type: 'orchestrate_auto_start_ended',
          sessionId: 'chat-1',
          dispatchKey: CARD_KEY,
        });
      });
      expect(screen.queryByTestId('session-forward-countdown')).toBeNull();
      expect(screen.getByTestId('session-forward')).toBeTruthy();
    });

    it('shows the session when another device pressed Start before the countdown ended', () => {
      setOrchestrateSessionActive('chat-1', true);
      serverCountdown(CARD_KEY, 20_000);
      render(<SessionForwardCard {...props} />);
      expect(screen.getByTestId('session-forward-countdown')).toBeTruthy();
      // The other device's dispatch publishes the start.
      act(() => {
        orchestrateLaunch.handleEvent({
          type: 'session_forward_started',
          sessionId: 'chat-1',
          dispatchKey: CARD_KEY,
          started: { sessionId: 'sess-other', agentId: 'ada', name: 'Fix login', mode: 'review' },
        });
      });
      expect(screen.queryByTestId('session-forward-countdown')).toBeNull();
      expect(screen.getByText('Forwarded as Build and Review.')).toBeTruthy();
      expect(dispatchSession).not.toHaveBeenCalled();
    });

    it('recovers from Starting… when the reconnect refresh finds the start it missed', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      setOrchestrateSessionActive('chat-1', true);
      serverSettings('chat-1', 'push', true);
      serverCountdown(CARD_KEY, 5_000);
      render(<SessionForwardCard {...props} />);
      // The socket is down while the countdown ends and the server starts it.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6_000);
      });
      expect(screen.getByTestId('session-forward-countdown').textContent).toBe('Starting…');

      getOrchestrateLaunch.mockResolvedValue({
        settings: { mode: 'push', autoStart: true, configured: true, revision: 1 },
        launched: [
          {
            dispatchKey: CARD_KEY,
            sessionId: 'srv-1',
            agentId: 'ada',
            name: 'Fix login',
            mode: 'push',
          },
        ],
        cancelled: [],
        pending: [],
      });
      // What the app runs when the socket reconnects.
      await act(async () => {
        await orchestrateLaunch.refreshAll();
      });
      expect(screen.queryByTestId('session-forward-countdown')).toBeNull();
      expect(screen.getByText('Forwarded as Build and Push.')).toBeTruthy();
      expect(dispatchSession).not.toHaveBeenCalled();
      vi.useRealTimers();
    });

    it('keeps the card open with an error when dismissing it on the server fails', async () => {
      cancelOrchestrateAutoStart.mockRejectedValueOnce(new Error('offline'));
      render(<SessionForwardCard {...props} />);
      fireEvent.click(screen.getByTestId('session-forward-dismiss'));
      await waitFor(() => expect(screen.getByTestId('session-forward-cancel-error')).toBeTruthy());
      expect(screen.queryByTestId('session-forward-dismissed')).toBeNull();
    });
  });

  it("starts a manual press at the Orchestrate chat's Default build", async () => {
    dispatchSession.mockResolvedValue({
      sessionId: 'sess-1',
      agentId: 'ada',
      projectId: 'app',
      name: 'Fix login',
      skippedSkills: [],
      ref: '',
    });
    serverSettings('chat-1', 'push', false);
    setOrchestrateSessionActive('chat-1', true);
    render(
      <SessionForwardCard
        forward={{ ...forward, mode: 'manual' }}
        sessionId="chat-1"
        messageId="m-1"
        projects={[{ id: 'app', mode: 'dev' }]}
      />,
    );
    expect(await screen.findByTestId('session-forward-mode')).toHaveValue('push');
    fireEvent.click(screen.getByTestId('session-forward'));
    await waitFor(() =>
      expect(dispatchSession).toHaveBeenCalledWith(
        'app',
        expect.objectContaining({ mode: 'push' }),
        { parentSessionId: 'chat-1' },
      ),
    );
  });

  it('keeps a mode chosen on the card over the Default build', async () => {
    dispatchSession.mockResolvedValue({
      sessionId: 'sess-1',
      agentId: 'ada',
      projectId: 'app',
      name: 'Fix login',
      skippedSkills: [],
      ref: '',
    });
    serverSettings('chat-1', 'push', false);
    setOrchestrateSessionActive('chat-1', true);
    render(
      <SessionForwardCard
        forward={forward}
        sessionId="chat-1"
        messageId="m-1"
        projects={[{ id: 'app', mode: 'dev' }]}
      />,
    );
    fireEvent.change(await screen.findByTestId('session-forward-mode'), {
      target: { value: 'review' },
    });
    fireEvent.click(screen.getByTestId('session-forward'));
    await waitFor(() =>
      expect(dispatchSession).toHaveBeenCalledWith(
        'app',
        expect.objectContaining({ mode: 'review' }),
        { parentSessionId: 'chat-1' },
      ),
    );
  });

  it('remembers the mode the session started with when another tab started it first', async () => {
    dispatchSession.mockResolvedValue({
      sessionId: 'sess-1',
      agentId: 'ada',
      projectId: 'app',
      name: 'Fix login',
      mode: 'manual',
      skippedSkills: [],
      ref: '',
    });
    render(
      <SessionForwardCard
        forward={forward}
        sessionId="chat-1"
        messageId="m-1"
        projects={[{ id: 'app', mode: 'dev' }]}
      />,
    );
    fireEvent.change(await screen.findByTestId('session-forward-mode'), {
      target: { value: 'push' },
    });
    fireEvent.click(screen.getByTestId('session-forward'));
    await waitFor(() => expect(screen.getByText(/Forwarded as Build\./)).toBeTruthy());
    expect(dispatchSession).toHaveBeenCalledWith('app', expect.objectContaining({ mode: 'push' }), {
      parentSessionId: 'chat-1',
    });
    const saved = Object.keys(localStorage)
      .map((key) => localStorage.getItem(key) ?? '')
      .find((value) => value.includes('sess-1'));
    expect(JSON.parse(saved!)).toMatchObject({ sessionId: 'sess-1', mode: 'manual' });
  });
});
