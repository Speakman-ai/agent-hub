import { describe, it, expect } from 'vitest';
import {
  isFileModifyingTool,
  shortenPath,
  parseDiffLines,
  mergeEditInputWithToolResult,
  diffHasDisplayableLines,
  isExplicitEmptyWrite,
} from './diff.js';

describe('isFileModifyingTool', () => {
  it('returns true for Edit and Write', () => {
    expect(isFileModifyingTool('Edit')).toBe(true);
    expect(isFileModifyingTool('Write')).toBe(true);
  });

  it('returns false for non-modifying tools', () => {
    expect(isFileModifyingTool('Read')).toBe(false);
    expect(isFileModifyingTool('Bash')).toBe(false);
    expect(isFileModifyingTool('Grep')).toBe(false);
    expect(isFileModifyingTool('Glob')).toBe(false);
  });
});

describe('shortenPath', () => {
  it('returns empty string for falsy input', () => {
    expect(shortenPath('')).toBe('');
    expect(shortenPath(null)).toBe('');
    expect(shortenPath(undefined)).toBe('');
  });

  it('returns short paths unchanged', () => {
    expect(shortenPath('/src/App.jsx')).toBe('/src/App.jsx');
    expect(shortenPath('src/App.jsx')).toBe('src/App.jsx');
  });

  it('shortens long paths to last 3 segments', () => {
    expect(shortenPath('/home/user/projects/app/src/components/Foo.jsx')).toBe(
      'src/components/Foo.jsx',
    );
    expect(shortenPath('/a/b/c/d/e.js')).toBe('c/d/e.js');
  });
});

describe('parseDiffLines', () => {
  it('parses Edit tool with old_string and new_string', () => {
    const result = parseDiffLines('Edit', {
      file_path: '/src/App.jsx',
      old_string: 'const a = 1;\nconst b = 2;',
      new_string: 'const a = 10;\nconst b = 20;\nconst c = 30;',
    });

    expect(result.filePath).toBe('/src/App.jsx');
    expect(result.action).toBe('Update');
    expect(result.removals).toEqual(['const a = 1;', 'const b = 2;']);
    expect(result.additions).toEqual(['const a = 10;', 'const b = 20;', 'const c = 30;']);
  });

  it('parses Write tool — shows all content as additions', () => {
    const result = parseDiffLines('Write', {
      file_path: '/src/new-file.js',
      content: 'line1\nline2\nline3',
    });

    expect(result.filePath).toBe('/src/new-file.js');
    expect(result.action).toBe('Create');
    expect(result.removals).toEqual([]);
    expect(result.additions).toEqual(['line1', 'line2', 'line3']);
  });

  it('truncates Write content beyond 20 lines', () => {
    const lines = Array.from({ length: 25 }, (_, i) => `line ${i + 1}`);
    const result = parseDiffLines('Write', {
      file_path: '/src/big.js',
      content: lines.join('\n'),
    });

    expect(result.additions).toHaveLength(21); // 20 lines + 1 truncation message
    expect(result.additions[20]).toBe('… +5 more lines');
  });

  it('handles missing input fields gracefully (no blank gutter rows)', () => {
    const result = parseDiffLines('Edit', {});
    expect(result.filePath).toBe('');
    expect(result.removals).toEqual([]);
    expect(result.additions).toEqual([]);
    expect(diffHasDisplayableLines('Edit', {})).toBe(false);
  });

  it('handles null input', () => {
    const result = parseDiffLines('Edit', null);
    expect(result.filePath).toBe('');
    expect(result.removals).toEqual([]);
    expect(result.additions).toEqual([]);
  });

  it('ignores empty strReplace shell (falls through to old_string)', () => {
    const result = parseDiffLines('Edit', {
      path: 'x.ts',
      strReplace: {},
      old_string: 'a',
      new_string: 'b',
    });
    expect(result.removals).toEqual(['a']);
    expect(result.additions).toEqual(['b']);
  });

  it('does not treat empty strReplace oldText/newText as displayable', () => {
    expect(
      diffHasDisplayableLines('Edit', {
        path: 'cad/foo.ts',
        strReplace: { oldText: '', newText: '' },
      }),
    ).toBe(false);
  });

  it('parses Codex file_change changes[] (path + kind only)', () => {
    const result = parseDiffLines('Edit', {
      changes: [{ path: 'server/foo.ts', kind: 'update' }],
    });
    expect(result.filePath).toBe('server/foo.ts');
    expect(result.action).toBe('Update');
    expect(result.removals).toEqual([]);
    expect(result.additions[0]).toContain('server/foo.ts');
    expect(result.additions[0]).toContain('line-level diff not included');
  });

  it('parses Codex multi-file patch as Patch summary', () => {
    const result = parseDiffLines('Edit', {
      changes: [
        { path: 'a.ts', kind: 'add' },
        { path: 'b.ts', kind: 'delete' },
      ],
    });
    expect(result.filePath).toBe('2 files');
    expect(result.action).toBe('Patch');
    expect(result.additions).toHaveLength(3);
    expect(result.additions[0]).toMatch(/^add\s+a\.ts/);
    expect(result.additions[1]).toBe('· · ·');
    expect(result.additions[2]).toMatch(/^delete\s+b\.ts/);
  });

  it('renders Codex unified_diff as removals/additions (not duplicated +/- gutters)', () => {
    const result = parseDiffLines('Edit', {
      changes: [{ path: 'x.ts', kind: 'update', unified_diff: '-old\n+new' }],
    });
    expect(result.filePath).toBe('x.ts');
    expect(result.removals).toEqual(['old']);
    expect(result.additions).toEqual(['update  x.ts', 'new']);
  });

  it('parses CRLF unified_diff bodies', () => {
    const result = parseDiffLines('Edit', {
      changes: [{ path: 'x.ts', kind: 'update', unified_diff: '-old\r\n+new\r\n' }],
    });
    expect(result.removals).toEqual(['old']);
    expect(result.additions).toEqual(['update  x.ts', 'new']);
  });

  it('parses Unicode minus leader as removal', () => {
    const result = parseDiffLines('Edit', {
      changes: [{ path: 'x.ts', kind: 'update', unified_diff: '\u2212old\n+new' }],
    });
    expect(result.removals).toEqual(['old']);
    expect(result.additions).toEqual(['update  x.ts', 'new']);
  });

  it('merges Codex file_change unified_diff from tool_result.output JSON', () => {
    const input = { changes: [{ path: 'ci.yml', kind: 'update' }] };
    const merged = mergeEditInputWithToolResult(input, {
      output: JSON.stringify([
        { path: 'ci.yml', kind: 'update', unified_diff: '-before\n+after\n' },
      ]),
    });
    const result = parseDiffLines('Edit', merged);
    expect(result.removals).toEqual(['before']);
    expect(result.additions).toEqual(['update  ci.yml', 'after']);
  });

  it('parses Codex git-style unified_diff headers', () => {
    const patch = [
      'diff --git a/x.ts b/x.ts',
      'index 1111111..2222222 100644',
      '--- a/x.ts',
      '+++ b/x.ts',
      '@@ -1,1 +1,1 @@',
      '-alpha',
      '+beta',
    ].join('\n');
    const result = parseDiffLines('Edit', {
      changes: [{ path: 'x.ts', kind: 'update', unified_diff: patch }],
    });
    expect(result.removals).toEqual(['alpha']);
    expect(result.additions).toEqual(['update  x.ts', 'beta']);
  });

  it('parses Cursor Edit root-level unified_diff when no strReplace', () => {
    const result = parseDiffLines('Edit', {
      path: 'z.ts',
      unified_diff: '-a\n+b',
    });
    expect(result.filePath).toBe('z.ts');
    expect(result.removals).toEqual(['a']);
    expect(result.additions).toEqual(['b']);
  });

  it('parses Codex multi-file unified_diff with file separators', () => {
    const result = parseDiffLines('Edit', {
      changes: [
        { path: 'a.ts', kind: 'update', unified_diff: '-x\n+y' },
        { path: 'b.ts', kind: 'update', unified_diff: '-p\n+q' },
      ],
    });
    expect(result.removals).toEqual(['x', '', 'p']);
    expect(result.additions).toEqual(['update  a.ts', 'y', '· · ·', 'update  b.ts', 'q']);
  });

  it('parses Cursor Agent editToolCall strReplace (nested oldText/newText)', () => {
    const result = parseDiffLines('Edit', {
      path: 'server/design-multi-engine.ts',
      strReplace: {
        oldText: 'export const a = 1;',
        newText: 'export const a = 2;',
      },
    });
    expect(result.filePath).toBe('server/design-multi-engine.ts');
    expect(result.removals).toEqual(['export const a = 1;']);
    expect(result.additions).toEqual(['export const a = 2;']);
  });

  it('parses Cursor applyPatch.patchContent into +/- line bodies', () => {
    const result = parseDiffLines('Edit', {
      path: 'foo.ts',
      applyPatch: {
        patchContent: '@@ -1,2 +1,2 @@\n-old\n+new',
      },
    });
    expect(result.removals).toEqual(['old']);
    expect(result.additions).toEqual(['new']);
  });

  it('parses Cursor multiStrReplace edits sequentially', () => {
    const result = parseDiffLines('Edit', {
      path: 'x.ts',
      multiStrReplace: {
        edits: [
          { oldText: 'a', newText: 'b' },
          { oldText: 'c', newText: 'd' },
        ],
      },
    });
    expect(result.removals).toEqual(['a', '', 'c']);
    expect(result.additions).toEqual(['b', '· · ·', 'd']);
  });

  it('parses Write tool when Cursor uses fileText / contents', () => {
    expect(parseDiffLines('Write', { path: '/p/a.js', fileText: 'one\ntwo' }).additions).toEqual([
      'one',
      'two',
    ]);
    expect(parseDiffLines('Write', { path: '/p/b.js', contents: 'x' }).additions).toEqual(['x']);
  });

  it('accepts camelCase oldString/newString as Claude-style fallback', () => {
    const result = parseDiffLines('Edit', {
      path: '/z.ts',
      oldString: 'x',
      newString: 'y',
    });
    expect(result.removals).toEqual(['x']);
    expect(result.additions).toEqual(['y']);
  });

  it('ignores empty strReplace object and uses Claude-style old_string', () => {
    const result = parseDiffLines('Edit', {
      path: '/z.ts',
      strReplace: {},
      old_string: 'a',
      new_string: 'b',
    });
    expect(result.removals).toEqual(['a']);
    expect(result.additions).toEqual(['b']);
  });

  // Pins the contract that Composer 2.5's content-less Edit (path + empty
  // strReplace + no Claude-style fallback fields, no diffString) yields
  // EMPTY arrays — not [''] — so DiffView renders its placeholder instead
  // of two blank +/- gutter rows. See review item #7 on PR #1058.
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

  it('returns false when Write body field is missing (args not yet arrived)', () => {
    // Distinguishing "content explicitly ''" from "field absent" is the
    // whole point of the helper — the absent case should fall back to
    // the standard "pending or unavailable" placeholder.
    expect(isExplicitEmptyWrite('Write', { path: '/x.txt' })).toBe(false);
    expect(isExplicitEmptyWrite('Write', {})).toBe(false);
    expect(isExplicitEmptyWrite('Write', null)).toBe(false);
  });

  it('returns false when Write body has content', () => {
    expect(isExplicitEmptyWrite('Write', { path: '/x.txt', content: 'hello' })).toBe(false);
  });

  it('returns false for Edit even with empty strReplace (Edit gets the pending placeholder)', () => {
    expect(isExplicitEmptyWrite('Edit', { path: 'f.ts', strReplace: {} })).toBe(false);
    expect(isExplicitEmptyWrite('Edit', { path: 'f.ts' })).toBe(false);
  });

  it('returns false for non-file-modifying tools', () => {
    expect(isExplicitEmptyWrite('Bash', { content: '' })).toBe(false);
    expect(isExplicitEmptyWrite('Read', { content: '' })).toBe(false);
  });
});
