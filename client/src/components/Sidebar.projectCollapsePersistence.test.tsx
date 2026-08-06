/**
 * Sidebar project collapse is remembered PER USER.
 *
 * The authoritative store is the account (`/api/auth/me/sidebar-collapsed-projects`);
 * localStorage is only a first-paint cache so a reload doesn't flash every
 * project open while the hydration GET is in flight. These tests pin both
 * halves plus the race between them.
 *
 * Regression this file exists for: collapse state used to be plain in-memory
 * `useState`, so every reload (and every other device) reset the sidebar.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const getMySidebarCollapsedProjects = vi.fn();
const putMySidebarCollapsedProject = vi.fn();
const sharedSaverState = vi.hoisted(() => ({ savers: [] as any[] }));

(vi as any).mock('../utils/api', () => ({
  api: {
    getMySidebarCollapsedProjects: (...args: any[]) => getMySidebarCollapsedProjects(...args),
    putMySidebarCollapsedProject: (...args: any[]) => putMySidebarCollapsedProject(...args),
  },
}));
(vi as any).mock('@shared/utils/sidebarProjectCollapse', async () => {
  const actual = await vi.importActual<any>('@shared/utils/sidebarProjectCollapse');
  return {
    ...actual,
    createCollapsedProjectSaver: (put: any) => {
      const saver = actual.createCollapsedProjectSaver(put);
      sharedSaverState.savers.push(saver);
      return saver;
    },
  };
});

(vi as any).mock('./OrgSwitcher.jsx', () => ({
  default: () => <div data-testid="org-switcher-stub" />,
}));
(vi as any).mock('./KanbanSidebarEpicsPanel.jsx', () => ({
  default: () => <div data-testid="kanban-sidebar-epics-panel" />,
}));

const { default: Sidebar } = await import('./Sidebar');
const { collapsedProjectsCacheKey, currentCollapsedProjectsKey } =
  await import('../utils/sidebarProjectCollapse');
const { setToken } = await import('../utils/auth');

const PROJECT_ID = 'proj-1';
const AGENT_ID = 'agent-1';
const OTHER_AGENT_ID = 'agent-2';

/** Put a signed-in account in localStorage, the way `login()` does. */
const signIn = (userId: string) =>
  setToken({
    token: `tok-${userId}`,
    expiresAt: null,
    user: { id: userId, username: userId, email: null, role: 'Owner' },
  });

/** Seed the cache for a specific account (defaults to whoever is signed in). */
const seedCache = (ids: string[], userId?: string) =>
  localStorage.setItem(
    userId ? collapsedProjectsCacheKey({ id: userId }) : currentCollapsedProjectsKey(),
    JSON.stringify(ids),
  );

beforeEach(() => {
  sharedSaverState.savers.length = 0;
  localStorage.clear();
  signIn('user-a');
  getMySidebarCollapsedProjects.mockReset().mockResolvedValue({ sidebarCollapsedProjects: [] });
  putMySidebarCollapsedProject.mockReset().mockResolvedValue({ sidebarCollapsedProjects: [] });
  (globalThis as any).fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ version: 'test', gitHash: 'abc' }),
  });
});

const buildProps = (overrides: any = {}) => {
  const sessions = [
    { id: 's-running', name: 'Running task' },
    { id: 's-idle', name: 'Idle session' },
  ];
  return {
    // Two agents so the project row offers a collapse chevron.
    projects: [
      {
        id: PROJECT_ID,
        name: 'Test Project',
        color: '#22d3ee',
        agents: [
          { id: AGENT_ID, name: 'Primary Agent', color: '#22d3ee', active: true },
          { id: OTHER_AGENT_ID, name: 'Secondary Agent', color: '#a78bfa', active: true },
        ],
      },
    ],
    agents: [],
    activeAgentId: AGENT_ID,
    loadedSessionsAgentId: AGENT_ID,
    loadedArchivedAgentId: AGENT_ID,
    onSelectAgent: vi.fn(),
    onExpandAgent: vi.fn(),
    sessionsByAgentId: { [AGENT_ID]: sessions },
    archivedSessionsByAgentId: {},
    onFocusSession: vi.fn(),
    sessions,
    activeSessionId: null,
    onSelectSession: vi.fn(),
    onNewSession: vi.fn(),
    onDeleteSession: vi.fn(),
    onClearAllSessions: vi.fn(),
    onClearMergedSessions: vi.fn(),
    onRenameSession: vi.fn(),
    onNavigate: vi.fn(),
    currentView: 'chat',
    activeTaskSessionIds: { 's-running': true },
    changesReadyBySession: {},
    ...overrides,
  };
};

const isCollapsed = () => !!screen.queryByTestId('project-collapsed-actionable');
const cached = () => JSON.parse(localStorage.getItem(currentCollapsedProjectsKey()) || '[]');

describe('Sidebar project collapse persistence', () => {
  it('paints collapsed from the local cache before the account fetch resolves', () => {
    seedCache([PROJECT_ID]);
    render(<Sidebar {...buildProps()} />);
    // Synchronous first paint — the hydration promise has not resolved yet.
    expect(isCollapsed()).toBe(true);
  });

  it('saves a collapse to the account and mirrors it into the cache', async () => {
    render(<Sidebar {...buildProps()} />);
    await waitFor(() => expect(getMySidebarCollapsedProjects).toHaveBeenCalled());
    expect(isCollapsed()).toBe(false);

    fireEvent.click(screen.getByText('Test Project' as any) as any);

    expect(isCollapsed()).toBe(true);
    expect(putMySidebarCollapsedProject).toHaveBeenCalledWith(PROJECT_ID, true);
    expect(cached()).toEqual([PROJECT_ID]);
  });

  it('saves an expand as collapsed:false and clears the cache entry', async () => {
    seedCache([PROJECT_ID]);
    getMySidebarCollapsedProjects.mockResolvedValue({ sidebarCollapsedProjects: [PROJECT_ID] });
    render(<Sidebar {...buildProps()} />);
    await waitFor(() => expect(isCollapsed()).toBe(true));

    fireEvent.click(screen.getByText('Test Project' as any) as any);

    expect(isCollapsed()).toBe(false);
    expect(putMySidebarCollapsedProject).toHaveBeenCalledWith(PROJECT_ID, false);
    // Empty list → the cache key is removed rather than left as a stale `[]`.
    expect(localStorage.getItem(currentCollapsedProjectsKey())).toBeNull();
  });

  it("adopts the account's list when the local cache is stale", async () => {
    // Another device collapsed the project; this browser has no cache entry.
    getMySidebarCollapsedProjects.mockResolvedValue({ sidebarCollapsedProjects: [PROJECT_ID] });
    render(<Sidebar {...buildProps()} />);

    await waitFor(() => expect(isCollapsed()).toBe(true));
    expect(cached()).toEqual([PROJECT_ID]);
  });

  it('keeps a toggle made before the account fetch resolved', async () => {
    // Regression: without the pre-hydration merge, a click landing while the
    // GET is in flight snaps back open when the (older) server list arrives.
    let resolveHydration: (value: any) => void = () => {};
    getMySidebarCollapsedProjects.mockReturnValue(
      new Promise((resolve) => {
        resolveHydration = resolve;
      }),
    );
    render(<Sidebar {...buildProps()} />);

    fireEvent.click(screen.getByText('Test Project' as any) as any);
    expect(isCollapsed()).toBe(true);

    resolveHydration({ sidebarCollapsedProjects: [] });
    await waitFor(() => expect(cached()).toEqual([PROJECT_ID]));
    expect(isCollapsed()).toBe(true);
  });

  it('ignores a malformed account payload rather than expanding everything', async () => {
    seedCache([PROJECT_ID]);
    getMySidebarCollapsedProjects.mockResolvedValue({ sidebarCollapsedProjects: 'nope' });
    render(<Sidebar {...buildProps()} />);
    await waitFor(() => expect(getMySidebarCollapsedProjects).toHaveBeenCalled());
    // A non-array normalizes to "nothing collapsed" server-side, which is a
    // legitimate answer — the cache must not resurrect the stale entry.
    await waitFor(() => expect(isCollapsed()).toBe(false));
  });

  it('leaves the cached view in place when the account fetch fails', async () => {
    seedCache([PROJECT_ID]);
    getMySidebarCollapsedProjects.mockRejectedValue(new Error('offline'));
    render(<Sidebar {...buildProps()} />);

    await waitFor(() => expect(getMySidebarCollapsedProjects).toHaveBeenCalled());
    expect(isCollapsed()).toBe(true);
    expect(cached()).toEqual([PROJECT_ID]);
  });

  it("never paints another account's cached collapse", async () => {
    // Regression: a global cache key let user B's first paint (and, on a failed
    // hydration fetch, their whole session) show user A's collapsed projects.
    seedCache([PROJECT_ID], 'user-a');
    signIn('user-b');
    getMySidebarCollapsedProjects.mockRejectedValue(new Error('offline'));

    render(<Sidebar {...buildProps()} />);
    expect(isCollapsed()).toBe(false);
    await waitFor(() => expect(getMySidebarCollapsedProjects).toHaveBeenCalled());
    // Even with no server answer to fall back on, B keeps their own view.
    expect(isCollapsed()).toBe(false);
  });

  it('re-hydrates when the signed-in account changes without a remount', async () => {
    seedCache([PROJECT_ID], 'user-a');
    getMySidebarCollapsedProjects.mockResolvedValue({ sidebarCollapsedProjects: [PROJECT_ID] });
    const { rerender } = render(<Sidebar {...buildProps()} />);
    await waitFor(() => expect(isCollapsed()).toBe(true));

    signIn('user-b');
    getMySidebarCollapsedProjects.mockResolvedValue({ sidebarCollapsedProjects: [] });
    rerender(<Sidebar {...buildProps()} />);

    await waitFor(() => expect(isCollapsed()).toBe(false));
    // A's bucket is pruned on write; B's own (empty) state is what persists.
    expect(localStorage.getItem(collapsedProjectsCacheKey({ id: 'user-a' }))).toBeNull();
  });

  it('coalesces rapid toggles so the last value is what reaches the account', async () => {
    // Regression: independent fire-and-forget PUTs could arrive out of order,
    // leaving the account collapsed while the UI showed expanded.
    const pendingPuts: Array<() => void> = [];
    putMySidebarCollapsedProject.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          pendingPuts.push(resolve);
        }),
    );
    render(<Sidebar {...buildProps()} />);
    await waitFor(() => expect(getMySidebarCollapsedProjects).toHaveBeenCalled());

    const header = screen.getByText('Test Project' as any) as any;
    fireEvent.click(header); // collapse
    fireEvent.click(header); // expand
    fireEvent.click(header); // collapse — the user's final intent

    // Only one request is in flight; the rest coalesced into the queue.
    expect(putMySidebarCollapsedProject).toHaveBeenCalledTimes(1);
    expect(putMySidebarCollapsedProject).toHaveBeenCalledWith(PROJECT_ID, true);

    pendingPuts[0]();
    await waitFor(() => expect(putMySidebarCollapsedProject).toHaveBeenCalledTimes(2));
    // Second (and last) request carries the UI's final state, not an
    // intermediate one — server and UI agree.
    expect(putMySidebarCollapsedProject.mock.calls.at(-1)).toEqual([PROJECT_ID, true]);
    expect(isCollapsed()).toBe(true);
  });

  it("never sends a queued toggle under the next account's credentials", async () => {
    // Regression: the saver's queue holds VALUES, and the auth token is read at
    // dispatch time. A saver that outlived the account would send user A's
    // pending toggle after user B signed in — writing A's state to B.
    const pendingPuts: Array<() => void> = [];
    putMySidebarCollapsedProject.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          pendingPuts.push(resolve);
        }),
    );
    const { rerender } = render(<Sidebar {...buildProps()} />);
    await waitFor(() => expect(getMySidebarCollapsedProjects).toHaveBeenCalled());

    const header = screen.getByText('Test Project' as any) as any;
    fireEvent.click(header); // collapse — dispatched with A's token
    fireEvent.click(header); // expand — QUEUED behind the in-flight request
    expect(putMySidebarCollapsedProject).toHaveBeenCalledTimes(1);

    // User B signs in before the first PUT settles.
    signIn('user-b');
    rerender(<Sidebar {...buildProps()} />);
    await waitFor(() => expect(getMySidebarCollapsedProjects).toHaveBeenCalledTimes(2));

    // A's in-flight request settles; its queued sibling must NOT go out.
    pendingPuts[0]();
    await waitFor(() => expect(getMySidebarCollapsedProjects).toHaveBeenCalledTimes(2));
    expect(putMySidebarCollapsedProject).toHaveBeenCalledTimes(1);
  });

  it('retires the eager saver queue when the account changes', async () => {
    const pendingPuts: Array<() => void> = [];
    putMySidebarCollapsedProject.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          pendingPuts.push(resolve);
        }),
    );
    const { rerender } = render(<Sidebar {...buildProps()} />);
    // Calling the eager instance directly models a click before the first
    // passive hydration effect had a chance to run. The implementation must
    // keep this instance as the account saver, not abandon it on effect setup.
    const eagerSaver = sharedSaverState.savers[0];
    eagerSaver.save(PROJECT_ID, true);
    eagerSaver.save(PROJECT_ID, false);
    expect(putMySidebarCollapsedProject).toHaveBeenCalledTimes(1);

    signIn('user-b');
    rerender(<Sidebar {...buildProps()} />);
    await waitFor(() => expect(getMySidebarCollapsedProjects).toHaveBeenCalledTimes(2));

    pendingPuts[0]();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(putMySidebarCollapsedProject).toHaveBeenCalledTimes(1);
  });

  it('keeps saving normally for the account that signed in', async () => {
    // The other half of the retire-on-account-change path: the replacement
    // saver must actually work, not be dead on arrival.
    const { rerender } = render(<Sidebar {...buildProps()} />);
    await waitFor(() => expect(getMySidebarCollapsedProjects).toHaveBeenCalledTimes(1));

    signIn('user-b');
    rerender(<Sidebar {...buildProps()} />);
    await waitFor(() => expect(getMySidebarCollapsedProjects).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByText('Test Project' as any) as any);
    await waitFor(() =>
      expect(putMySidebarCollapsedProject).toHaveBeenCalledWith(PROJECT_ID, true),
    );
  });

  it('keeps the optimistic toggle when the save fails', async () => {
    putMySidebarCollapsedProject.mockRejectedValue(new Error('boom'));
    render(<Sidebar {...buildProps()} />);
    await waitFor(() => expect(getMySidebarCollapsedProjects).toHaveBeenCalled());

    fireEvent.click(screen.getByText('Test Project' as any) as any);

    expect(isCollapsed()).toBe(true);
    await waitFor(() => expect(putMySidebarCollapsedProject).toHaveBeenCalled());
    expect(isCollapsed()).toBe(true);
  });
});
