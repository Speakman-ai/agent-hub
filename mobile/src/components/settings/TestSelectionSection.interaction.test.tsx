import type { ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

process.env.NODE_ENV = 'development';
const React = (await import('react')).default;
const { default: TestRenderer, act } = await import('react-test-renderer');

vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  TextInput: 'TextInput',
  Switch: 'Switch',
  TouchableOpacity: 'TouchableOpacity',
  StyleSheet: { create: (styles: unknown) => styles },
}));

const { default: TestSelectionSection } = await import('./TestSelectionSection');

const jobs = [{ job_id: 'lint', configured: true }];

function chip(r: ReactTestRenderer, id: string) {
  return r.root.findAll(
    (n) =>
      (n.type as unknown) === 'TouchableOpacity' &&
      n.findAll((c) => (c.type as unknown) === 'Text' && c.props.children === id).length > 0,
  )[0];
}

describe('TestSelectionSection interactions', () => {
  it('keeps unsaved list edits when only the mode is saved', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    let r!: ReactTestRenderer;
    await act(async () => {
      r = TestRenderer.create(
        <TestSelectionSection settings={{}} ciOnPushEnabled tests={jobs} onSave={onSave} />,
      );
    });
    await act(async () => chip(r, 'lint').props.onPress());
    await act(async () =>
      r.root.findByType('TextInput' as never).props.onChangeText('fixtures/a,b/**'),
    );
    await act(async () => r.root.findByType('Switch' as never).props.onValueChange(true));
    expect(onSave).toHaveBeenCalledWith({ mode: 'dynamic' });

    await act(async () => {
      r.update(
        <TestSelectionSection
          settings={{ mode: 'dynamic' }}
          ciOnPushEnabled
          tests={jobs}
          onSave={onSave}
        />,
      );
    });
    expect(chip(r, 'lint').props.accessibilityState).toEqual({ selected: true });
    expect(r.root.findByType('TextInput' as never).props.value).toBe('fixtures/a,b/**');

    const save = r.root.findAll(
      (n) =>
        (n.type as unknown) === 'TouchableOpacity' &&
        n.findAll((c) => (c.type as unknown) === 'Text' && c.props.children === 'Save').length > 0,
    )[0];
    expect(save.props.disabled).toBe(false);
    await act(async () => save.props.onPress());
    expect(onSave).toHaveBeenLastCalledWith({
      alwaysRun: ['lint'],
      fullRunPaths: ['fixtures/a,b/**'],
    });
  });
});
