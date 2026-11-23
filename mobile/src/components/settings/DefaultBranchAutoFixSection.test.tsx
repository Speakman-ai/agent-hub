import type { ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

process.env.NODE_ENV = 'development';
const React = (await import('react')).default;
const { default: TestRenderer, act } = await import('react-test-renderer');

vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  Switch: 'Switch',
  TouchableOpacity: 'TouchableOpacity',
  StyleSheet: { create: (styles: unknown) => styles },
}));

const { default: DefaultBranchAutoFixSection } = await import('./DefaultBranchAutoFixSection');

const agents = [
  { id: 'rev', name: 'Reviewer', role: 'reviewer' },
  { id: 'dev', name: 'Dev', role: 'dev' },
];

async function render(ciOnPush: unknown, onSave = vi.fn().mockResolvedValue(undefined)) {
  let r!: ReactTestRenderer;
  await act(async () => {
    r = TestRenderer.create(
      <DefaultBranchAutoFixSection project={{ id: 'p', agents, ciOnPush }} onSave={onSave} />,
    );
  });
  return { r, onSave };
}

function radios(r: ReactTestRenderer) {
  return r.root.findAll(
    (n) => (n.type as unknown) === 'TouchableOpacity' && n.props.accessibilityRole === 'radio',
  );
}

describe('DefaultBranchAutoFixSection', () => {
  it('toggles autoFix and shows no agent choice while off', async () => {
    const { r, onSave } = await render({ enabled: true });
    expect(radios(r)).toHaveLength(0);
    await act(async () => r.root.findByType('Switch' as never).props.onValueChange(true));
    expect(onSave).toHaveBeenCalledWith({ autoFix: true });
  });

  it('lists the default plus non-reviewer agents and saves the pick', async () => {
    const { r, onSave } = await render({ enabled: true, autoFix: true, autoFixAgentId: 'dev' });
    const options = radios(r);
    expect(options).toHaveLength(2);
    expect(options[1]!.props.accessibilityState).toEqual({ selected: true });
    await act(async () => options[0]!.props.onPress());
    expect(onSave).toHaveBeenCalledWith({ autoFixAgentId: null });
  });

  it('shows a save error inline', async () => {
    const { r } = await render({ enabled: true }, vi.fn().mockRejectedValue(new Error('nope')));
    await act(async () => r.root.findByType('Switch' as never).props.onValueChange(true));
    expect(
      r.root.findAll((n) => (n.type as unknown) === 'Text' && n.props.children === 'nope'),
    ).toHaveLength(1);
  });
});
