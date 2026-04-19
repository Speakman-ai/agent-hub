import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SHORTCUTS,
  parseBinding,
  matchShortcut,
  formatShortcut,
  isEditableTarget,
  getPlatform,
} from './shortcuts.js';

function makeEvent({ key = '', meta = false, ctrl = false, alt = false, shift = false } = {}) {
  return {
    key,
    metaKey: meta,
    ctrlKey: ctrl,
    altKey: alt,
    shiftKey: shift,
  };
}

describe('parseBinding', () => {
  it('parses single-key bindings', () => {
    expect(parseBinding('?')).toMatchObject({ key: '?' });
    expect(parseBinding('Escape')).toMatchObject({ key: 'escape' });
  });

  it('parses Mod+Shift+N', () => {
    const b = parseBinding('Mod+Shift+N');
    expect(b).toMatchObject({ mod: true, shift: true, key: 'n' });
  });

  it('parses explicit Meta/Ctrl', () => {
    expect(parseBinding('Meta+K')).toMatchObject({ meta: true, key: 'k' });
    expect(parseBinding('Ctrl+K')).toMatchObject({ ctrl: true, key: 'k' });
  });

  it('returns null for falsy or empty input', () => {
    expect(parseBinding('')).toBeNull();
    expect(parseBinding(null)).toBeNull();
    expect(parseBinding(undefined)).toBeNull();
  });
});

describe('matchShortcut', () => {
  it('matches Mod+K on mac via metaKey', () => {
    expect(matchShortcut(makeEvent({ key: 'k', meta: true }), 'Mod+K', 'mac')).toBe(true);
    expect(matchShortcut(makeEvent({ key: 'k', ctrl: true }), 'Mod+K', 'mac')).toBe(false);
  });

  it('matches Mod+K on other via ctrlKey', () => {
    expect(matchShortcut(makeEvent({ key: 'k', ctrl: true }), 'Mod+K', 'other')).toBe(true);
    expect(matchShortcut(makeEvent({ key: 'k', meta: true }), 'Mod+K', 'other')).toBe(false);
  });

  it('requires Shift when specified', () => {
    expect(
      matchShortcut(makeEvent({ key: 'n', ctrl: true, shift: true }), 'Mod+Shift+N', 'other'),
    ).toBe(true);
    // Missing shift should NOT match
    expect(matchShortcut(makeEvent({ key: 'n', ctrl: true }), 'Mod+Shift+N', 'other')).toBe(false);
  });

  it('requires Alt when specified', () => {
    expect(
      matchShortcut(makeEvent({ key: 'n', ctrl: true, alt: true }), 'Mod+Alt+N', 'other'),
    ).toBe(true);
    // Missing alt should NOT match
    expect(matchShortcut(makeEvent({ key: 'n', ctrl: true }), 'Mod+Alt+N', 'other')).toBe(false);
  });

  it('rejects extra modifiers that the binding does not list', () => {
    // Ctrl+N should not fire when Alt is also held.
    expect(matchShortcut(makeEvent({ key: 'n', ctrl: true, alt: true }), 'Mod+N', 'other')).toBe(
      false,
    );
  });

  it('matches bare "?" even with shiftKey (shifted character)', () => {
    expect(matchShortcut(makeEvent({ key: '?' }), '?', 'other')).toBe(true);
    // Shift+/ produces "?" on most layouts; shiftKey is inherently true for "?"
    // so the matcher should accept it when the binding is just "?".
    expect(matchShortcut(makeEvent({ key: '?', shift: true }), '?', 'other')).toBe(true);
  });

  it('matches ArrowRight', () => {
    expect(
      matchShortcut(
        makeEvent({ key: 'ArrowRight', ctrl: true, shift: true }),
        'Mod+Shift+ArrowRight',
        'other',
      ),
    ).toBe(true);
  });

  it('is case-insensitive for letter keys', () => {
    // Shift+letter sometimes delivers the uppercase form as event.key
    expect(
      matchShortcut(makeEvent({ key: 'N', meta: true, shift: true }), 'Mod+Shift+N', 'mac'),
    ).toBe(true);
  });
});

describe('formatShortcut', () => {
  it('renders mac glyphs', () => {
    expect(formatShortcut('Mod+Alt+N', 'mac')).toBe('⌘⌥N');
    expect(formatShortcut('Mod+B', 'mac')).toBe('⌘B');
    expect(formatShortcut('Mod+,', 'mac')).toBe('⌘,');
  });

  it('renders plus-separated on other platforms', () => {
    expect(formatShortcut('Mod+Alt+N', 'other')).toBe('Ctrl+Alt+N');
    expect(formatShortcut('?', 'other')).toBe('?');
  });

  it('renders arrow keys as glyphs', () => {
    expect(formatShortcut('Mod+Shift+ArrowRight', 'mac')).toBe('⌘⇧→');
    expect(formatShortcut('Mod+Shift+ArrowRight', 'other')).toBe('Ctrl+Shift+→');
  });

  it('returns empty string for empty binding', () => {
    expect(formatShortcut('', 'mac')).toBe('');
  });
});

describe('isEditableTarget', () => {
  it('returns true for inputs, textareas, and contentEditable nodes', () => {
    expect(isEditableTarget({ tagName: 'INPUT' })).toBe(true);
    expect(isEditableTarget({ tagName: 'TEXTAREA' })).toBe(true);
    expect(isEditableTarget({ tagName: 'SELECT' })).toBe(true);
    expect(isEditableTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true);
  });

  it('returns false for plain elements', () => {
    expect(isEditableTarget({ tagName: 'BUTTON' })).toBe(false);
    expect(isEditableTarget({ tagName: 'DIV' })).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });
});

describe('DEFAULT_SHORTCUTS registry', () => {
  it('covers the MVP action list', () => {
    const ids = DEFAULT_SHORTCUTS.map((s) => s.id);
    const required = [
      'new-session',
      'new-ticket-chat',
      'new-doc-chat',
      'new-conference-room',
      'go-to-board',
      'go-to-wiki',
      'go-to-skills',
      'go-to-settings',
      'go-to-next-project',
      'show-help',
    ];
    for (const id of required) {
      expect(ids).toContain(id);
    }
  });

  it('has no duplicate bindings', () => {
    const bindings = DEFAULT_SHORTCUTS.map((s) => s.binding);
    const unique = new Set(bindings);
    expect(unique.size).toBe(bindings.length);
  });

  it('every shortcut parses cleanly', () => {
    for (const s of DEFAULT_SHORTCUTS) {
      const parsed = parseBinding(s.binding);
      expect(parsed, `binding "${s.binding}" for ${s.id}`).not.toBeNull();
      expect(parsed.key, `binding "${s.binding}" for ${s.id}`).toBeTruthy();
    }
  });
});

describe('getPlatform', () => {
  it('detects mac', () => {
    expect(getPlatform({ platform: 'MacIntel' })).toBe('mac');
    expect(getPlatform({ userAgentData: { platform: 'macOS' } })).toBe('mac');
  });
  it('defaults to other', () => {
    expect(getPlatform({ platform: 'Win32' })).toBe('other');
    expect(getPlatform(null)).toBe('other');
  });
});
