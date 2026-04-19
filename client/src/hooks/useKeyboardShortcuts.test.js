import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useKeyboardShortcuts } from './useKeyboardShortcuts.js';

function dispatchKey({ key, meta = false, ctrl = false, shift = false, alt = false, target } = {}) {
  const ev = new KeyboardEvent('keydown', {
    key,
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
    expect(handler).toHaveBeenCalled();
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
    expect(handler).not.toHaveBeenCalled();
    input.remove();
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
    expect(handler).not.toHaveBeenCalled();
  });

  it('removes the listener on unmount', () => {
    const handler = vi.fn();
    const shortcuts = [{ id: 'help', binding: '?' }];
    const { unmount } = renderHook(() =>
      useKeyboardShortcuts({ handlers: { help: handler }, shortcuts }),
    );
    unmount();
    dispatchKey({ key: '?' });
    expect(handler).not.toHaveBeenCalled();
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
    expect(bad).toHaveBeenCalled();
    expect(good).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
