import { createStreamParser } from './stream-parser.js';
import type { StreamEvent } from './types.js';

describe('createStreamParser — Claude Code', () => {
  function parse(lines: string[]): StreamEvent[] {
    const parser = createStreamParser('claude-code');
    const events: StreamEvent[] = [];
    for (const line of lines) {
      events.push(...parser.feed(line + '\n'));
    }
    events.push(...parser.flush());
    return events;
  }

  it('parses system init event', () => {
    const events = parse([
      JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: 'sess-1',
        model: 'claude-opus-4-7',
        cwd: '/home/user',
        tools: ['Bash', 'Read'],
      }),
    ]);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('system');
    expect((events[0] as { sessionId: string }).sessionId).toBe('sess-1');
    expect((events[0] as { model: string }).model).toBe('claude-opus-4-7');
    expect((events[0] as { cwd: string }).cwd).toBe('/home/user');
    expect((events[0] as { tools: string[] }).tools).toEqual(['Bash', 'Read']);
  });

  it('ignores non-init system events', () => {
    const events = parse([JSON.stringify({ type: 'system', subtype: 'other' })]);
    expect(events).toHaveLength(0);
  });

  it('parses assistant text blocks', () => {
    const events = parse([
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'Hello world' }],
        },
      }),
    ]);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('assistant_text');
    expect((events[0] as { text: string }).text).toBe('Hello world');
    expect((events[0] as { partial: boolean }).partial).toBe(false);
  });

  it('parses thinking blocks', () => {
    const events = parse([
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'thinking', thinking: 'Let me think...' }],
        },
      }),
    ]);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('thinking');
    expect((events[0] as { text: string }).text).toBe('Let me think...');
  });

  it('parses tool_use blocks', () => {
    const events = parse([
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'ls' } }],
        },
      }),
    ]);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('tool_use');
    expect((events[0] as { id: string }).id).toBe('tool-1');
    expect((events[0] as { tool: string }).tool).toBe('Bash');
    expect((events[0] as { input: Record<string, unknown> }).input).toEqual({ command: 'ls' });
  });

  it('parses tool_result blocks from user events', () => {
    const events = parse([
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'tool-1', content: 'file.txt', is_error: false },
          ],
        },
      }),
    ]);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('tool_result');
    expect((events[0] as { toolUseId: string }).toolUseId).toBe('tool-1');
    expect((events[0] as { output: string }).output).toBe('file.txt');
    expect((events[0] as { isError: boolean }).isError).toBe(false);
  });

  it('parses tool_result with is_error=true', () => {
    const events = parse([
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-2',
              content: 'Error: not found',
              is_error: true,
            },
          ],
        },
      }),
    ]);

    expect((events[0] as { isError: boolean }).isError).toBe(true);
  });

  it('parses stream_event text deltas', () => {
    const events = parse([
      JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'partial ' },
        },
      }),
    ]);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('assistant_text');
    expect((events[0] as { text: string }).text).toBe('partial ');
    expect((events[0] as { partial: boolean }).partial).toBe(true);
  });

  it('ignores non-text stream_event deltas', () => {
    const events = parse([
      JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_start' },
      }),
    ]);
    expect(events).toHaveLength(0);
  });

  it('parses result event', () => {
    const events = parse([
      JSON.stringify({
        type: 'result',
        result: 'Done!',
        duration_ms: 1500,
        total_cost_usd: 0.05,
        num_turns: 3,
        is_error: false,
        stop_reason: 'end_turn',
      }),
    ]);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('result');
    expect((events[0] as { text: string }).text).toBe('Done!');
    expect((events[0] as { durationMs: number }).durationMs).toBe(1500);
    expect((events[0] as { costUsd: number }).costUsd).toBe(0.05);
    expect((events[0] as { numTurns: number }).numTurns).toBe(3);
    expect((events[0] as { isError: boolean }).isError).toBe(false);
    expect((events[0] as { stopReason: string }).stopReason).toBe('end_turn');
  });

  it('normalizes rate_limit_event', () => {
    const events = parse([
      JSON.stringify({ type: 'rate_limit_event', retry_after_ms: 5000, message: 'Rate limited' }),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('rate_limit');
    expect((events[0] as { retryAfterMs: number }).retryAfterMs).toBe(5000);
    expect((events[0] as { message: string }).message).toBe('Rate limited');
  });

  it('normalizes rate_limit_event with no extra fields', () => {
    const events = parse([JSON.stringify({ type: 'rate_limit_event' })]);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('rate_limit');
    expect((events[0] as { retryAfterMs: number | null }).retryAfterMs).toBeNull();
    expect((events[0] as { message: string | null }).message).toBeNull();
  });

  it('returns unknown for unhandled types', () => {
    const events = parse([JSON.stringify({ type: 'new_future_event' })]);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('unknown');
  });

  it('handles non-JSON lines', () => {
    const events = parse(['this is not json']);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('unknown');
    expect((events[0] as { text: string }).text).toBe('this is not json');
  });

  it('handles empty lines', () => {
    const events = parse(['', '  ']);
    expect(events).toHaveLength(0);
  });

  it('handles multiple content blocks in one assistant event', () => {
    const events = parse([
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'thinking', thinking: 'hmm' },
            { type: 'text', text: 'Hello' },
            { type: 'tool_use', id: 't1', name: 'Read', input: { path: '/x' } },
          ],
        },
      }),
    ]);

    expect(events).toHaveLength(3);
    expect(events[0].type).toBe('thinking');
    expect(events[1].type).toBe('assistant_text');
    expect(events[2].type).toBe('tool_use');
  });
});

describe('createStreamParser — chunked input', () => {
  it('handles partial lines split across chunks', () => {
    const parser = createStreamParser('claude-code');
    const json = JSON.stringify({ type: 'result', result: 'OK', is_error: false });
    const mid = Math.floor(json.length / 2);

    const first = parser.feed(json.slice(0, mid));
    expect(first).toHaveLength(0);

    const second = parser.feed(json.slice(mid) + '\n');
    expect(second).toHaveLength(1);
    expect(second[0].type).toBe('result');
    expect((second[0] as { text: string }).text).toBe('OK');
  });

  it('flush emits remaining buffer', () => {
    const parser = createStreamParser('claude-code');
    const json = JSON.stringify({ type: 'result', result: 'Final', is_error: false });

    parser.feed(json);
    const events = parser.flush();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('result');
    expect((events[0] as { text: string }).text).toBe('Final');
  });

  it('flush with empty buffer returns nothing', () => {
    const parser = createStreamParser('claude-code');
    expect(parser.flush()).toHaveLength(0);
  });
});

describe('createStreamParser — Cursor Agent', () => {
  function parse(lines: string[]): StreamEvent[] {
    const parser = createStreamParser('cursor-agent');
    const events: StreamEvent[] = [];
    for (const line of lines) {
      events.push(...parser.feed(line + '\n'));
    }
    events.push(...parser.flush());
    return events;
  }

  it('parses system init', () => {
    const events = parse([
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1', model: 'gpt-5.3' }),
    ]);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('system');
    expect((events[0] as { sessionId: string }).sessionId).toBe('s1');
    expect((events[0] as { tools: string[] }).tools).toEqual([]);
  });

  it('skips user events', () => {
    const events = parse([
      JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'hi' }] } }),
    ]);
    expect(events).toHaveLength(0);
  });

  it('skips thinking events', () => {
    const events = parse([JSON.stringify({ type: 'thinking', content: 'internal thought' })]);
    expect(events).toHaveLength(0);
  });

  it('parses streaming assistant events (with timestamp_ms)', () => {
    const events = parse([
      JSON.stringify({
        type: 'assistant',
        timestamp_ms: 12345,
        message: { content: [{ type: 'text', text: 'streaming...' }] },
      }),
    ]);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('assistant_text');
    expect((events[0] as { text: string }).text).toBe('streaming...');
    expect((events[0] as { partial: boolean }).partial).toBe(true);
  });

  it('skips final assistant event (no timestamp_ms)', () => {
    const events = parse([
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'final' }] },
      }),
    ]);
    expect(events).toHaveLength(0);
  });

  it('parses tool_call started', () => {
    const events = parse([
      JSON.stringify({
        type: 'tool_call',
        subtype: 'started',
        call_id: 'c1',
        tool_call: {
          shellToolCall: { args: { command: 'ls -la' } },
        },
      }),
    ]);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('tool_use');
    expect((events[0] as { id: string }).id).toBe('c1');
    expect((events[0] as { tool: string }).tool).toBe('Bash');
    expect((events[0] as { input: Record<string, unknown> }).input).toEqual({ command: 'ls -la' });
  });

  it('parses tool_call completed with success', () => {
    const events = parse([
      JSON.stringify({
        type: 'tool_call',
        subtype: 'completed',
        call_id: 'c1',
        tool_call: {
          shellToolCall: {
            args: {},
            result: { success: { stdout: 'hello', stderr: '', exitCode: 0 } },
          },
        },
      }),
    ]);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('tool_result');
    expect((events[0] as { toolUseId: string }).toolUseId).toBe('c1');
    expect((events[0] as { output: string }).output).toContain('hello');
    expect((events[0] as { isError: boolean }).isError).toBe(false);
  });

  it('parses tool_call completed with failure', () => {
    const events = parse([
      JSON.stringify({
        type: 'tool_call',
        subtype: 'completed',
        call_id: 'c2',
        tool_call: {
          shellToolCall: {
            args: {},
            result: { failure: 'command not found' },
          },
        },
      }),
    ]);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('tool_result');
    expect((events[0] as { isError: boolean }).isError).toBe(true);
    expect((events[0] as { output: string }).output).toBe('command not found');
  });

  it('parses tool_call completed with non-zero exit code', () => {
    const events = parse([
      JSON.stringify({
        type: 'tool_call',
        subtype: 'completed',
        call_id: 'c3',
        tool_call: {
          shellToolCall: {
            args: {},
            result: { success: { stdout: '', stderr: 'error', exitCode: 1 } },
          },
        },
      }),
    ]);

    expect((events[0] as { isError: boolean }).isError).toBe(true);
  });

  it('maps cursor tool names to friendly names', () => {
    const toolCases: [string, string][] = [
      ['readToolCall', 'Read'],
      ['writeToolCall', 'Write'],
      ['editToolCall', 'Edit'],
      ['grepToolCall', 'Grep'],
      ['globToolCall', 'Glob'],
      ['listDirToolCall', 'List'],
      ['webSearchToolCall', 'WebSearch'],
      ['webFetchToolCall', 'WebFetch'],
    ];

    for (const [variant, expected] of toolCases) {
      const events = parse([
        JSON.stringify({
          type: 'tool_call',
          subtype: 'started',
          call_id: 'x',
          tool_call: { [variant]: { args: {} } },
        }),
      ]);
      expect((events[0] as { tool: string }).tool).toBe(expected);
    }
  });

  it('handles unknown tool variants gracefully', () => {
    const events = parse([
      JSON.stringify({
        type: 'tool_call',
        subtype: 'started',
        call_id: 'x',
        tool_call: { myCustomToolCall: { args: {} } },
      }),
    ]);
    expect((events[0] as { tool: string }).tool).toBe('MyCustom');
  });

  it('parses result event', () => {
    const events = parse([
      JSON.stringify({
        type: 'result',
        result: 'Finished',
        duration_ms: 2000,
        is_error: false,
      }),
    ]);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('result');
    expect((events[0] as { text: string }).text).toBe('Finished');
    expect((events[0] as { costUsd: number | null }).costUsd).toBeNull();
    expect((events[0] as { numTurns: number | null }).numTurns).toBeNull();
  });
});
