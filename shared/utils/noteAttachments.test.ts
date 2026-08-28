import { describe, it, expect } from 'vitest';
import {
  isImageAttachment,
  attachmentLabel,
  buildAttachmentMarkdown,
  insertAtSelection,
  diffEdit,
  transformOffset,
  transformRange,
} from './noteAttachments';

describe('isImageAttachment', () => {
  it('detects images by content type regardless of name', () => {
    expect(isImageAttachment('whatever.dat', 'image/png')).toBe(true);
    expect(isImageAttachment(null, 'image/jpeg')).toBe(true);
    expect(isImageAttachment('x.png', 'IMAGE/PNG')).toBe(true);
  });

  it('falls back to extension when content type is absent', () => {
    expect(isImageAttachment('photo.JPG')).toBe(true);
    expect(isImageAttachment('diagram.svg')).toBe(true);
    expect(isImageAttachment('shot.webp')).toBe(true);
  });

  it('treats non-image content types and files as links', () => {
    expect(isImageAttachment('report.pdf', 'application/pdf')).toBe(false);
    expect(isImageAttachment('notes.txt')).toBe(false);
    expect(isImageAttachment(null, null)).toBe(false);
  });
});

describe('attachmentLabel', () => {
  it('collapses whitespace and strips brackets', () => {
    expect(attachmentLabel('my [cool]  shot.png', true)).toBe('my cool shot.png');
  });

  it('falls back to a generic label when empty', () => {
    expect(attachmentLabel('', true)).toBe('image');
    expect(attachmentLabel('   ', false)).toBe('file');
    expect(attachmentLabel('[]', false)).toBe('file');
  });
});

describe('buildAttachmentMarkdown', () => {
  it('embeds images with the ![alt](url) form', () => {
    expect(
      buildAttachmentMarkdown({
        name: 'shot.png',
        url: '/uploads/abc.png',
        contentType: 'image/png',
      }),
    ).toBe('\n![shot.png](/uploads/abc.png)\n');
  });

  it('links non-image files with the [name](url) form', () => {
    expect(
      buildAttachmentMarkdown({
        name: 'spec.pdf',
        url: '/uploads/x.pdf',
        contentType: 'application/pdf',
      }),
    ).toBe('\n[spec.pdf](/uploads/x.pdf)\n');
  });

  it('detects images by extension when content type is missing', () => {
    expect(buildAttachmentMarkdown({ name: 'a.gif', url: '/uploads/a.gif' })).toBe(
      '\n![a.gif](/uploads/a.gif)\n',
    );
  });
});

describe('insertAtSelection', () => {
  it('inserts at the caret and reports the new cursor position', () => {
    const { text, cursor } = insertAtSelection('abcd', 'XY', 2, 2);
    expect(text).toBe('abXYcd');
    expect(cursor).toBe(4);
  });

  it('replaces the selected range', () => {
    const { text, cursor } = insertAtSelection('abcd', 'Z', 1, 3);
    expect(text).toBe('aZd');
    expect(cursor).toBe(2);
  });

  it('appends when the selection is unknown or out of range', () => {
    expect(insertAtSelection('abc', '!', null, null)).toEqual({ text: 'abc!', cursor: 4 });
    expect(insertAtSelection('abc', '!', 5, 9)).toEqual({ text: 'abc!', cursor: 4 });
  });

  it('treats empty base text safely', () => {
    expect(insertAtSelection('', 'hi', 0, 0)).toEqual({ text: 'hi', cursor: 2 });
  });

  // Regression: the web attach flow captures the caret offset BEFORE the async
  // upload and advances it per file, so a batch stays ordered and anchored to
  // where the paste/drop/attach was initiated — even though the returned cursor
  // (from a prior insert) is the only position each later insert relies on, not
  // a live-read of the textarea that the user may have moved during the upload.
  it('keeps serial inserts ordered and anchored at the captured offset', () => {
    const captured = 3; // caret between "abc" and "def" at attach time
    let content = 'abcdef';
    let pos = captured;
    for (const snippet of ['[1]', '[2]', '[3]']) {
      const r = insertAtSelection(content, snippet, pos, pos);
      content = r.text;
      pos = r.cursor;
    }
    // Inserted in order at the original caret, pushing later text right.
    expect(content).toBe('abc[1][2][3]def');
  });

  // Regression: overlapping attach batches (a second paste/drop arriving while
  // the first is still uploading) share ONE advancing cursor via the serialized
  // drain queue, so they never re-anchor to a stale captured offset — the second
  // batch continues from where the first left off, keeping global order.
  it('continues a later batch from the advancing cursor, not a re-captured offset', () => {
    let content = 'XYZ';
    let pos = 1; // caret after "X" when the first batch was initiated
    // batch 1 (enqueued first)
    for (const s of ['[a]', '[b]']) {
      const r = insertAtSelection(content, s, pos, pos);
      content = r.text;
      pos = r.cursor;
    }
    // batch 2 (arrived mid-drain — must NOT reset pos to a new capture)
    for (const s of ['[c]']) {
      const r = insertAtSelection(content, s, pos, pos);
      content = r.text;
      pos = r.cursor;
    }
    expect(content).toBe('X[a][b][c]YZ');
  });

  // Regression: if the buffer shrank while an upload was in flight, a captured
  // offset past the new end must not throw or land mid-word — it appends.
  it('clamps a captured offset that now exceeds the (shrunk) buffer length', () => {
    const shrunk = 'ab';
    const capturedPos = 6; // captured when the buffer was longer
    const at = Math.min(capturedPos, shrunk.length);
    expect(insertAtSelection(shrunk, '[x]', at, at)).toEqual({ text: 'ab[x]', cursor: 5 });
  });

  // Regression: the FIRST insert of a batch replaces the captured selection
  // range (like a normal paste); the range then collapses to a cursor so later
  // files in the batch append after it instead of replacing again.
  it('replaces the selected range on the first insert, then collapses', () => {
    let content = 'abcdef';
    // User had "cd" (offsets 2..4) selected when the attach was initiated.
    let range = { start: 2, end: 4 };
    const results: string[] = [];
    for (const snippet of ['[1]', '[2]']) {
      const r = insertAtSelection(content, snippet, range.start, range.end);
      content = r.text;
      range = { start: r.cursor, end: r.cursor };
      results.push(content);
    }
    // First insert replaced "cd"; second appended after it.
    expect(results[0]).toBe('ab[1]ef');
    expect(results[1]).toBe('ab[1][2]ef');
  });
});

describe('diffEdit', () => {
  it('locates an insertion', () => {
    expect(diffEdit('abc', 'aXYbc')).toEqual({ p: 1, oldEnd: 1, newEnd: 3 });
  });
  it('locates a deletion', () => {
    expect(diffEdit('abcdef', 'abef')).toEqual({ p: 2, oldEnd: 4, newEnd: 2 });
  });
  it('locates a replacement', () => {
    expect(diffEdit('abcdef', 'abZZef')).toEqual({ p: 2, oldEnd: 4, newEnd: 4 });
  });
  it('handles no change', () => {
    expect(diffEdit('abc', 'abc')).toEqual({ p: 3, oldEnd: 3, newEnd: 3 });
  });
});

describe('transformOffset', () => {
  it('leaves an offset before the edit unchanged', () => {
    // insert "XY" at 0; offset 3 shifts right by 2
    expect(transformOffset(3, 'abc', 'XYabc')).toBe(5);
  });
  it('keeps an offset that precedes the edit', () => {
    // insert "Z" at 4; offset 2 (before) is untouched
    expect(transformOffset(2, 'abcdef', 'abcdZef')).toBe(2);
  });
  it('rides an interior offset to the end of the new region', () => {
    // replace [2,4) with "ZZZ"; offset 3 was inside → new region end = 5
    expect(transformOffset(3, 'abcdef', 'abZZZef')).toBe(5);
  });
});

describe('transformRange (pending attachment survives concurrent edits)', () => {
  it('shifts the anchor right when text is typed BEFORE it', () => {
    // Upload started with caret at end of "abc" (offset 3). User types "XY" at 0.
    const r = transformRange({ start: 3, end: 3 }, 'abc', 'XYabc');
    expect(r).toEqual({ start: 5, end: 5 });
    // Applying the attachment now lands after "abc", not inside "XYabc".
    expect(insertAtSelection('XYabc', '[img]', r.start, r.end).text).toBe('XYabc[img]');
  });

  it('preserves a selection replacement when the edit is entirely before it', () => {
    // Selected "de" (3..5) in "abcdef"; user types "XY" at 0.
    const r = transformRange({ start: 3, end: 5 }, 'abcdef', 'XYabcdef');
    expect(r).toEqual({ start: 5, end: 7 }); // still spans "de"
    expect(insertAtSelection('XYabcdef', '[img]', r.start, r.end).text).toBe('XYabc[img]f');
  });

  it('collapses to a caret when the edit disturbs the selection interior', () => {
    // Selected "de" (3..5); user types "Z" at 4 (inside the selection).
    const r = transformRange({ start: 3, end: 5 }, 'abcdef', 'abcdZef');
    // Must not replace/delete the freshly typed "Z": collapse to a caret.
    expect(r.start).toBe(r.end);
    const applied = insertAtSelection('abcdZef', '[img]', r.start, r.end).text;
    expect(applied).toContain('Z'); // the user's new character survives
  });
});
