// Keyboard shortcuts registry + matching/formatting helpers.
//
// Bindings are expressed as strings like "Mod+Shift+N" or "?".
//   - "Mod"   → Meta on macOS, Ctrl elsewhere
//   - "Meta"  → always Meta/Command
//   - "Ctrl"  → always Control
//   - "Alt"   → Alt / Option
//   - "Shift" → Shift
//   - The final segment is the key itself (case-insensitive, matched against
//     `event.key`). Special tokens: "?" (literal question mark), "/" (slash),
//     "Escape", "ArrowLeft", etc.
//
// `DEFAULT_SHORTCUTS` is the registry consumed by `useKeyboardShortcuts` and
// the `ShortcutsHelpModal`. Future iterations can override these per-user;
// for MVP the defaults are hardcoded and the action IDs are stable.

export const DEFAULT_SHORTCUTS = [
  {
    id: 'new-session',
    label: 'New session',
    description: 'Start a fresh chat with the active agent',
    binding: 'Mod+Alt+N',
    group: 'Create',
  },
  {
    id: 'new-ticket-chat',
    label: 'New Ticket Chat',
    description: 'Open the kanban board and start a chat for a ticket',
    binding: 'Mod+Alt+T',
    group: 'Create',
  },
  {
    id: 'new-doc-chat',
    label: 'New Doc Chat',
    description: 'Open the wiki and start a chat about a doc',
    binding: 'Mod+Alt+D',
    group: 'Create',
  },
  {
    id: 'new-conference-room',
    label: 'New conference room',
    description: 'Create a multi-agent conference room',
    binding: 'Mod+Alt+R',
    group: 'Create',
  },
  {
    id: 'go-to-board',
    label: 'Go to board',
    description: 'Jump to the kanban board for the current project',
    binding: 'Mod+B',
    group: 'Navigate',
  },
  {
    id: 'go-to-wiki',
    label: 'Wiki',
    description: 'Open the wiki for the current project',
    binding: 'Mod+Alt+W',
    group: 'Navigate',
  },
  {
    id: 'go-to-skills',
    label: 'Skills',
    description: 'Open the skills browser',
    binding: 'Mod+Shift+K',
    group: 'Navigate',
  },
  {
    id: 'go-to-settings',
    label: 'Settings',
    description: 'Open the settings page',
    binding: 'Mod+,',
    group: 'Navigate',
  },
  {
    id: 'go-to-next-project',
    label: 'Go to next project',
    description: 'Cycle to the next project in the sidebar',
    binding: 'Mod+Shift+ArrowRight',
    group: 'Navigate',
  },
  {
    id: 'show-help',
    label: 'Show keyboard shortcuts',
    description: 'Open this help dialog',
    binding: '?',
    group: 'Help',
  },
];

export function getPlatform(nav = typeof navigator !== 'undefined' ? navigator : null) {
  if (!nav) return 'other';
  // navigator.userAgentData is the modern API; fall back to platform / userAgent.
  const platform = (
    nav.userAgentData?.platform ||
    nav.platform ||
    nav.userAgent ||
    ''
  ).toLowerCase();
  if (platform.includes('mac') || platform.includes('iphone') || platform.includes('ipad')) {
    return 'mac';
  }
  return 'other';
}

// Derive the stable `KeyboardEvent.code` value for a binding key, if one
// exists. `event.code` is layout- and modifier-independent, so it's the right
// thing to check for letter/digit keys when modifiers like Option (macOS) or
// AltGr produce dead keys or composed characters — e.g. Option+N on macOS
// fires event.key === '˜' but event.code === 'KeyN'.
//
// Returns null for keys we don't have a stable code for (symbols/punctuation
// where `code` depends on layout), so matching falls back to `event.key`.
function codeForKey(key) {
  if (typeof key !== 'string' || key.length !== 1) return null;
  const c = key.toLowerCase();
  if (c >= 'a' && c <= 'z') return `Key${c.toUpperCase()}`;
  if (c >= '0' && c <= '9') return `Digit${c}`;
  return null;
}

// Parse "Mod+Shift+N" → { mod: true, shift: true, key: 'n', raw: 'Mod+Shift+N' }
export function parseBinding(binding) {
  if (typeof binding !== 'string' || binding.length === 0) {
    return null;
  }
  const parts = binding
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;
  const result = {
    mod: false,
    meta: false,
    ctrl: false,
    alt: false,
    shift: false,
    key: '',
    code: null,
    raw: binding,
  };
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const lower = part.toLowerCase();
    const isLast = i === parts.length - 1;
    if (!isLast) {
      if (lower === 'mod') result.mod = true;
      else if (lower === 'meta' || lower === 'cmd' || lower === 'command') result.meta = true;
      else if (lower === 'ctrl' || lower === 'control') result.ctrl = true;
      else if (lower === 'alt' || lower === 'option') result.alt = true;
      else if (lower === 'shift') result.shift = true;
      else {
        // Unknown modifier — treat as key (last-wins below).
        console.warn(`parseBinding: unknown modifier "${part}" in "${binding}", treating as key`);
        result.key = lower;
      }
    } else {
      result.key = lower;
    }
  }
  result.code = codeForKey(result.key);
  return result;
}

// Characters that require Shift on standard QWERTY layouts. When a binding's
// key is one of these and the binding doesn't explicitly request Shift, we
// skip the shiftKey check — the browser will fire shiftKey=true because the
// physical key requires it, but the user intent is just the character itself.
const SHIFTED_CHARS = new Set('~!@#$%^&*()_+{}|:"<>?'.split(''));

// True if the binding requires a primary modifier (Mod / Meta / Ctrl / Alt).
// Shift alone does NOT count — many typed characters require Shift, so a
// Shift-only binding should still defer to normal typing in editable fields.
// Used to decide whether a shortcut is safe to fire even when focus is inside
// a text input (Cmd+B is safe; plain `?` is not).
export function hasPrimaryModifier(binding) {
  const parsed = typeof binding === 'string' ? parseBinding(binding) : binding;
  if (!parsed) return false;
  return !!(parsed.mod || parsed.meta || parsed.ctrl || parsed.alt);
}

// Returns true if `event` satisfies `binding` on the given `platform`.
export function matchShortcut(event, binding, platform = getPlatform()) {
  const parsed = typeof binding === 'string' ? parseBinding(binding) : binding;
  if (!parsed || !parsed.key) return false;

  // Resolve "Mod" to platform's primary modifier.
  const wantMeta = parsed.meta || (parsed.mod && platform === 'mac');
  const wantCtrl = parsed.ctrl || (parsed.mod && platform !== 'mac');
  const wantAlt = parsed.alt;
  const wantShift = parsed.shift;

  if (!!event.metaKey !== !!wantMeta) return false;
  if (!!event.ctrlKey !== !!wantCtrl) return false;
  if (!!event.altKey !== !!wantAlt) return false;

  // For shifted characters (e.g. "?"), skip the shift check when the binding
  // doesn't explicitly include Shift — the keyboard produces shiftKey=true
  // inherently for these characters.
  const skipShiftCheck = !wantShift && SHIFTED_CHARS.has(parsed.key);
  if (!skipShiftCheck && !!event.shiftKey !== !!wantShift) return false;

  // Prefer `event.code` for letters/digits — it's stable across layouts and
  // doesn't collapse to a dead key when Option is held on macOS (Option+N
  // fires event.key === '˜' but event.code === 'KeyN'). Fall back to
  // `event.key` for everything else (symbols, arrows, Escape, etc.) where
  // `code` is layout-dependent.
  if (parsed.code && event.code) {
    return event.code === parsed.code;
  }
  const eventKey = (event.key || '').toLowerCase();
  return eventKey === parsed.key;
}

const KEY_DISPLAY = {
  mac: {
    mod: '⌘',
    meta: '⌘',
    ctrl: '⌃',
    alt: '⌥',
    shift: '⇧',
    arrowright: '→',
    arrowleft: '←',
    arrowup: '↑',
    arrowdown: '↓',
    escape: 'Esc',
    enter: 'Return',
    ' ': 'Space',
  },
  other: {
    mod: 'Ctrl',
    meta: 'Win',
    ctrl: 'Ctrl',
    alt: 'Alt',
    shift: 'Shift',
    arrowright: '→',
    arrowleft: '←',
    arrowup: '↑',
    arrowdown: '↓',
    escape: 'Esc',
    enter: 'Enter',
    ' ': 'Space',
  },
};

function displayToken(token, platform) {
  const table = KEY_DISPLAY[platform] || KEY_DISPLAY.other;
  const lower = token.toLowerCase();
  if (table[lower]) return table[lower];
  if (lower.length === 1) return token.toUpperCase();
  // Title-case unknown tokens like "Home" / "PageUp"
  return token.charAt(0).toUpperCase() + token.slice(1);
}

// Returns a human-readable string like "⌘⇧N" (mac) or "Ctrl+Shift+N" (other).
export function formatShortcut(binding, platform = getPlatform()) {
  if (typeof binding !== 'string' || binding.length === 0) return '';
  const parts = binding
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return '';
  const rendered = parts.map((p) => {
    const lower = p.toLowerCase();
    if (lower === 'mod') {
      return displayToken(platform === 'mac' ? 'meta' : 'ctrl', platform);
    }
    return displayToken(p, platform);
  });
  return platform === 'mac' ? rendered.join('') : rendered.join('+');
}

// True if the event originated in an editable field — we skip shortcuts there
// so typing "?" or Cmd+B inside an input still does the obvious thing.
export function isEditableTarget(target) {
  if (!target) return false;
  const tag = (target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  if (target.isContentEditable) return true;
  return false;
}
