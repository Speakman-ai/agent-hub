import { describe, it, expect } from 'vitest';
import {
  buildVoiceNoteMarkdown,
  padBlockForInsert,
  splitDetailsSegments,
  VOICE_TRANSCRIPT_LABEL,
} from './voiceNoteMarkdown';

describe('buildVoiceNoteMarkdown', () => {
  it('puts the summary above a collapsed transcript', () => {
    expect(buildVoiceNoteMarkdown({ summary: ' **Gist.** ', transcript: ' hi there ' })).toBe(
      `**Gist.**\n\n<details>\n<summary>${VOICE_TRANSCRIPT_LABEL}</summary>\n\nhi there\n\n</details>`,
    );
  });

  it('omits the summary when there is none', () => {
    expect(buildVoiceNoteMarkdown({ transcript: 'hi' }).startsWith('<details>')).toBe(true);
  });

  it('keeps a spoken closing tag from ending the block early', () => {
    const md = buildVoiceNoteMarkdown({ transcript: 'say </details> out loud' });
    const segs = splitDetailsSegments(md);
    expect(segs).toHaveLength(1);
    expect(segs[0]).toMatchObject({ kind: 'details', body: 'say &lt;/details> out loud' });
  });
});

describe('padBlockForInsert', () => {
  it('separates the block from neighbours with a blank line', () => {
    expect(padBlockForInsert('a b', 1, 'X')).toBe('\n\nX\n\n');
    expect(padBlockForInsert('a\n\nb', 3, 'X')).toBe('X\n\n');
    expect(padBlockForInsert('', 0, 'X')).toBe('X');
    expect(padBlockForInsert('a', 1, '  ')).toBe('');
  });
});

describe('splitDetailsSegments', () => {
  it('splits plain markdown and details blocks', () => {
    const md = `# Top\n\n${buildVoiceNoteMarkdown({ summary: 'S', transcript: 'T' })}\n\nafter`;
    expect(splitDetailsSegments(md)).toEqual([
      { kind: 'markdown', text: '# Top\n\nS\n' },
      { kind: 'details', summary: VOICE_TRANSCRIPT_LABEL, body: 'T' },
      { kind: 'markdown', text: '\nafter' },
    ]);
  });

  it('ignores details tags inside code fences and unclosed blocks', () => {
    const fenced = '```\n<details>\n</details>\n```';
    expect(splitDetailsSegments(fenced)).toEqual([{ kind: 'markdown', text: fenced }]);
    expect(splitDetailsSegments('<details>\nopen')).toEqual([
      { kind: 'markdown', text: '<details>\nopen' },
    ]);
  });

  it('accepts a summary on the opener line and defaults the label', () => {
    expect(splitDetailsSegments('<details><summary>Hi</summary>\nx\n</details>')).toEqual([
      { kind: 'details', summary: 'Hi', body: 'x' },
    ]);
    expect(splitDetailsSegments('<details>\nx\n</details>')[0]).toMatchObject({
      summary: 'Details',
    });
  });

  it('a shorter fence inside a longer one does not close it', () => {
    const md = ['````md', '```', 'code', '```', '<details>', 'x', '</details>', '````'].join('\n');
    expect(splitDetailsSegments(md)).toEqual([{ kind: 'markdown', text: md }]);
  });

  it('a fence line with trailing text does not close the fence', () => {
    const md = ['```', '``` not a closer', '<details>', 'x', '</details>', '```'].join('\n');
    expect(splitDetailsSegments(md)).toEqual([{ kind: 'markdown', text: md }]);
  });

  it('a longer closing fence ends the block, so a later details block folds', () => {
    const md = ['```', 'a', '`````', '<details>', 'x', '</details>'].join('\n');
    expect(splitDetailsSegments(md)).toEqual([
      { kind: 'markdown', text: '```\na\n`````' },
      { kind: 'details', summary: 'Details', body: 'x' },
    ]);
  });

  it('respects fence length inside a details body', () => {
    const md = ['<details>', '````', '```', '</details>', '```', '````', '</details>'].join('\n');
    expect(splitDetailsSegments(md)).toEqual([
      { kind: 'details', summary: 'Details', body: '````\n```\n</details>\n```\n````' },
    ]);
  });
});
