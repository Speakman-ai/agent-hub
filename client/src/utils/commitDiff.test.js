import { describe, it, expect } from 'vitest';
import { splitUnifiedDiff, annotateDiffLines } from './commitDiff.js';

const TWO_FILE_PATCH = [
  'diff --git a/src/app.js b/src/app.js',
  'index 111..222 100644',
  '--- a/src/app.js',
  '+++ b/src/app.js',
  '@@ -1,2 +1,3 @@',
  ' const a = 1;',
  '+const b = 2;',
  '-const c = 3;',
  '+const c = 4;',
  'diff --git a/README.md b/README.md',
  '--- a/README.md',
  '+++ b/README.md',
  '@@ -1 +1 @@',
  '-old',
  '+new',
].join('\n');

describe('splitUnifiedDiff', () => {
  it('splits a multi-file patch into per-file sections with counts', () => {
    const sections = splitUnifiedDiff(TWO_FILE_PATCH);
    expect(sections).toHaveLength(2);
    expect(sections[0]).toMatchObject({
      filename: 'src/app.js',
      additions: 2,
      deletions: 1,
      isBinary: false,
    });
    expect(sections[1]).toMatchObject({ filename: 'README.md', additions: 1, deletions: 1 });
    // +++/--- header lines are not counted as changes.
    expect(sections[0].lines[0]).toBe('diff --git a/src/app.js b/src/app.js');
  });

  it('marks binary files and renders renames as old → new', () => {
    const patch = [
      'diff --git a/img/logo.png b/img/logo.png',
      'Binary files a/img/logo.png and b/img/logo.png differ',
      'diff --git a/old-name.js b/new-name.js',
      'similarity index 90%',
      'rename from old-name.js',
      'rename to new-name.js',
    ].join('\n');
    const sections = splitUnifiedDiff(patch);
    expect(sections[0]).toMatchObject({ filename: 'img/logo.png', isBinary: true });
    expect(sections[1].filename).toBe('old-name.js → new-name.js');
  });

  it('handles empty/garbage input', () => {
    expect(splitUnifiedDiff('')).toEqual([]);
    expect(splitUnifiedDiff(null)).toEqual([]);
    expect(splitUnifiedDiff(undefined)).toEqual([]);
    expect(splitUnifiedDiff('\n\n')).toEqual([]);
  });

  it('keeps preamble text before the first file header visible', () => {
    const sections = splitUnifiedDiff('commit notes from -m\ndiff --git a/x b/x\n+1');
    expect(sections).toHaveLength(2);
    expect(sections[0].filename).toBe('');
    expect(sections[0].lines).toContain('commit notes from -m');
    expect(sections[1]).toMatchObject({ filename: 'x', additions: 1 });
  });
});

describe('annotateDiffLines', () => {
  it('tracks old/new line numbers through hunks', () => {
    const lines = [
      'diff --git a/f.txt b/f.txt',
      '--- a/f.txt',
      '+++ b/f.txt',
      '@@ -10,3 +20,4 @@ context fn',
      ' unchanged-a', //  old 10, new 20
      '-removed', //      old 11
      '+added-1', //               new 21
      '+added-2', //               new 22
      ' unchanged-b', //  old 12, new 23
    ];
    const out = annotateDiffLines(lines);
    expect(out[0]).toMatchObject({ oldLine: null, newLine: null }); // diff header
    expect(out[3]).toMatchObject({ oldLine: null, newLine: null }); // hunk header
    expect(out[4]).toMatchObject({ text: ' unchanged-a', oldLine: 10, newLine: 20 });
    expect(out[5]).toMatchObject({ text: '-removed', oldLine: 11, newLine: null });
    expect(out[6]).toMatchObject({ text: '+added-1', oldLine: null, newLine: 21 });
    expect(out[7]).toMatchObject({ text: '+added-2', oldLine: null, newLine: 22 });
    expect(out[8]).toMatchObject({ text: ' unchanged-b', oldLine: 12, newLine: 23 });
  });

  it('handles multiple hunks and single-line hunk headers', () => {
    const lines = ['@@ -1 +1 @@', '-old', '+new', '@@ -50,2 +60,2 @@', ' ctx', '+tail'];
    const out = annotateDiffLines(lines);
    expect(out[1]).toMatchObject({ text: '-old', oldLine: 1 });
    expect(out[2]).toMatchObject({ text: '+new', newLine: 1 });
    expect(out[4]).toMatchObject({ text: ' ctx', oldLine: 50, newLine: 60 });
    expect(out[5]).toMatchObject({ text: '+tail', newLine: 61 });
  });

  it('marks "no newline" markers and empty input safely', () => {
    expect(annotateDiffLines([])).toEqual([]);
    expect(annotateDiffLines(null)).toEqual([]);
    const out = annotateDiffLines(['@@ -1 +1 @@', '+x', '\\ No newline at end of file']);
    expect(out[2]).toMatchObject({ oldLine: null, newLine: null });
  });
});
