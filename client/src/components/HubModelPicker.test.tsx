import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import HubModelPicker, { defaultHubModelForEngine, hubSelectableEngines } from './HubModelPicker';

const modelConfig = {
  engineValidModels: {
    'claude-code': ['claude-opus-5', 'claude-sonnet-5'],
    'codex-cli': ['gpt-5.6-sol'],
    'gemini-cli': ['gemini-2.5-pro'],
  },
  engineDefaultModels: {
    'claude-code': 'claude-opus-5',
    'codex-cli': 'gpt-5.6-sol',
  },
};

describe('HubModelPicker', () => {
  it('omits gemini-cli and reports the engine default model', () => {
    expect(hubSelectableEngines(modelConfig)).toEqual(['claude-code', 'codex-cli']);
    expect(defaultHubModelForEngine(modelConfig, 'claude-code')).toBe('claude-opus-5');
  });

  it('lets the user pick engine and model', () => {
    const onEngineChange = vi.fn();
    const onModelChange = vi.fn();
    render(
      <HubModelPicker
        modelConfig={modelConfig}
        engine="claude-code"
        model="claude-opus-5"
        onEngineChange={onEngineChange}
        onModelChange={onModelChange}
      />,
    );
    expect(screen.getByTestId('hub-model-picker')).toBeInTheDocument();
    fireEvent.change(screen.getByTestId('hub-engine-select'), { target: { value: 'codex-cli' } });
    expect(onEngineChange).toHaveBeenCalledWith('codex-cli');
    fireEvent.change(screen.getByTestId('hub-model-select'), {
      target: { value: 'claude-sonnet-5' },
    });
    expect(onModelChange).toHaveBeenCalledWith('claude-sonnet-5');
  });
});
