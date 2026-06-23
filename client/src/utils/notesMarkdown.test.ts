import { describe, it, expect } from 'vitest';
import { normalizeNotesMarkdown, shouldHardBreak } from './notesMarkdown';

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
    // List → plain prose without a separator triggers the list-breakout pass:
    // a synthetic blank line is spliced in so "Preselect file types if possible"
    // renders as a fresh paragraph instead of being absorbed into the list as
    // a lazy continuation (the second screenshot bug, fixed in 1.10.x).
    expect(lines[3]).toBe('');
    expect(lines[4]).toBe('Preselect file types if possible');
  });

  it('breaks out of a list with a synthetic blank line (regression for the second screenshot bug)', () => {
    // The screenshot showed a list item immediately followed by a plain prose
    // line collapsing into the list's last <li> via CommonMark lazy
    // continuation. After the fix, the preprocessor splices in a blank line
    // so the list ends and the prose renders as its own paragraph.
    const src = '- Add M— back into the lookup\nPreselect file types if possible';
    const expected = '- Add M— back into the lookup\n\nPreselect file types if possible';
    expect(normalizeNotesMarkdown(src)).toBe(expected);
  });

  it('inserts hard break between two adjacent prose lines (the core run-on fix)', () => {
    const src = 'First idea\nSecond idea';
    expect(normalizeNotesMarkdown(src)).toBe('First idea  \nSecond idea');
  });

  it('inserts two-space hard breaks between adjacent non-blank lines', () => {
    const src = 'Line one\nLine two\nLine three';
    const out = normalizeNotesMarkdown(src);
    expect(out!).toBe('Line one  \nLine two  \nLine three');
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

  it('breaks out of a list when a plain prose line follows without a blank separator', () => {
    // Bug report screenshot: lines like "- Title\nBuilder\nRealtor\nOption to add"
    // were rendered as a single <li> via CommonMark lazy continuation, producing
    // the merged "Title Builder" line in the preview. The preprocessor must
    // splice in a blank line so the list ends and a new paragraph begins.
    const src = ['- Lender Name', '- Law Firm Name', ' - Title', 'Builder', 'Realtor'].join('\n');
    const out = normalizeNotesMarkdown(src);
    const lines = out.split('\n');
    expect(lines[0]).toBe('- Lender Name');
    expect(lines[1]).toBe('- Law Firm Name');
    expect(lines[2]).toBe(' - Title');
    // Blank line spliced in to escape the list.
    expect(lines[3]).toBe('');
    // "Builder" is now a fresh paragraph; "Realtor" follows on the next visual
    // line so it gets a hard break for the normal run-on protection.
    expect(lines[4]).toBe('Builder  ');
    expect(lines[5]).toBe('Realtor');
  });

  it('reproduces the full screenshot input — list breakout + heading preserved', () => {
    // Verbatim from the user's bug report screenshot. The original output
    // merged "Title Builder" into one rendered line. After the fix, "Title"
    // stays in the list and "Builder/Realtor/Option to add" form their own
    // paragraph with hard breaks between them.
    const src = [
      '## Client Rep problem with email',
      '',
      '- Lender Name',
      '- Law Firm Name',
      ' - Title',
      'Builder',
      'Realtor',
      'Option to add',
    ].join('\n');
    const out = normalizeNotesMarkdown(src);
    const lines = out.split('\n');
    expect(lines[0]).toBe('## Client Rep problem with email');
    expect(lines[1]).toBe('');
    expect(lines[2]).toBe('- Lender Name');
    expect(lines[3]).toBe('- Law Firm Name');
    expect(lines[4]).toBe(' - Title');
    expect(lines[5]).toBe(''); // synthetic blank inserted by the list-breakout pass
    expect(lines[6]).toBe('Builder  ');
    expect(lines[7]).toBe('Realtor  ');
    expect(lines[8]).toBe('Option to add');
  });

  it('does not splice a blank line when a list is already followed by a heading or another list', () => {
    // Headings already break the list naturally — the splice would be redundant
    // and would create gratuitous whitespace.
    expect(normalizeNotesMarkdown('- one\n## next')).toBe('- one\n## next');
    // Another list item is the same list — no splice.
    expect(normalizeNotesMarkdown('- one\n- two')).toBe('- one\n- two');
    // Blank line already present — no splice.
    expect(normalizeNotesMarkdown('- one\n\nafter')).toBe('- one\n\nafter');
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
