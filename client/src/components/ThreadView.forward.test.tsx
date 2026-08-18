import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ThreadView from './ThreadView';

// Mock the API module: ThreadView loads thread entries on mount and calls
// forwardThreadEntry when a message is forwarded. Use the bare `vi.mock(...)`
// callee form (no `as any`, no `.js`) so Vitest's static hoisting plugin
// recognizes it and lifts the mock above the imports below — otherwise the
// real api module loads first and the on-mount fetches hit the network.
vi.mock('../utils/api', () => ({
  api: {
    getThread: vi.fn(() => Promise.resolve({ id: 't1', name: 'Nightly cron', type: 'cron' })),
    getThreadEntries: vi.fn(() =>
      Promise.resolve([
        { id: 'e1', role: 'system', content: 'deploy finished', timestamp: '2026-06-30T10:00:00' },
        { id: 'e2', role: 'user', content: 'thanks', timestamp: '2026-06-30T10:01:00' },
      ]),
    ),
    forwardThreadEntry: vi.fn(() =>
      Promise.resolve({
        session: { id: 's-fwd', agent_id: 'agent-b', name: '[Fwd] Nightly cron' },
      }),
    ),
  },
}));

import { api } from '../utils/api';

const AGENTS = [
  { id: 'agent-b', name: 'Beta', engine: 'claude-code', projectName: 'Proj', active: true },
];

describe('ThreadView — retired heartbeat threads', () => {
  it('does not render historical heartbeat logs', async () => {
    vi.mocked(api.getThread).mockResolvedValueOnce({
      id: 'hb1',
      name: 'Daily Check',
      type: 'heartbeat',
    });
    render(<ThreadView threadId="hb1" agents={AGENTS} onBack={vi.fn()} />);
    expect(await screen.findByText('This thread is no longer available')).toBeInTheDocument();
    expect(screen.queryByTestId('thread-entry-forward')).not.toBeInTheDocument();
    expect(screen.queryByText('Daily Check')).not.toBeInTheDocument();
  });
});

describe('ThreadView — forward a message to an agent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders a forward button on each entry and forwards the chosen one', async () => {
    render(
      <ThreadView
        threadId="t1"
        thread={{ id: 't1', name: 'Nightly cron', type: 'cron' }}
        agents={AGENTS}
        onForwarded={vi.fn()}
      />,
    );

    // Entries load → one forward button per entry.
    const buttons = await screen.findAllByTestId('thread-entry-forward');
    expect(buttons.length).toBe(2);

    // Open the forward modal for the first (system) entry.
    fireEvent.click(buttons[0]);
    expect(await screen.findByText('Forward message')).toBeInTheDocument();

    // Pick the target agent, then submit (the modal's submit button has the
    // exact accessible name "Forward" — distinct from the per-entry forward
    // affordances labelled "Forward message to an agent").
    fireEvent.click(screen.getByText('Beta'));
    fireEvent.click(screen.getByRole('button', { name: 'Forward' }));

    await waitFor(() => {
      expect((api as any).forwardThreadEntry).toHaveBeenCalledWith(
        't1',
        'e1',
        expect.objectContaining({ targetAgentId: 'agent-b' }),
      );
    });
  });
});
