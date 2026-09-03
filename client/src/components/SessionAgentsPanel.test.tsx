import { fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SessionAgentsPanel from './SessionAgentsPanel';

const apiMock = vi.hoisted(() => ({
  addSessionAgent: vi.fn(),
  removeSessionAgent: vi.fn(),
  setSessionAgentModel: vi.fn(),
  setSessionAgentEngine: vi.fn(),
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
  engineOverride: null,
  model: 'model-a',
  projectId: 'project-1',
};
const agents = [
  { id: 'agent-1', name: 'Lead', engine: 'claude-code', projectId: 'project-1' },
  { id: 'agent-2', name: 'Helper', engine: 'claude-code', projectId: 'project-1' },
];
const modelConfig = {
  engineValidModels: {
    'claude-code': ['model-a', 'model-b'],
    'cursor-agent': ['composer-2.5'],
    'codex-cli': ['gpt-5.6-sol'],
  },
  engineDefaultModels: {
    'claude-code': 'model-a',
    'cursor-agent': 'composer-2.5',
    'codex-cli': 'gpt-5.6-sol',
  },
};

describe('SessionAgentsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.getSessionDetail.mockResolvedValue({ id: 'session-1' });
  });
  afterEach(cleanup);

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
      // The displayed add-row engine is authoritative: it is sent explicitly
      // (the agent's own engine here) so a per-user override cannot silently
      // diverge the spawn from what was shown.
      expect(apiMock.addSessionAgent).toHaveBeenCalledWith(
        'session-1',
        'agent-2',
        'model-b',
        'claude-code',
      );
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

  it('adds an advisor with the picked engine when it differs from the agent engine', async () => {
    render(
      <SessionAgentsPanel
        sessionId="session-1"
        sessionAgents={[executor]}
        agents={agents}
        modelConfig={modelConfig}
      />,
    );

    fireEvent.click(screen.getByText('Single agent'));
    const engineSelect = screen.getByLabelText('Engine for new Helper') as HTMLSelectElement;
    fireEvent.change(engineSelect, { target: { value: 'cursor-agent' } });

    // The add-row model list follows the picked engine.
    const modelSelect = screen.getByLabelText('Model for new Helper') as HTMLSelectElement;
    const modelValues = Array.from(modelSelect.options).map((o) => o.value);
    expect(modelValues).toContain('composer-2.5');
    expect(modelValues).not.toContain('model-a');

    // Click Helper's own Add button (one Add button exists per rostered agent).
    fireEvent.click(modelSelect.closest('div')!.querySelector('button')!);
    await waitFor(() => {
      expect(apiMock.addSessionAgent).toHaveBeenCalledWith(
        'session-1',
        'agent-2',
        null,
        'cursor-agent',
      );
    });
  });

  it('fires the engine override API from an existing advisor chip', async () => {
    render(
      <SessionAgentsPanel
        sessionId="session-1"
        sessionAgents={[executor, advisor]}
        agents={agents}
        modelConfig={modelConfig}
      />,
    );

    fireEvent.click(screen.getByText('2 agents (1 advisor)'));
    fireEvent.change(screen.getByLabelText('Engine for Helper'), {
      target: { value: 'codex-cli' },
    });
    await waitFor(() => {
      expect(apiMock.setSessionAgentEngine).toHaveBeenCalledWith(
        'session-1',
        'participant-1',
        'codex-cli',
      );
    });
  });
});
