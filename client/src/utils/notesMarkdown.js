/**
 * Normalize markdown source for the Notes preview pane.
 *
 * Background: CommonMark joins consecutive non-blank lines into a single
 * paragraph (separated by a space) and only recognizes `-`, `*`, `+` as
 * unordered list markers. Notes users frequently type em-dash (—) or
 * en-dash (–) bullets and expect each line to render on its own row,
 * which produces confusing run-on paragraphs in the preview.
 *
 * This preprocessor applies two minimally-invasive fixes before the
 * source is handed to ReactMarkdown:
 *
 *   1. **Em/en-dash bullet shortcut.** A line that begins with optional
 *      indentation followed by `— ` or `– ` (em or en dash + space) is
 *      rewritten to use `- ` so CommonMark renders it as a list item.
 *   2. **Hard line breaks between adjacent non-blank lines.** Two trailing
 *      spaces are appended to non-blank lines whose successor is also
 *      non-blank, which CommonMark interprets as a `<br>`. This preserves
 *      the visual line layout the user typed without changing paragraph
 *      semantics. Lines inside fenced code blocks (```/~~~) are left
 *      untouched so code samples continue to render verbatim.
 *
 * The function is pure: same input → same output, no side effects.
 *
 * @param {string} source raw markdown source (may be empty or undefined)
 * @returns {string} normalized markdown
 */
export function normalizeNotesMarkdown(source) {
  if (!source) return '';
  const lines = source.split('\n');
  const out = new Array(lines.length);

  let inFence = false;
  let fenceMarker = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Detect fenced code block boundaries (``` or ~~~). The opener and closer
    // are the same character; nested fences of different kinds are valid.
    const fenceMatch = line.match(/^(\s{0,3})(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[2][0];
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
        out[i] = line;
        continue;
      }
      // Close fence only when the marker character matches.
      if (marker === fenceMarker) {
        inFence = false;
        fenceMarker = '';
      }
      out[i] = line;
      continue;
    }

    if (inFence) {
      out[i] = line;
      continue;
    }

    // Em/en-dash bullet shortcut: rewrite `<indent>— text` → `<indent>- text`.
    // We require a trailing space after the dash so we don't break em-dashes
    // used mid-sentence (those start with letters, not whitespace + dash).
    let rewritten = line.replace(/^(\s*)[—–]\s+/, '$1- ');
    out[i] = rewritten;
  }

  // Second pass — break out of a list cleanly when the user's next line is
  // a plain prose line. CommonMark's lazy-continuation rule otherwise pulls
  // those trailing lines INTO the last list item, producing the merged
  // "Title Builder" rendering reported in the screenshot bug. We insert a
  // synthetic blank line so the list ends and a new paragraph starts.
  //
  // We mutate `out` in place (splice in '' entries). The third pass that
  // appends hard-break trailing spaces runs against the post-splice buffer,
  // so it sees the new structure and treats the now-separated paragraph
  // lines normally.
  inFence = false;
  fenceMarker = '';
  for (let i = 0; i < out.length - 1; i++) {
    const line = out[i];
    const fenceMatch = line.match(/^(\s{0,3})(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[2][0];
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
      } else if (marker === fenceMarker) {
        inFence = false;
        fenceMarker = '';
      }
      continue;
    }
    if (inFence) continue;

    const next = out[i + 1];
    if (!isListItem(line)) continue;
    if (next === undefined) continue;
    if (/^\s*$/.test(next)) continue; // already blank, list ends naturally
    if (isListItem(next)) continue; // next item in the same list, fine
    if (isBlockStart(next)) continue; // heading / blockquote / hr — also breaks
    // List item → plain prose with no separator. Splice in a blank line.
    out.splice(i + 1, 0, '');
    // Skip past the blank we just inserted; the inner for-loop check still
    // runs against `out.length` so the third pass sees the spliced buffer.
    i += 1;
  }

  // Third pass — append two-space hard breaks between adjacent non-blank
  // lines so that the visible newlines the user typed survive into the
  // preview. We do this after the dash rewrite so list items don't get
  // double-spaced (a list item already starts a new block; CommonMark
  // handles the line break for us).
  inFence = false;
  fenceMarker = '';
  for (let i = 0; i < out.length - 1; i++) {
    const line = out[i];
    const next = out[i + 1];

    const fenceMatch = line.match(/^(\s{0,3})(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[2][0];
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
      } else if (marker === fenceMarker) {
        inFence = false;
        fenceMarker = '';
      }
      continue;
    }
    if (inFence) continue;

    if (!shouldHardBreak(line, next)) continue;

    // Don't double-add trailing spaces if the user already provided them.
    if (/ {2}$/.test(line)) continue;
    // Don't add a hard break to a line that's only whitespace.
    if (/^\s*$/.test(line)) continue;

    out[i] = line + '  ';
  }

  return out.join('\n');
}

/** True when `line` opens a CommonMark list item (`-`, `*`, `+`, or `1.`/`1)`). */
function isListItem(line) {
  return /^\s*([-*+]|\d+[.)])\s+/.test(line);
}

/** True when `line` opens a heading / blockquote / horizontal rule. */
function isBlockStart(line) {
  return /^\s*(#{1,6}\s|>\s|-{3,}\s*$|_{3,}\s*$|\*{3,}\s*$)/.test(line);
}

/**
 * Decide whether a hard line break should be inserted at the end of `line`
 * because `next` continues directly underneath it. We skip cases where
 * CommonMark already starts a new block on the next line — list items,
 * headings, blockquotes, horizontal rules, blank lines — because those
 * naturally break the paragraph and don't need a `<br>`.
 *
 * Exposed for unit testing.
 */
export function shouldHardBreak(line, next) {
  if (next === undefined || next === null) return false;
  // Blank line below: paragraph already ends naturally.
  if (/^\s*$/.test(next)) return false;
  // Next line is a CommonMark block-level construct that ends the paragraph
  // on its own — no <br> needed.
  if (isBlockStart(next)) return false;
  // Next line starts a list item — already a new block.
  if (isListItem(next)) return false;
  // Current line is itself a heading / hr / blockquote — let it stand alone.
  if (isBlockStart(line)) return false;
  // Current line is a list item — CommonMark already handles tight-list
  // line breaks; we don't want to force a <br> inside the item.
  if (isListItem(line)) return false;
  return true;
}
