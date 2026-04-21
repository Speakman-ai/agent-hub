import { describe, it, expect } from 'vitest';
import { isFileModifyingTool, shortenPath, parseDiffLines } from './diff.js';

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
    const content = Array.from({ length: 25 }, (_, i) => `line ${i + 1}`).join('\n');
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

  it('handles missing fields gracefully', () => {
    const result = parseDiffLines('Edit', {});
    expect(result.filePath).toBe('');
    expect(result.action).toBe('Update');
    expect(result.removals).toEqual(['']);
    expect(result.additions).toEqual(['']);
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
});
