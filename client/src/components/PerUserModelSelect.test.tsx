import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import PerUserModelSelect from './PerUserModelSelect';

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
    expect(Array.from((select as any).options).map((o: any) => (o as any).value)).toEqual([
      '',
      'claude-opus',
      'claude-sonnet',
    ]);
    expect((select as any).options[0].textContent).toMatch(/Default \(claude-opus\)/);
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
    fireEvent.change(select, { target: { value: 'claude-sonnet' } } as any);
    expect(onSelect!).toHaveBeenCalledWith('claude-sonnet');
    fireEvent.change(select, { target: { value: '' } } as any);
    expect(onSelect!).toHaveBeenCalledWith('');
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

  it('labels the default with the first advertised model when no engine default is set', () => {
    render(
      <PerUserModelSelect
        engine="cursor-agent"
        modelConfig={{
          engineDefaultModels: {},
          engineValidModels: { 'cursor-agent': ['cursor-fallback', 'cursor-other'] },
        }}
        value=""
        onSelect={vi.fn()}
      />,
    );
    expect(
      (screen.getByTestId('per-user-model-select') as HTMLSelectElement).options[0].textContent,
    ).toBe('Default (cursor-fallback)');
  });
});
