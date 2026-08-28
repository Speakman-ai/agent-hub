/**
 * Pure helpers for attaching images/files to project notes. Notes are plain
 * markdown, so an attachment is just an uploaded asset referenced by markdown:
 * an image embed for pictures, a plain link for everything else. Shared by the
 * web (NotesEditor) and mobile (NotesScreen) flows so detection and markdown
 * shaping live in exactly one, unit-tested place.
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

/**
 * Sanitize a filename for use as markdown link/alt text: collapse whitespace and
 * strip the `[` / `]` characters that would break the `![alt](url)` syntax.
 * Falls back to a generic label so the reference is never empty.
 */
export function attachmentLabel(name: string | null | undefined, isImage: boolean): string {
  const cleaned = String(name || '')
    .replace(/[[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned) return cleaned;
  return isImage ? 'image' : 'file';
}

/**
 * Build the markdown snippet that references an uploaded attachment. Images use
 * the `![alt](url)` embed form; other files use a plain `[name](url)` link. The
 * snippet is wrapped in newlines so it lands as its own block regardless of
 * where the cursor sits.
 */
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

/**
 * Insert `snippet` into `text` at the given selection range, replacing whatever
 * the selection covered. Returns the new text plus the caret position that
 * should follow the inserted snippet, so a caller can restore the cursor. When
 * the selection is unknown (null), the snippet is appended to the end.
 */
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
 * Describe the single contiguous edit between two strings as the region
 * `[p, oldEnd)` in the old text that was replaced by `[p, newEnd)` in the new
 * text. A textarea `onChange` always yields one such contiguous replacement
 * (insert, delete, or replace), so common-prefix / common-suffix scanning
 * recovers it exactly without a full diff.
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
 * Map a single offset from the old text to the new text across one contiguous
 * edit (see `diffEdit`). Uses a RIGHT bias at the edit boundary so an anchor
 * sitting exactly where text is inserted rides to AFTER the inserted text — that
 * is what keeps two attachments queued at the same caret in insertion order, and
 * makes an attachment land after text the user types at its anchor:
 *   - offset strictly before the edit start → unchanged,
 *   - offset strictly after the edit end    → shifted by the length delta,
 *   - offset at the boundary or inside the edited region → rides to the end of
 *     the new region (its original surrounding context no longer exists).
 */
export function transformOffset(offset: number, oldText: string, newText: string): number {
  const { p, oldEnd, newEnd } = diffEdit(oldText, newText);
  if (offset < p) return offset;
  if (offset > oldEnd) return offset + (newEnd - oldEnd);
  return newEnd;
}

/**
 * Transform a pending insertion range across one contiguous edit so an
 * attachment whose upload started earlier still lands at the intended logical
 * position after the user has typed elsewhere. Two safety rules:
 *   - result offsets are clamped to the new text length;
 *   - if the edit disturbed the interior of a NON-empty selection, the range
 *     collapses to a caret so applying the attachment can never delete freshly
 *     typed text (a stale "replace the selection" intent is void once the user
 *     edits within it).
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
