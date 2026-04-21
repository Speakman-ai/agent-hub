import { createStreamParser, extractAskBlocks, extractStepMarkers } from './stream-parser.js';
import type { AskUserQuestionEvent, ProgressStepEvent, StreamEvent } from './types.js';

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

describe('extractAskBlocks — agenthub:ask protocol', () => {
  it('returns original text unchanged when no fence is present', () => {
    const { strippedText, asks } = extractAskBlocks('Hello, world. No questions here.');
    expect(strippedText).toBe('Hello, world. No questions here.');
    expect(asks).toEqual([]);
  });

  it('extracts a single valid ask block and strips it from the text', () => {
    const text = `Sure, two options:

\`\`\`agenthub:ask
[
  {
    "question": "Which date library?",
    "header": "Library",
    "multiSelect": false,
    "options": [
      {"label":"date-fns","description":"Tree-shakable"},
      {"label":"luxon","description":"Timezones"}
    ]
  }
]
\`\`\`

Let me know.`;
    const { strippedText, asks } = extractAskBlocks(text);
    expect(asks).toHaveLength(1);
    expect(asks[0].askId).toMatch(/^ask-[a-z0-9]+$/);
    expect(asks[0].questions).toHaveLength(1);
    expect(asks[0].questions[0].header).toBe('Library');
    expect(asks[0].questions[0].options).toHaveLength(2);
    expect(strippedText).toBe('Sure, two options:\n\nLet me know.');
  });

  it('supports the object-shaped payload { questions: [...] }', () => {
    const text = `\`\`\`agenthub:ask
{"questions":[{"question":"X?","header":"X","multiSelect":false,"options":[{"label":"a","description":"A"},{"label":"b","description":"B"}]}]}
\`\`\``;
    const { asks } = extractAskBlocks(text);
    expect(asks).toHaveLength(1);
    expect(asks[0].questions[0].question).toBe('X?');
  });

  it('extracts multi-select and preview fields', () => {
    const text = `\`\`\`agenthub:ask
[{"question":"Features?","header":"Feat","multiSelect":true,"options":[{"label":"A","description":"a","preview":"code-a"},{"label":"B","description":"b"}]}]
\`\`\``;
    const { asks } = extractAskBlocks(text);
    expect(asks[0].questions[0].multiSelect).toBe(true);
    expect(asks[0].questions[0].options[0].preview).toBe('code-a');
    expect(asks[0].questions[0].options[1].preview).toBeUndefined();
  });

  it('extracts multiple blocks', () => {
    const text = `First:

\`\`\`agenthub:ask
[{"question":"Q1?","header":"H1","multiSelect":false,"options":[{"label":"a","description":"A"},{"label":"b","description":"B"}]}]
\`\`\`

Second:

\`\`\`agenthub:ask
[{"question":"Q2?","header":"H2","multiSelect":false,"options":[{"label":"x","description":"X"},{"label":"y","description":"Y"}]}]
\`\`\``;
    const { strippedText, asks } = extractAskBlocks(text);
    expect(asks).toHaveLength(2);
    expect(asks[0].questions[0].question).toBe('Q1?');
    expect(asks[1].questions[0].question).toBe('Q2?');
    expect(strippedText).toBe('First:\n\nSecond:');
  });

  it('leaves malformed blocks in place without extracting', () => {
    const text = '```agenthub:ask\nnot-json\n```';
    const { strippedText, asks } = extractAskBlocks(text);
    expect(asks).toEqual([]);
    expect(strippedText).toBe(text);
  });

  it('rejects questions with fewer than 2 options', () => {
    const text = `\`\`\`agenthub:ask
[{"question":"Q?","header":"H","multiSelect":false,"options":[{"label":"only","description":"one"}]}]
\`\`\``;
    const { asks } = extractAskBlocks(text);
    expect(asks).toEqual([]);
  });

  it('rejects more than 4 questions', () => {
    const q = (n: number) =>
      `{"question":"Q${n}?","header":"H${n}","multiSelect":false,"options":[{"label":"a","description":"A"},{"label":"b","description":"B"}]}`;
    const text = `\`\`\`agenthub:ask
[${[1, 2, 3, 4, 5].map(q).join(',')}]
\`\`\``;
    const { asks } = extractAskBlocks(text);
    expect(asks).toEqual([]);
  });

  it('produces the same askId for the same payload (stable)', () => {
    const text = `\`\`\`agenthub:ask
[{"question":"Q?","header":"H","multiSelect":false,"options":[{"label":"a","description":"A"},{"label":"b","description":"B"}]}]
\`\`\``;
    const a = extractAskBlocks(text);
    const b = extractAskBlocks(text);
    expect(a.asks[0].askId).toBe(b.asks[0].askId);
  });

  it('treats missing option.description as optional (defaults to empty string)', () => {
    // Previously a single option missing `description` invalidated the whole
    // block and the fence rendered as raw JSON. Now the field is optional: the
    // picker still extracts, with description=''.
    const text = `\`\`\`agenthub:ask
[{"question":"Q?","header":"H","multiSelect":false,"options":[{"label":"a"},{"label":"b","description":"B"}]}]
\`\`\``;
    const { asks } = extractAskBlocks(text);
    expect(asks).toHaveLength(1);
    expect(asks[0].questions[0].options).toHaveLength(2);
    expect(asks[0].questions[0].options[0].description).toBe('');
    expect(asks[0].questions[0].options[1].description).toBe('B');
  });

  it('still rejects options with missing label (label remains required)', () => {
    const text = `\`\`\`agenthub:ask
[{"question":"Q?","header":"H","multiSelect":false,"options":[{"description":"no label"},{"label":"b","description":"B"}]}]
\`\`\``;
    const { asks } = extractAskBlocks(text);
    expect(asks).toEqual([]);
  });
});

describe('createStreamParser — ask_user_question integration', () => {
  function parse(lines: string[]): StreamEvent[] {
    const parser = createStreamParser('claude-code');
    const events: StreamEvent[] = [];
    for (const line of lines) {
      events.push(...parser.feed(line + '\n'));
    }
    events.push(...parser.flush());
    return events;
  }

  it('emits ask_user_question alongside stripped assistant_text', () => {
    const payload = `Here is a question:\n\n\`\`\`agenthub:ask\n[{"question":"Q?","header":"H","multiSelect":false,"options":[{"label":"a","description":"A"},{"label":"b","description":"B"}]}]\n\`\`\`\n\nPick one.`;
    const events = parse([
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: payload }] },
      }),
    ]);
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('assistant_text');
    expect((events[0] as { text: string }).text).toBe('Here is a question:\n\nPick one.');
    expect(events[1].type).toBe('ask_user_question');
    const ask = events[1] as AskUserQuestionEvent;
    expect(ask.askId).toMatch(/^ask-/);
    expect(ask.questions[0].question).toBe('Q?');
  });

  it('emits only assistant_text when no ask block is present', () => {
    const events = parse([
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Plain prose.' }] },
      }),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('assistant_text');
  });

  it('suppresses empty stripped text but still emits the ask', () => {
    const payload =
      '```agenthub:ask\n[{"question":"Q?","header":"H","multiSelect":false,"options":[{"label":"a","description":"A"},{"label":"b","description":"B"}]}]\n```';
    const events = parse([
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: payload }] },
      }),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('ask_user_question');
  });

  it('does not apply ask detection to streaming text deltas (partials)', () => {
    // Partial chunks may bisect a fenced block; extraction must wait for the
    // finalized assistant event. The streaming delta should always emit the
    // raw text as partial=true.
    const events = parse([
      JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: '```agenthub:ask\n[{"qu' },
        },
      }),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('assistant_text');
    expect((events[0] as { partial: boolean }).partial).toBe(true);
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

  it('extracts ask blocks from the final result text (Cursor has no finalized assistant_text)', () => {
    const resultText = `Pick one:\n\n\`\`\`agenthub:ask\n[{"question":"Q?","header":"H","multiSelect":false,"options":[{"label":"a","description":"A"},{"label":"b","description":"B"}]}]\n\`\`\`\n\nDone.`;
    const events = parse([
      JSON.stringify({ type: 'result', result: resultText, duration_ms: 1, is_error: false }),
    ]);

    // Expect: finalized assistant_text (stripped) + ask_user_question + result.
    expect(events).toHaveLength(3);
    expect(events[0].type).toBe('assistant_text');
    expect((events[0] as { text: string }).text).toBe('Pick one:\n\nDone.');
    expect((events[0] as { partial: boolean }).partial).toBe(false);
    expect(events[1].type).toBe('ask_user_question');
    const ask = events[1] as AskUserQuestionEvent;
    expect(ask.askId).toMatch(/^ask-/);
    expect(ask.questions[0].question).toBe('Q?');
    expect(events[2].type).toBe('result');
    // The raw result text is preserved on the result event — only the
    // broadcast/persistence path uses the stripped assistant_text.
    expect((events[2] as { text: string }).text).toBe(resultText);
  });

  it('does not synthesize an extra assistant_text from result when no ask block is present', () => {
    const events = parse([
      JSON.stringify({ type: 'result', result: 'Plain final text', is_error: false }),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('result');
  });
});

describe('extractStepMarkers — [[STEP:...]] progress protocol', () => {
  it('returns input unchanged when there are no markers', () => {
    const result = extractStepMarkers('just regular prose');
    expect(result.strippedText).toBe('just regular prose');
    expect(result.steps).toEqual([]);
  });

  it('extracts a single started marker', () => {
    const result = extractStepMarkers('[[STEP:started:Gather PR context]]\nworking on it');
    expect(result.steps).toEqual([{ step: 'Gather PR context', status: 'started' }]);
    expect(result.strippedText).toBe('working on it');
  });

  it('extracts started → completed pair preserving order', () => {
    const text = [
      'Kicking off review.',
      '[[STEP:started:Gather PR context]]',
      '...fetching...',
      '[[STEP:completed:Gather PR context]]',
      'Next phase.',
    ].join('\n');
    const result = extractStepMarkers(text);
    expect(result.steps).toEqual([
      { step: 'Gather PR context', status: 'started' },
      { step: 'Gather PR context', status: 'completed' },
    ]);
    expect(result.strippedText).not.toContain('[[STEP:');
    expect(result.strippedText).toContain('Kicking off review.');
    expect(result.strippedText).toContain('Next phase.');
  });

  it('accepts failed status', () => {
    const result = extractStepMarkers('[[STEP:failed:Analyze diff and files]]');
    expect(result.steps).toEqual([{ step: 'Analyze diff and files', status: 'failed' }]);
  });

  it('is case-insensitive on status and trims labels', () => {
    const result = extractStepMarkers('[[STEP: STARTED :  Post formal review  ]]');
    expect(result.steps).toEqual([{ step: 'Post formal review', status: 'started' }]);
  });

  it('ignores malformed markers (no status)', () => {
    const text = '[[STEP:Post formal review]] leftover';
    const result = extractStepMarkers(text);
    expect(result.steps).toEqual([]);
    // Malformed markers are left in place for visibility.
    expect(result.strippedText).toContain('[[STEP:Post formal review]]');
  });

  it('emits progress_step events from a Claude assistant text block, in order', () => {
    const parser = createStreamParser('claude-code');
    const events: StreamEvent[] = [];
    const assistantLine = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'text',
            text: [
              '[[STEP:started:Gather PR context]]',
              'done gathering',
              '[[STEP:completed:Gather PR context]]',
              '[[STEP:started:Analyze diff and files]]',
            ].join('\n'),
          },
        ],
      },
    });
    events.push(...parser.feed(assistantLine + '\n'));

    const progress = events.filter((e) => e.type === 'progress_step') as ProgressStepEvent[];
    expect(progress.map((p) => p.status)).toEqual(['started', 'completed', 'started']);
    expect(progress.map((p) => p.step)).toEqual([
      'Gather PR context',
      'Gather PR context',
      'Analyze diff and files',
    ]);
    // All events carry a numeric startedAt; completed carries a finishedAt.
    for (const p of progress) {
      expect(typeof p.startedAt).toBe('number');
    }
    const completed = progress.find((p) => p.status === 'completed')!;
    expect(typeof completed.finishedAt).toBe('number');

    // The visible assistant_text should have the markers stripped.
    const assistantText = events.find((e) => e.type === 'assistant_text') as
      | { text: string }
      | undefined;
    expect(assistantText).toBeDefined();
    expect(assistantText!.text).not.toContain('[[STEP:');
    expect(assistantText!.text).toContain('done gathering');
  });

  it('does not emit assistant_text when the text is *only* markers', () => {
    const parser = createStreamParser('claude-code');
    const events: StreamEvent[] = [];
    const assistantLine = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'text',
            text: '[[STEP:started:X]]\n[[STEP:completed:X]]',
          },
        ],
      },
    });
    events.push(...parser.feed(assistantLine + '\n'));

    const assistantTexts = events.filter((e) => e.type === 'assistant_text');
    expect(assistantTexts).toHaveLength(0);
    const progress = events.filter((e) => e.type === 'progress_step');
    expect(progress).toHaveLength(2);
  });

  it('picks up markers from a Cursor result event', () => {
    const parser = createStreamParser('cursor-agent');
    const events: StreamEvent[] = [];
    const resultLine = JSON.stringify({
      type: 'result',
      result: 'prose\n[[STEP:started:Analyze diff and files]]\nmore prose',
      is_error: false,
    });
    events.push(...parser.feed(resultLine + '\n'));

    const progress = events.filter((e) => e.type === 'progress_step') as ProgressStepEvent[];
    expect(progress).toHaveLength(1);
    expect(progress[0].step).toBe('Analyze diff and files');
    expect(progress[0].status).toBe('started');
  });
});

describe('createStreamParser — Gemini CLI', () => {
  function parse(lines: string[]): StreamEvent[] {
    const parser = createStreamParser('gemini-cli');
    const events: StreamEvent[] = [];
    for (const line of lines) {
      events.push(...parser.feed(line + '\n'));
    }
    events.push(...parser.flush());
    return events;
  }

  it('parses init event into a system event', () => {
    const events = parse([
      JSON.stringify({
        type: 'init',
        sessionId: 'gem-1',
        model: 'gemini-2.5-pro',
        cwd: '/home/user',
        tools: ['shell', 'readFile'],
      }),
    ]);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('system');
    expect((events[0] as { sessionId: string }).sessionId).toBe('gem-1');
    expect((events[0] as { model: string }).model).toBe('gemini-2.5-pro');
    expect((events[0] as { tools: string[] }).tools).toEqual(['shell', 'readFile']);
  });

  it('emits partial assistant_text for partial message events', () => {
    const events = parse([
      JSON.stringify({
        type: 'message',
        role: 'assistant',
        partial: true,
        content: [{ type: 'text', text: 'Hel' }],
      }),
      JSON.stringify({
        type: 'message',
        role: 'assistant',
        partial: true,
        content: [{ type: 'text', text: 'lo' }],
      }),
    ]);

    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('assistant_text');
    expect((events[0] as { partial: boolean }).partial).toBe(true);
    expect((events[0] as { text: string }).text).toBe('Hel');
    expect((events[1] as { text: string }).text).toBe('lo');
  });

  it('emits finalized assistant_text for non-partial message events', () => {
    const events = parse([
      JSON.stringify({
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello world' }],
      }),
    ]);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('assistant_text');
    expect((events[0] as { partial: boolean }).partial).toBe(false);
    expect((events[0] as { text: string }).text).toBe('Hello world');
  });

  it('ignores non-assistant message events', () => {
    const events = parse([
      JSON.stringify({
        type: 'message',
        role: 'user',
        content: [{ type: 'text', text: 'from the user' }],
      }),
    ]);
    expect(events).toHaveLength(0);
  });

  it('normalizes tool_use events', () => {
    const events = parse([
      JSON.stringify({
        type: 'tool_use',
        id: 'tool-1',
        name: 'shell',
        input: { command: 'ls' },
      }),
    ]);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('tool_use');
    expect((events[0] as { id: string }).id).toBe('tool-1');
    expect((events[0] as { tool: string }).tool).toBe('shell');
    expect((events[0] as { input: Record<string, unknown> }).input).toEqual({ command: 'ls' });
  });

  it('normalizes real google gemini-cli tool_use shape (tool_name/tool_id/parameters)', () => {
    // Matches the stream-json schema shipped in google-gemini/gemini-cli PR #10883.
    const events = parse([
      JSON.stringify({
        type: 'tool_use',
        tool_name: 'Bash',
        tool_id: 'bash-123',
        parameters: { command: 'ls -la' },
        timestamp: '2025-10-10T12:00:02.000Z',
      }),
    ]);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('tool_use');
    expect((events[0] as { id: string }).id).toBe('bash-123');
    expect((events[0] as { tool: string }).tool).toBe('Bash');
    expect((events[0] as { input: Record<string, unknown> }).input).toEqual({
      command: 'ls -la',
    });
  });

  it('pairs tool_result to tool_use via real gemini-cli tool_id field', () => {
    const events = parse([
      JSON.stringify({
        type: 'tool_use',
        tool_name: 'Bash',
        tool_id: 'bash-abc',
        parameters: { command: 'echo hi' },
      }),
      JSON.stringify({
        type: 'tool_result',
        tool_id: 'bash-abc',
        status: 'success',
        output: 'hi',
      }),
      JSON.stringify({
        type: 'tool_result',
        tool_id: 'bash-xyz',
        status: 'error',
        output: 'nope',
      }),
    ]);

    const use = events.find((e) => e.type === 'tool_use') as { id: string };
    const results = events.filter((e) => e.type === 'tool_result') as Array<{
      toolUseId: string;
      output: string;
      isError: boolean;
    }>;
    expect(use.id).toBe('bash-abc');
    expect(results).toHaveLength(2);
    expect(results[0].toolUseId).toBe('bash-abc');
    expect(results[0].output).toBe('hi');
    expect(results[0].isError).toBe(false);
    expect(results[1].toolUseId).toBe('bash-xyz');
    expect(results[1].isError).toBe(true);
  });

  it('normalizes tool_result events including isError', () => {
    const events = parse([
      JSON.stringify({
        type: 'tool_result',
        toolUseId: 'tool-1',
        output: 'file1\nfile2',
        isError: false,
      }),
      JSON.stringify({
        type: 'tool_result',
        toolUseId: 'tool-2',
        output: 'boom',
        isError: true,
      }),
    ]);

    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('tool_result');
    expect((events[0] as { toolUseId: string }).toolUseId).toBe('tool-1');
    expect((events[0] as { output: string }).output).toBe('file1\nfile2');
    expect((events[0] as { isError: boolean }).isError).toBe(false);
    expect((events[1] as { isError: boolean }).isError).toBe(true);
  });

  it('emits a result event with duration + cost from stats', () => {
    const events = parse([
      JSON.stringify({
        type: 'result',
        response: 'final answer',
        stats: { durationMs: 1234, turns: 3, costUsd: 0.002 },
      }),
    ]);

    const result = events.find((e) => e.type === 'result');
    expect(result).toBeDefined();
    expect((result as { text: string }).text).toBe('final answer');
    expect((result as { durationMs: number | null }).durationMs).toBe(1234);
    expect((result as { numTurns: number | null }).numTurns).toBe(3);
    expect((result as { costUsd: number | null }).costUsd).toBe(0.002);
    expect((result as { isError: boolean }).isError).toBe(false);
  });

  it('extracts ask blocks from a finalized assistant message', () => {
    const askBlock = [
      '```agenthub:ask',
      JSON.stringify([
        {
          question: 'Which library?',
          header: 'Library',
          multiSelect: false,
          options: [{ label: 'A' }, { label: 'B' }],
        },
      ]),
      '```',
    ].join('\n');

    const events = parse([
      JSON.stringify({
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: `Preamble\n\n${askBlock}\n\nEpilogue` }],
      }),
    ]);

    const ask = events.find((e) => e.type === 'ask_user_question') as
      | AskUserQuestionEvent
      | undefined;
    expect(ask).toBeDefined();
    expect(ask?.questions[0].question).toBe('Which library?');
  });

  it('returns an unknown event for unrecognized types', () => {
    const events = parse([JSON.stringify({ type: 'gobbledygook' })]);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('unknown');
  });
});

describe('createStreamParser — Codex CLI', () => {
  function parse(lines: string[]): StreamEvent[] {
    const parser = createStreamParser('codex-cli');
    const events: StreamEvent[] = [];
    for (const line of lines) {
      events.push(...parser.feed(line + '\n'));
    }
    events.push(...parser.flush());
    return events;
  }

  it('normalizes thread.started into a system event with sessionId', () => {
    const events = parse([
      JSON.stringify({
        type: 'thread.started',
        thread_id: '019db065-acf4-7221-a047-4bf736bc773d',
      }),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('system');
    expect((events[0] as { sessionId: string }).sessionId).toBe(
      '019db065-acf4-7221-a047-4bf736bc773d',
    );
  });

  it('drops turn.started without emitting an event', () => {
    const events = parse([JSON.stringify({ type: 'turn.started' })]);
    expect(events).toHaveLength(0);
  });

  it('emits finalized assistant_text from agent_message on item.completed', () => {
    const events = parse([
      JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'item_3',
          type: 'agent_message',
          text: 'Repo contains docs, sdk, and examples directories.',
        },
      }),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('assistant_text');
    expect((events[0] as { partial: boolean }).partial).toBe(false);
    expect((events[0] as { text: string }).text).toBe(
      'Repo contains docs, sdk, and examples directories.',
    );
  });

  it('does not emit assistant_text on item.started or item.updated for agent_message', () => {
    const events = parse([
      JSON.stringify({
        type: 'item.started',
        item: { id: 'item_3', type: 'agent_message', text: 'partial' },
      }),
      JSON.stringify({
        type: 'item.updated',
        item: { id: 'item_3', type: 'agent_message', text: 'partial' },
      }),
    ]);
    expect(events).toHaveLength(0);
  });

  it('emits thinking for reasoning item.completed', () => {
    const events = parse([
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'item_2', type: 'reasoning', text: 'planning the approach' },
      }),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('thinking');
    expect((events[0] as { text: string }).text).toBe('planning the approach');
  });

  it('emits tool_use on command_execution started and tool_result on completed', () => {
    const events = parse([
      JSON.stringify({
        type: 'item.started',
        item: {
          id: 'item_1',
          type: 'command_execution',
          command: 'bash -lc ls',
          status: 'in_progress',
        },
      }),
      JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'item_1',
          type: 'command_execution',
          command: 'bash -lc ls',
          aggregated_output: 'docs\nsdk\nexamples',
          exit_code: 0,
          status: 'completed',
        },
      }),
    ]);
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('tool_use');
    expect((events[0] as { tool: string }).tool).toBe('Bash');
    expect((events[0] as { id: string }).id).toBe('item_1');
    expect((events[0] as { input: Record<string, unknown> }).input).toEqual({
      command: 'bash -lc ls',
    });
    expect(events[1].type).toBe('tool_result');
    expect((events[1] as { toolUseId: string }).toolUseId).toBe('item_1');
    expect((events[1] as { output: string }).output).toBe('docs\nsdk\nexamples');
    expect((events[1] as { isError: boolean }).isError).toBe(false);
  });

  it('marks command_execution with non-zero exit_code as an error', () => {
    const events = parse([
      JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'item_1',
          type: 'command_execution',
          command: 'false',
          aggregated_output: '',
          exit_code: 1,
          status: 'failed',
        },
      }),
    ]);
    const result = events.find((e) => e.type === 'tool_result') as { isError: boolean };
    expect(result).toBeDefined();
    expect(result.isError).toBe(true);
  });

  it('emits tool_use for web_search on item.started', () => {
    const events = parse([
      JSON.stringify({
        type: 'item.started',
        item: { id: 'item_4', type: 'web_search', query: 'node lts version' },
      }),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('tool_use');
    expect((events[0] as { tool: string }).tool).toBe('WebSearch');
    expect((events[0] as { input: Record<string, unknown> }).input).toEqual({
      query: 'node lts version',
    });
  });

  it('emits tool_use + tool_result for mcp_tool_call', () => {
    const events = parse([
      JSON.stringify({
        type: 'item.started',
        item: {
          id: 'mcp_1',
          type: 'mcp_tool_call',
          server: 'github',
          tool: 'list_issues',
          arguments: { repo: 'openai/codex' },
          status: 'in_progress',
        },
      }),
      JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'mcp_1',
          type: 'mcp_tool_call',
          server: 'github',
          tool: 'list_issues',
          result: { count: 3 },
          status: 'completed',
        },
      }),
    ]);
    expect(events).toHaveLength(2);
    expect((events[0] as { tool: string }).tool).toBe('github:list_issues');
    expect((events[0] as { input: Record<string, unknown> }).input).toEqual({
      repo: 'openai/codex',
    });
    expect(events[1].type).toBe('tool_result');
    expect((events[1] as { isError: boolean }).isError).toBe(false);
  });

  it('emits a result event on turn.completed', () => {
    const events = parse([
      JSON.stringify({
        type: 'turn.completed',
        usage: { input_tokens: 24763, cached_input_tokens: 24448, output_tokens: 122 },
      }),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('result');
    expect((events[0] as { isError: boolean }).isError).toBe(false);
    expect((events[0] as { numTurns: number }).numTurns).toBe(1);
  });

  it('emits a failed result event on turn.failed', () => {
    const events = parse([
      JSON.stringify({
        type: 'turn.failed',
        error: { message: 'upstream 500' },
      }),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('result');
    expect((events[0] as { isError: boolean }).isError).toBe(true);
    expect((events[0] as { text: string }).text).toBe('upstream 500');
  });

  it('replays a real captured Codex exec --json session without crashing', () => {
    // Fixture captured locally against `codex exec --json --skip-git-repo-check
    // --sandbox read-only "hi"` on 2026-04-21 (codex-cli 0.122.0). The auth
    // failure path is what gets exercised when CODEX_API_KEY is unset — these
    // lines are the canonical sequence we need to tolerate even on cold-start
    // boxes. Real successful turns add item.* events between turn.started and
    // turn.failed/completed, which are covered by the unit tests above.
    const fixture = [
      '{"type":"thread.started","thread_id":"019db065-acf4-7221-a047-4bf736bc773d"}',
      '{"type":"turn.started"}',
      '{"type":"error","message":"Reconnecting... 1/5 (401 Unauthorized)"}',
      '{"type":"turn.failed","error":{"message":"unexpected status 401 Unauthorized"}}',
    ];
    const events = parse(fixture);

    const system = events.find((e) => e.type === 'system') as { sessionId: string } | undefined;
    expect(system?.sessionId).toBe('019db065-acf4-7221-a047-4bf736bc773d');

    const result = events.find((e) => e.type === 'result') as { isError: boolean } | undefined;
    expect(result).toBeDefined();
    expect(result?.isError).toBe(true);
  });

  it('returns an unknown event for unrecognized codex types', () => {
    const events = parse([JSON.stringify({ type: 'mystery.event' })]);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('unknown');
  });

  it('extracts agenthub:ask fenced blocks from agent_message text', () => {
    const text =
      'Need your input:\n\n```agenthub:ask\n[{"question": "Library?","header": "Library","multiSelect": false,"options": [{"label": "A","description": "a"}, {"label": "B","description": "b"}]}]\n```';
    const events = parse([
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'msg_1', type: 'agent_message', text },
      }),
    ]);
    const ask = events.find((e) => e.type === 'ask_user_question') as
      | { questions: Array<{ question: string }> }
      | undefined;
    expect(ask).toBeDefined();
    expect(ask?.questions[0].question).toBe('Library?');
  });
});
