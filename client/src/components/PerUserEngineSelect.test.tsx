import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import PerUserEngineSelect from './PerUserEngineSelect';

const modelConfig = {
  engineValidModels: {
    'claude-code': ['claude-opus', 'claude-sonnet'],
    'codex-cli': ['gpt-5-codex'],
    // Engines with no authenticated models must not appear as choices.
    'cursor-agent': [],
  },
};

describe('<PerUserEngineSelect>', () => {
  it('lists only engines that have models, with no shared-default option', () => {
    render(
      <PerUserEngineSelect
        agentEngine="claude-code"
        modelConfig={modelConfig}
        value=""
        onSelect={vi.fn()}
      />,
    );
    const select = screen.getByTestId('per-user-engine-select');
    expect(Array.from((select as any).options).map((o: any) => (o as any).value)).toEqual([
      'claude-code',
      'codex-cli',
    ]);
    expect(select.textContent).not.toMatch(/shared/i);
    // No saved pick: shows the agent's own engine as the selected value.
    expect(select).toHaveValue('claude-code');
  });

  it('shows the saved per-user pick when one exists', () => {
    render(
      <PerUserEngineSelect
        agentEngine="claude-code"
        modelConfig={modelConfig}
        value="codex-cli"
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByTestId('per-user-engine-select')).toHaveValue('codex-cli');
  });

  it('emits the picked engine id', () => {
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
    fireEvent.change(select, { target: { value: 'codex-cli' } } as any);
    expect(onSelect!).toHaveBeenCalledWith('codex-cli');
  });

  it('shows an unavailable saved pick as a placeholder, not the creation engine', () => {
    const onSelect = vi.fn();
    render(
      <PerUserEngineSelect
        agentEngine="claude-code"
        modelConfig={{ engineValidModels: { 'claude-code': ['claude-opus'] } }}
        value="gemini-cli"
        onSelect={onSelect}
      />,
    );
    const select = screen.getByTestId('per-user-engine-select');
    expect(select).toHaveValue('');
    expect((select as any).options[0].textContent).toMatch(/gemini-cli \(unavailable\)/);
    // The creation engine is not pre-selected, so choosing it repairs the pick.
    fireEvent.change(select, { target: { value: 'claude-code' } } as any);
    expect(onSelect).toHaveBeenCalledWith('claude-code');
  });

  it('shows an unavailable placeholder when neither pick nor agent engine is in the catalog', () => {
    const onSelect = vi.fn();
    render(
      <PerUserEngineSelect
        agentEngine="gemini-cli"
        modelConfig={{ engineValidModels: { 'claude-code': ['claude-opus'] } }}
        value=""
        onSelect={onSelect}
      />,
    );
    const select = screen.getByTestId('per-user-engine-select');
    expect(select).toHaveValue('');
    expect((select as any).options[0].textContent).toMatch(/gemini-cli \(unavailable\)/);
    expect((select as any).options[0].disabled).toBe(true);
    // The only real engine is not pre-selected, so picking it fires onSelect.
    fireEvent.change(select, { target: { value: 'claude-code' } } as any);
    expect(onSelect).toHaveBeenCalledWith('claude-code');
  });
});
