import { useEffect, useRef } from 'react';
import {
  DEFAULT_SHORTCUTS,
  getPlatform,
  hasPrimaryModifier,
  isEditableTarget,
  matchShortcut,
} from '../utils/shortcuts.js';

// Global keydown listener that dispatches to named action handlers.
//
// Usage:
//   useKeyboardShortcuts({
//     handlers: {
//       'new-session': () => createSession(),
//       'show-help':   () => setHelpOpen(true),
//     },
//     enabled: !modalOpen,
//   });
//
// The shortcuts list defaults to `DEFAULT_SHORTCUTS`. An action fires only if
// its handler is defined in `handlers`; unknown/unhandled actions are ignored.
//
// Editable-field handling: a keydown originating in an input / textarea /
// contenteditable is only skipped when the matched shortcut has no primary
// modifier (Mod / Meta / Ctrl / Alt). Shortcuts like Cmd+B or Ctrl+Alt+N still
// fire from inside the chat composer — without this the composer focus (which
// is almost always held) would swallow every global shortcut. Plain / Shift-
// only shortcuts such as `?` or `Escape` continue to defer to typing.
export function useKeyboardShortcuts({
  handlers,
  shortcuts = DEFAULT_SHORTCUTS,
  enabled = true,
} = {}) {
  // Stash the latest handlers in a ref so we don't re-bind the listener on
  // every render. This matters because the handler map is often rebuilt
  // inline by the caller.
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  const shortcutsRef = useRef(shortcuts);
  shortcutsRef.current = shortcuts;

  useEffect(() => {
    if (!enabled) return undefined;
    const platform = getPlatform();

    const onKeyDown = (event) => {
      const editable = isEditableTarget(event.target);
      const list = shortcutsRef.current || [];
      for (const shortcut of list) {
        if (!matchShortcut(event, shortcut.binding, platform)) continue;
        // Inside editable fields, only fire bindings that carry a primary
        // modifier (Mod / Meta / Ctrl / Alt). Plain / Shift-only keys defer
        // to typing.
        if (editable && !hasPrimaryModifier(shortcut.binding)) return;
        const handler = handlersRef.current?.[shortcut.id];
        if (typeof handler !== 'function') return;
        event.preventDefault();
        try {
          handler(event, shortcut);
        } catch (err) {
          // Don't let a broken handler tear down the whole listener.
          console.error(`shortcut "${shortcut.id}" handler threw`, err);
        }
        return;
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [enabled]);
}
