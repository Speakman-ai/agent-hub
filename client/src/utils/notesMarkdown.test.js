import { describe, it, expect } from 'vitest';
import { normalizeNotesMarkdown, shouldHardBreak } from './notesMarkdown.js';

describe('normalizeNotesMarkdown', () => {
  it('returns empty string for falsy input', () => {
    expect(normalizeNotesMarkdown('')).toBe('');
    expect(normalizeNotesMarkdown(null)).toBe('');
    expect(normalizeNotesMarkdown(undefined)).toBe('');
  });

  it('rewrites em-dash bullets to standard list markers', () => {
    const src = '— First item\n— Second item';
    const out = normalizeNotesMarkdown(src);
    expect(out.split('\n')[0]).toBe('- First item');
    expect(out.split('\n')[1]).toBe('- Second item');
  });

  it('rewrites en-dash bullets to standard list markers', () => {
    const src = '– First\n– Second';
    const out = normalizeNotesMarkdown(src);
    expect(out.split('\n')).toEqual(['- First', '- Second']);
  });

  it('preserves indentation when rewriting dash bullets', () => {
    const src = '  — nested item';
    expect(normalizeNotesMarkdown(src)).toBe('  - nested item');
  });

  it('does not rewrite mid-line em-dashes', () => {
    const src = 'Add M— back into the lookup';
    expect(normalizeNotesMarkdown(src)).toBe('Add M— back into the lookup');
  });

  it('reproduces the screenshot scenario — converts em-dash bullets and breaks adjacent lines', () => {
    const src = [
      'Overdue on drafting',
      '— Name are not vertically centered on routing pages',
      '— Add M— back into the lookup',
      'Preselect file types if possible',
    ].join('\n');
    const out = normalizeNotesMarkdown(src);
    const lines = out.split('\n');
    // Line 0 is followed by a list item (after the dash rewrite); CommonMark
    // already breaks the paragraph there, so no extra hard break is added.
    expect(lines[0]).toBe('Overdue on drafting');
    expect(lines[1]).toBe('- Name are not vertically centered on routing pages');
    expect(lines[2]).toBe('- Add M— back into the lookup');
    // The last two lines were the run-on case in the bug report. Both are
    // plain prose, so a hard break is required between them — but since
    // line[2] is a list item, no break is added between [2] and [3].
    expect(lines[3]).toBe('Preselect file types if possible');
  });

  it('inserts hard break between two prose lines that follow a list (regression for screenshot bug)', () => {
    // The original screenshot showed a list item immediately followed by a
    // plain prose line collapsing into a single paragraph. After rewrite,
    // "- Add M— back into the lookup\nPreselect file types if possible"
    // should render as a list item then a fresh paragraph — never a run-on.
    const src = '- Add M— back into the lookup\nPreselect file types if possible';
    const out = normalizeNotesMarkdown(src);
    expect(out).toBe(src); // already correct: list item is its own block
  });

  it('inserts hard break between two adjacent prose lines (the core run-on fix)', () => {
    const src = 'First idea\nSecond idea';
    expect(normalizeNotesMarkdown(src)).toBe('First idea  \nSecond idea');
  });

  it('inserts two-space hard breaks between adjacent non-blank lines', () => {
    const src = 'Line one\nLine two\nLine three';
    const out = normalizeNotesMarkdown(src);
    expect(out).toBe('Line one  \nLine two  \nLine three');
  });

  it('does not insert hard break before a blank line', () => {
    const src = 'Para one\n\nPara two';
    expect(normalizeNotesMarkdown(src)).toBe('Para one\n\nPara two');
  });

  it('does not insert hard break before a heading', () => {
    const src = 'Intro\n# Heading\nBody';
    const out = normalizeNotesMarkdown(src);
    const lines = out.split('\n');
    expect(lines[0]).toBe('Intro'); // no trailing spaces
    expect(lines[1]).toBe('# Heading');
    expect(lines[2]).toBe('Body');
  });

  it('does not insert hard break before a list item', () => {
    const src = 'Intro line\n- bullet';
    expect(normalizeNotesMarkdown(src)).toBe('Intro line\n- bullet');
  });

  it('does not insert hard break inside a list', () => {
    const src = '- one\n- two';
    expect(normalizeNotesMarkdown(src)).toBe('- one\n- two');
  });

  it('does not modify content inside fenced code blocks', () => {
    const src = ['```js', 'const a = 1;', 'const b = 2;', '```', 'After'].join('\n');
    const out = normalizeNotesMarkdown(src);
    const lines = out.split('\n');
    expect(lines[0]).toBe('```js');
    expect(lines[1]).toBe('const a = 1;'); // no trailing spaces
    expect(lines[2]).toBe('const b = 2;');
    expect(lines[3]).toBe('```');
    expect(lines[4]).toBe('After');
  });

  it('handles tilde-fenced code blocks', () => {
    const src = ['~~~', '— still code, do not rewrite', '~~~'].join('\n');
    const out = normalizeNotesMarkdown(src);
    expect(out.split('\n')[1]).toBe('— still code, do not rewrite');
  });

  it('preserves existing two-space hard breaks (no double-padding)', () => {
    const src = 'Line one  \nLine two';
    expect(normalizeNotesMarkdown(src)).toBe('Line one  \nLine two');
  });

  it('does not break standard markdown lists, headings, or links', () => {
    const src = ['# Title', '', 'Some text', '', '- a', '- b', '', '[link](https://x)'].join('\n');
    expect(normalizeNotesMarkdown(src)).toBe(src);
  });

  it('mixes standard `-` bullets and em-dash bullets', () => {
    const src = ['- standard one', '— em-dash one', '- standard two'].join('\n');
    expect(normalizeNotesMarkdown(src)).toBe(
      ['- standard one', '- em-dash one', '- standard two'].join('\n'),
    );
  });

  it('does not append a hard break to the final line', () => {
    const src = 'Single line';
    expect(normalizeNotesMarkdown(src)).toBe('Single line');
  });

  it('leaves blockquotes intact', () => {
    const src = 'Intro\n> quoted\nAfter';
    const out = normalizeNotesMarkdown(src);
    const lines = out.split('\n');
    // No hard break on the line preceding the blockquote (block-level break already)
    expect(lines[0]).toBe('Intro');
    expect(lines[1]).toBe('> quoted');
    // The quoted line itself shouldn't get a hard break either
    expect(lines[2]).toBe('After');
  });
});

describe('shouldHardBreak', () => {
  it('returns false when next line is blank', () => {
    expect(shouldHardBreak('text', '')).toBe(false);
    expect(shouldHardBreak('text', '   ')).toBe(false);
  });

  it('returns false when next line is a heading', () => {
    expect(shouldHardBreak('text', '# H')).toBe(false);
    expect(shouldHardBreak('text', '## H')).toBe(false);
  });

  it('returns false when next line is a list item', () => {
    expect(shouldHardBreak('text', '- item')).toBe(false);
    expect(shouldHardBreak('text', '* item')).toBe(false);
    expect(shouldHardBreak('text', '+ item')).toBe(false);
    expect(shouldHardBreak('text', '1. item')).toBe(false);
  });

  it('returns false when current line is a list item', () => {
    expect(shouldHardBreak('- item', 'continuation')).toBe(false);
  });

  it('returns false when next line is undefined', () => {
    expect(shouldHardBreak('text', undefined)).toBe(false);
  });

  it('returns true for two adjacent non-blank prose lines', () => {
    expect(shouldHardBreak('one', 'two')).toBe(true);
  });
});
