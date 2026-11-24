import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SpawnedSessionsRail, { SPAWNED_SESSION_WS_EVENT } from './SpawnedSessionsRail';
import { orchestrateLaunch } from '../utils/orchestrateLaunchSettings';

const getSpawnedSessions = vi.fn();
const getOrchestrateLaunch = vi.fn();
const putOrchestrateLaunch = vi.fn();

vi.mock('../utils/api', () => ({
  api: {
    getSpawnedSessions: (...args: unknown[]) => getSpawnedSessions(...args),
    getOrchestrateLaunch: (...args: unknown[]) => getOrchestrateLaunch(...args),
    putOrchestrateLaunch: (...args: unknown[]) => putOrchestrateLaunch(...args),
  },
}));

const launchSnapshot = (mode: string, autoStart: boolean, revision: number) => ({
  settings: { mode, autoStart, configured: revision > 0, revision },
  launched: [],
  cancelled: [],
  pending: [],
});

const parent = { id: 'parent-1', name: 'Project chat', agent_id: 'agent-1' };

beforeEach(() => {
  getSpawnedSessions.mockReset();
  getOrchestrateLaunch.mockReset().mockResolvedValue(launchSnapshot('manual', false, 0));
  putOrchestrateLaunch.mockReset();
  orchestrateLaunch.resetForTests();
  localStorage.clear();
  getSpawnedSessions.mockResolvedValue({
    parent,
    sessions: [
      {
        id: 'child-1',
        name: 'Fix login',
        agent_id: 'agent-2',
        state: 'working',
        updated_at: '2026-11-12 12:00:00',
        last_turn_error: null,
      },
    ],
  });
});

describe('SpawnedSessionsRail', () => {
  it('renders spawned sessions and opens the one that is clicked', async () => {
    const onOpenSession = vi.fn();
    render(
      <SpawnedSessionsRail
        parentSessionId="parent-1"
        activeSessionId="parent-1"
        agents={[{ id: 'agent-2', name: 'Docs' }]}
        onOpenSession={onOpenSession}
      />,
    );
    expect(await screen.findByText('Fix login')).toBeTruthy();
    expect(screen.getByTestId('spawned-session-status-child-1')).toHaveTextContent('Working');
    expect(screen.getByTestId('spawned-session-state-child-1')).toHaveAttribute(
      'data-session-state',
      'working',
    );
    expect(screen.getByText('· Docs')).toBeTruthy();
    fireEvent.click(screen.getByTestId('spawned-session-child-1'));
    expect(onOpenSession).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'child-1',
        agent_id: 'agent-2',
        spawned_from_session_id: 'parent-1',
      }),
    );
  });

  it('prefers a live working signal over a waiting seed, like the session list', async () => {
    getSpawnedSessions.mockResolvedValue({
      parent,
      sessions: [
        {
          id: 'child-1',
          name: 'Fix login',
          agent_id: 'agent-2',
          state: 'waiting_for_user_input',
          updated_at: '2026-11-12 12:00:00',
          last_turn_error: null,
        },
      ],
    });
    render(
      <SpawnedSessionsRail
        parentSessionId="parent-1"
        activeSessionId="parent-1"
        activeTaskSessionIds={{ 'child-1': true }}
        onOpenSession={vi.fn()}
      />,
    );
    expect(await screen.findByTestId('spawned-session-status-child-1')).toHaveTextContent(
      'Working',
    );
    expect(screen.getByTestId('spawned-session-state-child-1')).toHaveAttribute(
      'data-session-state',
      'working',
    );
  });

  it('shows the empty copy and a way back to the parent chat', async () => {
    getSpawnedSessions.mockResolvedValue({ parent, sessions: [] });
    const onOpenSession = vi.fn();
    render(
      <SpawnedSessionsRail
        parentSessionId="parent-1"
        activeSessionId="child-9"
        agents={[]}
        onOpenSession={onOpenSession}
      />,
    );
    expect(await screen.findByText('Spawned sessions will show up here.')).toBeTruthy();
    fireEvent.click(screen.getByTestId('spawned-sessions-back'));
    expect(onOpenSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'parent-1', agent_id: 'agent-1' }),
    );
  });

  it('prepends a worker announced over the session websocket', async () => {
    render(
      <SpawnedSessionsRail
        parentSessionId="parent-1"
        activeSessionId="parent-1"
        onOpenSession={vi.fn()}
      />,
    );
    await screen.findByText('Fix login');
    window.dispatchEvent(
      new CustomEvent(SPAWNED_SESSION_WS_EVENT, {
        detail: {
          type: 'session_created',
          session: {
            id: 'child-2',
            name: 'Add rail',
            agent_id: 'agent-1',
            state: 'waiting_for_user_input',
            spawned_from_session_id: 'parent-1',
          },
        },
      }),
    );
    await waitFor(() => expect(screen.getByText('Add rail')).toBeTruthy());
    expect(screen.getByTestId('spawned-session-status-child-2')).toHaveTextContent(
      'Waiting for user input',
    );
    expect(screen.getByTestId('spawned-session-state-child-2')).toHaveAttribute(
      'data-session-state',
      'waiting_for_user_input',
    );
  });

  it('deletes a worker and returns to the parent when that chat was open', async () => {
    const onDeleteSession = vi.fn().mockResolvedValue(true);
    const onOpenSession = vi.fn();
    render(
      <SpawnedSessionsRail
        parentSessionId="parent-1"
        activeSessionId="child-1"
        onOpenSession={onOpenSession}
        onDeleteSession={onDeleteSession}
      />,
    );
    fireEvent.click(await screen.findByTestId('spawned-session-delete-child-1'));
    await waitFor(() =>
      expect(screen.getByText('Spawned sessions will show up here.')).toBeTruthy(),
    );
    expect(screen.getByTestId('spawned-archived-section')).toBeTruthy();
    fireEvent.click(screen.getByTestId('spawned-archived-toggle'));
    expect(screen.getByTestId('spawned-archived-child-1')).toBeTruthy();
    expect(onDeleteSession).toHaveBeenCalledWith(expect.objectContaining({ id: 'child-1' }));
    expect(onOpenSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'parent-1', agent_id: 'agent-1' }),
    );
  });

  it('keeps the row when delete fails', async () => {
    const onDeleteSession = vi.fn().mockResolvedValue(false);
    render(
      <SpawnedSessionsRail
        parentSessionId="parent-1"
        activeSessionId="parent-1"
        onOpenSession={vi.fn()}
        onDeleteSession={onDeleteSession}
      />,
    );
    fireEvent.click(await screen.findByTestId('spawned-session-delete-child-1'));
    await waitFor(() => expect(onDeleteSession).toHaveBeenCalled());
    expect(screen.getByText('Fix login')).toBeTruthy();
  });

  it('restores an archived worker onto the rail', async () => {
    getSpawnedSessions.mockResolvedValue({
      parent,
      sessions: [],
      archived: [
        {
          id: 'child-old',
          name: 'Old attempt',
          agent_id: 'agent-1',
          deleted_at: new Date().toISOString(),
        },
      ],
    });
    const onRestoreSession = vi.fn().mockResolvedValue(true);
    render(
      <SpawnedSessionsRail
        parentSessionId="parent-1"
        activeSessionId="parent-1"
        onOpenSession={vi.fn()}
        onRestoreSession={onRestoreSession}
      />,
    );
    fireEvent.click(await screen.findByTestId('spawned-archived-toggle'));
    fireEvent.click(screen.getByTestId('spawned-session-restore-child-old'));
    await waitFor(() => expect(screen.getByTestId('spawned-session-child-old')).toBeTruthy());
    expect(onRestoreSession).toHaveBeenCalledWith(expect.objectContaining({ id: 'child-old' }));
    expect(screen.queryByTestId('spawned-archived-section')).toBeNull();
  });

  it('loads and saves the default build mode and auto start on the server', async () => {
    putOrchestrateLaunch
      .mockResolvedValueOnce({ settings: { mode: 'merge', autoStart: false, revision: 1 } })
      .mockResolvedValueOnce({ settings: { mode: 'merge', autoStart: true, revision: 2 } });
    render(
      <SpawnedSessionsRail
        parentSessionId="parent-1"
        activeSessionId="parent-1"
        onOpenSession={vi.fn()}
      />,
    );
    const select = (await screen.findByTestId('orchestrate-default-build')) as HTMLSelectElement;
    await waitFor(() => expect(select.disabled).toBe(false));
    expect(select.value).toBe('manual');
    fireEvent.change(select, { target: { value: 'merge' } });
    await waitFor(() => expect(select.value).toBe('merge'));
    const autoStart = screen.getByTestId('orchestrate-auto-start') as HTMLInputElement;
    await waitFor(() => expect(autoStart.disabled).toBe(false));
    fireEvent.click(autoStart);
    await waitFor(() => expect(autoStart.checked).toBe(true));
    expect(putOrchestrateLaunch.mock.calls).toEqual([
      ['parent-1', { mode: 'merge' }],
      ['parent-1', { autoStart: true }],
    ]);
    expect(screen.getByRole('option', { name: 'Build' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Build and Review' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Build and Push' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Auto Merge' })).toBeTruthy();
  });

  it('keeps the old value and says so when the server does not take a save', async () => {
    putOrchestrateLaunch.mockRejectedValueOnce(new Error('offline'));
    render(
      <SpawnedSessionsRail
        parentSessionId="parent-1"
        activeSessionId="parent-1"
        onOpenSession={vi.fn()}
      />,
    );
    const autoStart = (await screen.findByTestId('orchestrate-auto-start')) as HTMLInputElement;
    await waitFor(() => expect(autoStart.disabled).toBe(false));
    fireEvent.click(autoStart);
    await waitFor(() =>
      expect(screen.getByTestId('orchestrate-launch-error').textContent).toMatch(/Couldn't save/),
    );
    expect(autoStart.checked).toBe(false);
  });

  it("loads the parent chat's settings when a worker is opened directly", async () => {
    getOrchestrateLaunch.mockResolvedValue(launchSnapshot('push', true, 4));
    render(
      <SpawnedSessionsRail
        parentSessionId="parent-1"
        activeSessionId="child-1"
        onOpenSession={vi.fn()}
      />,
    );
    const autoStart = (await screen.findByTestId('orchestrate-auto-start')) as HTMLInputElement;
    await waitFor(() => expect(autoStart.checked).toBe(true));
    expect(getOrchestrateLaunch).toHaveBeenCalledWith('parent-1');
    expect(autoStart.disabled).toBe(false);
    expect((screen.getByTestId('orchestrate-default-build') as HTMLSelectElement).value).toBe(
      'push',
    );
  });

  it('offers a retry when the settings do not load', async () => {
    getOrchestrateLaunch.mockRejectedValueOnce(new Error('offline'));
    render(
      <SpawnedSessionsRail
        parentSessionId="parent-1"
        activeSessionId="parent-1"
        onOpenSession={vi.fn()}
      />,
    );
    const error = await screen.findByTestId('orchestrate-launch-error');
    expect((screen.getByTestId('orchestrate-auto-start') as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(error.querySelector('button')!);
    await waitFor(() =>
      expect((screen.getByTestId('orchestrate-auto-start') as HTMLInputElement).disabled).toBe(
        false,
      ),
    );
  });

  it('opens as a drawer from an edge tab below the lg breakpoint', async () => {
    const onOpenSession = vi.fn();
    render(
      <SpawnedSessionsRail
        parentSessionId="parent-1"
        activeSessionId="parent-1"
        onOpenSession={onOpenSession}
      />,
    );
    await screen.findByText('Fix login');
    const rail = screen.getByTestId('spawned-sessions-rail');
    const toggle = screen.getByTestId('spawned-sessions-drawer-toggle');
    // Narrow layout: the rail is hidden until the tab opens it; lg shows it inline.
    expect(rail.className).toMatch(/(^|\s)hidden(\s|$)/);
    expect(rail.className).toContain('lg:flex');
    expect(toggle.className).toContain('lg:hidden');
    expect(toggle).toHaveAttribute('aria-label', 'Spawned sessions (1)');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(toggle);
    expect(rail).toHaveAttribute('data-drawer-open', 'true');
    expect(rail.className).toContain('fixed');
    expect(rail.className).not.toMatch(/(^|\s)hidden(\s|$)/);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(rail).not.toHaveAttribute('data-drawer-open');

    fireEvent.click(toggle);
    fireEvent.click(screen.getByTestId('spawned-session-child-1'));
    expect(onOpenSession).toHaveBeenCalledWith(expect.objectContaining({ id: 'child-1' }));
    expect(rail).not.toHaveAttribute('data-drawer-open');

    fireEvent.click(toggle);
    fireEvent.click(screen.getByTestId('spawned-sessions-drawer-backdrop'));
    expect(rail).not.toHaveAttribute('data-drawer-open');
  });

  it('keeps a worker created while the first load was in flight', async () => {
    let resolve!: (value: unknown) => void;
    getSpawnedSessions.mockReturnValue(new Promise((r) => (resolve = r)));
    render(
      <SpawnedSessionsRail
        parentSessionId="parent-1"
        activeSessionId="parent-1"
        onOpenSession={vi.fn()}
      />,
    );
    act(() => {
      window.dispatchEvent(
        new CustomEvent(SPAWNED_SESSION_WS_EVENT, {
          detail: {
            type: 'session_forwarded',
            session: {
              id: 'child-new',
              name: 'New worker',
              agent_id: 'agent-2',
              spawned_from_session_id: 'parent-1',
            },
          },
        }),
      );
    });
    await act(async () => {
      resolve({
        parent,
        sessions: [
          {
            id: 'child-1',
            name: 'Fix login',
            agent_id: 'agent-2',
            state: 'working',
            updated_at: '2026-11-12 12:00:00',
            last_turn_error: null,
          },
        ],
        archived: [],
      });
    });
    expect(screen.getByTestId('spawned-session-child-new')).toBeTruthy();
    expect(screen.getByTestId('spawned-session-child-1')).toBeTruthy();
  });

  it("never shows the previous parent's workers while the next parent loads", async () => {
    const view = render(
      <SpawnedSessionsRail
        parentSessionId="parent-1"
        activeSessionId="parent-1"
        onOpenSession={vi.fn()}
        onDeleteSession={vi.fn()}
      />,
    );
    expect(await screen.findByTestId('spawned-session-child-1')).toBeTruthy();

    let resolveFirst!: (value: unknown) => void;
    getSpawnedSessions.mockReturnValueOnce(new Promise((r) => (resolveFirst = r)));
    view.rerender(
      <SpawnedSessionsRail
        parentSessionId="parent-2"
        activeSessionId="parent-2"
        onOpenSession={vi.fn()}
        onDeleteSession={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('spawned-session-child-1')).toBeNull();
    expect(screen.queryByTestId('spawned-session-delete-child-1')).toBeNull();
    expect(screen.getByText('Spawned sessions will show up here.')).toBeTruthy();

    await act(async () => {
      resolveFirst({
        parent: { id: 'parent-2', name: 'Other chat', agent_id: 'agent-1' },
        sessions: [
          {
            id: 'child-2',
            name: 'Other worker',
            agent_id: 'agent-2',
            state: 'working',
            updated_at: '2026-11-12 12:00:00',
            last_turn_error: null,
          },
        ],
        archived: [],
      });
    });
    expect(screen.getByTestId('spawned-session-child-2')).toBeTruthy();
    expect(screen.queryByTestId('spawned-session-child-1')).toBeNull();
  });

  it('does not jump back to the parent when an archive finishes after the user moved on', async () => {
    let finishDelete!: (value: boolean) => void;
    const onDeleteSession = vi.fn(() => new Promise<boolean>((r) => (finishDelete = r)));
    const onOpenSession = vi.fn();
    const props = { parentSessionId: 'parent-1', onOpenSession, onDeleteSession };
    const view = render(<SpawnedSessionsRail {...props} activeSessionId="child-1" />);
    fireEvent.click(await screen.findByTestId('spawned-session-delete-child-1'));
    view.rerender(<SpawnedSessionsRail {...props} activeSessionId="somewhere-else" />);
    await act(async () => {
      finishDelete(true);
    });
    expect(onOpenSession).not.toHaveBeenCalled();
    expect(screen.queryByTestId('spawned-session-child-1')).toBeNull();
  });

  it('links a nested Orchestrate chat up to the chat that started it', async () => {
    getSpawnedSessions.mockResolvedValue({
      parent: {
        id: 'worker-1',
        name: 'Worker chat',
        agent_id: 'agent-1',
        up: { id: 'parent-1', name: 'Project chat', agent_id: 'agent-1' },
      },
      sessions: [],
      archived: [],
    });
    const onOpenSession = vi.fn();
    render(
      <SpawnedSessionsRail
        parentSessionId="worker-1"
        activeSessionId="worker-1"
        onOpenSession={onOpenSession}
      />,
    );
    const back = await screen.findByTestId('spawned-sessions-back');
    expect(back).toHaveTextContent('Project chat');
    fireEvent.click(back);
    expect(onOpenSession).toHaveBeenCalledWith({
      id: 'parent-1',
      name: 'Project chat',
      agent_id: 'agent-1',
    });
  });
});
