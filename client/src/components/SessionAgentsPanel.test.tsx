import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SessionAgentsPanel from './SessionAgentsPanel';

const apiMock = vi.hoisted(() => ({
  addSessionAgent: vi.fn(),
  removeSessionAgent: vi.fn(),
  setSessionAgentModel: vi.fn(),
  getSessionDetail: vi.fn(),
  updateSession: vi.fn(),
}));

vi.mock('../utils/api', () => ({ api: apiMock }));

const executor = {
  participantId: 'executor:agent-1',
  id: 'agent-1',
  name: 'Lead',
  role: 'executor',
  engine: 'claude-code',
  model: 'model-a',
  projectId: 'project-1',
};
const advisor = {
  participantId: 'participant-1',
  id: 'agent-2',
  name: 'Helper',
  role: 'advisor',
  engine: 'claude-code',
  model: 'model-a',
  projectId: 'project-1',
};
const agents = [
  { id: 'agent-1', name: 'Lead', engine: 'claude-code', projectId: 'project-1' },
  { id: 'agent-2', name: 'Helper', engine: 'claude-code', projectId: 'project-1' },
];
const modelConfig = {
  engineValidModels: { 'claude-code': ['model-a', 'model-b'] },
};

describe('SessionAgentsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.getSessionDetail.mockResolvedValue({ id: 'session-1' });
  });

  it('keeps rostered agents addable and sends the selected model for a duplicate instance', async () => {
    render(
      <SessionAgentsPanel
        sessionId="session-1"
        sessionAgents={[executor, advisor]}
        agents={agents}
        modelConfig={modelConfig}
      />,
    );

    fireEvent.click(screen.getByText('2 agents (1 advisor)'));
    const helperModel = screen.getByLabelText('Model for new Helper');
    fireEvent.change(helperModel, {
      target: { value: 'model-b' },
    });
    fireEvent.click(helperModel.closest('div')!.querySelector('button')!);

    await waitFor(() => {
      expect(apiMock.addSessionAgent).toHaveBeenCalledWith('session-1', 'agent-2', 'model-b');
    });
  });

  it('updates and removes one advisor participant by participant id', async () => {
    render(
      <SessionAgentsPanel
        sessionId="session-1"
        sessionAgents={[executor, advisor]}
        agents={agents}
        modelConfig={modelConfig}
      />,
    );

    fireEvent.click(screen.getByText('2 agents (1 advisor)'));
    fireEvent.change(screen.getByLabelText('Model for Helper'), {
      target: { value: 'model-b' },
    });
    await waitFor(() => {
      expect(apiMock.setSessionAgentModel).toHaveBeenCalledWith(
        'session-1',
        'participant-1',
        'model-b',
      );
    });

    fireEvent.click(screen.getByRole('button', { name: '✕' }));
    await waitFor(() => {
      expect(apiMock.removeSessionAgent).toHaveBeenCalledWith('session-1', 'participant-1');
    });
  });
});
