/**
 * Smoke tests for the inline per-user per-agent engine override picker
 * rendered inside each agent card on the Agents settings page.
 *
 * Covers:
 *   - Initial GET fetches once and pre-fills the dropdowns from the
 *     saved override for that agent.
 *   - Changing the engine resets the model and shows "(per-engine
 *     default)" as the implicit model fallback.
 *   - Save buttons PUT the entire `agentEngineOverrides` map (the
 *     unchanged entries for other agents must be preserved so we don't
 *     wipe a sibling's saved override).
 *   - Picking "(follow agent default)" + Save removes the entry from
 *     the PUT body for this agent.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import MyAgentEngineOverrideInline from './MyAgentEngineOverrideInline.jsx';
import { api } from '../utils/api.js';

vi.mock('../utils/api.js', () => ({
  api: {
    getMyAgentEngineOverrides: vi.fn(),
    putMyAgentEngineOverrides: vi.fn(),
  },
}));

const modelConfig = {
  engineValidModels: {
    'claude-code': ['claude-sonnet-4.5'],
    'codex-cli': ['gpt-5-codex'],
  },
};

describe('<MyAgentEngineOverrideInline>', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loads existing override and pre-fills the dropdowns', async () => {
    api.getMyAgentEngineOverrides.mockResolvedValue({
      agentEngineOverrides: {
        'agent-hub': { engine: 'codex-cli', model: 'gpt-5-codex' },
      },
    });
    render(
      <MyAgentEngineOverrideInline
        agentId="agent-hub"
        agentEngine="claude-code"
        modelConfig={modelConfig}
      />,
    );
    await waitFor(() => expect(api.getMyAgentEngineOverrides).toHaveBeenCalledTimes(1));
    const selects = await screen.findAllByRole('combobox');
    expect(selects[0].value).toBe('codex-cli');
    expect(selects[1].value).toBe('gpt-5-codex');
  });

  it('PUTs the merged map preserving overrides for OTHER agents', async () => {
    api.getMyAgentEngineOverrides.mockResolvedValue({
      agentEngineOverrides: {
        reviewer: { engine: 'cursor-agent' },
      },
    });
    api.putMyAgentEngineOverrides.mockResolvedValue({
      agentEngineOverrides: {
        reviewer: { engine: 'cursor-agent' },
        'agent-hub': { engine: 'codex-cli' },
      },
    });
    render(
      <MyAgentEngineOverrideInline
        agentId="agent-hub"
        agentEngine="claude-code"
        modelConfig={modelConfig}
      />,
    );
    await waitFor(() => expect(api.getMyAgentEngineOverrides).toHaveBeenCalled());
    const selects = await screen.findAllByRole('combobox');
    fireEvent.change(selects[0], { target: { value: 'codex-cli' } });
    const save = screen.getByRole('button', { name: /save override/i });
    fireEvent.click(save);

    await waitFor(() => expect(api.putMyAgentEngineOverrides).toHaveBeenCalledTimes(1));
    const body = api.putMyAgentEngineOverrides.mock.calls[0][0];
    expect(body.agentEngineOverrides.reviewer).toEqual({ engine: 'cursor-agent' });
    expect(body.agentEngineOverrides['agent-hub']).toEqual({ engine: 'codex-cli' });
  });

  it('clearing the engine removes the entry from the PUT body', async () => {
    api.getMyAgentEngineOverrides.mockResolvedValue({
      agentEngineOverrides: {
        'agent-hub': { engine: 'codex-cli', model: 'gpt-5-codex' },
        reviewer: { engine: 'cursor-agent' },
      },
    });
    api.putMyAgentEngineOverrides.mockResolvedValue({
      agentEngineOverrides: { reviewer: { engine: 'cursor-agent' } },
    });
    render(
      <MyAgentEngineOverrideInline
        agentId="agent-hub"
        agentEngine="claude-code"
        modelConfig={modelConfig}
      />,
    );
    await waitFor(() => expect(api.getMyAgentEngineOverrides).toHaveBeenCalled());
    const selects = await screen.findAllByRole('combobox');
    fireEvent.change(selects[0], { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /update override/i }));

    await waitFor(() => expect(api.putMyAgentEngineOverrides).toHaveBeenCalledTimes(1));
    const body = api.putMyAgentEngineOverrides.mock.calls[0][0];
    expect(body.agentEngineOverrides['agent-hub']).toBeUndefined();
    expect(body.agentEngineOverrides.reviewer).toEqual({ engine: 'cursor-agent' });
  });
});
