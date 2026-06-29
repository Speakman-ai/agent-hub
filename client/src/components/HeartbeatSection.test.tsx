import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor, fireEvent } from '@testing-library/react';
import { HeartbeatSection } from './SettingsPage';
import { api } from '../utils/api';

(vi as any).mock('../utils/api.js', () => ({
  api: {
    getHeartbeats: vi.fn(),
    getHeartbeatLogs: vi.fn(),
    getModelConfig: vi.fn(),
    updateHeartbeat: vi.fn(),
    runHeartbeat: vi.fn(),
    getHeartbeatThread: vi.fn(),
  },
}));

const HEARTBEAT = {
  agentId: 'agent-1',
  projectId: 'proj-a',
  agentName: 'Reviewer',
  color: '#888',
  heartbeat: {
    enabled: true,
    interval: '0 * * * *',
    prompt: 'Review recent work.',
    model: 'claude-opus-4-8',
  },
  latestLog: null,
  state: null,
  owner_user_id: 'user-b',
  owner_username: 'bob@example.com',
  shared: 1,
  can_manage: false,
};

describe('HeartbeatSection ownership UI', () => {
  beforeEach(() => {
    (api.getHeartbeats as any).mockResolvedValue([HEARTBEAT]);
    (api.getHeartbeatLogs as any).mockResolvedValue([]);
    (api.getModelConfig as any).mockResolvedValue({ engineValidModels: { 'claude-code': [] } });
    (api.updateHeartbeat as any).mockResolvedValue({ ...HEARTBEAT, shared: 0 });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('shows owner/shared badges and disables shared toggle for non-managers', async () => {
    const { findByText } = render(<HeartbeatSection />);

    await findByText('Reviewer');
    await waitFor(() => {
      expect(document.body.textContent).toContain('Shared');
    });
    await findByText('Owner: bob@example.com');

    const sharedToggle = await waitFor(() => {
      const input = document.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
      if (!input) throw new Error('Shared checkbox not mounted');
      return input;
    });
    expect(sharedToggle.disabled).toBe(true);
  });

  it('round-trips shared toggle updates for managers', async () => {
    (api.getHeartbeats as any).mockResolvedValueOnce([
      {
        ...HEARTBEAT,
        owner_user_id: 'user-a',
        owner_username: 'alice@example.com',
        can_manage: true,
      },
    ]);
    const { findByText } = render(<HeartbeatSection />);

    await findByText('Owner: alice@example.com');
    const sharedToggle = await waitFor(() => {
      const input = document.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
      if (!input) throw new Error('Shared checkbox not mounted');
      return input;
    });
    expect(sharedToggle.disabled).toBe(false);

    fireEvent.click(sharedToggle);

    await waitFor(() => {
      expect(api.updateHeartbeat).toHaveBeenCalledWith('agent-1', { shared: false });
    });
  });

  it('shows a toast when a shared toggle update fails', async () => {
    const showToast = vi.fn();
    (api.getHeartbeats as any).mockResolvedValueOnce([
      {
        ...HEARTBEAT,
        owner_user_id: 'user-a',
        owner_username: 'alice@example.com',
        can_manage: true,
      },
    ]);
    (api.updateHeartbeat as any).mockRejectedValueOnce(new Error('not allowed'));
    const { findByText } = render(<HeartbeatSection showToast={showToast} />);

    await findByText('Owner: alice@example.com');
    const sharedToggle = await waitFor(() => {
      const input = document.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
      if (!input) throw new Error('Shared checkbox not mounted');
      return input;
    });

    fireEvent.click(sharedToggle);

    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith('not allowed', 'error');
    });
  });

  it('closes a stale edit form when refreshed data is no longer manageable', async () => {
    let resolveRefresh: (value: any[]) => void = () => {};
    (api.getHeartbeats as any)
      .mockResolvedValueOnce([
        {
          ...HEARTBEAT,
          owner_user_id: 'user-a',
          owner_username: 'alice@example.com',
          can_manage: true,
        },
      ])
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveRefresh = resolve;
          }),
      );
    const { findByLabelText, findByText, queryByText } = render(
      <HeartbeatSection refreshMs={10} />,
    );

    fireEvent.click(await findByLabelText('Edit heartbeat'));
    await findByText('Save');

    resolveRefresh([HEARTBEAT]);

    await waitFor(() => {
      expect(queryByText('Save')).toBeNull();
    });
    expect(api.updateHeartbeat).not.toHaveBeenCalled();
  });
});
