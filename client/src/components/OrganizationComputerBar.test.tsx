import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useState } from 'react';

vi.mock('../utils/api', () => ({ api: { getDesktopRuntime: vi.fn() } }));

import OrganizationComputerBar from './OrganizationComputerBar';

const scope = (tools: string[], extra: Record<string, unknown> = {}) => ({
  enabled: true,
  archivedAt: null,
  projects: 'all-linked' as const,
  tools,
  ...extra,
});
const assistant = {
  id: '__organization_acme__assistant',
  name: 'Organization Assistant',
  computerToolEnabled: true,
  organizationScope: scope(['computer', 'projects:read']),
};
const custom = {
  id: '__organization_acme__agent_1',
  name: 'Finance',
  computerToolEnabled: false,
  organizationScope: scope(['computer']),
};
const user = { email: 'ana@example.com' };
const runtimeOk = () => Promise.resolve({ available: true });

/** Holds the session switch the way App does: the server echo replaces the row value. */
function Harness({
  agent,
  initial = null,
  put,
  runtime = runtimeOk,
}: {
  agent: any;
  initial?: 0 | 1 | null;
  put: (enabled: boolean | null) => Promise<0 | 1 | null>;
  runtime?: () => Promise<any>;
}) {
  const [value, setValue] = useState<0 | 1 | null>(initial);
  return (
    <OrganizationComputerBar
      agent={agent}
      organizationName="Acme"
      user={user}
      sessionValue={value}
      loadRuntime={runtime}
      onChange={async (enabled) => setValue(await put(enabled))}
      onOpenViewer={() => {}}
    />
  );
}
const state = () => screen.getByTestId('organization-computer-bar').getAttribute('data-state');

describe('OrganizationComputerBar', () => {
  it('names the organization, agent and signed-in user that own the desktop', async () => {
    render(<Harness agent={assistant} put={vi.fn()} />);
    expect(screen.getByTestId('organization-computer-owner').textContent).toBe(
      'Organization Assistant in Acme · private to ana@example.com',
    );
    await waitFor(() => expect(screen.getByText('Open Computer')).toBeTruthy());
  });

  it('inherits the default-on Assistant, overrides it off, then returns to the default', async () => {
    const put = vi.fn(async (enabled: boolean | null) =>
      enabled === null ? null : enabled ? (1 as const) : (0 as const),
    );
    render(<Harness agent={assistant} put={put} />);
    expect(state()).toBe('ready');
    expect(screen.getByTestId('organization-computer-source').textContent).toBe('Agent default');

    await act(async () => fireEvent.click(screen.getByText('Turn off for this chat')));
    expect(put).toHaveBeenLastCalledWith(false);
    expect(state()).toBe('off');
    expect(screen.getByTestId('organization-computer-source').textContent).toBe('This chat');

    await act(async () => fireEvent.click(screen.getByText('Use agent default (On)')));
    expect(put).toHaveBeenLastCalledWith(null);
    expect(state()).toBe('ready');
    expect(screen.queryByText('Use agent default (On)')).toBeNull();
  });

  it('keeps a default-off custom agent off until the chat explicitly enables it', async () => {
    const put = vi.fn(async () => 1 as const);
    render(<Harness agent={custom} put={put} />);
    expect(state()).toBe('off');
    expect(screen.queryByText('Open Computer')).toBeNull();
    await act(async () => fireEvent.click(screen.getByText('Turn on for this chat')));
    expect(put).toHaveBeenCalledWith(true);
    expect(state()).toBe('ready');
    expect(screen.getByText('Use agent default (Off)')).toBeTruthy();
  });

  it('shows a denied change inline and leaves the setting untouched', async () => {
    const put = vi.fn(async () => {
      throw Object.assign(new Error('Computer is not permitted'), { status: 403 });
    });
    render(<Harness agent={custom} put={put} />);
    await act(async () => fireEvent.click(screen.getByText('Turn on for this chat')));
    expect(screen.getByRole('alert').textContent).toMatch(/isn't allowed for this agent/);
    expect(state()).toBe('off');
    expect(screen.getByText('Turn on for this chat')).not.toBeDisabled();
  });

  it('reports an unavailable backend as recoverable', async () => {
    render(
      <Harness
        agent={assistant}
        put={vi.fn()}
        runtime={() => Promise.resolve({ available: false, reason: 'Firecracker is missing.' })}
      />,
    );
    await waitFor(() => expect(state()).toBe('unavailable'));
    expect(screen.getByTestId('organization-computer-detail').textContent).toMatch(
      /Firecracker is missing\..*Chat still works/,
    );
  });

  it('treats an unknown backend status as ready rather than unavailable', async () => {
    render(
      <Harness agent={assistant} put={vi.fn()} runtime={() => Promise.reject(new Error('x'))} />,
    );
    await act(async () => {});
    expect(state()).toBe('ready');
  });

  it('offers no switch for archived agents or agents without the Computer tool', () => {
    const archived = {
      ...assistant,
      organizationScope: scope(['computer'], { archivedAt: 'now' }),
    };
    const { unmount } = render(<Harness agent={archived} initial={1} put={vi.fn()} />);
    expect(state()).toBe('agent-inactive');
    expect(screen.queryByText(/for this chat/)).toBeNull();
    unmount();
    render(
      <Harness
        agent={{ ...custom, organizationScope: scope(['web']) }}
        initial={1}
        put={vi.fn()}
      />,
    );
    expect(state()).toBe('not-permitted');
    expect(screen.queryByText('Open Computer')).toBeNull();
  });
});
