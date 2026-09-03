/**
 * Pure helpers shared by the web and mobile Agent browser panes.
 *
 * The pane renders a downscaled JPEG of the agent's Chromium; input has to be
 * mapped back into the Chromium viewport's CSS-pixel space before it is sent
 * over `/api/sessions/:id/browser/ws`.
 */

export type BrowserPaneStatus = 'connecting' | 'waiting' | 'live' | 'closed' | 'error';

export interface BrowserPaneFrame {
  data: string;
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
  url: string | null;
}

export interface BrowserPaneViewport {
  width: number;
  height: number;
}

/**
 * Map a pointer position inside the rendered image (px, relative to the image
 * box) to Chromium viewport coordinates. Returns null when the geometry is
 * unknown (no frame yet / zero-size box) so callers can drop the event.
 */
export function mapPointerToViewport(
  point: { x: number; y: number },
  rendered: { width: number; height: number },
  viewport: BrowserPaneViewport | null | undefined,
): { x: number; y: number } | null {
  if (!viewport || viewport.width <= 0 || viewport.height <= 0) return null;
  if (rendered.width <= 0 || rendered.height <= 0) return null;
  const x = (point.x / rendered.width) * viewport.width;
  const y = (point.y / rendered.height) * viewport.height;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return {
    x: Math.round(Math.min(viewport.width, Math.max(0, x)) * 100) / 100,
    y: Math.round(Math.min(viewport.height, Math.max(0, y)) * 100) / 100,
  };
}

/** Size the frame image should render at inside a box, preserving aspect. */
export function fitFrameInBox(
  frame: { width: number; height: number } | null | undefined,
  box: { width: number; height: number },
): { width: number; height: number } {
  if (!frame || frame.width <= 0 || frame.height <= 0 || box.width <= 0 || box.height <= 0) {
    return { width: 0, height: 0 };
  }
  const scale = Math.min(box.width / frame.width, box.height / frame.height, 1);
  return {
    width: Math.floor(frame.width * scale),
    height: Math.floor(frame.height * scale),
  };
}

/** Keys the pane forwards as named presses (everything else must be a single printable char). */
const NAMED_KEYS = new Set([
  'Enter',
  'Backspace',
  'Delete',
  'Tab',
  'Escape',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Insert',
  'F1',
  'F2',
  'F3',
  'F4',
  'F5',
  'F6',
  'F7',
  'F8',
  'F9',
  'F10',
  'F11',
  'F12',
  ' ',
]);

export interface DomKeyLike {
  key: string;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  isComposing?: boolean;
}

/**
 * Translate a DOM keydown into a `key` input frame, or null when the key
 * should be left to the host page (browser shortcuts like Ctrl+L, IME
 * composition, lone modifier presses).
 */
export function keyInputFromDomEvent(
  ev: DomKeyLike,
): { kind: 'key'; type: 'press'; key: string; modifiers?: Record<string, boolean> } | null {
  if (ev.isComposing) return null;
  const key = ev.key;
  if (!key) return null;
  if (key === 'Shift' || key === 'Control' || key === 'Alt' || key === 'Meta') return null;
  const printable = key.length === 1;
  if (!printable && !NAMED_KEYS.has(key)) return null;
  // Browser-owned chords stay with the user's own browser.
  if ((ev.ctrlKey || ev.metaKey) && /^[lLtTnNwWrR]$/.test(key)) return null;
  const modifiers: Record<string, boolean> = {};
  if (ev.altKey) modifiers.alt = true;
  if (ev.ctrlKey) modifiers.ctrl = true;
  if (ev.metaKey) modifiers.meta = true;
  if (ev.shiftKey && !printable) modifiers.shift = true;
  return {
    kind: 'key',
    type: 'press',
    key,
    ...(Object.keys(modifiers).length ? { modifiers } : {}),
  };
}

/** Human-readable label for the pane header. */
export function browserPaneStatusLabel(status: BrowserPaneStatus): string {
  switch (status) {
    case 'connecting':
      return 'Connecting…';
    case 'waiting':
      return 'Waiting for the agent to open a browser';
    case 'live':
      return 'Live';
    case 'closed':
      return 'Browser closed';
    case 'error':
      return 'Connection error';
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

/** Normalise a URL-bar submission the way a browser would (bare host → https). */
export function normalizeUrlBarInput(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  if (/^https?:\/\//i.test(t)) return t;
  // Another explicit scheme (`ftp://`, `mailto:`) is passed through so the
  // server refuses it with its own message; `host:port` is NOT a scheme.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t) || /^[a-z][a-z0-9+.-]*:(?!\d)/i.test(t)) return t;
  return `https://${t}`;
}
