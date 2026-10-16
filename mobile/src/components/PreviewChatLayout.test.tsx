import { describe, expect, it, vi } from 'vitest';

process.env.NODE_ENV = 'development';

vi.mock('react-native', () => ({
  StyleSheet: { create: (s: any) => s, flatten: (s: any) => Object.assign({}, ...[s].flat(9)) },
  View: 'View',
}));

const React = await import('react');
const { default: TestRenderer, act } = await import('react-test-renderer');
const { default: PreviewChatLayout } = await import('./PreviewChatLayout');

function tracked(name: string) {
  const mounted = vi.fn();
  const unmounted = vi.fn();
  function Component() {
    React.useEffect(() => {
      mounted();
      return unmounted;
    }, []);
    return React.createElement(name);
  }
  return { Component, mounted, unmounted };
}

const flat = (style: any) => Object.assign({}, ...[style].flat(9).filter(Boolean));

describe('PreviewChatLayout', () => {
  it('keeps the preview and the composer mounted across fullscreen toggles', () => {
    const preview = tracked('Preview');
    const composer = tracked('Composer');
    const tree = (fullscreen: boolean) =>
      React.createElement(
        PreviewChatLayout,
        { preview: React.createElement(preview.Component), fullscreen },
        React.createElement(composer.Component),
      );
    let renderer!: ReturnType<typeof TestRenderer.create>;
    act(() => {
      renderer = TestRenderer.create(tree(false));
    });
    const column = () => renderer.root.findByProps({ testID: 'preview-chat-column' });
    expect(flat(column().props.style).display).toBeUndefined();
    act(() => renderer.update(tree(true)));
    expect(flat(column().props.style).display).toBe('none');
    expect(column().props.pointerEvents).toBe('none');
    act(() => renderer.update(tree(false)));
    expect(flat(column().props.style).display).toBeUndefined();

    for (const c of [preview, composer]) {
      expect(c.mounted).toHaveBeenCalledTimes(1);
      expect(c.unmounted).not.toHaveBeenCalled();
    }
  });

  it('keeps the composer mounted when the preview opens and closes', () => {
    const composer = tracked('Composer');
    const tree = (open: boolean) =>
      React.createElement(
        PreviewChatLayout,
        { preview: open ? React.createElement('Preview') : null, fullscreen: true },
        React.createElement(composer.Component),
      );
    let renderer!: ReturnType<typeof TestRenderer.create>;
    act(() => {
      renderer = TestRenderer.create(tree(false));
    });
    const column = () => renderer.root.findByProps({ testID: 'preview-chat-column' });
    // No preview: the chat shows even if fullscreen was left on.
    expect(flat(column().props.style).display).toBeUndefined();
    act(() => renderer.update(tree(true)));
    act(() => renderer.update(tree(false)));
    expect(composer.mounted).toHaveBeenCalledTimes(1);
    expect(composer.unmounted).not.toHaveBeenCalled();
  });
});
