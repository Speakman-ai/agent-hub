/**
 * In-page element description for browser demo recordings.
 *
 * The describer runs inside the agent's Chromium via `page.evaluate`. It is
 * kept as a plain JavaScript source string rather than a TS function passed
 * through `toString()`, because tsx/esbuild `keepNames` injects `__name()`
 * helper calls into compiled function bodies and those don't exist in the
 * page. It reports a CSS selector, a short visible label, and whether text
 * typed into the element must be masked. It never reads an input's value.
 */

export interface DemoElementDescription {
  selector: string | null;
  text: string | null;
  tag: string | null;
  /** True when keystrokes into this element must not be stored. */
  sensitive: boolean;
}

export const DEMO_TEXT_MAX_CHARS = 80;

/**
 * Largest cut point <= max that does not split a UTF-16 surrogate pair (0
 * when even one code point does not fit).
 */
export function codePointCut(text: string, max: number): number {
  if (max <= 0) return 0;
  if (text.length <= max) return text.length;
  const code = text.charCodeAt(max - 1);
  return code >= 0xd800 && code <= 0xdbff ? max - 1 : max;
}

/**
 * `point` set: the element under that viewport coordinate (a click target).
 * `point` null: the focused element (where typed text lands).
 */
const DESCRIBE_ELEMENT_FN = String.raw`function (point) {
  var MAX = ${DEMO_TEXT_MAX_CHARS};
  var SENSITIVE_AUTOCOMPLETE = /password|one-time-code|cc-(number|csc|exp)/i;
  var SENSITIVE_HINT = /pass|pwd|otp|one.?time|2fa|mfa|totp|(^|[^a-z])pin([^a-z]|$)|cvv|cvc|csc|card.?num|cc.?num|ssn|secret/i;
  var PLAIN_INPUT_TYPES = { text: 1, search: 1, email: 1, url: 1, tel: 1, number: 1 };
  // Typed text is stored in the clear only for a control positively known to
  // be plain text entry. Anything else, including a shadow host whose closed
  // root hides the real focused field, custom elements and frames, is masked.
  function plainTextEntry(node) {
    var t = node.tagName.toLowerCase();
    if (t === 'textarea') return true;
    if (t === 'input') {
      return PLAIN_INPUT_TYPES[(node.getAttribute('type') || 'text').toLowerCase()] === 1;
    }
    if (node.isContentEditable === true) return true;
    var ce = node.getAttribute('contenteditable');
    return ce === '' || ce === 'true' || ce === 'plaintext-only';
  }
  function clean(s) {
    if (!s) return null;
    var t = String(s).replace(/\s+/g, ' ').trim();
    if (!t) return null;
    if (t.length <= MAX) return t;
    var cut = MAX - 1;
    // Never end on half of a surrogate pair.
    var code = t.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
    return t.slice(0, cut) + '\u2026';
  }
  function cssEscape(s) {
    if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(s);
    return s.replace(/[^a-zA-Z0-9_-]/g, function (c) { return '\\' + c; });
  }
  function attrValue(s) { return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"'); }
  function unique(sel, root) {
    try { return (root || document).querySelectorAll(sel).length === 1; } catch (e) { return false; }
  }


  var el = null;
  if (point) {
    el = document.elementFromPoint(point.x, point.y);
    while (el && el.shadowRoot) {
      var inner = el.shadowRoot.elementFromPoint(point.x, point.y);
      if (!inner || inner === el) break;
      el = inner;
    }
  } else {
    el = document.activeElement;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
    if (el === document.body || el === document.documentElement) el = null;
  }
  // Unknown focus: keystrokes might be going anywhere, so mask them.
  if (!el) return { selector: null, text: null, tag: null, sensitive: !point };

  var tag = el.tagName.toLowerCase();
  // A frame (payment widget, embedded sign-in) hides what has focus inside
  // it, so keystrokes there are treated as sensitive.
  if (tag === 'iframe' || tag === 'frame') {
    return { selector: null, text: null, tag: tag, sensitive: true };
  }

  var autocomplete = el.getAttribute('autocomplete') || '';
  var hints = [
    el.getAttribute('name'),
    el.id,
    el.getAttribute('aria-label'),
    el.getAttribute('placeholder'),
  ].join(' ');
  var sensitive =
    !plainTextEntry(el) ||
    SENSITIVE_AUTOCOMPLETE.test(autocomplete) ||
    SENSITIVE_HINT.test(hints);

  // Climb from an icon/span inside a button or link to the control itself.
  var target = el;
  if (point && el.closest) {
    var control = el.closest('a,button,input,select,textarea,label,summary,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="option"],[role="checkbox"]');
    if (control) target = control;
  }

  // Selector for node within its own root (the document or a shadow root):
  // uniqueness is checked inside that root and the climb stops at it.
  function selectorInRoot(node, root) {
    var t = node.tagName.toLowerCase();
    if (node.id && unique('#' + cssEscape(node.id), root)) return '#' + cssEscape(node.id);
    var attrs = ['data-testid', 'data-test', 'data-qa', 'name', 'aria-label'];
    for (var i = 0; i < attrs.length; i++) {
      var v = node.getAttribute(attrs[i]);
      if (v) {
        var s = t + '[' + attrs[i] + '="' + attrValue(v) + '"]';
        if (unique(s, root)) return s;
      }
    }
    var parts = [];
    var cur = node;
    while (cur && cur !== document.documentElement && parts.length < 5) {
      if (cur !== node && cur.id && unique('#' + cssEscape(cur.id), root)) {
        parts.unshift('#' + cssEscape(cur.id));
        break;
      }
      // At the top of a shadow tree the parent is the root itself.
      var parent = cur.parentNode;
      var part = cur.tagName.toLowerCase();
      if (parent && parent.children) {
        var same = [];
        for (var j = 0; j < parent.children.length; j++) {
          if (parent.children[j].tagName === cur.tagName) same.push(parent.children[j]);
        }
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(cur) + 1) + ')';
      }
      parts.unshift(part);
      var joined = parts.join(' > ');
      if (unique(joined, root)) return joined;
      if (!parent || parent === root) break;
      cur = parent;
    }
    return parts.join(' > ');
  }

  // Shadow-host chain, outermost first, joined with Playwright's ' >> '
  // chaining so the selector identifies the control across shadow roots.
  function buildSelector(node) {
    var segments = [];
    var cur = node;
    for (var depth = 0; cur && depth < 8; depth++) {
      var root = cur.getRootNode ? cur.getRootNode() : document;
      segments.unshift(selectorInRoot(cur, root));
      cur = root && root.host ? root.host : null;
    }
    return segments.join(' >> ');
  }

  function labelOf(node) {
    var aria = clean(node.getAttribute('aria-label'));
    if (aria) return aria;
    var t = node.tagName.toLowerCase();
    if (t === 'input' || t === 'textarea' || t === 'select') {
      var fromLabel = node.labels && node.labels[0] ? clean(node.labels[0].textContent) : null;
      if (fromLabel) return fromLabel;
      var type = (node.getAttribute('type') || '').toLowerCase();
      // Button-like inputs show their value; other inputs never expose it.
      if (type === 'submit' || type === 'button' || type === 'reset') {
        return clean(node.getAttribute('value')) || type;
      }
      return clean(node.getAttribute('placeholder')) || clean(node.getAttribute('title'));
    }
    // An editable region's text is user input, never a label: it may hold
    // what was typed (and masked) earlier.
    if (node.isContentEditable === true || (node.closest && node.closest('[contenteditable]:not([contenteditable="false"])'))) {
      return clean(node.getAttribute('title'));
    }
    var text = typeof node.innerText === 'string' ? node.innerText : node.textContent;
    return clean(text) || clean(node.getAttribute('title')) || clean(node.getAttribute('alt'));
  }

  return {
    selector: buildSelector(target),
    text: labelOf(target),
    tag: target.tagName.toLowerCase(),
    sensitive: sensitive
  };
}`;

/** Marker so test fakes (and readers) can tell the document-token script apart. */
export const DOC_TOKEN_MARKER = 'agent-hub.demo.document';

/**
 * Expression returning a token unique to the current document. It is created
 * on first read and kept on `window` under a registry symbol (not a string
 * key, so page script won't trip over it); a reload or a new document at the
 * same URL gets a new token.
 */
const DOC_TOKEN_EXPR = `(function () {
  var k = Symbol.for('${DOC_TOKEN_MARKER}');
  if (!window[k]) {
    Object.defineProperty(window, k, {
      value: Math.random().toString(36).slice(2) + Date.now().toString(36),
    });
  }
  return window[k];
})()`;

/** evaluate() source returning just the document token. */
export const DOC_TOKEN_SCRIPT = DOC_TOKEN_EXPR;

/** The document token, or null when the page returned something else. */
export function parseDocToken(raw: unknown): string | null {
  return typeof raw === 'string' && raw.length > 0 && raw.length <= 64 ? raw : null;
}

/** What one page read asks for besides the document token. */
export type PageReadMode =
  | { kind: 'point'; x: number; y: number }
  | { kind: 'focus' }
  | { kind: 'none' };

export interface PageRead {
  /** Token of the document this read ran in; null when unreadable. */
  doc: string | null;
  /** The described element (point / focus modes), or null. */
  target: DemoElementDescription | null;
}

/** Marker at the start of every page-read script, followed by its mode. */
export const PAGE_READ_MARKER = '/*agent-hub.demo.read:';

/**
 * evaluate() source for one page read: the document token and the requested
 * target come back together from one synchronous run in the page, so they
 * always describe the same document. Never read them in separate round trips.
 */
export function pageReadScript(mode: PageReadMode): string {
  const target =
    mode.kind === 'none'
      ? 'null'
      : `(${DESCRIBE_ELEMENT_FN})(${
          mode.kind === 'point' ? JSON.stringify({ x: mode.x, y: mode.y }) : 'null'
        })`;
  return `${PAGE_READ_MARKER}${mode.kind}*/(function () {
  return { doc: ${DOC_TOKEN_EXPR}, target: ${target} };
})()`;
}

/** Normalize a page read; anything malformed reads as unknown document and target. */
export function parsePageRead(raw: unknown): PageRead {
  if (!raw || typeof raw !== 'object') return { doc: null, target: null };
  const r = raw as Record<string, unknown>;
  return { doc: parseDocToken(r.doc), target: parseDemoElementDescription(r.target) };
}

/** The evaluate() source describing the element at `point`, or the focused one. */
export function describeElementScript(point: { x: number; y: number } | null): string {
  const arg = point ? JSON.stringify({ x: point.x, y: point.y }) : 'null';
  return `(${DESCRIBE_ELEMENT_FN})(${arg})`;
}

/**
 * Normalize whatever evaluate() returned. A malformed result reports
 * `sensitive: true` so an unreadable target never leaks typed text.
 */
export function parseDemoElementDescription(raw: unknown): DemoElementDescription | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown, max: number): string | null =>
    typeof v === 'string' && v ? v.slice(0, codePointCut(v, max)) : null;
  return {
    selector: str(r.selector, 512),
    text: str(r.text, DEMO_TEXT_MAX_CHARS),
    tag: str(r.tag, 32),
    sensitive: r.sensitive !== false,
  };
}
