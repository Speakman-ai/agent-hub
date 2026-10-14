/**
 * Locating text edits in a React Native composer so tracked mentions follow
 * the right occurrence.
 *
 * React Native reports an edit as the new text only, and a selection change
 * as `{ start, end }` only. Neither says which text version a selection
 * belongs to, and platforms do not document whether the caret moved by an
 * edit is reported before or after its text. A single selection value is
 * therefore ambiguous: the caret before the edit, or the caret it produced.
 *
 * So the tracker never guesses an order. It keeps the selections reported
 * since the last text change and works out every reading of the edit that
 * reproduces the new text exactly:
 *
 * - selection-first: the latest selection is the caret after the edit, the
 *   one before it (or the caret left by the previous edit) is where it began;
 * - text-first: the latest selection is where the edit began.
 *
 * One reading, or several that agree, settles it. When they disagree (pasting
 * `@bob ` before an existing `@bob `), the selection-first reading is applied
 * provisionally: on a text-first platform the caret the edit produced is
 * reported right after the text, and if it matches another reading the
 * mentions are recomputed from the text before the edit. Nothing else can
 * reinterpret an edit once that window closes or the text changes again.
 */
import { reconcileComposerMentions, type ComposerMention } from '@shared/utils/hubChatRefs';

export interface Sel {
  start: number;
  end: number;
}

/** How long a disagreeing edit waits for the caret it produced. */
export const EDIT_SETTLE_MS = 150;

/**
 * True when replacing `prev[a, b)` with `next[a, c)` turns `prev` into `next`,
 * where `b` follows from the lengths.
 */
function fits(prev: string, next: string, a: number, c: number): boolean {
  const b = prev.length - (next.length - c);
  return (
    a >= 0 &&
    a <= c &&
    a <= b &&
    b <= prev.length &&
    c <= next.length &&
    prev.slice(0, a) === next.slice(0, a) &&
    prev.slice(b) === next.slice(c)
  );
}

/** Where the edit ended if `pre` was the selection when it began. */
function fromStart(prev: string, next: string, pre: Sel): number | null {
  const start = Math.min(pre.start, pre.end);
  const end = Math.max(pre.start, pre.end);
  if (end > prev.length) return null;
  // Typing or pasting over the selection.
  const inserted = next.length - (prev.length - (end - start));
  if (inserted >= 0 && fits(prev, next, start, start + inserted)) {
    if (prev.length - (next.length - (start + inserted)) === end) return start + inserted;
  }
  if (start === end && next.length < prev.length) {
    const removed = prev.length - next.length;
    // Backspace, then forward delete.
    if (start >= removed && fits(prev, next, start - removed, start - removed)) {
      return start - removed;
    }
    if (fits(prev, next, start, start)) return start;
  }
  return null;
}

/** Whether `post` can be the caret the edit produced, starting at `pre` if known. */
function fromEnd(prev: string, next: string, pre: Sel | null, post: Sel): number | null {
  if (post.start !== post.end) return null;
  const c = post.end;
  if (pre) {
    const a = Math.min(pre.start, pre.end, c);
    return fits(prev, next, a, c) ? c : null;
  }
  const grown = next.length - prev.length;
  if (grown >= 0 && fits(prev, next, c - grown, c)) return c;
  return fits(prev, next, c, c) ? c : null;
}

/** Where an edit ended, judged from the text alone (ambiguous when text repeats). */
export function caretAfterEdit(prev: string, next: string): number {
  const min = Math.min(prev.length, next.length);
  let suffix = 0;
  while (suffix < min && prev[prev.length - 1 - suffix] === next[next.length - 1 - suffix]) {
    suffix += 1;
  }
  let prefix = 0;
  while (prefix < min - suffix && prev[prefix] === next[prefix]) prefix += 1;
  return Math.max(prefix, next.length - suffix);
}

/**
 * Every caret the edit could have ended at, given the selections reported
 * since the last text change and the caret that change left. Selection-first
 * first; the text diff only when nothing else fits.
 */
export function editReadings(
  prev: string,
  next: string,
  history: { since: Sel[]; after: Sel | null },
): number[] {
  const { since, after } = history;
  const out: number[] = [];
  const add = (c: number | null) => {
    if (c !== null && !out.includes(c)) out.push(c);
  };
  const last = since.length ? since[since.length - 1] : null;
  if (last) add(fromEnd(prev, next, since.length >= 2 ? since[since.length - 2] : after, last));
  const pre = last ?? after;
  if (pre) add(fromStart(prev, next, pre));
  if (out.length === 0) out.push(caretAfterEdit(prev, next));
  return out;
}

export interface EditResult {
  caret: number;
  mentions: ComposerMention[];
}

export function createEditTracker(settleMs: number = EDIT_SETTLE_MS) {
  let since: Sel[] = [];
  let after: Sel | null = null;
  // The text the history above was measured on. When the composer's text is
  // replaced from outside (opening a message to edit, clearing after send),
  // that history describes another text and is dropped.
  let text: string | null = null;
  const ensureText = (current: string) => {
    if (text !== null && text !== current) {
      settle();
      since = [];
      after = null;
    }
    text = current;
  };
  let pending: {
    prev: string;
    next: string;
    before: ComposerMention[];
    readings: number[];
    chosen: number;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;

  const settle = () => {
    if (pending) clearTimeout(pending.timer);
    pending = null;
  };

  return {
    /** A text change from `prev` (tracking `mentions`) to `next`. */
    onText(prev: string, next: string, mentions: ComposerMention[]): EditResult {
      ensureText(prev);
      settle();
      text = next;
      const readings = editReadings(prev, next, { since, after });
      const caret = readings[0];
      since = [];
      after = { start: caret, end: caret };
      if (readings.length > 1) {
        const timer = setTimeout(() => {
          if (pending?.timer === timer) pending = null;
        }, settleMs);
        pending = { prev, next, before: mentions, readings, chosen: caret, timer };
      }
      return { caret, mentions: reconcileComposerMentions(prev, next, mentions, caret) };
    },
    /**
     * A selection change while `value` is shown. Returns a corrected result
     * when this is the caret a just-made, ambiguous edit produced and it
     * shows a different reading was right.
     */
    onSelection(sel: Sel, value: string): EditResult | null {
      if (!(pending && value === pending.next)) ensureText(value);
      if (pending && value === pending.next && sel.start === sel.end) {
        const p = pending;
        if (p.readings.includes(sel.end)) {
          settle();
          since = [];
          after = sel;
          if (sel.end === p.chosen) return null;
          return {
            caret: sel.end,
            mentions: reconcileComposerMentions(p.prev, p.next, p.before, sel.end),
          };
        }
      }
      // The echo of a caret already known adds nothing.
      const known = since.length ? since[since.length - 1] : after;
      if (known && known.start === sel.start && known.end === sel.end) return null;
      since.push(sel);
      return null;
    },
    /** The composer placed the caret itself (after picking a suggestion). */
    setCaret(caret: number, current: string) {
      settle();
      text = current;
      since = [];
      after = { start: caret, end: caret };
    },
    dispose: settle,
  };
}

export type EditTracker = ReturnType<typeof createEditTracker>;
