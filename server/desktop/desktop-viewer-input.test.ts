import { describe, expect, it } from 'vitest';
import { DesktopViewerInputTranslator, desktopKeyComboFromDomKey } from './desktop-viewer-input.js';

describe('desktopKeyComboFromDomKey', () => {
  it('maps DOM named keys to xdotool keysyms', () => {
    expect(desktopKeyComboFromDomKey('Enter')).toBe('Return');
    expect(desktopKeyComboFromDomKey('Backspace')).toBe('BackSpace');
    expect(desktopKeyComboFromDomKey('ArrowLeft')).toBe('Left');
    expect(desktopKeyComboFromDomKey('PageDown')).toBe('Page_Down');
    expect(desktopKeyComboFromDomKey('F5')).toBe('F5');
  });

  it('builds chords with modifiers, including punctuation keysyms', () => {
    expect(desktopKeyComboFromDomKey('l', { ctrl: true })).toBe('ctrl+l');
    expect(desktopKeyComboFromDomKey('Tab', { alt: true, shift: true })).toBe('alt+shift+Tab');
    expect(desktopKeyComboFromDomKey('-', { ctrl: true })).toBe('ctrl+minus');
    expect(desktopKeyComboFromDomKey('c', { meta: true })).toBe('super+c');
  });

  it('refuses keys without a safe keysym', () => {
    expect(desktopKeyComboFromDomKey('Dead')).toBeNull();
    expect(desktopKeyComboFromDomKey('é', { ctrl: true })).toBeNull();
    expect(desktopKeyComboFromDomKey('a b')).toBeNull();
  });
});

describe('DesktopViewerInputTranslator', () => {
  it('turns pointer down/up in place into one click at the down point', () => {
    const t = new DesktopViewerInputTranslator();
    expect(t.translate({ kind: 'mouse', type: 'down', x: 100.4, y: 50.6 })).toEqual({
      ok: true,
      events: [],
    });
    expect(t.translate({ kind: 'mouse', type: 'move', x: 101, y: 51 })).toEqual({
      ok: true,
      events: [],
    });
    expect(t.translate({ kind: 'mouse', type: 'up', x: 102, y: 52 })).toEqual({
      ok: true,
      events: [{ type: 'click', x: 100, y: 51, button: 'left' }],
    });
  });

  it('drops a pointer up that has no matching down', () => {
    const t = new DesktopViewerInputTranslator();
    expect(t.translate({ kind: 'mouse', type: 'up', x: 50, y: 60 })).toEqual({
      ok: true,
      events: [],
    });
  });

  it('turns a left press that travels into a drag', () => {
    const t = new DesktopViewerInputTranslator();
    t.translate({ kind: 'mouse', type: 'down', x: 10, y: 10 });
    expect(t.translate({ kind: 'mouse', type: 'up', x: 200, y: 300 })).toEqual({
      ok: true,
      events: [{ type: 'drag', fromX: 10, fromY: 10, toX: 200, toY: 300 }],
    });
  });

  it('keeps right clicks as clicks and clamps to the screen', () => {
    const t = new DesktopViewerInputTranslator();
    t.translate({ kind: 'mouse', type: 'down', x: 1280, y: 800, button: 'right' });
    expect(t.translate({ kind: 'mouse', type: 'up', x: 1280, y: 800, button: 'right' })).toEqual({
      ok: true,
      events: [{ type: 'click', x: 1279, y: 799, button: 'right' }],
    });
  });

  it('accumulates wheel deltas into scroll clicks', () => {
    const t = new DesktopViewerInputTranslator();
    expect(t.translate({ kind: 'wheel', x: 5, y: 5, deltaX: 0, deltaY: 40 })).toEqual({
      ok: true,
      events: [],
    });
    expect(t.translate({ kind: 'wheel', x: 5, y: 5, deltaX: 0, deltaY: 70 })).toEqual({
      ok: true,
      events: [{ type: 'scroll', x: 5, y: 5, direction: 'down', amount: 1 }],
    });
    // Reversing drops the leftover 10 instead of cancelling the first notch up.
    expect(t.translate({ kind: 'wheel', x: 5, y: 5, deltaX: 0, deltaY: -300 })).toEqual({
      ok: true,
      events: [{ type: 'scroll', x: 5, y: 5, direction: 'up', amount: 3 }],
    });
  });

  it('types plain characters and sends chords as keys', () => {
    const t = new DesktopViewerInputTranslator();
    expect(t.translate({ kind: 'key', type: 'press', key: 'A' })).toEqual({
      ok: true,
      events: [{ type: 'type', text: 'A' }],
    });
    expect(
      t.translate({ kind: 'key', type: 'press', key: 'a', modifiers: { ctrl: true } }),
    ).toEqual({ ok: true, events: [{ type: 'key', combo: 'ctrl+a' }] });
    expect(t.translate({ kind: 'key', type: 'press', key: 'Enter' })).toEqual({
      ok: true,
      events: [{ type: 'key', combo: 'Return' }],
    });
    expect(t.translate({ kind: 'text', text: 'hello' })).toEqual({
      ok: true,
      events: [{ type: 'type', text: 'hello' }],
    });
    expect(t.translate({ kind: 'key', type: 'down', key: 'a' }).ok).toBe(false);
  });
});
