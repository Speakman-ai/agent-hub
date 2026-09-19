/**
 * Note attachments as markdown: image embed or a plain link.
 */

const IMAGE_EXT_RE = /\.(jpe?g|png|gif|webp|bmp|svg|avif|heic|heif)$/i;

/** True when a file should be embedded as an image rather than linked. */
export function isImageAttachment(
  name: string | null | undefined,
  contentType?: string | null,
): boolean {
  if (contentType && contentType.toLowerCase().startsWith('image/')) return true;
  if (!contentType && name && IMAGE_EXT_RE.test(name)) return true;
  return false;
}

/** Strip `[]` and collapse whitespace. Never empty. */
export function attachmentLabel(name: string | null | undefined, isImage: boolean): string {
  const cleaned = String(name || '')
    .replace(/[[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned) return cleaned;
  return isImage ? 'image' : 'file';
}

/** `![alt](url)` for images, `[name](url)` otherwise. Wrapped in newlines. */
export function buildAttachmentMarkdown(opts: {
  name?: string | null;
  url: string;
  contentType?: string | null;
}): string {
  const isImage = isImageAttachment(opts.name, opts.contentType);
  const label = attachmentLabel(opts.name, isImage);
  const ref = isImage ? `![${label}](${opts.url})` : `[${label}](${opts.url})`;
  return `\n${ref}\n`;
}

/** Insert `snippet` at the selection (or append). Returns text plus caret after it. */
export function insertAtSelection(
  text: string,
  snippet: string,
  selStart: number | null | undefined,
  selEnd: number | null | undefined,
): { text: string; cursor: number } {
  const base = text || '';
  const hasSel =
    typeof selStart === 'number' &&
    typeof selEnd === 'number' &&
    selStart >= 0 &&
    selEnd >= selStart &&
    selEnd <= base.length;
  if (!hasSel) {
    const next = base + snippet;
    return { text: next, cursor: next.length };
  }
  const next = base.slice(0, selStart) + snippet + base.slice(selEnd);
  return { text: next, cursor: (selStart as number) + snippet.length };
}

/**
 * Single contiguous edit between two strings as `[p, oldEnd)` → `[p, newEnd)`.
 * A textarea `onChange` is always one such replacement.
 */
export function diffEdit(
  oldText: string,
  newText: string,
): { p: number; oldEnd: number; newEnd: number } {
  const o = oldText || '';
  const n = newText || '';
  const oldLen = o.length;
  const newLen = n.length;
  let p = 0;
  const maxP = Math.min(oldLen, newLen);
  while (p < maxP && o[p] === n[p]) p++;
  let s = 0;
  const maxS = Math.min(oldLen - p, newLen - p);
  while (s < maxS && o[oldLen - 1 - s] === n[newLen - 1 - s]) s++;
  return { p, oldEnd: oldLen - s, newEnd: newLen - s };
}

/**
 * Map an offset across one contiguous edit. Right bias at the boundary so
 * queued attachments at the same caret stay in insertion order.
 */
export function transformOffset(offset: number, oldText: string, newText: string): number {
  const { p, oldEnd, newEnd } = diffEdit(oldText, newText);
  if (offset < p) return offset;
  if (offset > oldEnd) return offset + (newEnd - oldEnd);
  return newEnd;
}

/**
 * Transform a pending insertion range across one edit. Clamp to the new length.
 * If the edit hit the interior of a non-empty selection, collapse to a caret
 * so applying the attachment cannot delete freshly typed text.
 */
export function transformRange(
  range: { start: number; end: number },
  oldText: string,
  newText: string,
): { start: number; end: number } {
  const n = (newText || '').length;
  const { p, oldEnd } = diffEdit(oldText, newText);
  const clamp = (x: number) => Math.max(0, Math.min(x, n));
  const start = clamp(transformOffset(range.start, oldText, newText));
  const end = clamp(transformOffset(range.end, oldText, newText));
  const disturbedInterior = p < range.end && oldEnd > range.start;
  if (disturbedInterior && range.start !== range.end) {
    return { start, end: start };
  }
  return { start, end: Math.max(start, end) };
}
