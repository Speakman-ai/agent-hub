/**
 * Slice a markdown document into heading-scoped sections.
 *
 * A "section" is everything from a heading down to — but not including — the
 * next heading of the **same or higher level** (i.e. a `#` in ATX terms with a
 * level number less-than-or-equal to the section heading's level). This means a
 * top-level `#` heading's section includes any nested `##`/`###` sub-headings
 * and their content, while a `##` heading's section stops at the next `#` or
 * `##`.
 *
 * Worked example (matches the product spec):
 *
 *   # Title 1            ← level 1 → section runs to just before "# Title 3"
 *     - under title 1        (includes the "## Title 2" sub-section)
 *   ## Title 2           ← level 2 → section runs to just before "# Title 3"
 *     - under title 2
 *   # Title 3            ← level 1 → section runs to end-of-document
 *     - under title 3
 *
 * `#` characters inside fenced code blocks (``` or ~~~) are ignored so code
 * comments never register as headings.
 *
 * All functions are pure: same input → same output, no side effects.
 */

export interface MarkdownHeading {
  /** ATX heading level, 1–6. */
  level: number;
  /** Heading text with the leading `#`s and surrounding whitespace stripped. */
  text: string;
  /** 1-indexed line number of the heading within `source`. */
  line: number;
}

export interface MarkdownSection {
  /** The heading that opens this section. */
  heading: string;
  /** Heading level (1–6). */
  level: number;
  /** 1-indexed line of the heading within `source`. */
  line: number;
  /**
   * The full section markdown — the heading line plus every line beneath it up
   * to (but excluding) the next same-or-higher-level heading. Trailing blank
   * lines are trimmed.
   */
  section: string;
}

const ATX_HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*#*[ \t]*$/;
const FENCE = /^(\s{0,3})(`{3,}|~{3,})/;

/**
 * Iterate the lines of `source` that are NOT inside a fenced code block
 * (``` or ~~~), invoking `visit(line, lineNumber)` with a 1-indexed line
 * number. Centralises the fence-tracking state machine so heading and
 * list-item parsing stay in sync.
 */
function eachNonFencedLine(
  source: string,
  visit: (line: string, lineNumber: number) => void,
): void {
  const lines = source.split('\n');
  let inFence = false;
  let fenceMarker = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const fenceMatch = line.match(FENCE);
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

    visit(line, i + 1);
  }
}

/**
 * Parse every ATX heading in `source`, skipping fenced code blocks.
 */
export function parseMarkdownHeadings(source: string | null | undefined): MarkdownHeading[] {
  if (!source) return [];
  const headings: MarkdownHeading[] = [];

  eachNonFencedLine(source, (line, lineNumber) => {
    const m = line.match(ATX_HEADING);
    if (m) {
      headings.push({ level: m[1].length, text: (m[2] || '').trim(), line: lineNumber });
    }
  });

  return headings;
}

/** Trim trailing blank lines from a block of text (keeps internal blanks). */
function trimTrailingBlankLines(text: string): string {
  return text.replace(/\s+$/, '');
}

/**
 * Return the section that opens at the heading on 1-indexed `line`, or `null`
 * when no heading sits on that line. The section extends to just before the
 * next heading whose level is `<=` this heading's level (or to end-of-document).
 */
export function sliceSectionAtLine(
  source: string | null | undefined,
  line: number,
): MarkdownSection | null {
  if (!source) return null;
  const lines = source.split('\n');
  const headings = parseMarkdownHeadings(source);

  const idx = headings.findIndex((h) => h.line === line);
  if (idx === -1) return null;

  const current = headings[idx];
  // First subsequent heading at the same or a higher level closes the section.
  let endLine = lines.length + 1; // exclusive; default = EOF
  for (let j = idx + 1; j < headings.length; j++) {
    if (headings[j].level <= current.level) {
      endLine = headings[j].line;
      break;
    }
  }

  const section = trimTrailingBlankLines(lines.slice(current.line - 1, endLine - 1).join('\n'));

  return {
    heading: current.text,
    level: current.level,
    line: current.line,
    section,
  };
}

/**
 * List every heading-scoped section in document order. Content that appears
 * before the first heading is not part of any section and is omitted.
 */
export function listMarkdownSections(source: string | null | undefined): MarkdownSection[] {
  const headings = parseMarkdownHeadings(source);
  return headings
    .map((h) => sliceSectionAtLine(source, h.line))
    .filter((s): s is MarkdownSection => s !== null);
}

export interface MarkdownLineItem {
  /** The list item text with the leading marker (`-`, `*`, `+`, `1.`) removed. */
  text: string;
  /** 1-indexed line number of the list item within `source`. */
  line: number;
  /** Leading-whitespace depth of the marker (0 for a top-level item). */
  indent: number;
}

// `- `, `* `, `+ `, `1. `, `1) ` and the em/en-dash bullets Notes users type.
const LIST_ITEM = /^(\s*)(?:[-*+]|[—–]|\d+[.)])\s+(.*)$/;

/**
 * List every markdown list item (bullet or ordered), skipping fenced code
 * blocks. Each item's `text` is the content after the marker — the natural
 * title when converting a single line into a kanban ticket. Em/en-dash bullets
 * (which Notes accepts as shorthand) are recognised too. Empty items are
 * dropped.
 */
export function listMarkdownLineItems(source: string | null | undefined): MarkdownLineItem[] {
  if (!source) return [];
  const items: MarkdownLineItem[] = [];

  eachNonFencedLine(source, (line, lineNumber) => {
    const m = line.match(LIST_ITEM);
    if (m) {
      const text = m[2].trim();
      if (text) items.push({ text, line: lineNumber, indent: m[1].length });
    }
  });

  return items;
}
