import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import path from 'path';
import os from 'os';
import { parseToolErrorsFromNote, aggregateToolErrors } from './tool-errors.js';

describe('parseToolErrorsFromNote', () => {
  it('parses a well-formed line', () => {
    const note = [
      '## 02:45',
      '```',
      'TOOL_ERROR | 2026-04-16T02:45:00Z | Bash | npm test | exit 1 | ENOENT: tsx not found in PATH',
      '```',
      '',
    ].join('\n');
    const got = parseToolErrorsFromNote(note, '2026-04-16');
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({
      timestamp: '2026-04-16T02:45:00Z',
      tool: 'Bash',
      action: 'npm test',
      errorType: 'exit 1',
      summary: 'ENOENT: tsx not found in PATH',
      date: '2026-04-16',
    });
  });

  it('ignores non-matching lines including prose that mentions tool_error', () => {
    const note = [
      'Just prose talking about TOOL_ERROR protocol.',
      '## 09:00',
      'Nothing to see here.',
    ].join('\n');
    expect(parseToolErrorsFromNote(note, '2026-04-17')).toEqual([]);
  });

  it('skips malformed lines (too few fields)', () => {
    const note = 'TOOL_ERROR | 2026-04-16T02:45:00Z | Bash | only four fields';
    expect(parseToolErrorsFromNote(note, '2026-04-16')).toEqual([]);
  });

  it('parses multiple lines in one note', () => {
    const note = [
      'TOOL_ERROR | 2026-04-16T02:45:00Z | Bash | npm test | exit 1 | tsx missing',
      'TOOL_ERROR | 2026-04-16T03:00:00Z | Read | /tmp/foo | ENOENT | no such file',
    ].join('\n');
    const got = parseToolErrorsFromNote(note, '2026-04-16');
    expect(got).toHaveLength(2);
    expect(got.map((e) => e.tool)).toEqual(['Bash', 'Read']);
  });

  it('tolerates extra pipe in summary (defence-in-depth)', () => {
    const note = 'TOOL_ERROR | 2026-04-16T02:45:00Z | Bash | cmd | exit 2 | part one | part two';
    const got = parseToolErrorsFromNote(note, '2026-04-16');
    expect(got).toHaveLength(1);
    expect(got[0].summary).toBe('part one | part two');
  });
});

describe('aggregateToolErrors', () => {
  let tmpDir: string;
  let memoryDir: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `tool-errors-test-${Date.now()}-${Math.random()}`);
    memoryDir = path.join(tmpDir, 'memory');
    mkdirSync(memoryDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it('returns an empty aggregate when workspace is missing', () => {
    const agg = aggregateToolErrors(undefined);
    expect(agg.total).toBe(0);
    expect(agg.errors).toEqual([]);
  });

  it('returns empty aggregate when memory dir does not exist', () => {
    const agg = aggregateToolErrors(path.join(tmpDir, 'nope'));
    expect(agg.total).toBe(0);
  });

  it('aggregates across multiple daily notes and builds count buckets', () => {
    writeFileSync(
      path.join(memoryDir, '2026-04-15.md'),
      'TOOL_ERROR | 2026-04-15T12:00:00Z | Bash | a | exit 1 | one\n',
      'utf-8',
    );
    writeFileSync(
      path.join(memoryDir, '2026-04-16.md'),
      [
        'TOOL_ERROR | 2026-04-16T02:45:00Z | Bash | b | exit 1 | two',
        'TOOL_ERROR | 2026-04-16T03:00:00Z | Read | c | ENOENT | three',
      ].join('\n'),
      'utf-8',
    );

    const agg = aggregateToolErrors(tmpDir);
    expect(agg.total).toBe(3);
    expect(agg.countsByTool).toEqual({ Bash: 2, Read: 1 });
    expect(agg.countsByErrorType).toEqual({ 'exit 1': 2, ENOENT: 1 });
    expect(agg.countsByDate).toEqual({ '2026-04-15': 1, '2026-04-16': 2 });
    // Newest-first.
    expect(agg.errors[0].timestamp).toBe('2026-04-16T03:00:00Z');
  });

  it('filters files by `since` (inclusive)', () => {
    writeFileSync(
      path.join(memoryDir, '2026-04-10.md'),
      'TOOL_ERROR | 2026-04-10T12:00:00Z | Bash | old | exit 1 | old error\n',
      'utf-8',
    );
    writeFileSync(
      path.join(memoryDir, '2026-04-16.md'),
      'TOOL_ERROR | 2026-04-16T02:45:00Z | Bash | new | exit 1 | new error\n',
      'utf-8',
    );

    const agg = aggregateToolErrors(tmpDir, { since: '2026-04-16' });
    expect(agg.total).toBe(1);
    expect(agg.errors[0].summary).toBe('new error');
  });

  it('ignores non-daily-note files in memory/', () => {
    writeFileSync(
      path.join(memoryDir, 'random.md'),
      'TOOL_ERROR | 2026-04-15T12:00:00Z | Bash | x | exit 1 | ignore me\n',
      'utf-8',
    );
    const agg = aggregateToolErrors(tmpDir);
    expect(agg.total).toBe(0);
  });
});
