import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import path from 'path';
import os from 'os';
import {
  parseToolErrorsFromNote,
  aggregateToolErrors,
  parseMetaFromJsonTail,
} from './tool-errors.js';

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

  it('v1 lines get default meta (v=1, sev=blocked, resolution=unresolved)', () => {
    const note = 'TOOL_ERROR | 2026-04-16T02:45:00Z | Bash | npm test | exit 1 | tsx missing';
    const [got] = parseToolErrorsFromNote(note, '2026-04-16');
    expect(got.meta).toEqual({ v: 1, sev: 'blocked', resolution: 'unresolved' });
  });

  it('v2 JSON tail is peeled off and parsed into meta', () => {
    const tail =
      '{"v":2,"sev":"soft","resolution":"recovered","session":"s1","agent":"hub-backend","attempt":2,"tags":["ci","deploy"]}';
    const note = `TOOL_ERROR | 2026-04-16T02:45:00Z | Bash | npm test | exit 1 | tsx missing | ${tail}`;
    const [got] = parseToolErrorsFromNote(note, '2026-04-16');
    expect(got.summary).toBe('tsx missing');
    expect(got.meta).toMatchObject({
      v: 2,
      sev: 'soft',
      resolution: 'recovered',
      session: 's1',
      agent: 'hub-backend',
      attempt: 2,
      tags: ['ci', 'deploy'],
    });
  });

  it('v2 tail containing pipes inside JSON strings does not shred the line', () => {
    // The writer sanitises `|` in positional fields, so raw pipes only ever
    // appear inside the JSON tail's string values. This covers that path —
    // we must peel the JSON atomically before splitting the positional
    // fields on `|` or the tags would get shredded.
    const tail = '{"v":2,"sev":"blocked","tags":["foo|bar","baz|qux"]}';
    const note = `TOOL_ERROR | 2026-04-16T02:45:00Z | Bash | cmd | exit 1 | summary text | ${tail}`;
    const [got] = parseToolErrorsFromNote(note, '2026-04-16');
    expect(got.summary).toBe('summary text');
    expect(got.action).toBe('cmd');
    expect(got.meta.tags).toEqual(['foo|bar', 'baz|qux']);
  });

  it('malformed JSON tail falls back to treating the line as v1', () => {
    const note =
      'TOOL_ERROR | 2026-04-16T02:45:00Z | Bash | cmd | exit 1 | summary with {not: real json}';
    const [got] = parseToolErrorsFromNote(note, '2026-04-16');
    expect(got.meta.v).toBe(1);
    // The `{not: real json}` lives inside the summary; nothing was peeled.
    expect(got.summary).toContain('{not: real json}');
  });

  it('unknown enum values in v2 meta collapse to "unknown"', () => {
    const tail = '{"v":2,"sev":"catastrophic","resolution":"fancy"}';
    const note = `TOOL_ERROR | 2026-04-16T02:45:00Z | Bash | cmd | exit 1 | summary | ${tail}`;
    const [got] = parseToolErrorsFromNote(note, '2026-04-16');
    expect(got.meta.sev).toBe('unknown');
    expect(got.meta.resolution).toBe('unknown');
  });

  it('v2 meta preserves unknown keys under extras', () => {
    const tail = '{"v":2,"sev":"blocked","custom_key":"future-use","other":42}';
    const note = `TOOL_ERROR | 2026-04-16T02:45:00Z | Bash | cmd | exit 1 | summary | ${tail}`;
    const [got] = parseToolErrorsFromNote(note, '2026-04-16');
    expect(got.meta.extras).toEqual({ custom_key: 'future-use', other: 42 });
  });

  it('v2 tail with nested JSON objects round-trips correctly', () => {
    const tail = '{"v":2,"sev":"blocked","extras":{"nested":{"a":1},"list":[1,2]}}';
    const note = `TOOL_ERROR | 2026-04-16T02:45:00Z | Bash | cmd | exit 1 | summary | ${tail}`;
    const [got] = parseToolErrorsFromNote(note, '2026-04-16');
    expect(got.summary).toBe('summary');
    expect(got.meta.v).toBe(2);
    expect(got.meta.sev).toBe('blocked');
    expect(got.meta.extras).toEqual({ extras: { nested: { a: 1 }, list: [1, 2] } });
  });

  it('mixed v1 + v2 lines in a single note parse side-by-side', () => {
    const note = [
      'TOOL_ERROR | 2026-04-16T02:00:00Z | Bash | npm test | exit 1 | v1 line',
      'TOOL_ERROR | 2026-04-16T03:00:00Z | Bash | npm test | exit 1 | v2 line | {"v":2,"sev":"retry","attempt":3}',
    ].join('\n');
    const got = parseToolErrorsFromNote(note, '2026-04-16');
    expect(got).toHaveLength(2);
    expect(got[0].meta.v).toBe(1);
    expect(got[1].meta.v).toBe(2);
    expect(got[1].meta.sev).toBe('retry');
    expect(got[1].meta.attempt).toBe(3);
  });
});

describe('parseMetaFromJsonTail', () => {
  it('returns defaults when JSON is invalid', () => {
    expect(parseMetaFromJsonTail('{not json}')).toEqual({
      v: 1,
      sev: 'blocked',
      resolution: 'unresolved',
    });
  });

  it('returns defaults when JSON is an array (not an object)', () => {
    expect(parseMetaFromJsonTail('[1,2,3]')).toEqual({
      v: 1,
      sev: 'blocked',
      resolution: 'unresolved',
    });
  });

  it('coerces v=1 when explicitly present', () => {
    const meta = parseMetaFromJsonTail('{"v":1,"sev":"soft"}');
    expect(meta.v).toBe(1);
    expect(meta.sev).toBe('soft');
  });

  it('filters non-string entries out of tags', () => {
    const meta = parseMetaFromJsonTail('{"v":2,"tags":["a",1,"b",null,"c"]}');
    expect(meta.tags).toEqual(['a', 'b', 'c']);
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
    // All-v1 corpus: severity + resolution + version buckets match defaults.
    expect(agg.countsBySeverity).toEqual({ blocked: 3 });
    expect(agg.countsByResolution).toEqual({ unresolved: 3 });
    expect(agg.countsByVersion).toEqual({ v1: 3 });
    // Newest-first.
    expect(agg.errors[0].timestamp).toBe('2026-04-16T03:00:00Z');
  });

  it('aggregates v2 structured buckets when the corpus contains JSON tails', () => {
    writeFileSync(
      path.join(memoryDir, '2026-04-16.md'),
      [
        // v1 — defaults to blocked/unresolved/v1
        'TOOL_ERROR | 2026-04-16T01:00:00Z | Bash | a | exit 1 | v1',
        // v2 soft/recovered
        'TOOL_ERROR | 2026-04-16T02:00:00Z | Bash | b | exit 1 | v2a | {"v":2,"sev":"soft","resolution":"recovered"}',
        // v2 retry/escalated with attempt counter
        'TOOL_ERROR | 2026-04-16T03:00:00Z | Bash | c | exit 1 | v2b | {"v":2,"sev":"retry","resolution":"escalated","attempt":4}',
      ].join('\n'),
      'utf-8',
    );

    const agg = aggregateToolErrors(tmpDir);
    expect(agg.total).toBe(3);
    expect(agg.countsBySeverity).toEqual({ blocked: 1, soft: 1, retry: 1 });
    expect(agg.countsByResolution).toEqual({ unresolved: 1, recovered: 1, escalated: 1 });
    expect(agg.countsByVersion).toEqual({ v1: 1, v2: 2 });
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
