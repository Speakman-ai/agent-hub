import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const getProjects = vi.fn();
const getAgents = vi.fn();
const createSession = vi.fn();

(vi as any).mock('../utils/api', () => ({
  api: {
    getProjects: (...a: any[]) => getProjects(...a),
    getAgents: (...a: any[]) => getAgents(...a),
    createSession: (...a: any[]) => createSession(...a),
  },
}));

import StartSessionModal from './StartSessionModal';

describe('StartSessionModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getProjects.mockResolvedValue([{ id: 'proj-1', name: 'Project One' }]);
    getAgents.mockResolvedValue([{ id: 'agent-1', name: 'Dev', projectId: 'proj-1' }]);
    createSession.mockResolvedValue({ id: 'sess-1', agent_id: 'agent-1' });
  });

  it('creates a session seeded with the context and reports it back', async () => {
    const onStarted = vi.fn();
    const onClose = vi.fn();
    render(
      <StartSessionModal
        contextLabel="Email: Q3 planning"
        seedMessage="Here's an email I'd like to work on with you."
        defaultName="Email: Q3 planning"
        onClose={onClose}
        onStarted={onStarted}
      />,
    );

    // Agent auto-selects the only agent once projects/agents load.
    await waitFor(() => expect(getAgents).toHaveBeenCalled());
    const submit = await screen.findByTestId('start-session-submit');
    await waitFor(() => expect(submit).not.toBeDisabled());

    fireEvent.click(submit);

    await waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
    expect(createSession).toHaveBeenCalledWith('agent-1', 'Email: Q3 planning', {
      seedMessage: "Here's an email I'd like to work on with you.",
    });
    await waitFor(() =>
      expect(onStarted).toHaveBeenCalledWith({ id: 'sess-1', agent_id: 'agent-1' }),
    );
    expect(onClose).toHaveBeenCalled();
  });

  it('sends the edited seed text', async () => {
    const onStarted = vi.fn();
    render(
      <StartSessionModal
        contextLabel="Todo: ship it"
        seedMessage="original seed"
        onClose={() => {}}
        onStarted={onStarted}
      />,
    );
    await waitFor(() => expect(getAgents).toHaveBeenCalled());
    const textarea = await screen.findByTestId('start-session-seed');
    fireEvent.change(textarea, { target: { value: 'edited seed' } });
    const submit = await screen.findByTestId('start-session-submit');
    await waitFor(() => expect(submit).not.toBeDisabled());
    fireEvent.click(submit);
    await waitFor(() => expect(createSession).toHaveBeenCalled());
    expect(createSession.mock.calls[0][2]).toEqual({ seedMessage: 'edited seed' });
  });
});
