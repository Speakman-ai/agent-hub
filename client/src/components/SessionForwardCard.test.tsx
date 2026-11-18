import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ExtractedForward } from '@shared/utils/extractForwardBlocks';
import {
  resetOrchestrateLaunchStateForTests,
  setOrchestrateLaunchSettings,
  setOrchestrateSessionActive,
} from '../utils/orchestrateLaunchSettings';

const dispatchSession = vi.hoisted(() => vi.fn());
vi.mock('../utils/api', () => ({ api: { dispatchSession } }));

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
    localStorage.clear();
    forwardStore.clear();
    forwardDock.clear();
    resetOrchestrateLaunchStateForTests();
    vi.useRealTimers();
  });

  it('dismisses without starting anything and stays dismissed on reload', () => {
    const card = <SessionForwardCard forward={forward} sessionId="chat-1" messageId="m-1" />;
    const view = render(card);
    fireEvent.click(screen.getByTestId('session-forward-dismiss'));
    expect(screen.getByTestId('session-forward-dismissed')).toBeTruthy();
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

    it('stays below later messages until dismissed, then returns to its message', () => {
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
      expect(screen.queryByTestId('session-forward-dock')).toBeNull();
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

  it('starts with the orchestrate default build mode after 30 seconds', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    dispatchSession.mockResolvedValue({
      sessionId: 'sess-1',
      agentId: 'ada',
      projectId: 'app',
      name: 'Fix login',
      skippedSkills: [],
      ref: '',
    });
    setOrchestrateLaunchSettings('chat-1', { mode: 'push', autoStart: true });
    setOrchestrateSessionActive('chat-1', true);
    render(
      <SessionForwardCard
        forward={forward}
        sessionId="chat-1"
        messageId="m-1"
        projects={[{ id: 'app', mode: 'dev' }]}
      />,
    );
    expect(await screen.findByTestId('session-forward-countdown')).toHaveTextContent(
      'Starting in 30s as Build and Push',
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(dispatchSession).toHaveBeenCalledWith('app', expect.objectContaining({ mode: 'push' }), {
      parentSessionId: 'chat-1',
    });
    vi.useRealTimers();
  });

  it('starts immediately or stays manual when the countdown is overridden', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    dispatchSession.mockResolvedValue({
      sessionId: 'sess-1',
      agentId: 'ada',
      projectId: 'app',
      name: 'Fix login',
      skippedSkills: [],
      ref: '',
    });
    setOrchestrateLaunchSettings('chat-1', { mode: 'merge', autoStart: true });
    setOrchestrateSessionActive('chat-1', true);
    const view = render(
      <SessionForwardCard
        forward={forward}
        sessionId="chat-1"
        messageId="m-1"
        projects={[{ id: 'app', mode: 'dev' }]}
      />,
    );
    expect(await screen.findByTestId('session-forward-countdown')).toBeTruthy();
    fireEvent.click(screen.getByTestId('session-forward-cancel-auto'));
    expect(screen.getByTestId('session-forward')).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(dispatchSession).not.toHaveBeenCalled();

    view.rerender(
      <SessionForwardCard
        forward={{ ...forward, forwardId: 'fwd-now' }}
        sessionId="chat-1"
        messageId="m-2"
        projects={[{ id: 'app', mode: 'dev' }]}
      />,
    );
    fireEvent.click(await screen.findByTestId('session-forward-start-now'));
    await act(async () => {
      await Promise.resolve();
    });
    expect(dispatchSession).toHaveBeenCalledWith(
      'app',
      expect.objectContaining({ mode: 'merge' }),
      { parentSessionId: 'chat-1' },
    );
    vi.useRealTimers();
  });

  it('does not auto start once the chat leaves Orchestrate', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setOrchestrateLaunchSettings('chat-1', { mode: 'push', autoStart: true });
    setOrchestrateSessionActive('chat-1', true);
    render(
      <SessionForwardCard
        forward={forward}
        sessionId="chat-1"
        messageId="m-1"
        projects={[{ id: 'app', mode: 'dev' }]}
      />,
    );
    expect(await screen.findByTestId('session-forward-countdown')).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
      setOrchestrateSessionActive('chat-1', false);
    });
    expect(screen.queryByTestId('session-forward-countdown')).toBeNull();
    expect(screen.getByTestId('session-forward')).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(dispatchSession).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('ignores a saved Auto start in a chat that is not in Orchestrate', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setOrchestrateLaunchSettings('chat-1', { mode: 'push', autoStart: true });
    render(
      <SessionForwardCard
        forward={forward}
        sessionId="chat-1"
        messageId="m-1"
        projects={[{ id: 'app', mode: 'dev' }]}
      />,
    );
    expect(await screen.findByTestId('session-forward')).toBeTruthy();
    expect(screen.queryByTestId('session-forward-countdown')).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
    });
    expect(dispatchSession).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('auto starts a workflow forward as consult', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    dispatchSession.mockResolvedValue({
      sessionId: 'sess-1',
      agentId: 'ada',
      projectId: 'app',
      name: 'Fix login',
      skippedSkills: [],
      ref: '',
    });
    setOrchestrateLaunchSettings('chat-1', { mode: 'push', autoStart: true });
    setOrchestrateSessionActive('chat-1', true);
    render(
      <SessionForwardCard
        forward={{ ...forward, mode: 'consult' }}
        sessionId="chat-1"
        messageId="m-1"
        projects={[{ id: 'app', mode: 'workflow' }]}
      />,
    );
    expect(await screen.findByTestId('session-forward-countdown')).toHaveTextContent(
      'Starting in 30s',
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(dispatchSession).toHaveBeenCalledWith(
      'app',
      expect.objectContaining({ mode: 'consult' }),
      { parentSessionId: 'chat-1' },
    );
    vi.useRealTimers();
  });

  it('cancelling one copy of a card stops the countdown in every copy', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setOrchestrateLaunchSettings('chat-1', { mode: 'push', autoStart: true });
    setOrchestrateSessionActive('chat-1', true);
    const props = {
      forward,
      sessionId: 'chat-1',
      messageId: 'm-1',
      projects: [{ id: 'app', mode: 'dev' }],
    };
    render(
      <>
        <SessionForwardCard {...props} />
        <SessionForwardCard {...props} />
      </>,
    );
    await waitFor(() => expect(screen.getAllByTestId('session-forward-countdown')).toHaveLength(2));
    fireEvent.click(screen.getAllByTestId('session-forward-cancel-auto')[0]!);
    expect(screen.queryAllByTestId('session-forward-countdown')).toHaveLength(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
    });
    expect(dispatchSession).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('does not restart a cancelled countdown after a reload', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setOrchestrateLaunchSettings('chat-1', { mode: 'push', autoStart: true });
    setOrchestrateSessionActive('chat-1', true);
    const props = {
      forward,
      sessionId: 'chat-1',
      messageId: 'm-1',
      projects: [{ id: 'app', mode: 'dev' }],
    };
    const first = render(<SessionForwardCard {...props} />);
    fireEvent.click(await screen.findByTestId('session-forward-cancel-auto'));
    first.unmount();

    // Reload: in-memory state is gone; saved settings and cancels remain.
    resetOrchestrateLaunchStateForTests();
    setOrchestrateSessionActive('chat-1', true);
    render(<SessionForwardCard {...props} />);
    expect(await screen.findByTestId('session-forward')).toBeTruthy();
    expect(screen.queryByTestId('session-forward-countdown')).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
    });
    expect(dispatchSession).not.toHaveBeenCalled();
    vi.useRealTimers();
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
    setOrchestrateLaunchSettings('chat-1', { mode: 'push', autoStart: false });
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
    setOrchestrateLaunchSettings('chat-1', { mode: 'push', autoStart: false });
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
