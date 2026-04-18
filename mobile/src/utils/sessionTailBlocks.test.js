import { describe, it, expect } from 'vitest';
import { eventsToBlocks, summarizeToolInput } from './sessionTailBlocks.js';

const seq = (events) => events.map((event, i) => ({ seq: i, event }));

describe('eventsToBlocks', () => {
  it('returns empty array for missing/empty events', () => {
    expect(eventsToBlocks(undefined)).toEqual([]);
    expect(eventsToBlocks([])).toEqual([]);
  });

  it('discriminates subagent tools (Task, Agent) from regular tools', () => {
    const blocks = eventsToBlocks(
      seq([
        { type: 'tool_use', id: 't1', tool: 'Bash', input: { command: 'ls' } },
        { type: 'tool_use', id: 't2', tool: 'Task', input: { description: 'look' } },
        { type: 'tool_use', id: 't3', tool: 'Agent', input: { description: 'go' } },
      ]),
    );
    expect(blocks.map((b) => b.kind)).toEqual(['tool', 'subagent', 'subagent']);
  });

  it('pairs tool_result with tool_use by id and hides orphan results', () => {
    const blocks = eventsToBlocks(
      seq([
        { type: 'tool_use', id: 't1', tool: 'Read', input: { file_path: '/a' } },
        { type: 'tool_result', toolUseId: 't1', output: 'hello', isError: false },
      ]),
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe('tool');
    expect(blocks[0].result?.output).toBe('hello');
  });

  it('prefers final assistant_text over partials and coalesces consecutive text', () => {
    const blocks = eventsToBlocks(
      seq([
        { type: 'assistant_text', text: 'Hel', partial: true },
        { type: 'assistant_text', text: 'lo', partial: true },
        { type: 'assistant_text', text: 'Hello world', partial: false },
      ]),
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({ kind: 'text', content: 'Hello world' });
  });

  it('closes text buffer when a non-text event arrives', () => {
    const blocks = eventsToBlocks(
      seq([
        { type: 'assistant_text', text: 'first', partial: false },
        { type: 'thinking', text: 'hmm' },
        { type: 'assistant_text', text: 'second', partial: false },
      ]),
    );
    expect(blocks.map((b) => b.kind)).toEqual(['text', 'thinking', 'text']);
  });

  it('maps checkpoint, rate_limit, ask_user_question, system, result, error kinds', () => {
    const blocks = eventsToBlocks(
      seq([
        { type: 'system', model: 'claude-sonnet-4', cwd: '/tmp' },
        { type: 'checkpoint', uuid: 'abcdef123456', turnIndex: 2 },
        { type: 'rate_limit', retryAfterMs: 5000, message: 'slow down' },
        { type: 'ask_user_question', askId: 'q1', questions: [{ question: 'why?' }] },
        { type: 'result', durationMs: 2000, costUsd: 0.01, numTurns: 1, isError: false },
        { type: 'error', message: 'boom' },
      ]),
    );
    expect(blocks.map((b) => b.kind)).toEqual([
      'system',
      'checkpoint',
      'rate_limit',
      'ask_question',
      'result',
      'error',
    ]);
    expect(blocks[0]).toMatchObject({ model: 'claude-sonnet-4', cwd: '/tmp' });
    expect(blocks[3]).toMatchObject({ askId: 'q1' });
  });

  it('flushes pending text before emitting the ask_question block', () => {
    const blocks = eventsToBlocks(
      seq([
        { type: 'assistant_text', text: 'Choose wisely', partial: false },
        { type: 'ask_user_question', askId: 'q1', questions: [{ question: 'pick one' }] },
      ]),
    );
    expect(blocks.map((b) => b.kind)).toEqual(['text', 'ask_question']);
    expect(blocks[0].content).toBe('Choose wisely');
    expect(blocks[1].askId).toBe('q1');
  });

  it('defaults questions to an empty array when the server omits it', () => {
    const blocks = eventsToBlocks(seq([{ type: 'ask_user_question', askId: 'q1' }]));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: 'ask_question', askId: 'q1', questions: [] });
  });

  it('preserves every ask block when a stream contains multiple', () => {
    const blocks = eventsToBlocks(
      seq([
        { type: 'ask_user_question', askId: 'a', questions: [{ question: 'A?' }] },
        { type: 'ask_user_question', askId: 'b', questions: [{ question: 'B?' }] },
      ]),
    );
    const askBlocks = blocks.filter((b) => b.kind === 'ask_question');
    expect(askBlocks).toHaveLength(2);
    expect(askBlocks.map((b) => b.askId)).toEqual(['a', 'b']);
  });

  it('skips progress_step events (handled by out-of-tail progress UI)', () => {
    const blocks = eventsToBlocks(
      seq([
        { type: 'progress_step', name: 'Gather' },
        { type: 'thinking', text: 'thinking' },
      ]),
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe('thinking');
  });

  it('skips null events without crashing', () => {
    const blocks = eventsToBlocks([{ seq: 0, event: null }, { seq: 1, event: undefined }]);
    expect(blocks).toEqual([]);
  });
});

describe('summarizeToolInput', () => {
  it('returns empty for missing input', () => {
    expect(summarizeToolInput('Bash', null)).toBe('');
    expect(summarizeToolInput('Bash', undefined)).toBe('');
  });

  it('summarizes Bash via command', () => {
    expect(summarizeToolInput('Bash', { command: 'ls -la' })).toBe('ls -la');
  });

  it('summarizes Read/Write/Edit via file_path', () => {
    expect(summarizeToolInput('Read', { file_path: '/a.js' })).toBe('/a.js');
    expect(summarizeToolInput('Edit', { file_path: '/b.js' })).toBe('/b.js');
    expect(summarizeToolInput('Write', { path: '/legacy.js' })).toBe('/legacy.js');
  });

  it('wraps Grep/Glob patterns in slashes', () => {
    expect(summarizeToolInput('Grep', { pattern: 'foo' })).toBe('/foo/');
    expect(summarizeToolInput('Glob', { pattern: '*.ts' })).toBe('/*.ts/');
  });

  it('summarizes TodoWrite with count', () => {
    expect(summarizeToolInput('TodoWrite', { todos: [1, 2, 3] })).toBe('3 todos');
    expect(summarizeToolInput('TodoWrite', { todos: [1] })).toBe('1 todo');
  });

  it('falls back to first string field for unknown tools', () => {
    expect(summarizeToolInput('MysteryTool', { extra: 'value', n: 1 })).toBe('value');
  });
});
