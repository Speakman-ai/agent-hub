// @ts-nocheck
import { describe, it, expect } from 'vitest';
import {
  mergeEditInputWithToolResult,
  isFileModifyingTool,
  shortenPath,
  parseDiffLines,
  isExplicitEmptyWrite,
  diffHasDisplayableLines,
} from './diff';
describe('isFileModifyingTool', () => {
  it('returns true for Edit and Write', () => {
    expect(isFileModifyingTool('Edit')).toBe(true);
    expect(isFileModifyingTool('Write')).toBe(true);
  });
  it('returns false for other tools', () => {
    expect(isFileModifyingTool('Read')).toBe(false);
    expect(isFileModifyingTool('Bash')).toBe(false);
    expect(isFileModifyingTool('Grep')).toBe(false);
    expect(isFileModifyingTool(undefined)).toBe(false);
  });
});
describe('shortenPath', () => {
  it('returns empty string for falsy input', () => {
    expect(shortenPath('')).toBe('');
    expect(shortenPath(null)).toBe('');
    expect(shortenPath(undefined)).toBe('');
  });
  it('returns the path unchanged when 3 or fewer segments', () => {
    expect(shortenPath('a/b/c')).toBe('a/b/c');
    expect(shortenPath('foo.js')).toBe('foo.js');
  });
  it('returns the last 3 segments for longer paths', () => {
    expect(shortenPath('/home/user/app/src/components/Foo.jsx')).toBe('src/components/Foo.jsx');
  });
});
describe('parseDiffLines', () => {
  it('parses Edit tool input into removals and additions', () => {
    const { filePath, action, removals, additions } = parseDiffLines('Edit', {
      file_path: '/proj/src/a.js',
      old_string: 'const a = 1;\nconst b = 2;',
      new_string: 'const a = 10;\nconst b = 20;',
    });
    expect(filePath).toBe('/proj/src/a.js');
    expect(action).toBe('Update');
    expect(removals).toEqual(['const a = 1;', 'const b = 2;']);
    expect(additions).toEqual(['const a = 10;', 'const b = 20;']);
  });
  it('parses Write tool input into additions only', () => {
    const content = Array.from({ length: 25 }, (_: any, i: any) => `line ${i + 1}`).join('\n');
    const { filePath, action, removals, additions } = parseDiffLines('Write', {
      file_path: '/proj/new.js',
      content,
    });
    expect(filePath).toBe('/proj/new.js');
    expect(action).toBe('Create');
    expect(removals).toEqual([]);
    // Truncated to 20 lines + the summary marker.
    expect(additions).toHaveLength(21);
    expect(additions[20]).toMatch(/\+5 more lines/);
  });
  it('handles missing fields gracefully (no blank gutter rows)', () => {
    const result = parseDiffLines('Edit', {});
    expect(result.filePath).toBe('');
    expect(result.action).toBe('Update');
    expect(result.removals).toEqual([]);
    expect(result.additions).toEqual([]);
  });
  it('accepts path alias alongside file_path', () => {
    const { filePath } = parseDiffLines('Write', { path: '/legacy/a.js', content: 'x' });
    expect(filePath).toBe('/legacy/a.js');
  });
  it('parses Codex file_change changes[]', () => {
    const { filePath, action, additions } = parseDiffLines('Edit', {
      changes: [{ path: 'x.ts', kind: 'update' }],
    });
    expect(filePath).toBe('x.ts');
    expect(action).toBe('Update');
    expect(additions[0]).toContain('line-level diff not included');
  });
  it('parses Codex unified_diff into removals and additions', () => {
    const { removals, additions } = parseDiffLines('Edit', {
      changes: [{ path: 'x.ts', kind: 'update', unified_diff: '-old\n+new' }],
    });
    expect(removals).toEqual(['old']);
    expect(additions).toEqual(['update  x.ts', 'new']);
  });
  it('parses Cursor Edit root-level unified_diff', () => {
    const { removals, additions } = parseDiffLines('Edit', {
      path: 'z.ts',
      unified_diff: '-a\n+b',
    });
    expect(removals).toEqual(['a']);
    expect(additions).toEqual(['b']);
  });
  it('parses Cursor Agent editToolCall strReplace (nested oldText/newText)', () => {
    const { filePath, removals, additions } = parseDiffLines('Edit', {
      path: 'server/design-multi-engine.ts',
      strReplace: {
        oldText: 'export const a = 1;',
        newText: 'export const a = 2;',
      },
    });
    expect(filePath).toBe('server/design-multi-engine.ts');
    expect(removals).toEqual(['export const a = 1;']);
    expect(additions).toEqual(['export const a = 2;']);
  });
  it('parses Cursor applyPatch.patchContent into +/- line bodies', () => {
    const { removals, additions } = parseDiffLines('Edit', {
      path: 'foo.ts',
      applyPatch: {
        patchContent: '@@ -1,2 +1,2 @@\n-old\n+new',
      },
    });
    expect(removals).toEqual(['old']);
    expect(additions).toEqual(['new']);
  });
  it('parses Cursor multiStrReplace edits sequentially', () => {
    const { removals, additions } = parseDiffLines('Edit', {
      path: 'x.ts',
      multiStrReplace: {
        edits: [
          { oldText: 'a', newText: 'b' },
          { oldText: 'c', newText: 'd' },
        ],
      },
    });
    expect(removals).toEqual(['a', '', 'c']);
    expect(additions).toEqual(['b', '· · ·', 'd']);
  });
  it('parses Write when Cursor uses fileText / contents', () => {
    expect(parseDiffLines('Write', { path: '/p/a.js', fileText: 'one\ntwo' }).additions).toEqual([
      'one',
      'two',
    ]);
    expect(parseDiffLines('Write', { path: '/p/b.js', contents: 'x' }).additions).toEqual(['x']);
  });
  it('accepts camelCase oldString/newString as Claude-style fallback', () => {
    const { removals, additions } = parseDiffLines('Edit', {
      path: '/z.ts',
      oldString: 'x',
      newString: 'y',
    });
    expect(removals).toEqual(['x']);
    expect(additions).toEqual(['y']);
  });
  it('ignores empty strReplace object and uses Claude-style old_string', () => {
    const { removals, additions } = parseDiffLines('Edit', {
      path: '/z.ts',
      strReplace: {},
      old_string: 'a',
      new_string: 'b',
    });
    expect(removals).toEqual(['a']);
    expect(additions).toEqual(['b']);
  });
  // Mobile twin of the same contract in the web diff.test.js — Composer 2.5
  // path-only Edit must yield empty arrays so DiffView shows a placeholder.
  it('returns empty additions/removals for Edit with strReplace:{} and no fallback content', () => {
    const result = parseDiffLines('Edit', { path: 'f.ts', strReplace: {} });
    expect(result.removals).toEqual([]);
    expect(result.additions).toEqual([]);
    expect(diffHasDisplayableLines('Edit', { path: 'f.ts', strReplace: {} })).toBe(false);
  });
});
describe('isExplicitEmptyWrite', () => {
  it('returns true when Write content is the empty string', () => {
    expect(isExplicitEmptyWrite('Write', { path: '/x.txt', content: '' })).toBe(true);
    expect(isExplicitEmptyWrite('Write', { path: '/x.txt', fileText: '' })).toBe(true);
    expect(isExplicitEmptyWrite('Write', { path: '/x.txt', contents: '' })).toBe(true);
  });
  it('returns false when Write body field is absent (pending args)', () => {
    expect(isExplicitEmptyWrite('Write', { path: '/x.txt' })).toBe(false);
    expect(isExplicitEmptyWrite('Write', {})).toBe(false);
  });
  it('returns false for Edit (Edit-no-content stays on the pending placeholder)', () => {
    expect(isExplicitEmptyWrite('Edit', { path: 'f.ts', strReplace: {} })).toBe(false);
  });
});

describe('completed Codex file changes', () => {
  it('renders recovered added-file contents after merging the tool result', () => {
    const input = { changes: [{ path: 'research/test.py', kind: 'add' }] };
    const result = {
      output: JSON.stringify([
        { ...input.changes[0], content: 'def test_annotation():\n    assert True' },
      ]),
    };
    const diff = parseDiffLines('Edit', mergeEditInputWithToolResult(input, result));
    expect(diff.additions).toContain('def test_annotation():');
    expect(diff.additions.join('\n')).not.toContain('line-level diff not included');
  });
  it('renders completed updates and deletions from patch aliases', () => {
    const input = {
      changes: [
        { path: 'a.ts', kind: 'update' },
        { path: 'b.ts', kind: 'delete' },
      ],
    };
    const result = {
      output: JSON.stringify([
        { ...input.changes[0], patch: '@@ -1 +1 @@\n-before\n+after' },
        { ...input.changes[1], unified_diff: '@@ -1 +0,0 @@\n-deleted' },
      ]),
    };
    const diff = parseDiffLines('Edit', mergeEditInputWithToolResult(input, result));
    expect(diff.removals).toEqual(['before', '', 'deleted']);
    expect(diff.additions).toContain('after');
  });
});

describe('Codex changes discovered on completion', () => {
  it('renders files when item.started had an empty change list', () => {
    const merged = mergeEditInputWithToolResult(
      { changes: [] },
      {
        output: JSON.stringify([
          { path: 'file.ts', kind: 'update', unified_diff: '@@ -1 +1 @@\n-before\n+after' },
        ]),
      },
    );
    const diff = parseDiffLines('Edit', merged);
    expect(diff.removals).toEqual(['before']);
    expect(diff.additions).toContain('after');
  });
});

describe('Codex recovered content presence', () => {
  it.each(['', ' \t', '\n \n'])(
    'preserves recovered content %j through merging and rendering',
    (content) => {
      const change = { path: 'file.txt', kind: 'add' };
      const input = { changes: [change] };
      const merged = mergeEditInputWithToolResult(input, {
        output: JSON.stringify([{ ...change, content }]),
      });
      expect(merged.changes[0].content).toBe(content);
      expect(input.changes[0]).not.toHaveProperty('content');
      expect(parseDiffLines('Edit', merged).additions).toEqual([
        'add  file.txt',
        ...(content === '' ? ['(empty file)'] : content.split('\n')),
      ]);
    },
  );

  it.each(['', ' \t', '\n \n'])('renders supplied content %j as present', (content) => {
    const input = { changes: [{ path: 'file.txt', kind: 'add', content }] };
    expect(parseDiffLines('Edit', input).additions).toEqual([
      'add  file.txt',
      ...(content === '' ? ['(empty file)'] : content.split('\n')),
    ]);
    expect(diffHasDisplayableLines('Edit', input)).toBe(true);
  });

  it.each([undefined, null])('keeps the unavailable hint for missing content %j', (content) => {
    const change = { path: 'file.txt', kind: 'add' };
    const merged = mergeEditInputWithToolResult(
      { changes: [change] },
      {
        output: JSON.stringify([{ ...change, content }]),
      },
    );
    expect(merged.changes[0]).not.toHaveProperty('content');
    expect(parseDiffLines('Edit', merged).additions[0]).toContain('line-level diff not included');
  });
});
