import { describe, it, expect } from 'vitest';
import { isFileModifyingTool, shortenPath, parseDiffLines } from './diff.js';

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

  it('handles missing input fields gracefully', () => {
    const result = parseDiffLines('Edit', {});
    expect(result.filePath).toBe('');
    expect(result.removals).toEqual(['']);
    expect(result.additions).toEqual(['']);
  });

  it('handles null input', () => {
    const result = parseDiffLines('Edit', null);
    expect(result.filePath).toBe('');
    expect(result.removals).toEqual(['']);
    expect(result.additions).toEqual(['']);
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
    expect(result.additions).toHaveLength(2);
    expect(result.additions[0]).toMatch(/^add\s+a\.ts/);
    expect(result.additions[1]).toMatch(/^delete\s+b\.ts/);
  });

  it('renders Codex unified_diff when present', () => {
    const result = parseDiffLines('Edit', {
      changes: [{ path: 'x.ts', kind: 'update', unified_diff: '-old\n+new' }],
    });
    expect(result.filePath).toBe('x.ts');
    expect(result.additions).toEqual(['update  x.ts', '-old', '+new']);
  });
});
