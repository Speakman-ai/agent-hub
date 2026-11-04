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

const { default: BaseDriftSection } = await import('./BaseDriftSection');

function input(r: ReactTestRenderer, label: string) {
  return r.root.find(
    (n) => (n.type as unknown) === 'TextInput' && n.props.accessibilityLabel === label,
  );
}

function button(r: ReactTestRenderer, text: string) {
  return r.root.findAll(
    (n) =>
      (n.type as unknown) === 'TouchableOpacity' &&
      n.findAll((c) => (c.type as unknown) === 'Text' && c.props.children === text).length > 0,
  )[0]!;
}

async function render(settings: unknown, onSave = vi.fn().mockResolvedValue(undefined)) {
  let r!: ReactTestRenderer;
  await act(async () => {
    r = TestRenderer.create(<BaseDriftSection settings={settings} onSave={onSave} />);
  });
  return { r, onSave };
}

describe('BaseDriftSection', () => {
  it('saves merge-check jobs and toggles auto-update', async () => {
    const { r, onSave } = await render({});
    // Full mode: no fast-only fields.
    expect(
      r.root.findAll(
        (n) => (n.type as unknown) === 'TextInput' && n.props.accessibilityLabel === 'Hazard paths',
      ),
    ).toHaveLength(0);
    await act(async () =>
      input(r, 'Merge checks').props.onChangeText('backend-checks, frontend-build'),
    );
    await act(async () => button(r, 'Save').props.onPress());
    expect(onSave).toHaveBeenCalledWith({
      reuseJobs: [],
      hazardPaths: ['**/migrations/**', '**/db/migrate/**'],
      mergeCheckJobs: ['backend-checks', 'frontend-build'],
    });
    await act(async () => r.root.findByType('Switch' as never).props.onValueChange(true));
    expect(onSave).toHaveBeenCalledWith({ autoUpdatePrs: true });
  });

  it('switches mode and shows fast-only fields in fast mode', async () => {
    const { r, onSave } = await render({ mode: 'fast', reuseJobs: ['e2e'] });
    expect(input(r, 'Jobs that keep their earlier result').props.value).toBe('e2e');
    await act(async () => button(r, 'Off: push without re-running').props.onPress());
    expect(onSave).toHaveBeenCalledWith({ mode: 'off' });
  });

  it('off mode hides merge checks and auto-update', async () => {
    const { r } = await render({ mode: 'off' });
    expect(r.root.findAllByType('TextInput' as never)).toHaveLength(0);
    expect(r.root.findAllByType('Switch' as never)).toHaveLength(0);
  });

  it('shows a save error inline', async () => {
    const { r } = await render({}, vi.fn().mockRejectedValue(new Error('baseDrift bad')));
    await act(async () => r.root.findByType('Switch' as never).props.onValueChange(true));
    expect(
      r.root.findAll(
        (n) => (n.type as unknown) === 'Text' && n.props.accessibilityRole === 'alert',
      )[0]!.props.children,
    ).toBe('baseDrift bad');
  });
});
