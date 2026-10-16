/**
 * Turn the Agent browser pane's input frames (DOM-shaped: pointer down/up,
 * wheel deltas, `KeyboardEvent.key`) into desktop input events (xdotool-shaped:
 * click, drag, scroll clicks, keysym combos). The pane sends the same frames
 * for every surface, so the desktop needs this small amount of state: where
 * the pointer went down, and the wheel delta not yet worth a scroll click.
 */
import type { BrowserViewerInput } from '../browser-screencast.js';
import {
  DESKTOP_SCREEN,
  type DesktopInputEvent,
  type DesktopMouseButton,
} from './desktop-runtime.js';

/** Pointer travel (screen px) between down and up that makes it a drag, not a click. */
export const DESKTOP_DRAG_THRESHOLD_PX = 5;
/** Wheel delta (DOM px) per desktop scroll click; a mouse notch is ~100. */
export const DESKTOP_WHEEL_DELTA_PER_CLICK = 100;
const MAX_SCROLL_CLICKS_PER_EVENT = 10;

const NAMED_KEYSYMS: Record<string, string> = {
  Enter: 'Return',
  Backspace: 'BackSpace',
  Delete: 'Delete',
  Tab: 'Tab',
  Escape: 'Escape',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Home: 'Home',
  End: 'End',
  PageUp: 'Page_Up',
  PageDown: 'Page_Down',
  Insert: 'Insert',
  ' ': 'space',
};
for (let i = 1; i <= 12; i++) NAMED_KEYSYMS[`F${i}`] = `F${i}`;

const PUNCTUATION_KEYSYMS: Record<string, string> = {
  '-': 'minus',
  '=': 'equal',
  '[': 'bracketleft',
  ']': 'bracketright',
  ';': 'semicolon',
  "'": 'apostrophe',
  ',': 'comma',
  '.': 'period',
  '/': 'slash',
  '\\': 'backslash',
  '`': 'grave',
};

type Modifiers = { alt?: boolean; ctrl?: boolean; meta?: boolean; shift?: boolean };

/** xdotool combo for a DOM key + modifiers, or null when it has no keysym we accept. */
export function desktopKeyComboFromDomKey(key: string, modifiers?: Modifiers): string | null {
  let sym = NAMED_KEYSYMS[key];
  if (!sym && key.length === 1) {
    if (/^[A-Za-z0-9]$/.test(key)) sym = key;
    else sym = PUNCTUATION_KEYSYMS[key];
  }
  if (!sym) return null;
  const mods: string[] = [];
  if (modifiers?.ctrl) mods.push('ctrl');
  if (modifiers?.alt) mods.push('alt');
  if (modifiers?.meta) mods.push('super');
  if (modifiers?.shift) mods.push('shift');
  return [...mods, sym].join('+');
}

function clampCoord(v: number, max: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(max - 1, Math.max(0, Math.round(v)));
}

function point(x: number, y: number): { x: number; y: number } {
  return { x: clampCoord(x, DESKTOP_SCREEN.width), y: clampCoord(y, DESKTOP_SCREEN.height) };
}

export type DesktopViewerTranslation =
  | { ok: true; events: DesktopInputEvent[] }
  | { ok: false; message: string };

/** Per-pane input state. One instance per chat session's pane. */
export class DesktopViewerInputTranslator {
  private pressed: { x: number; y: number; button: DesktopMouseButton } | null = null;
  private wheel = { x: 0, y: 0 };

  translate(input: BrowserViewerInput): DesktopViewerTranslation {
    switch (input.kind) {
      case 'mouse':
        return this.mouse(input);
      case 'wheel':
        return { ok: true, events: this.scroll(input) };
      case 'key': {
        if (input.type !== 'press') {
          return { ok: false, message: 'The desktop takes key presses, not separate down/up.' };
        }
        const plain =
          input.key.length === 1 &&
          !input.modifiers?.ctrl &&
          !input.modifiers?.alt &&
          !input.modifiers?.meta;
        if (plain) return { ok: true, events: [{ type: 'type', text: input.key }] };
        const combo = desktopKeyComboFromDomKey(input.key, input.modifiers);
        if (!combo)
          return { ok: false, message: `The desktop does not accept the key ${input.key}.` };
        return { ok: true, events: [{ type: 'key', combo }] };
      }
      case 'text':
        return { ok: true, events: [{ type: 'type', text: input.text }] };
      default: {
        const _exhaustive: never = input;
        void _exhaustive;
        return { ok: false, message: 'Unknown input.' };
      }
    }
  }

  private mouse(input: Extract<BrowserViewerInput, { kind: 'mouse' }>): DesktopViewerTranslation {
    const p = point(input.x, input.y);
    const button = input.button ?? 'left';
    switch (input.type) {
      // Hover and drag motion are not replayed: xdotool drags from the down
      // point to the up point in one step.
      case 'move':
        return { ok: true, events: [] };
      case 'down':
        this.pressed = { ...p, button };
        return { ok: true, events: [] };
      case 'up': {
        const from = this.pressed;
        this.pressed = null;
        // An up without its down (the press began on another surface, before a
        // reset, or was refused) is dropped rather than invented into a click.
        if (!from) return { ok: true, events: [] };
        const moved = Math.hypot(p.x - from.x, p.y - from.y) >= DESKTOP_DRAG_THRESHOLD_PX;
        if (moved && from.button === 'left') {
          return {
            ok: true,
            events: [{ type: 'drag', fromX: from.x, fromY: from.y, toX: p.x, toY: p.y }],
          };
        }
        return { ok: true, events: [{ type: 'click', x: from.x, y: from.y, button: from.button }] };
      }
      case 'click':
        return {
          ok: true,
          events: [{ type: (input.clickCount ?? 1) >= 2 ? 'double_click' : 'click', ...p, button }],
        };
      default: {
        const _exhaustive: never = input.type;
        void _exhaustive;
        return { ok: false, message: 'Unknown mouse input.' };
      }
    }
  }

  private scroll(input: Extract<BrowserViewerInput, { kind: 'wheel' }>): DesktopInputEvent[] {
    const p = point(input.x, input.y);
    const vertical = Math.abs(input.deltaY) >= Math.abs(input.deltaX);
    const axis = vertical ? 'y' : 'x';
    const delta = vertical ? input.deltaY : input.deltaX;
    // A direction change drops the remainder so the first notch the other
    // way is not swallowed.
    if (Math.sign(delta) !== Math.sign(this.wheel[axis])) this.wheel[axis] = 0;
    this.wheel[axis] += delta;
    const clicks = Math.trunc(this.wheel[axis] / DESKTOP_WHEEL_DELTA_PER_CLICK);
    if (clicks === 0) return [];
    this.wheel[axis] -= clicks * DESKTOP_WHEEL_DELTA_PER_CLICK;
    const direction = vertical ? (clicks > 0 ? 'down' : 'up') : clicks > 0 ? 'right' : 'left';
    return [
      {
        type: 'scroll',
        ...p,
        direction,
        amount: Math.min(MAX_SCROLL_CLICKS_PER_EVENT, Math.abs(clicks)),
      },
    ];
  }
}
