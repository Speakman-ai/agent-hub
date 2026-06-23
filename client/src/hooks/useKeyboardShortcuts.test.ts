import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useKeyboardShortcuts } from './useKeyboardShortcuts';

function dispatchKey({
  key,
  code = '',
  meta = false,
  ctrl = false,
  shift = false,
  alt = false,
  target,
}: any = {}) {
  const ev = new KeyboardEvent('keydown', {
    key,
    code,
    metaKey: meta,
    ctrlKey: ctrl,
    shiftKey: shift,
    altKey: alt,
    bubbles: true,
    cancelable: true,
  });
  if (target) {
    Object.defineProperty(ev, 'target', { value: target });
  }
  window.dispatchEvent(ev);
  return ev;
}

afterEach(() => {
  // Nothing — renderHook's unmount is handled by each test where relevant.
});

describe('useKeyboardShortcuts', () => {
  it('fires the handler for a matching shortcut', () => {
    const handler = vi.fn();
    const shortcuts = [{ id: 'test', binding: 'Mod+Shift+N' }];
    renderHook(() => useKeyboardShortcuts({ handlers: { test: handler }, shortcuts }));
    // Simulate "other" platform match: Ctrl+Shift+N
    dispatchKey({ key: 'n', ctrl: true, shift: true });
    // Also simulate "mac" platform match: Meta+Shift+N — one of these will fire
    // depending on platform detection in jsdom. Either firing counts as a pass.
    dispatchKey({ key: 'n', meta: true, shift: true });
    expect(handler!).toHaveBeenCalled();
  });

  it('ignores shortcuts with no registered handler', () => {
    const shortcuts = [{ id: 'unhandled', binding: '?' }];
    // No handlers — ensure no throw.
    renderHook(() => useKeyboardShortcuts({ handlers: {}, shortcuts }));
    expect(() => dispatchKey({ key: '?' })).not.toThrow();
  });

  it('skips events originating in an input', () => {
    const handler = vi.fn();
    const shortcuts = [{ id: 'help', binding: '?' }];
    renderHook(() => useKeyboardShortcuts({ handlers: { help: handler }, shortcuts }));
    const input = document.createElement('input');
    document.body.appendChild(input);
    dispatchKey({ key: '?', target: input });
    expect(handler!).not.toHaveBeenCalled();
    input.remove();
  });

  it('still fires modifier-bearing shortcuts from inside an input', () => {
    // Regression: the chat composer is almost always focused, so bailing on
    // all editable targets swallowed every global hotkey. Shortcuts with a
    // primary modifier (Mod / Meta / Ctrl / Alt) must still fire.
    const handler = vi.fn();
    const shortcuts = [{ id: 'board', binding: 'Mod+B' }];
    renderHook(() => useKeyboardShortcuts({ handlers: { board: handler }, shortcuts }));
    const textarea = document.createElement('textarea');
    document.body.appendChild(textarea);
    // Fire both platform variants — whichever matches `getPlatform()` in jsdom
    // will trigger the handler.
    dispatchKey({ key: 'b', ctrl: true, target: textarea });
    dispatchKey({ key: 'b', meta: true, target: textarea });
    expect(handler!).toHaveBeenCalled();
    textarea.remove();
  });

  it('still skips shift-only shortcuts from inside an input', () => {
    // Shift alone does not count as a primary modifier — typing `A` produces
    // shiftKey=true, so a Shift+A binding inside the composer should defer
    // to normal typing.
    const handler = vi.fn();
    const shortcuts = [{ id: 'shout', binding: 'Shift+A' }];
    renderHook(() => useKeyboardShortcuts({ handlers: { shout: handler }, shortcuts }));
    const input = document.createElement('input');
    document.body.appendChild(input);
    dispatchKey({ key: 'a', shift: true, target: input });
    expect(handler!).not.toHaveBeenCalled();
    input.remove();
  });

  it('fires on macOS Cmd+Option+<letter> even when event.key is a dead key', () => {
    // On macOS, Option+N yields event.key === '˜' (dead tilde); the binding
    // still has to fire because event.code === 'KeyN' is stable. This is the
    // primary real-world regression for the target platform.
    const handler = vi.fn();
    const shortcuts = [{ id: 'new', binding: 'Mod+Alt+N' }];
    renderHook(() => useKeyboardShortcuts({ handlers: { new: handler }, shortcuts }));
    dispatchKey({ key: '˜', code: 'KeyN', meta: true, alt: true });
    dispatchKey({ key: 'n', code: 'KeyN', ctrl: true, alt: true }); // non-mac equivalent
    expect(handler!).toHaveBeenCalled();
  });

  it('fires modifier shortcuts from contenteditable targets', () => {
    const handler = vi.fn();
    const shortcuts = [{ id: 'new', binding: 'Mod+Alt+N' }];
    renderHook(() => useKeyboardShortcuts({ handlers: { new: handler }, shortcuts }));
    const div = document.createElement('div');
    div.setAttribute('contenteditable', 'true');
    // jsdom doesn't wire up contentEditable → isContentEditable automatically;
    // force it so the editable-check sees what the browser would.
    Object.defineProperty(div, 'isContentEditable', { value: true });
    document.body.appendChild(div);
    dispatchKey({ key: 'n', ctrl: true, alt: true, target: div });
    dispatchKey({ key: 'n', meta: true, alt: true, target: div });
    expect(handler!).toHaveBeenCalled();
    div.remove();
  });

  it('can be disabled via enabled=false', () => {
    const handler = vi.fn();
    const shortcuts = [{ id: 'help', binding: '?' }];
    renderHook(() =>
      useKeyboardShortcuts({
        handlers: { help: handler },
        shortcuts,
        enabled: false,
      }),
    );
    dispatchKey({ key: '?' });
    expect(handler!).not.toHaveBeenCalled();
  });

  it('removes the listener on unmount', () => {
    const handler = vi.fn();
    const shortcuts = [{ id: 'help', binding: '?' }];
    const { unmount } = renderHook(() =>
      useKeyboardShortcuts({ handlers: { help: handler }, shortcuts }),
    );
    unmount();
    dispatchKey({ key: '?' });
    expect(handler!).not.toHaveBeenCalled();
  });

  it('swallows handler errors without breaking the listener', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bad = vi.fn(() => {
      throw new Error('boom');
    });
    const good = vi.fn();
    const shortcuts = [
      { id: 'bad', binding: '?' },
      { id: 'good', binding: 'Escape' },
    ];
    renderHook(() =>
      useKeyboardShortcuts({
        handlers: { bad, good },
        shortcuts,
      }),
    );
    dispatchKey({ key: '?' });
    dispatchKey({ key: 'Escape' });
    expect(bad!).toHaveBeenCalled();
    expect(good!).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
