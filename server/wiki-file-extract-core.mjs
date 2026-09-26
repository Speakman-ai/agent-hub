// Text extraction for uploaded wiki files. Everything here touches untrusted
// document bytes, so it runs only inside the parser child process
// (wiki-file-extract-child.mjs), which the server time-boxes, memory-caps, and
// kills on overrun. Nothing in this module may be called from the server's
// main process. Every string pass is linear: no regex here can backtrack
// across a long run of attacker-chosen characters.
//
// Plain JS so the child loads it with plain node (and Electron's node mode);
// types live in wiki-file-extract-core.d.mts.
import sanitizeHtml from 'sanitize-html';

/** Error codes the parent maps to HTTP statuses. */
export const TOO_LARGE = 'too_large';

function tooLarge(message) {
  const err = new Error(message);
  err.code = TOO_LARGE;
  return err;
}

const SPACE = 0x20;
const TAB = 0x09;

/** `line` without trailing spaces/tabs, by index scan (no regex). */
function trimEndSpaceTab(line) {
  let end = line.length;
  while (end > 0) {
    const c = line.charCodeAt(end - 1);
    if (c !== SPACE && c !== TAB) break;
    end--;
  }
  return end === line.length ? line : line.slice(0, end);
}

/**
 * Normalize line endings to \n, strip trailing spaces/tabs from every line,
 * collapse runs of blank lines to one, and trim the ends. Linear in the input
 * length: one split on line breaks, one scan per line.
 */
export function normalizeText(raw) {
  const lines = raw.split(/\r\n|\r|\n/);
  const out = [];
  let blankRun = 0;
  for (const line of lines) {
    const trimmed = trimEndSpaceTab(line);
    if (trimmed === '') {
      blankRun++;
      if (blankRun === 1) out.push('');
    } else {
      blankRun = 0;
      out.push(trimmed);
    }
  }
  return out.join('\n').trim();
}

const BLOCK_CLOSE = /<\/(?:p|div|li|h[1-6]|tr|section|article|blockquote|pre)>/gi;
const BR = /<br\s*\/?>/gi;

/** Visible text of an HTML document, keeping paragraph breaks. */
export function htmlToText(html) {
  // Mark block boundaries before stripping tags so paragraphs survive into
  // the chunker. Both patterns anchor on a literal `<`, so each attempt scans
  // only its own tag. sanitize-html's default nonTextTags drop the contents
  // of script/style/textarea/option.
  const withBreaks = html.replace(BR, '\n').replace(BLOCK_CLOSE, '\n\n');
  const text = sanitizeHtml(withBreaks, { allowedTags: [], allowedAttributes: {} });
  return text
    .replaceAll('&nbsp;', ' ')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&');
}

const ZIP_EOCD_SIG = 0x06054b50;
const ZIP_CDH_SIG = 0x02014b50;

/**
 * Sum of the uncompressed sizes a ZIP (DOCX) declares in its central
 * directory, read before anything is inflated. Declared sizes can lie; the
 * parent's memory watchdog is the backstop.
 */
export function declaredZipExpandedSize(buf) {
  const searchFrom = Math.max(0, buf.length - 0xffff - 22);
  let eocd = -1;
  for (let i = buf.length - 22; i >= searchFrom; i--) {
    if (buf.readUInt32LE(i) === ZIP_EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a valid DOCX (zip) file');
  const entries = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  let total = 0;
  for (let n = 0; n < entries; n++) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== ZIP_CDH_SIG) {
      throw new Error('not a valid DOCX (zip) file');
    }
    const size = buf.readUInt32LE(offset + 24);
    // ZIP64 sentinel: the real size lives elsewhere and exceeds 4 GiB.
    if (size === 0xffffffff) return Number.POSITIVE_INFINITY;
    total += size;
    offset +=
      46 +
      buf.readUInt16LE(offset + 28) +
      buf.readUInt16LE(offset + 30) +
      buf.readUInt16LE(offset + 32);
  }
  return total;
}

async function extractPdf(buf, maxChars, maxPages) {
  const { getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const pageCount = Math.min(pdf.numPages, maxPages);
  let truncated = pdf.numPages > maxPages;
  const parts = [];
  let total = 0;
  for (let i = 1; i <= pageCount; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    let text = '';
    for (const item of content.items) {
      if (typeof item.str !== 'string') continue;
      text += item.str + (item.hasEOL ? '\n' : '');
    }
    page.cleanup();
    const section = `## Page ${i}\n\n${text.trim()}`;
    parts.push(section);
    total += section.length + 2;
    // Stop reading pages once we have more text than will be indexed.
    if (total > maxChars) {
      truncated = truncated || i < pdf.numPages;
      break;
    }
  }
  return { raw: parts.join('\n\n'), truncated };
}

async function extractDocx(buf, maxExpandedBytes) {
  const expanded = declaredZipExpandedSize(buf);
  if (expanded > maxExpandedBytes) {
    throw tooLarge(
      `DOCX expands to more than ${Math.round(maxExpandedBytes / 1024 / 1024)}MB; split it into smaller files`,
    );
  }
  const mammoth = (await import('mammoth')).default;
  const result = await mammoth.extractRawText({ buffer: buf });
  return { raw: result.value, truncated: false };
}

/**
 * Extract indexable text from one document. Input slices happen before
 * decoding, the result is normalized in linear time, and at most `maxChars`
 * characters are returned.
 */
export async function extractDocumentText({ kind, bytes, maxChars, maxPages, maxExpandedBytes }) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  let raw;
  let truncated = false;
  if (kind === 'pdf') {
    ({ raw, truncated } = await extractPdf(buf, maxChars, maxPages));
  } else if (kind === 'docx') {
    ({ raw, truncated } = await extractDocx(buf, maxExpandedBytes));
  } else if (kind === 'html') {
    // Markup outweighs text, so allow more bytes than characters kept.
    const cap = maxChars * 8;
    truncated = buf.length > cap;
    raw = htmlToText(buf.subarray(0, cap).toString('utf8'));
  } else {
    // A character is at most 4 UTF-8 bytes.
    const cap = maxChars * 4;
    truncated = buf.length > cap;
    raw = buf.subarray(0, cap).toString('utf8');
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  }
  let text = normalizeText(raw);
  if (text.length > maxChars) {
    text = text.slice(0, maxChars);
    truncated = true;
  }
  return { text, truncated };
}
