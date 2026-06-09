import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import PerUserEngineSelect from './PerUserEngineSelect.jsx';

const modelConfig = {
  engineValidModels: {
    'claude-code': ['claude-opus', 'claude-sonnet'],
    'codex-cli': ['gpt-5-codex'],
    // Engines with no authenticated models must not appear as choices.
    'cursor-agent': [],
  },
};

describe('<PerUserEngineSelect>', () => {
  it('lists only engines that have models, plus a shared-default option', () => {
    render(
      <PerUserEngineSelect
        agentEngine="claude-code"
        modelConfig={modelConfig}
        value=""
        onSelect={vi.fn()}
      />,
    );
    const select = screen.getByTestId('per-user-engine-select');
    expect(Array.from(select.options).map((o) => o.value)).toEqual([
      '',
      'claude-code',
      'codex-cli',
    ]);
    expect(select.options[0].textContent).toMatch(/Shared default \(claude-code\)/);
  });

  it('emits the picked engine id (and "" to clear)', () => {
    const onSelect = vi.fn();
    render(
      <PerUserEngineSelect
        agentEngine="claude-code"
        modelConfig={modelConfig}
        value=""
        onSelect={onSelect}
      />,
    );
    const select = screen.getByTestId('per-user-engine-select');
    fireEvent.change(select, { target: { value: 'codex-cli' } });
    expect(onSelect).toHaveBeenCalledWith('codex-cli');
    fireEvent.change(select, { target: { value: '' } });
    expect(onSelect).toHaveBeenCalledWith('');
  });

  it('falls back to the shared-default option when the value is unknown', () => {
    render(
      <PerUserEngineSelect
        agentEngine="claude-code"
        modelConfig={modelConfig}
        value="gemini-cli"
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByTestId('per-user-engine-select')).toHaveValue('');
  });
});
