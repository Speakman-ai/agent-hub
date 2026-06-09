import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import PerUserModelSelect from './PerUserModelSelect.jsx';

const modelConfig = {
  defaultModel: 'claude-opus',
  engineDefaultModels: { 'claude-code': 'claude-opus', 'codex-cli': 'gpt-5-codex' },
  engineValidModels: {
    'claude-code': ['claude-opus', 'claude-sonnet'],
    'codex-cli': ['gpt-5-codex', 'gpt-5'],
  },
};

describe('<PerUserModelSelect>', () => {
  it('lists the engine models plus a default option labeled with the fallback', () => {
    render(
      <PerUserModelSelect
        engine="claude-code"
        modelConfig={modelConfig}
        value=""
        onSelect={vi.fn()}
      />,
    );
    const select = screen.getByTestId('per-user-model-select');
    expect(Array.from(select.options).map((o) => o.value)).toEqual([
      '',
      'claude-opus',
      'claude-sonnet',
    ]);
    expect(select.options[0].textContent).toMatch(/Default \(claude-opus\)/);
  });

  it('emits the picked model id (and "" to clear)', () => {
    const onSelect = vi.fn();
    render(
      <PerUserModelSelect
        engine="claude-code"
        modelConfig={modelConfig}
        value=""
        onSelect={onSelect}
      />,
    );
    const select = screen.getByTestId('per-user-model-select');
    fireEvent.change(select, { target: { value: 'claude-sonnet' } });
    expect(onSelect).toHaveBeenCalledWith('claude-sonnet');
    fireEvent.change(select, { target: { value: '' } });
    expect(onSelect).toHaveBeenCalledWith('');
  });

  it('falls back to the default option when the value is invalid for the engine', () => {
    // 'claude-opus' is not a codex-cli model — must not render as selected.
    render(
      <PerUserModelSelect
        engine="codex-cli"
        modelConfig={modelConfig}
        value="claude-opus"
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByTestId('per-user-model-select')).toHaveValue('');
  });
});
