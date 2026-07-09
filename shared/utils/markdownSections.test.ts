import { describe, it, expect } from 'vitest';
import {
  parseMarkdownHeadings,
  sliceSectionAtLine,
  listMarkdownSections,
  listMarkdownLineItems,
} from './markdownSections';

// The canonical spec example from the product request.
const SPEC = `# Title 1
  - Should be included in title 1 block, nothing else
Should be included in title 1 block, nothing else

## Title 2
  - Should be included in title 1 block, or in title 2 block

# Title 3
 - Should be included in title 3 block only`;

describe('parseMarkdownHeadings', () => {
  it('parses ATX headings with levels and 1-indexed lines', () => {
    const headings = parseMarkdownHeadings(SPEC);
    expect(headings).toEqual([
      { level: 1, text: 'Title 1', line: 1 },
      { level: 2, text: 'Title 2', line: 5 },
      { level: 1, text: 'Title 3', line: 8 },
    ]);
  });

  it('ignores # inside fenced code blocks', () => {
    const md = ['# Real heading', '', '```bash', '# not a heading', '```', '', '## Also real'].join(
      '\n',
    );
    expect(parseMarkdownHeadings(md).map((h) => h.text)).toEqual(['Real heading', 'Also real']);
  });

  it('handles ~~~ fences and closing trailing hashes', () => {
    const md = ['## Heading ##', '~~~', '### fake', '~~~'].join('\n');
    const headings = parseMarkdownHeadings(md);
    expect(headings).toEqual([{ level: 2, text: 'Heading', line: 1 }]);
  });

  it('returns [] for empty / nullish input', () => {
    expect(parseMarkdownHeadings('')).toEqual([]);
    expect(parseMarkdownHeadings(null)).toEqual([]);
    expect(parseMarkdownHeadings(undefined)).toEqual([]);
  });
});

describe('sliceSectionAtLine — spec semantics', () => {
  it('H1 section encapsulates its nested H2 sub-section', () => {
    const s = sliceSectionAtLine(SPEC, 1);
    expect(s).not.toBeNull();
    expect(s!.heading).toBe('Title 1');
    expect(s!.level).toBe(1);
    // Runs from "# Title 1" up to (not including) "# Title 3" — so it INCLUDES
    // "## Title 2" and everything under it.
    expect(s!.section).toContain('# Title 1');
    expect(s!.section).toContain('## Title 2');
    expect(s!.section).toContain('or in title 2 block');
    expect(s!.section).not.toContain('Title 3');
    expect(s!.section).not.toContain('title 3 block only');
  });

  it('H2 section stops at the next same-or-higher-level heading', () => {
    const s = sliceSectionAtLine(SPEC, 5);
    expect(s!.heading).toBe('Title 2');
    expect(s!.level).toBe(2);
    expect(s!.section).toContain('## Title 2');
    expect(s!.section).toContain('or in title 2 block');
    // Does not bleed into Title 1's own bullets (they are above it) or Title 3.
    expect(s!.section).not.toContain('nothing else');
    expect(s!.section).not.toContain('Title 3');
  });

  it('final H1 section runs to end-of-document', () => {
    const s = sliceSectionAtLine(SPEC, 8);
    expect(s!.heading).toBe('Title 3');
    expect(s!.section).toContain('# Title 3');
    expect(s!.section).toContain('title 3 block only');
    expect(s!.section).not.toContain('Title 2');
  });

  it('trims trailing blank lines from a section', () => {
    const md = '# A\n\ncontent\n\n\n# B\nmore';
    const s = sliceSectionAtLine(md, 1);
    expect(s!.section).toBe('# A\n\ncontent');
  });

  it('returns null when no heading sits on the given line', () => {
    expect(sliceSectionAtLine(SPEC, 2)).toBeNull();
    expect(sliceSectionAtLine(SPEC, 999)).toBeNull();
  });

  it('a deeper sub-heading (H3) does not close an H2 section', () => {
    const md = ['## Parent', 'a', '### Child', 'b', '## Sibling', 'c'].join('\n');
    const s = sliceSectionAtLine(md, 1);
    expect(s!.section).toContain('### Child');
    expect(s!.section).toContain('b');
    expect(s!.section).not.toContain('## Sibling');
    expect(s!.section).not.toContain('c');
  });
});

describe('listMarkdownSections', () => {
  it('lists every section in document order', () => {
    const sections = listMarkdownSections(SPEC);
    expect(sections.map((s) => s.heading)).toEqual(['Title 1', 'Title 2', 'Title 3']);
    expect(sections.map((s) => s.line)).toEqual([1, 5, 8]);
  });

  it('returns [] when there are no headings', () => {
    expect(listMarkdownSections('just prose\nmore prose')).toEqual([]);
  });
});

describe('listMarkdownLineItems', () => {
  it('lists bullets and nested bullets with their text, line, and indent', () => {
    const items = listMarkdownLineItems(SPEC);
    expect(items).toEqual([
      { text: 'Should be included in title 1 block, nothing else', line: 2, indent: 2 },
      { text: 'Should be included in title 1 block, or in title 2 block', line: 6, indent: 2 },
      { text: 'Should be included in title 3 block only', line: 9, indent: 1 },
    ]);
  });

  it('recognises *, +, ordered, and em/en-dash markers; drops empty items', () => {
    const md = ['* star', '+ plus', '1. first', '2) second', '— dash', '- '].join('\n');
    expect(listMarkdownLineItems(md).map((i) => i.text)).toEqual([
      'star',
      'plus',
      'first',
      'second',
      'dash',
    ]);
  });

  it('ignores list markers inside fenced code blocks', () => {
    const md = ['- real', '```', '- fake', '```', '- real2'].join('\n');
    expect(listMarkdownLineItems(md).map((i) => i.text)).toEqual(['real', 'real2']);
  });

  it('returns [] for empty / nullish input', () => {
    expect(listMarkdownLineItems('')).toEqual([]);
    expect(listMarkdownLineItems(null)).toEqual([]);
  });
});
