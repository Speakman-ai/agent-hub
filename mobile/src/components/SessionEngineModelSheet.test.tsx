import { describe, expect, it, vi } from 'vitest';
import type { ReactTestRenderer } from 'react-test-renderer';

process.env.NODE_ENV = 'development';
const React = (await import('react')).default;
const { default: TestRenderer, act } = await import('react-test-renderer');

vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  TouchableOpacity: 'TouchableOpacity',
  Modal: 'Modal',
  Pressable: 'Pressable',
  Alert: { alert: vi.fn() },
  StyleSheet: { create: (styles: unknown) => styles },
}));
vi.mock('../theme/colors', () => ({ colors: new Proxy({}, { get: () => '#000' }) }));
vi.mock('../utils/engineOptions', () => ({
  engineOptionsFromConfig: () => [],
  modelsForEngine: () => [],
}));

const { default: SessionEngineModelSheet } = await import('./SessionEngineModelSheet');

function render(props: Record<string, unknown>): ReactTestRenderer {
  let r!: ReactTestRenderer;
  act(() => {
    r = TestRenderer.create(
      <SessionEngineModelSheet visible onClose={() => {}} engine="claude-code" {...props} />,
    );
  });
  return r;
}

describe('mobile SessionEngineModelSheet computer tool switch', () => {
  it('flips the session switch', async () => {
    const onToggle = vi.fn().mockResolvedValue(undefined);
    const r = render({ computerToolOn: false, onToggleComputerTool: onToggle });
    const row = r.root.findByProps({ testID: 'session-computer-tool-toggle' });
    expect(row.props.accessibilityState).toEqual({ checked: false });
    await act(async () => {
      row.props.onPress();
    });
    expect(onToggle).toHaveBeenCalledWith(true);
  });

  it('shows where the value comes from and resets a session override', async () => {
    const onToggle = vi.fn().mockResolvedValue(undefined);
    const inherited = render({
      computerToolOn: true,
      computerToolSetting: { enabled: true, overridden: false, agentDefault: true },
      onToggleComputerTool: onToggle,
    });
    expect(inherited.root.findAllByProps({ testID: 'session-computer-tool-reset' })).toHaveLength(
      0,
    );
    const r = render({
      computerToolOn: true,
      computerToolSetting: { enabled: true, overridden: true, agentDefault: false },
      onToggleComputerTool: onToggle,
    });
    const reset = r.root.findByProps({ testID: 'session-computer-tool-reset' });
    await act(async () => {
      reset.props.onPress();
    });
    expect(onToggle).toHaveBeenCalledWith(null);
  });

  it('is hidden without a handler', () => {
    const r = render({});
    expect(r.root.findAllByProps({ testID: 'session-computer-tool-toggle' })).toHaveLength(0);
  });
});
