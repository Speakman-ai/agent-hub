/**
 * mask.js: Capture-time privacy masking decisions for RUM.
 *
 * Compliance rule: masking happens at *capture*, in the browser, so that
 * unmasked text / input values never get serialized into a capture payload
 * and therefore never hit the wire. Every decision here is intentionally
 * fail-closed: when in doubt, mask.
 *
 * Three knobs, in priority order (highest wins):
 *   1. Block: element (and its subtree) is dropped entirely from capture.
 *   2. Always-mask: autocomplete/PII-sensitive fields (cc/cvv/expiry,
 *                    passwords). Masked even if the page tries to opt out.
 *   3. Mask / Unmask: explicit per-element hints, then the global
 *                      `maskAllInputs` default.
 *
 * Opt-in/out is expressed with attributes OR classes so it works for both
 * hand-authored markup and frameworks that only let you set className:
 *   - block : `data-rum-block`  / class `rum-block`
 *   - mask  : `data-rum-mask`   / class `rum-mask`
 *   - unmask: `data-rum-unmask` / class `rum-unmask`
 */

// Fail-closed capture baseline used when NO masking mode is supplied (e.g. a
// bare `captureSnapshot(root)` / `classifyElement(el)`). `maskAllInputs` is ON
// so a caller that forgets to configure masking still leaks nothing. This is
// NOT the RUM wizard's "passwords-only" policy — that is an explicit opt-out the
// wizard always passes via `maskOptionsForMode(false)` (which turns this flag
// off). Password / payment / PII fields are masked independently and always (see
// `isAlwaysMaskedField`), regardless of these flags.
export const DEFAULT_MASK_OPTIONS = Object.freeze({
  maskAllInputs: true,
  maskAllText: false,
  maskChar: '*',
});

/**
 * Resolve capture options for the RUM wizard's per-app masking mode. The single
 * `maskAllText` boolean selects the whole policy — `maskAllInputs` moves with it,
 * deliberately overriding the fail-closed `DEFAULT_MASK_OPTIONS.maskAllInputs`
 * baseline:
 *
 *   - `false` — "passwords & PII only" (the wizard's default selection): record
 *     other input values and all visible text verbatim; only password/PII fields
 *     are masked (those are ALWAYS masked via `isAlwaysMaskedField`, regardless
 *     of these flags). Resolves to `{ maskAllInputs: false, maskAllText: false }`.
 *   - `true` — "mask everything": mask every input value AND all text; only
 *     structure/layout/timing is captured. Resolves to
 *     `{ maskAllInputs: true, maskAllText: true }`.
 *
 * Any non-`true` value is coerced to the passwords-only mode. Note this differs
 * from a bare `DEFAULT_MASK_OPTIONS`, which masks all inputs — the wizard always
 * calls this builder so the recorder it injects never relies on that baseline.
 */
export function maskOptionsForMode(maskAllText: any) {
  const maskEverything = maskAllText === true;
  return Object.freeze({
    ...DEFAULT_MASK_OPTIONS,
    maskAllInputs: maskEverything,
    maskAllText: maskEverything,
  });
}

/**
 * Regexes that mark a field as ALWAYS masked regardless of opt-out hints.
 * Matched against autocomplete tokens, name, id, aria-label and placeholder.
 * Exported so tests can assert the exact coverage surface.
 */
export const ALWAYS_MASK_PATTERNS = Object.freeze([
  // Credit card number
  /card.?number|cc.?number|card.?num|ccnum|credit.?card|\bpan\b/i,
  // CVV / CVC / CSC / security code
  /\bcvv\b|\bcvc\b|\bcsc\b|security.?code|card.?(security|verification)|verification.?(value|code)/i,
  // Expiration date / month / year
  /expir|cc.?exp|exp.?(date|month|year)|card.?exp/i,
]);

/**
 * Autocomplete tokens (per the WHATWG/HTML spec) that are always masked.
 * These are normative, so we treat them as authoritative when present.
 */
const SENSITIVE_AUTOCOMPLETE_TOKENS = new Set([
  'cc-number',
  'cc-csc',
  'cc-exp',
  'cc-exp-month',
  'cc-exp-year',
  'current-password',
  'new-password',
  'one-time-code',
]);

function readAttr(el: any, name: any) {
  if (!el || typeof el.getAttribute !== 'function') return '';
  const v = el.getAttribute(name);
  return typeof v === 'string' ? v : '';
}

function hasClass(el: any, name: any) {
  if (!el) return false;
  // classList is most reliable; fall back to className string for safety.
  if (el.classList && typeof el.classList.contains === 'function') {
    return el.classList.contains(name);
  }
  const cn = typeof el.className === 'string' ? el.className : '';
  return cn.split(/\s+/).includes(name);
}

function hasFlag(el: any, attr: any, klass: any) {
  if (!el || typeof el.getAttribute !== 'function') return false;
  return el.hasAttribute?.(attr) === true || hasClass(el, klass);
}

/** True when the element (and subtree) must be excluded from capture. */
export function isBlocked(el: any) {
  return hasFlag(el, 'data-rum-block', 'rum-block');
}

function hasMaskHint(el: any) {
  return hasFlag(el, 'data-rum-mask', 'rum-mask');
}

function hasUnmaskHint(el: any) {
  return hasFlag(el, 'data-rum-unmask', 'rum-unmask');
}

/** Is this a form control whose value we'd otherwise capture? */
export function isFormControl(el: any) {
  if (!el || !el.tagName) return false;
  const tag = el.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select';
}

/**
 * Fields that carry payment-card / credential data. These are masked even
 * when the page explicitly asks to unmask, since opting a CVV field back in is
 * never a legitimate request, so we refuse it.
 */
export function isAlwaysMaskedField(el: any) {
  if (!el || !el.tagName) return false;
  const tag = el.tagName.toLowerCase();
  const type = (readAttr(el, 'type') || el.type || '').toLowerCase();

  if (tag === 'input' && type === 'password') return true;

  const autocomplete = (readAttr(el, 'autocomplete') || '').toLowerCase();
  for (const token of autocomplete.split(/\s+/)) {
    if (SENSITIVE_AUTOCOMPLETE_TOKENS.has(token)) return true;
  }

  // Heuristic fallback for markup that omits a proper autocomplete attribute.
  const haystack = [
    readAttr(el, 'name'),
    readAttr(el, 'id'),
    readAttr(el, 'aria-label'),
    readAttr(el, 'placeholder'),
    autocomplete,
  ].join(' ');
  return ALWAYS_MASK_PATTERNS.some((re: any) => re.test(haystack));
}

/**
 * Classify a single element into one of: 'block' | 'mask' | 'unmask'.
 * Pure function of the element + options; no DOM mutation.
 */
export function classifyElement(el: any, options: any = {}) {
  const opts = { ...DEFAULT_MASK_OPTIONS, ...options };

  if (isBlocked(el)) return 'block';

  // Sensitive fields can never be unmasked, regardless of hints.
  if (isAlwaysMaskedField(el)) return 'mask';

  if (hasMaskHint(el)) return 'mask';
  if (hasUnmaskHint(el)) return 'unmask';

  if (isFormControl(el)) {
    return opts.maskAllInputs ? 'mask' : 'unmask';
  }

  // Non-control elements (text-bearing nodes) follow maskAllText.
  return opts.maskAllText ? 'mask' : 'unmask';
}

/**
 * Replace the visible content of a string with the mask char, preserving
 * length and whitespace layout (matches rrweb's default text masker). This
 * keeps replay geometry intact while leaking zero characters.
 */
export function maskValue(value: any, maskChar: any = DEFAULT_MASK_OPTIONS.maskChar) {
  if (value == null) return value;
  const str = String(value);
  let out = '';
  for (const ch of str) {
    out += /\s/.test(ch) ? ch : maskChar;
  }
  return out;
}

/**
 * Should this element's captured value be masked? Convenience wrapper over
 * classifyElement for the common input case.
 */
export function shouldMaskValue(el: any, options: any = {}) {
  return classifyElement(el, options) === 'mask';
}
