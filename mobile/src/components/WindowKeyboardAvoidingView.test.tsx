import type { ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
  KeyboardAvoidingView: 'KeyboardAvoidingView',
  Platform: { OS: 'ios' },
  View: 'View',
}));

// react-test-renderer only exports act() outside production builds.
const originalNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = 'development';
const React = await import('react');
const TestRenderer = (await import('react-test-renderer')).default;
const { default: WindowKeyboardAvoidingView } = await import('./WindowKeyboardAvoidingView');
process.env.NODE_ENV = originalNodeEnv;
const { act } = TestRenderer;

function render(windowY: number | undefined) {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(
      <WindowKeyboardAvoidingView testID="kav">
        <></>
      </WindowKeyboardAvoidingView>,
      {
        createNodeMock: () =>
          windowY === undefined
            ? {}
            : { measureInWindow: (cb: (x: number, y: number) => void) => cb(0, windowY) },
      },
    );
  });
  return tree;
}

const kav = (tree: ReactTestRenderer) => tree.root.findByType('KeyboardAvoidingView' as any).props;

describe('WindowKeyboardAvoidingView', () => {
  it('offsets the keyboard by how far the view sits below the top of the window', () => {
    // A Hub tab sits under the safe area, Hub header, tab strip and chat
    // toggle; a fixed offset smaller than this left the composer under the keyboard.
    const tree = render(187.4);
    expect(kav(tree).keyboardVerticalOffset).toBe(0);
    act(() => {
      tree.root.findByType('View' as any).props.onLayout();
    });
    expect(kav(tree).keyboardVerticalOffset).toBe(187);
    expect(kav(tree).behavior).toBe('padding');
  });

  it('keeps a zero offset for a full-screen view', () => {
    const tree = render(0);
    act(() => {
      tree.root.findByType('View' as any).props.onLayout();
    });
    expect(kav(tree).keyboardVerticalOffset).toBe(0);
  });

  it('tolerates a host view that cannot be measured', () => {
    const tree = render(undefined);
    act(() => {
      tree.root.findByType('View' as any).props.onLayout();
    });
    expect(kav(tree).keyboardVerticalOffset).toBe(0);
  });
});
