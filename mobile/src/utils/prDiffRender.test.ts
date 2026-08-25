// @ts-nocheck
import { describe, it, expect } from 'vitest';
import {
  normalizePrFiles,
  summarizePrFiles,
  fileStatusLabel,
  annotatePatchLines,
  commentAnchorFor,
  commentsForFile,
  groupCommentThreads,
} from './prDiffRender';
describe('normalizePrFiles', () => {
  it('returns [] for null / undefined / junk payloads', () => {
    expect(normalizePrFiles(null)).toEqual([]);
    expect(normalizePrFiles(undefined)).toEqual([]);
    expect(normalizePrFiles('nope')).toEqual([]);
    expect(normalizePrFiles({})).toEqual([]);
    expect(normalizePrFiles({ files: 'nope' })).toEqual([]);
  });
  it('unwraps the { files: [...] } envelope from /api/pr/files', () => {
    const out = normalizePrFiles({
      source: 'user-oauth',
      truncated: false,
      files: [
        { filename: 'a.js', status: 'modified', additions: 3, deletions: 1, patch: '@@ -1 +1 @@' },
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      filename: 'a.js',
      status: 'modified',
      additions: 3,
      deletions: 1,
      isBinary: false,
    });
  });
  it('accepts a bare array too', () => {
    expect(normalizePrFiles([{ filename: 'x', additions: 1, deletions: 0 }])).toHaveLength(1);
  });
  it('marks entries without a patch as binary and defaults missing fields', () => {
    const [f] = normalizePrFiles({ files: [{ filename: 'img.png', status: 'added' }] });
    expect(f.isBinary).toBe(true);
    expect(f.patch).toBeNull();
    expect(f.additions).toBe(0);
    expect(f.deletions).toBe(0);
  });
  it('coerces bad counters to 0 and drops entries with no filename', () => {
    const out = normalizePrFiles({
      files: [
        { filename: 'ok.js', additions: 'NaN-ish', deletions: -4, patch: 'x' },
        { status: 'modified' },
        null,
        'junk',
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0].additions).toBe(0);
    expect(out[0].deletions).toBe(0);
  });
  it('keeps previous_filename for renames', () => {
    const [f] = normalizePrFiles({
      files: [{ filename: 'new.js', status: 'renamed', previous_filename: 'old.js' }],
    });
    expect(f.previousFilename).toBe('old.js');
  });
});
describe('summarizePrFiles', () => {
  it('sums per-file counters', () => {
    expect(
      summarizePrFiles([
        { additions: 2, deletions: 1 },
        { additions: 5, deletions: 0 },
      ]),
    ).toEqual({ count: 2, additions: 7, deletions: 1 });
  });
  it('handles empty / invalid input', () => {
    expect(summarizePrFiles(null)).toEqual({ count: 0, additions: 0, deletions: 0 });
    expect(summarizePrFiles([])).toEqual({ count: 0, additions: 0, deletions: 0 });
  });
});
describe('fileStatusLabel', () => {
  it('maps GitHub statuses to single letters', () => {
    expect(fileStatusLabel('added')).toBe('A');
    expect(fileStatusLabel('removed')).toBe('D');
    expect(fileStatusLabel('deleted')).toBe('D');
    expect(fileStatusLabel('renamed')).toBe('R');
    expect(fileStatusLabel('copied')).toBe('C');
    expect(fileStatusLabel('modified')).toBe('M');
    expect(fileStatusLabel('')).toBe('M');
    expect(fileStatusLabel(undefined)).toBe('M');
  });
});
describe('annotatePatchLines', () => {
  const patch = [
    '@@ -10,3 +20,4 @@ function foo() {',
    ' context-1',
    '-removed',
    '+added-1',
    '+added-2',
    ' context-2',
  ].join('\n');
  it('returns [] for empty / non-string input', () => {
    expect(annotatePatchLines(null)).toEqual([]);
    expect(annotatePatchLines('')).toEqual([]);
    expect(annotatePatchLines(42)).toEqual([]);
  });
  it('classifies kinds and walks old/new line numbers from the hunk header', () => {
    const out = annotatePatchLines(patch);
    expect(out.map((l: any) => l.kind)).toEqual([
      'hunk',
      'context',
      'del',
      'add',
      'add',
      'context',
    ]);
    // hunk header carries no numbers
    expect(out[0]).toMatchObject({ oldLine: null, newLine: null });
    // context: both sides
    expect(out[1]).toMatchObject({ oldLine: 10, newLine: 20 });
    // deletion: old side only
    expect(out[2]).toMatchObject({ oldLine: 11, newLine: null });
    // additions: new side only
    expect(out[3]).toMatchObject({ oldLine: null, newLine: 21 });
    expect(out[4]).toMatchObject({ oldLine: null, newLine: 22 });
    // trailing context resumes both counters
    expect(out[5]).toMatchObject({ oldLine: 12, newLine: 23 });
  });
  it('treats everything before the first hunk as meta (full git diff patches)', () => {
    const full = [
      'diff --git a/a.js b/a.js',
      'index 123..456 100644',
      '--- a/a.js',
      '+++ b/a.js',
      '@@ -1 +1 @@',
      '-old',
      '+new',
    ].join('\n');
    const out = annotatePatchLines(full);
    expect(out.slice(0, 4).every((l: any) => l.kind === 'meta')).toBe(true);
    expect(out[4].kind).toBe('hunk');
    expect(out[5]).toMatchObject({ kind: 'del', oldLine: 1 });
    expect(out[6]).toMatchObject({ kind: 'add', newLine: 1 });
  });
  it('handles single-line hunk ranges without a count (@@ -1 +1 @@)', () => {
    const out = annotatePatchLines('@@ -1 +1 @@\n-x\n+y');
    expect(out[1].oldLine).toBe(1);
    expect(out[2].newLine).toBe(1);
  });
  it('resets counters on a second hunk', () => {
    const out = annotatePatchLines('@@ -1,1 +1,1 @@\n x\n@@ -50,1 +60,1 @@\n+z');
    expect(out[3]).toMatchObject({ kind: 'add', newLine: 60 });
  });
  it('marks "\\ No newline at end of file" as meta without advancing counters', () => {
    const out = annotatePatchLines('@@ -1,2 +1,2 @@\n-a\n\\ No newline at end of file\n+b\n c');
    expect(out[2].kind).toBe('meta');
    expect(out[3]).toMatchObject({ kind: 'add', newLine: 1 });
    expect(out[4]).toMatchObject({ kind: 'context', oldLine: 2, newLine: 2 });
  });
  it('drops the trailing empty element from a final newline', () => {
    const out = annotatePatchLines('@@ -1 +1 @@\n+x\n');
    expect(out).toHaveLength(2);
  });
});
describe('commentAnchorFor', () => {
  it('prefers the new side (additions and context)', () => {
    expect(commentAnchorFor({ oldLine: 3, newLine: 5 })).toEqual({ side: 'new', line: 5 });
    expect(commentAnchorFor({ oldLine: null, newLine: 7 })).toEqual({ side: 'new', line: 7 });
  });
  it('uses the old side for deletions', () => {
    expect(commentAnchorFor({ oldLine: 4, newLine: null })).toEqual({ side: 'old', line: 4 });
  });
  it('returns null for non-commentable lines and bad input', () => {
    expect(commentAnchorFor({ oldLine: null, newLine: null })).toBeNull();
    expect(commentAnchorFor(null)).toBeNull();
    expect(commentAnchorFor(undefined)).toBeNull();
  });
});
describe('commentsForFile', () => {
  const comments = [
    { id: 1, file_path: 'a.js', line: 2 },
    { id: 2, file_path: 'b.js', line: 9 },
    null,
  ];
  it('filters by file_path', () => {
    expect(commentsForFile(comments, 'a.js').map((c: any) => c.id)).toEqual([1]);
  });
  it('returns [] for missing filename or non-array comments', () => {
    expect(commentsForFile(comments, '')).toEqual([]);
    expect(commentsForFile(null, 'a.js')).toEqual([]);
  });
});
describe('groupCommentThreads', () => {
  const c = (over: any) => ({
    id: 'x',
    line: 3,
    side: 'new',
    resolved: false,
    resolved_by: null,
    ...over,
  });
  it('groups comments sharing an anchor into one thread, in first-comment order', () => {
    const threads = groupCommentThreads([c({ id: 'a' }), c({ id: 'b', line: 9 }), c({ id: 'c' })]);
    expect(threads.map((t: any) => t.key)).toEqual(['new:3', 'new:9']);
    expect(threads[0].comments.map((x: any) => x.id)).toEqual(['a', 'c']);
  });
  it('treats the old and new side of one line as separate threads', () => {
    const threads = groupCommentThreads([c({ id: 'a' }), c({ id: 'b', side: 'old' })]);
    expect(threads.map((t: any) => t.key)).toEqual(['new:3', 'old:3']);
  });
  it('marks the whole thread resolved when any comment carries the flag', () => {
    const [thread] = groupCommentThreads([
      c({ id: 'a' }),
      c({ id: 'b', resolved: true, resolved_by: 'kevin' }),
    ]);
    expect(thread.resolved).toBe(true);
    expect(thread.resolvedBy).toBe('kevin');
    expect(thread.comments).toHaveLength(2);
  });
  it('leaves an untouched thread unresolved', () => {
    expect(groupCommentThreads([c({ id: 'a' })])[0]).toMatchObject({
      resolved: false,
      resolvedBy: null,
    });
  });
  it('tolerates junk input', () => {
    expect(groupCommentThreads(null)).toEqual([]);
    expect(groupCommentThreads([null, undefined])).toEqual([]);
  });
});
