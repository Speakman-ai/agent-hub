import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ExtractedForward } from '@shared/utils/extractForwardBlocks';

const dispatchSession = vi.hoisted(() => vi.fn());
vi.mock('../utils/api', () => ({ api: { dispatchSession } }));

const { default: SessionForwardCard, forwardStore } = await import('./SessionForwardCard');

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
    expect(dispatchSession).toHaveBeenCalledWith('ops', {
      prompt: forward.prompt,
      agentId: 'ops',
      name: 'Fix login',
      mode: 'consult',
    });
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
});
