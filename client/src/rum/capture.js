/**
 * capture.js: DOM to serializable snapshot for RUM, masking at capture time.
 *
 * This is the single chokepoint between the live DOM and anything that leaves
 * the browser. Every input value and text node passes through the masking
 * policy in `mask.js` BEFORE it lands in the returned snapshot object, so a
 * masked field's real value is never present in the payload that callers
 * serialize and send. Blocked elements are dropped entirely.
 *
 * The returned snapshot is a plain JSON-serializable tree:
 *   { tag, attributes, value?, text?, masked, blocked?, children }
 */

import { classifyElement, isBlocked, isFormControl, maskValue } from './mask.js';

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

// Safe structural attributes kept VERBATIM even on a masked node. Everything
// outside this allowlist is masked, because so many attributes can mirror a
// user-entered secret: not just `value`/`data-value`, but `title`,
// `aria-label`, `placeholder`, `alt`, `href`, `src`, and arbitrary
// framework-controlled `data-*` mirrors (`data-text`, `data-label`, …). An
// allowlist is fail-closed: an attribute family we've never seen is masked by
// default rather than leaked. The list is limited to what replay needs for
// geometry, layout, styling, and form-control state.
const STRUCTURAL_ATTRS = new Set([
  'id',
  'class',
  'type',
  'name',
  'dir',
  'lang',
  'role',
  'tabindex',
  'width',
  'height',
  'size',
  'rows',
  'cols',
  'colspan',
  'rowspan',
  'hidden',
  'disabled',
  'readonly',
  'required',
  'checked',
  'selected',
  'multiple',
  'open',
  // RUM control hints must survive so a re-capture / audit sees the same policy.
  'data-rum-block',
  'data-rum-mask',
  'data-rum-unmask',
]);

// `style` is NOT in STRUCTURAL_ATTRS: inline styles can smuggle secrets via
// custom properties (`--typed-value: 4111…`), `url(...)`, `content` strings, or
// framework-mirrored values. On a masked node we keep only a narrow allowlist
// of layout/geometry properties whose values are non-string, non-URL data.
const SAFE_STYLE_PROPS = new Set([
  // box model / layout
  'display',
  'position',
  'top',
  'right',
  'bottom',
  'left',
  'float',
  'clear',
  'width',
  'height',
  'min-width',
  'min-height',
  'max-width',
  'max-height',
  'margin',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'padding',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'box-sizing',
  'overflow',
  'overflow-x',
  'overflow-y',
  // flex / grid
  'flex',
  'flex-direction',
  'flex-wrap',
  'flex-grow',
  'flex-shrink',
  'flex-basis',
  'justify-content',
  'align-items',
  'align-self',
  'align-content',
  'gap',
  'row-gap',
  'column-gap',
  'order',
  'grid-template-columns',
  'grid-template-rows',
  'grid-column',
  'grid-row',
  // visual geometry (no text content, no URLs)
  'visibility',
  'opacity',
  'z-index',
  'vertical-align',
  'text-align',
  'white-space',
  'line-height',
  'font-size',
  'font-weight',
  'font-style',
  'border-width',
  'border-style',
]);

/**
 * Reduce an inline style to only safe, layout-bearing declarations on a masked
 * node. Drops custom properties, any value carrying `url(...)` or a quoted
 * string, `content`, and anything outside SAFE_STYLE_PROPS. Fail-closed: a
 * property we don't recognize is dropped, never kept.
 */
export function sanitizeMaskedStyle(styleText) {
  if (!styleText) return '';
  const kept = [];
  for (const decl of String(styleText).split(';')) {
    const idx = decl.indexOf(':');
    if (idx === -1) continue;
    const prop = decl.slice(0, idx).trim().toLowerCase();
    const value = decl.slice(idx + 1).trim();
    if (!prop || !value) continue;
    if (prop.startsWith('--')) continue; // custom properties can hold anything
    if (!SAFE_STYLE_PROPS.has(prop)) continue; // allowlist only
    if (/url\(/i.test(value) || /["']/.test(value)) continue; // URLs / strings
    kept.push(`${prop}: ${value}`);
  }
  return kept.join('; ');
}

function serializeAttributes(el, masked, maskChar) {
  const attrs = {};
  if (!el.attributes) return attrs;
  for (const attr of Array.from(el.attributes)) {
    if (masked && attr.name === 'style') {
      // Sanitize rather than keep verbatim or fully mask: preserves replay
      // geometry while stripping any secret-bearing declaration.
      const safe = sanitizeMaskedStyle(attr.value);
      if (safe) attrs.style = safe;
      continue;
    }
    if (masked && !STRUCTURAL_ATTRS.has(attr.name)) {
      // On a masked node, any non-structural attribute can carry the secret
      // (value, title, aria-label, placeholder, alt, href, data-*, …). Mask
      // its value but keep the attribute name so replay fidelity is preserved.
      attrs[attr.name] = maskValue(attr.value, maskChar);
      continue;
    }
    attrs[attr.name] = attr.value;
  }
  return attrs;
}

function readControlValue(el) {
  // The live `.value` property is the authoritative user input; the `value`
  // attribute alone misses anything typed after load.
  if (typeof el.value === 'string') return el.value;
  return readAttrValue(el);
}

function readAttrValue(el) {
  const v = el.getAttribute?.('value');
  return typeof v === 'string' ? v : '';
}

function serializeElement(el, options, maskChar, inheritedMask = false) {
  if (isBlocked(el)) {
    // Drop the subtree; emit a placeholder so replay geometry survives but no
    // child content (and no attributes that could leak) is captured.
    return { tag: el.tagName.toLowerCase(), blocked: true, masked: true };
  }

  // Masking is STICKY downward: once any ancestor is masked, the whole subtree
  // stays masked. This is the fail-closed direction and the only safe one. A
  // nested element is reclassified from scratch (a child <span> of a masked
  // <div> has no mask hint of its own), so without inheriting the ancestor's
  // decision its text would be captured raw and leak. An explicit unmask hint
  // on a descendant is intentionally NOT honored inside a masked subtree: you
  // cannot silently re-expose content an ancestor chose to mask.
  const masked = inheritedMask || classifyElement(el, options) === 'mask';
  const node = {
    tag: el.tagName.toLowerCase(),
    attributes: serializeAttributes(el, masked, maskChar),
    masked,
    children: [],
  };

  if (isFormControl(el)) {
    const raw = readControlValue(el);
    node.value = masked ? maskValue(raw, maskChar) : raw;
  }

  for (const child of Array.from(el.childNodes || [])) {
    const serialized = serializeNode(child, options, maskChar, masked);
    if (serialized) node.children.push(serialized);
  }

  return node;
}

function serializeNode(node, options, maskChar, inheritedMask) {
  if (!node) return null;
  if (node.nodeType === ELEMENT_NODE) {
    return serializeElement(node, options, maskChar, inheritedMask);
  }
  if (node.nodeType === TEXT_NODE) {
    const text = node.textContent || '';
    // Text inside a masked element (e.g. an explicitly masked subtree) is
    // masked too; otherwise it follows maskAllText via the parent decision.
    return { text: inheritedMask ? maskValue(text, maskChar) : text };
  }
  // Ignore comments, CDATA, etc.
  return null;
}

/**
 * Capture a DOM subtree into a masked, JSON-serializable snapshot.
 *
 * @param {Element} root            element to capture (its subtree included)
 * @param {object}  [options]       mask options (see DEFAULT_MASK_OPTIONS)
 * @returns {object} snapshot tree, safe to JSON.stringify and send
 */
export function captureSnapshot(root, options = {}) {
  if (!root || root.nodeType !== ELEMENT_NODE) {
    throw new TypeError('captureSnapshot requires an Element root');
  }
  const maskChar = options.maskChar ?? '*';
  return serializeElement(root, options, maskChar);
}

/**
 * Flatten every captured value/text string in a snapshot. Useful for tests
 * and audits that need to assert no secret survived the capture.
 */
export function collectSnapshotStrings(snapshot, acc = []) {
  if (!snapshot || typeof snapshot !== 'object') return acc;
  if (typeof snapshot.value === 'string') acc.push(snapshot.value);
  if (typeof snapshot.text === 'string') acc.push(snapshot.text);
  if (snapshot.attributes) {
    for (const v of Object.values(snapshot.attributes)) {
      if (typeof v === 'string') acc.push(v);
    }
  }
  for (const child of snapshot.children || []) {
    collectSnapshotStrings(child, acc);
  }
  return acc;
}
