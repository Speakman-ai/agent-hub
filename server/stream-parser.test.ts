import {
  createStreamParser,
  extractAskBlocks,
  extractStepMarkers,
  extractToolResult,
} from './stream-parser.js';
import type {
  AskUserQuestionEvent,
  ProgressStepEvent,
  StreamEvent,
  ToolUseEvent,
} from './types.js';

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
        model: 'claude-opus-4-8',
        cwd: '/home/user',
        tools: ['Bash', 'Read'],
      }),
    ]);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('system');
    expect((events[0] as { sessionId: string }).sessionId).toBe('sess-1');
    expect((events[0] as { model: string }).model).toBe('claude-opus-4-8');
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

  it('lifts base64 image content out of tool_result into images[]', () => {
    const events = parse([
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-img',
              content: [
                { type: 'text', text: 'here is the file' },
                {
                  type: 'image',
                  source: { type: 'base64', media_type: 'image/png', data: 'AAAABBBBCCCC' },
                },
              ],
              is_error: false,
            },
          ],
        },
      }),
    ]);

    expect(events).toHaveLength(1);
    const ev = events[0] as {
      type: string;
      output: string;
      images?: Array<{ mediaType: string; dataBase64?: string }>;
    };
    expect(ev.type).toBe('tool_result');
    // Base64 blob must NOT be inlined into output (that's what blew the payload cap).
    expect(ev.output).not.toContain('AAAABBBBCCCC');
    expect(ev.output).toContain('here is the file');
    expect(ev.output).toContain('[image: image/png]');
    expect(ev.images).toHaveLength(1);
    expect(ev.images?.[0].mediaType).toBe('image/png');
    expect(ev.images?.[0].dataBase64).toBe('AAAABBBBCCCC');
  });

  it('omits images[] for a plain-text tool_result', () => {
    const events = parse([
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'tool-txt', content: 'plain', is_error: false },
          ],
        },
      }),
    ]);
    expect((events[0] as { images?: unknown }).images).toBeUndefined();
  });

  it('does not attach the raw line to known events (keeps checkpoints small)', () => {
    const bigData = 'x'.repeat(200_000);
    const events = parse([
      JSON.stringify({
        type: 'user',
        uuid: 'chk-1',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-big',
              content: [
                {
                  type: 'image',
                  source: { type: 'base64', media_type: 'image/png', data: bigData },
                },
              ],
              is_error: false,
            },
          ],
        },
      }),
    ]);
    const checkpoint = events.find((e) => e.type === 'checkpoint') as
      | (StreamEvent & { raw?: string })
      | undefined;
    expect(checkpoint).toBeDefined();
    // The 200KB base64 must not ride along on the sibling checkpoint via `raw`.
    expect(checkpoint?.raw).toBeUndefined();
    expect(JSON.stringify(checkpoint).length).toBeLessThan(500);
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

  it('parses claude result event with usage tokens when present', () => {
    const events = parse([
      JSON.stringify({
        type: 'result',
        result: 'ok',
        duration_ms: 100,
        usage: { input_tokens: 10, output_tokens: 20 },
        is_error: false,
      }),
    ]);
    expect(events[0].type).toBe('result');
    expect((events[0] as { inputTokens: number | null }).inputTokens).toBe(10);
    expect((events[0] as { outputTokens: number | null }).outputTokens).toBe(20);
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

  it('ignores Claude control-plane frames in headless mode (no unknown tail noise)', () => {
    const events = parse([
      JSON.stringify({
        type: 'control_request',
        request_id: 'req-1',
        request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' } },
      }),
      JSON.stringify({
        type: 'control_response',
        request_id: 'req-1',
        response: { subtype: 'success', response: { behavior: 'allow' } },
      }),
    ]);
    expect(events).toHaveLength(0);
  });

  it('ignores tool_progress keep-alives emitted while a tool is still running', () => {
    // Verbatim frames captured from Claude Code 2.1.220 during a long Bash call:
    // one every 30s, which used to stamp an "unhandled event" row per tick.
    const events = parse([
      JSON.stringify({
        type: 'tool_progress',
        tool_use_id: 'toolu_01RRwoT5UX3rGULZgpP3ydyk-heartbeat-1',
        tool_name: 'Bash',
        parent_tool_use_id: 'toolu_01RRwoT5UX3rGULZgpP3ydyk',
        elapsed_time_seconds: 60,
        heartbeat: true,
        session_id: '2928f1f9-8236-4756-88cc-9bd37ddc8ab8',
        uuid: '25059ea5-28aa-43c7-916a-510fafeddac2',
      }),
      JSON.stringify({
        type: 'tool_progress',
        tool_use_id: 'toolu_01RRwoT5UX3rGULZgpP3ydyk-heartbeat-2',
        tool_name: 'Bash',
        parent_tool_use_id: 'toolu_01RRwoT5UX3rGULZgpP3ydyk',
        elapsed_time_seconds: 90,
        heartbeat: true,
        session_id: '2928f1f9-8236-4756-88cc-9bd37ddc8ab8',
        uuid: '87a7884b-8108-4a7f-be4e-dcfdb40a0b1c',
      }),
    ]);
    expect(events).toHaveLength(0);
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

  it('accepts single-select questions with one option (UI supplies Other)', () => {
    const text = `\`\`\`agenthub:ask
[{"question":"Q?","header":"H","multiSelect":false,"options":[{"label":"only","description":"one"}]}]
\`\`\``;
    const { asks } = extractAskBlocks(text);
    expect(asks).toHaveLength(1);
    expect(asks[0].questions[0].options).toHaveLength(1);
  });

  it('extracts XML-tagged ask blocks (models sometimes copy skill/close-card syntax)', () => {
    const text = `Confirm settings:\n\n<agenthub:ask>\n{"questions":[{"question":"Start?","header":"Script","multiSelect":false,"options":[{"label":"npm run dev","description":"vite"},{"label":"npm start","description":"prod"}]}]}\n</agenthub:ask>\n\nThanks.`;
    const { strippedText, asks } = extractAskBlocks(text);
    expect(asks).toHaveLength(1);
    expect(asks[0].questions[0].question).toBe('Start?');
    expect(strippedText).not.toContain('<agenthub:ask>');
    expect(strippedText).toContain('Confirm settings');
  });

  it('extracts inline agenthub:ask {json}</agenthub:ask> blocks', () => {
    const text = `Confirm:\n\nagenthub:ask {"questions":[{"question":"Script?","header":"Script","multiSelect":false,"options":[{"label":"npm run dev","description":"vite"},{"label":"npm start","description":"prod"}]}]}</agenthub:ask>\n\nThanks.`;
    const { strippedText, asks } = extractAskBlocks(text);
    expect(asks).toHaveLength(1);
    expect(strippedText).not.toContain('agenthub:ask');
  });

  it('normalizes wizard-style id/label/value question objects', () => {
    const text = `agenthub:ask {"questions":[{"id":"startScript","label":"Start script","multiSelect":false,"options":[{"value":"npm run dev","label":"npm run dev (vite)","default":true},{"value":"npm start","label":"npm start"}]}]}</agenthub:ask>`;
    const { asks } = extractAskBlocks(text);
    expect(asks).toHaveLength(1);
    expect(asks[0].questions[0].question).toBe('Start script');
    expect(asks[0].questions[0].options.length).toBeGreaterThanOrEqual(2);
  });

  it('extracts flat single-question envelope with explicit askId', () => {
    const text = `\`\`\`agenthub:ask
{"askId":"preview-bootstrap-approval","header":"Write docker-compose.yml?","question":"May I create docker-compose.yml?","multiSelect":false,"options":[{"label":"Yes","description":"Create"},{"label":"No","description":"Skip"}]}
\`\`\``;
    const { strippedText, asks } = extractAskBlocks(text);
    expect(asks).toHaveLength(1);
    expect(asks[0].askId).toBe('preview-bootstrap-approval');
    expect(asks[0].questions[0].header).toBe('Write docker'); // header chips ≤12 chars
    expect(strippedText).not.toContain('agenthub:ask');
  });

  it('normalizes prompt/id/type wizard questions in fenced blocks', () => {
    const text = `\`\`\`agenthub:ask
{"title":"Create docker-compose.yml?","questions":[{"id":"approve_bootstrap","prompt":"May I create docker-compose.yml?","type":"select","options":[{"value":"approve","label":"Yes"},{"value":"skip","label":"Skip"}],"default":"approve"}]}
\`\`\``;
    const { strippedText, asks } = extractAskBlocks(text);
    expect(asks).toHaveLength(1);
    expect(asks[0].questions[0].question).toContain('docker-compose');
    expect(strippedText).not.toContain('approve_bootstrap');
  });

  it('skips invalid questions but keeps siblings with enough options', () => {
    const text = `\`\`\`agenthub:ask
{"questions":[
  {"question":"Env?","header":"Env","multiSelect":true,"options":[]},
  {"question":"Script?","header":"Script","multiSelect":false,"options":[{"label":"a","description":"A"},{"label":"b","description":"B"}]}
]}
\`\`\``;
    const { asks } = extractAskBlocks(text);
    expect(asks).toHaveLength(1);
    expect(asks[0].questions).toHaveLength(1);
    expect(asks[0].questions[0].question).toBe('Script?');
  });

  it('keeps the first 4 questions instead of dropping an oversized picker', () => {
    const q = (n: number) =>
      `{"question":"Q${n}?","header":"H${n}","multiSelect":false,"options":[{"label":"a","description":"A"},{"label":"b","description":"B"}]}`;
    const text = `\`\`\`agenthub:ask
[${[1, 2, 3, 4, 5].map(q).join(',')}]
\`\`\``;
    const { strippedText, asks } = extractAskBlocks(text);
    expect(asks).toHaveLength(1);
    expect(asks[0].questions.map((x) => x.question)).toEqual(['Q1?', 'Q2?', 'Q3?', 'Q4?']);
    expect(strippedText).not.toContain('agenthub:ask');
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

  it('defaults a missing or blank header from the question (models often omit the chip text)', () => {
    const text = `\`\`\`agenthub:ask
[{"question":"Which way should we go?","header":"","multiSelect":false,"options":[{"label":"a","description":"A"},{"label":"b","description":"B"}]}]
\`\`\``;
    const { asks, strippedText } = extractAskBlocks(text);
    expect(asks).toHaveLength(1);
    expect(asks[0].questions[0].header).toBe('Which way sh');
    expect(strippedText).not.toContain('agenthub:ask');

    const noHeaderKey = `\`\`\`agenthub:ask
[{"question":"Plain question?","multiSelect":false,"options":[{"label":"a","description":"A"},{"label":"b","description":"B"}]}]
\`\`\``;
    const b = extractAskBlocks(noHeaderKey);
    expect(b.asks).toHaveLength(1);
    expect(b.asks[0].questions[0].header).toBe('Plain questi');
  });

  it('skips options without label or value', () => {
    const text = `\`\`\`agenthub:ask
[{"question":"Q?","header":"H","multiSelect":false,"options":[{"description":"no label"},{"label":"b","description":"B"}]}]
\`\`\``;
    const { asks } = extractAskBlocks(text);
    expect(asks).toHaveLength(1);
    expect(asks[0].questions[0].options).toHaveLength(1);
    expect(asks[0].questions[0].options[0].label).toBe('b');
  });

  it('does not strip agenthub:ask syntax shown inside another fenced block (doc example)', () => {
    const inner = [
      '```agenthub:ask',
      '[{"question":"Q?","header":"H","multiSelect":false,"options":[{"label":"a","description":"A"},{"label":"b","description":"B"}]}]',
      '```',
    ].join('\n');
    const text = ['Docs:', '', '```text', inner, '```', '', 'Done.'].join('\n');
    const { strippedText, asks } = extractAskBlocks(text);
    expect(asks).toEqual([]);
    expect(strippedText).toBe(text);
  });

  it('still extracts a real top-level ask after an unrelated fenced code section', () => {
    const askFence = [
      '```agenthub:ask',
      '[{"question":"Q?","header":"H","multiSelect":false,"options":[{"label":"a","description":"A"},{"label":"b","description":"B"}]}]',
      '```',
    ].join('\n');
    const text = [
      'Example:',
      '',
      '```js',
      'const x = 1;',
      '```',
      '',
      'Pick:',
      '',
      askFence,
      '',
      'End.',
    ].join('\n');
    const { strippedText, asks } = extractAskBlocks(text);
    expect(asks).toHaveLength(1);
    expect(strippedText).toContain('const x = 1');
    expect(strippedText).not.toContain('agenthub:ask');
    expect(strippedText).toContain('End.');
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

  it('ignores interaction_query frames (headless Cursor; no unknown tail noise)', () => {
    const events = parse([
      JSON.stringify({
        type: 'interaction_query',
        session_id: 's-cursor',
        query: 'Allow this MCP server to run?',
      }),
    ]);
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

  it('skips buffered flush before tool call (timestamp_ms + model_call_id duplicate)', () => {
    const events = parse([
      JSON.stringify({
        type: 'assistant',
        timestamp_ms: 99,
        model_call_id: 'mc-1',
        message: { content: [{ type: 'text', text: 'duplicate flush before tool' }] },
      }),
    ]);
    expect(events).toHaveLength(0);
  });

  it('keeps streaming deltas (timestamp_ms only) before the duplicate flush', () => {
    const events = parse([
      JSON.stringify({
        type: 'assistant',
        timestamp_ms: 1,
        message: { content: [{ type: 'text', text: 'Hello' }] },
      }),
      JSON.stringify({
        type: 'assistant',
        timestamp_ms: 2,
        model_call_id: 'pre-tool',
        message: { content: [{ type: 'text', text: 'Hello' }] },
      }),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('assistant_text');
    expect((events[0] as { text: string }).text).toBe('Hello');
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

  it('defers Edit tool_use when started has path-only empty strReplace', () => {
    const events = parse([
      JSON.stringify({
        type: 'tool_call',
        subtype: 'started',
        call_id: 'e-empty-sr',
        tool_call: {
          editToolCall: {
            args: { path: 'cad/services/foo.ts', strReplace: {} },
          },
        },
      }),
      JSON.stringify({
        type: 'tool_call',
        subtype: 'completed',
        call_id: 'e-empty-sr',
        tool_call: {
          editToolCall: {
            args: {
              path: 'cad/services/foo.ts',
              strReplace: { oldText: 'const a = 1;', newText: 'const a = 2;' },
            },
            result: { success: {} },
          },
        },
      }),
    ]);
    expect(events).toHaveLength(2);
    const use = events[0] as ToolUseEvent;
    expect(use.type).toBe('tool_use');
    expect(use.tool).toBe('Edit');
    expect((use.input.strReplace as { oldText: string }).oldText).toBe('const a = 1;');
  });

  it('upgrades Edit tool_use on completed when started emitted Codex-style changes[] only', () => {
    const events = parse([
      JSON.stringify({
        type: 'tool_call',
        subtype: 'started',
        call_id: 'e-upgrade',
        tool_call: {
          editToolCall: {
            args: { path: 'f.ts', changes: [{ path: 'f.ts', kind: 'update' }] },
          },
        },
      }),
      JSON.stringify({
        type: 'tool_call',
        subtype: 'completed',
        call_id: 'e-upgrade',
        tool_call: {
          editToolCall: {
            args: {
              path: 'f.ts',
              strReplace: { oldText: 'x', newText: 'y' },
            },
            result: { success: {} },
          },
        },
      }),
    ]);
    const uses = events.filter((e) => e.type === 'tool_use') as ToolUseEvent[];
    expect(uses).toHaveLength(2);
    expect((uses[1].input.strReplace as { newText: string }).newText).toBe('y');
  });

  it('enriches Edit tool_use from result.success.diffString when completed args are path-only', () => {
    const events = parse([
      JSON.stringify({
        type: 'tool_call',
        subtype: 'started',
        call_id: 'e-diff-string',
        tool_call: {
          editToolCall: {
            args: { path: 'backend/core/scoped_store.py' },
          },
        },
      }),
      JSON.stringify({
        type: 'tool_call',
        subtype: 'completed',
        call_id: 'e-diff-string',
        tool_call: {
          editToolCall: {
            args: { path: 'backend/core/scoped_store.py' },
            result: {
              success: {
                path: 'backend/core/scoped_store.py',
                diffString: '-old line\n+new line',
                linesAdded: 1,
                linesRemoved: 1,
              },
            },
          },
        },
      }),
    ]);
    const uses = events.filter((e) => e.type === 'tool_use') as ToolUseEvent[];
    expect(uses).toHaveLength(1);
    expect(uses[0].input.unified_diff).toBe('-old line\n+new line');
  });

  // Reviewer concern (PR #1058 review item #1): a stream that terminates
  // (cancel, crash, network drop) BEFORE `tool_call.completed` arrives must
  // still drain the deferred Edit so the client sees one tool_use. The
  // drained args carry no inline diff body (empty strReplace), which the
  // client's parseDiffLines collapses to empty arrays — DiffView then
  // shows its "Diff content pending or unavailable" placeholder instead of
  // blank +/- gutter rows.
  it('flush() emits deferred Edit tool_use with no diff content when stream is cancelled', () => {
    const parser = createStreamParser('cursor-agent');
    const startedEvents = parser.feed(
      JSON.stringify({
        type: 'tool_call',
        subtype: 'started',
        call_id: 'e-cancel',
        tool_call: {
          editToolCall: { args: { path: 'foo.ts', strReplace: {} } },
        },
      }) + '\n',
    );
    // started with empty strReplace is deferred — nothing emitted yet.
    expect(startedEvents).toHaveLength(0);

    // Cancellation: no completed event ever arrives, the parser is flushed.
    const flushed = parser.flush();
    const uses = flushed.filter((e) => e.type === 'tool_use') as ToolUseEvent[];
    expect(uses).toHaveLength(1);
    expect(uses[0].id).toBe('e-cancel');
    expect(uses[0].tool).toBe('Edit');
    expect(uses[0].input).toEqual({ path: 'foo.ts', strReplace: {} });
    // Round-trip through the client diff parser would return empty
    // additions/removals here; that contract is pinned in
    // client/src/utils/diff.test.js → "returns empty additions/removals
    // for Edit with strReplace:{} and no fallback content".
  });

  it('flush() is a no-op when every deferred Edit was already completed', () => {
    const parser = createStreamParser('cursor-agent');
    parser.feed(
      JSON.stringify({
        type: 'tool_call',
        subtype: 'started',
        call_id: 'e-complete',
        tool_call: {
          editToolCall: { args: { path: 'foo.ts', strReplace: {} } },
        },
      }) + '\n',
    );
    parser.feed(
      JSON.stringify({
        type: 'tool_call',
        subtype: 'completed',
        call_id: 'e-complete',
        tool_call: {
          editToolCall: {
            args: {
              path: 'foo.ts',
              strReplace: { oldText: 'a', newText: 'b' },
            },
            result: { success: {} },
          },
        },
      }) + '\n',
    );
    // Completed already drained the deferred entry; flush should emit nothing.
    expect(parser.flush()).toEqual([]);
  });

  it('upgrades Edit tool_use when diffString arrives only on completed result', () => {
    const events = parse([
      JSON.stringify({
        type: 'tool_call',
        subtype: 'started',
        call_id: 'e-diff-upgrade',
        tool_call: {
          editToolCall: {
            args: { path: 'f.ts', strReplace: {} },
          },
        },
      }),
      JSON.stringify({
        type: 'tool_call',
        subtype: 'completed',
        call_id: 'e-diff-upgrade',
        tool_call: {
          editToolCall: {
            args: { path: 'f.ts' },
            result: {
              success: { path: 'f.ts', diffString: '-before\n+after' },
            },
          },
        },
      }),
    ]);
    const uses = events.filter((e) => e.type === 'tool_use') as ToolUseEvent[];
    expect(uses).toHaveLength(1);
    expect(uses[0].input.unified_diff).toBe('-before\n+after');
  });

  it('merges Write tool args on tool_call completed when started had no fileText (DiffView data)', () => {
    const events = parse([
      JSON.stringify({
        type: 'tool_call',
        subtype: 'started',
        call_id: 'w1',
        tool_call: { writeToolCall: { args: {} } },
      }),
      JSON.stringify({
        type: 'tool_call',
        subtype: 'completed',
        call_id: 'w1',
        tool_call: {
          writeToolCall: {
            args: { path: 'summary.txt', fileText: 'hello' },
            result: { success: { path: '/p/summary.txt', linesCreated: 1, fileSize: 5 } },
          },
        },
      }),
    ]);
    expect(events).toHaveLength(2);
    const use = events[0] as ToolUseEvent;
    const res = events[1] as { type: string; isError: boolean; output: string };
    expect(use.type).toBe('tool_use');
    expect(use.tool).toBe('Write');
    expect(use.input).toEqual({ path: 'summary.txt', fileText: 'hello' });
    expect(res.type).toBe('tool_result');
    expect(res.isError).toBe(false);
  });

  it('emits Edit tool_use on started when args include unified_diff (not deferred to completed)', () => {
    const events = parse([
      JSON.stringify({
        type: 'tool_call',
        subtype: 'started',
        call_id: 'e-ud',
        tool_call: {
          editToolCall: {
            args: { path: 'f.ts', unified_diff: '-a\n+b' },
          },
        },
      }),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('tool_use');
    const use = events[0] as { tool: string; input: Record<string, unknown> };
    expect(use.tool).toBe('Edit');
    expect(use.input.path).toBe('f.ts');
    expect(use.input.unified_diff).toBe('-a\n+b');
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

    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('assistant_text');
    expect((events[0] as { text: string }).text).toBe('Finished');
    expect((events[0] as { replacesAssistantBuffer?: boolean }).replacesAssistantBuffer).toBe(true);
    expect(events[1].type).toBe('result');
    expect((events[1] as { text: string }).text).toBe('Finished');
    expect((events[1] as { costUsd: number | null }).costUsd).toBeNull();
    expect((events[1] as { numTurns: number | null }).numTurns).toBeNull();
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
    expect((events[0] as { replacesAssistantBuffer?: boolean }).replacesAssistantBuffer).toBe(true);
    expect(events[1].type).toBe('ask_user_question');
    const ask = events[1] as AskUserQuestionEvent;
    expect(ask.askId).toMatch(/^ask-/);
    expect(ask.questions[0].question).toBe('Q?');
    expect(events[2].type).toBe('result');
    // The raw result text is preserved on the result event — only the
    // broadcast/persistence path uses the stripped assistant_text.
    expect((events[2] as { text: string }).text).toBe(resultText);
  });

  it('synthesizes authoritative assistant_text from result when no ask block (handoff/delegate)', () => {
    const events = parse([
      JSON.stringify({ type: 'result', result: 'Plain final text', is_error: false }),
    ]);
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('assistant_text');
    expect((events[0] as { text: string }).text).toBe('Plain final text');
    expect((events[0] as { replacesAssistantBuffer?: boolean }).replacesAssistantBuffer).toBe(true);
    expect(events[1].type).toBe('result');
  });

  it('includes <handoff> payload from Cursor result for post-close parsing', () => {
    const handoffBody = '{"toAgent":"hub-backend","note":"Please fix."}';
    const resultStr = `Here is the transfer.\n\n<handoff>\n${handoffBody}\n</handoff>\n`;
    const events = parse([
      JSON.stringify({ type: 'result', result: resultStr, duration_ms: 1, is_error: false }),
    ]);
    const assistant = events.find((e) => e.type === 'assistant_text') as { text: string };
    expect(assistant).toBeDefined();
    expect(assistant.text).toContain('<handoff>');
    expect(assistant.text).toContain(handoffBody);
  });

  it('does not emit replacing assistant_text when result is ask-only (empty stripped prose)', () => {
    const askOnly = `\`\`\`agenthub:ask\n[{"question":"Q?","header":"H","multiSelect":false,"options":[{"label":"a","description":"A"},{"label":"b","description":"B"}]}]\n\`\`\``;
    const events = parse([
      JSON.stringify({ type: 'result', result: askOnly, duration_ms: 1, is_error: false }),
    ]);
    const replaceFinals = events.filter(
      (e) =>
        e.type === 'assistant_text' &&
        (e as { replacesAssistantBuffer?: boolean }).replacesAssistantBuffer,
    );
    expect(replaceFinals).toHaveLength(0);
    expect(events.some((e) => e.type === 'ask_user_question')).toBe(true);
    expect(events.some((e) => e.type === 'result')).toBe(true);
  });

  it('does not emit replacing assistant_text when result is step-markers only', () => {
    const stepOnly = '[[STEP:started:Sole marker]]';
    const events = parse([JSON.stringify({ type: 'result', result: stepOnly, is_error: false })]);
    const replaceFinals = events.filter(
      (e) =>
        e.type === 'assistant_text' &&
        (e as { replacesAssistantBuffer?: boolean }).replacesAssistantBuffer,
    );
    expect(replaceFinals).toHaveLength(0);
    expect(events.filter((e) => e.type === 'progress_step')).toHaveLength(1);
    expect(events.some((e) => e.type === 'result')).toBe(true);
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

    const assistant = events.find((e) => e.type === 'assistant_text') as { text: string };
    expect(assistant).toBeDefined();
    expect(assistant.text).toContain('prose');
    expect(assistant.text).toContain('more prose');
    expect(assistant.text).not.toContain('[[STEP:');

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

describe('createStreamParser — Grok Build CLI', () => {
  function parse(lines: string[]): StreamEvent[] {
    const parser = createStreamParser('grok-cli');
    const events: StreamEvent[] = [];
    for (const line of lines) {
      events.push(...parser.feed(line + '\n'));
    }
    events.push(...parser.flush());
    return events;
  }

  function update(sessionUpdate: string, extra: Record<string, unknown> = {}): string {
    return JSON.stringify({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId: 'grok-1', update: { sessionUpdate, ...extra } },
    });
  }

  it('emits partial assistant_text for agent_message_chunk deltas', () => {
    const events = parse([
      update('agent_message_chunk', { content: { type: 'text', text: 'Hel' } }),
      update('agent_message_chunk', { content: { type: 'text', text: 'lo' } }),
    ]);
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('assistant_text');
    expect((events[0] as { partial: boolean }).partial).toBe(true);
    expect((events[0] as { text: string }).text).toBe('Hel');
    expect((events[1] as { text: string }).text).toBe('lo');
  });

  it('emits thinking for agent_thought_chunk deltas', () => {
    const events = parse([
      update('agent_thought_chunk', { content: { type: 'text', text: 'pondering' } }),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('thinking');
    expect((events[0] as { text: string }).text).toBe('pondering');
  });

  it('emits tool_use for a tool_call notification', () => {
    const events = parse([
      update('tool_call', { toolCallId: 't1', title: 'read_file', rawInput: { path: 'a.ts' } }),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('tool_use');
    expect((events[0] as { id: string }).id).toBe('t1');
    expect((events[0] as { tool: string }).tool).toBe('read_file');
    expect((events[0] as { input: Record<string, unknown> }).input).toEqual({ path: 'a.ts' });
  });

  it('emits tool_result on a completed tool_call_update', () => {
    const events = parse([
      update('tool_call_update', {
        toolCallId: 't1',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'done' } }],
      }),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('tool_result');
    expect((events[0] as { toolUseId: string }).toolUseId).toBe('t1');
    expect((events[0] as { isError: boolean }).isError).toBe(false);
  });

  it('ignores in-progress tool_call_update events', () => {
    const events = parse([update('tool_call_update', { toolCallId: 't1', status: 'in_progress' })]);
    expect(events).toHaveLength(0);
  });

  it('finalizes on the terminal stopReason response with a result event', () => {
    const events = parse([
      update('agent_message_chunk', { content: { type: 'text', text: 'Hi there' } }),
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: { stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } },
      }),
    ]);
    // partial chunk, finalized assistant_text (buffer replace), result
    const finalText = events.find(
      (e) => e.type === 'assistant_text' && (e as { partial: boolean }).partial === false,
    );
    expect(finalText).toBeDefined();
    expect((finalText as { text: string }).text).toBe('Hi there');
    expect((finalText as { replacesAssistantBuffer?: boolean }).replacesAssistantBuffer).toBe(true);
    const result = events.find((e) => e.type === 'result');
    expect(result).toBeDefined();
    expect((result as { stopReason: string }).stopReason).toBe('end_turn');
    expect((result as { inputTokens: number }).inputTokens).toBe(10);
    expect((result as { outputTokens: number }).outputTokens).toBe(5);
  });

  it('extracts fenced ask pickers from the finalized message', () => {
    const asked =
      'Pick one:\n```agenthub:ask\n' +
      JSON.stringify({
        question: 'Which?',
        header: 'Pick',
        options: [{ label: 'A' }, { label: 'B' }],
      }) +
      '\n```';
    const events = parse([
      update('agent_message_chunk', { content: { type: 'text', text: asked } }),
      JSON.stringify({ jsonrpc: '2.0', id: 1, result: { stopReason: 'end_turn' } }),
    ]);
    const ask = events.find((e) => e.type === 'ask_user_question');
    expect(ask).toBeDefined();
  });

  it('surfaces error notifications as terminal isError results', () => {
    const events = parse([
      JSON.stringify({ jsonrpc: '2.0', method: 'error', error: { message: 'boom' } }),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('result');
    expect((events[0] as { isError: boolean }).isError).toBe(true);
    expect((events[0] as { stopReason: string }).stopReason).toBe('error');
    expect((events[0] as { text: string }).text).toContain('boom');
  });

  it('ignores unrelated JSON-RPC bookkeeping lines', () => {
    const events = parse([
      JSON.stringify({ jsonrpc: '2.0', id: 0, result: { protocolVersion: 1 } }),
    ]);
    expect(events).toHaveLength(0);
  });

  describe('native NDJSON stream (grok-composer)', () => {
    it('emits thinking + partial text for thought/text chunks', () => {
      const events = parse([
        JSON.stringify({ type: 'thought', data: 'ponder' }),
        JSON.stringify({ type: 'text', data: 'Hel' }),
        JSON.stringify({ type: 'text', data: 'lo' }),
      ]);
      expect(events.map((e) => e.type)).toEqual(['thinking', 'assistant_text', 'assistant_text']);
      expect((events[0] as { text: string }).text).toBe('ponder');
      expect((events[1] as { text: string }).text).toBe('Hel');
      expect((events[1] as { partial: boolean }).partial).toBe(true);
    });

    it('finalizes on native end events with stopReason EndTurn', () => {
      const events = parse([
        JSON.stringify({ type: 'text', data: 'Hi.' }),
        JSON.stringify({ type: 'text', data: ' What next?' }),
        JSON.stringify({
          type: 'end',
          stopReason: 'EndTurn',
          sessionId: '019ed10b-5247-79f3-9b4e-6ca2493f8aff',
        }),
      ]);
      const finalText = events.find(
        (e) => e.type === 'assistant_text' && (e as { partial: boolean }).partial === false,
      );
      expect(finalText).toBeDefined();
      expect((finalText as { text: string }).text).toBe('Hi. What next?');
      const result = events.find((e) => e.type === 'result');
      expect(result).toBeDefined();
      expect((result as { stopReason: string }).stopReason).toBe('EndTurn');
      expect(events.some((e) => e.type === 'unknown')).toBe(false);
    });

    it('surfaces a native error frame as a terminal isError result (drives the failed-turn lifecycle)', () => {
      const events = parse([JSON.stringify({ type: 'error', message: 'rate limited' })]);
      // Must NOT be a non-terminal `unknown` event — that let a model-side
      // error be treated as noise instead of a failed turn.
      expect(events.some((e) => e.type === 'unknown')).toBe(false);
      const result = events.find((e) => e.type === 'result') as {
        isError: boolean;
        text: string;
        stopReason: string;
      };
      expect(result).toBeDefined();
      expect(result.isError).toBe(true);
      expect(result.text).toContain('rate limited');
      expect(result.stopReason).toBe('error');
    });

    it('preserves assistant text streamed before a native error frame', () => {
      const events = parse([
        JSON.stringify({ type: 'text', data: 'Partial ans' }),
        JSON.stringify({ type: 'text', data: 'wer' }),
        JSON.stringify({ type: 'error', message: 'stream interrupted' }),
      ]);
      // The buffered text is flushed as a final (non-partial) assistant_text.
      const finalText = events.find(
        (e) => e.type === 'assistant_text' && (e as { partial: boolean }).partial === false,
      ) as { text: string } | undefined;
      expect(finalText?.text).toBe('Partial answer');
      const result = events.find((e) => e.type === 'result') as {
        isError: boolean;
        text: string;
      };
      expect(result.isError).toBe(true);
      expect(result.text).toContain('stream interrupted');
    });

    // Regression: current Grok builds stream tool activity as top-level native
    // NDJSON `tool_call` / `tool_call_update` lines (not ACP `session/update`
    // notifications). These fell through to the `unhandled grok event`
    // placeholder and flooded the session tail with grey rows. Support ticket
    // 6b7a5401-2034-4211-babe-fd2d45649048.
    it('normalizes native tool_call into tool_use (no unhandled row)', () => {
      const events = parse([
        JSON.stringify({
          type: 'tool_call',
          toolCallId: 'call-abc-39',
          title: 'read_file',
          kind: 'read',
          status: 'pending',
          toolName: 'read_file',
          rawInput: { target_file: '/repo/App.tsx' },
        }),
      ]);
      expect(events.some((e) => e.type === 'unknown')).toBe(false);
      const toolUse = events.find((e) => e.type === 'tool_use') as {
        id: string;
        tool: string;
        input: Record<string, unknown>;
      };
      expect(toolUse).toBeDefined();
      expect(toolUse.id).toBe('call-abc-39');
      expect(toolUse.tool).toBe('read_file');
      expect(toolUse.input).toEqual({ target_file: '/repo/App.tsx' });
      // A pending call has no terminal output yet.
      expect(events.some((e) => e.type === 'tool_result')).toBe(false);
    });

    it('drops non-terminal native tool_call_update ticks but emits tool_result on completed', () => {
      const events = parse([
        // pending → no output
        JSON.stringify({
          type: 'tool_call_update',
          toolCallId: 'call-abc-39',
          status: null,
          content: [],
          rawOutput: null,
          locations: [{ path: '/repo/App.tsx' }],
        }),
        // in_progress → still no output
        JSON.stringify({
          type: 'tool_call_update',
          toolCallId: 'call-abc-39',
          status: 'in_progress',
          content: [{ type: 'content', content: { type: 'text', text: '' } }],
        }),
        // completed → tool_result with the ACP-wrapped text lifted out
        JSON.stringify({
          type: 'tool_call_update',
          toolCallId: 'call-abc-39',
          status: 'completed',
          content: [{ type: 'content', content: { type: 'text', text: 'found 24 matches' } }],
          rawOutput: null,
        }),
      ]);
      expect(events.some((e) => e.type === 'unknown')).toBe(false);
      const results = events.filter((e) => e.type === 'tool_result') as Array<{
        toolUseId: string;
        output: string;
        isError: boolean;
      }>;
      expect(results).toHaveLength(1);
      expect(results[0].toolUseId).toBe('call-abc-39');
      expect(results[0].output).toBe('found 24 matches');
      expect(results[0].isError).toBe(false);
    });

    it('marks a failed native tool_call_update as an error result', () => {
      const events = parse([
        JSON.stringify({
          type: 'tool_call_update',
          toolCallId: 'call-abc-40',
          status: 'failed',
          content: [{ type: 'content', content: { type: 'text', text: 'boom' } }],
        }),
      ]);
      const result = events.find((e) => e.type === 'tool_result') as {
        isError: boolean;
        output: string;
      };
      expect(result).toBeDefined();
      expect(result.isError).toBe(true);
      expect(result.output).toBe('boom');
    });

    it('silently drops available_commands and usage bookkeeping frames', () => {
      const events = parse([
        JSON.stringify({
          type: 'available_commands',
          tools: ['run_terminal_command', 'read_file', 'grep'],
        }),
        JSON.stringify({
          type: 'usage',
          usage: { input_tokens: 3804, output_tokens: 565, reasoning_tokens: 562 },
          signature: 'abc',
        }),
      ]);
      expect(events).toHaveLength(0);
    });
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

  it('emits tool_use + tool_result for file_change on item.completed alone', () => {
    const events = parse([
      JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'fc_1',
          type: 'file_change',
          status: 'completed',
          changes: [{ path: 'README.md', kind: 'update' }],
        },
      }),
    ]);
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('tool_use');
    const toolUse = events[0] as ToolUseEvent;
    expect(toolUse.tool).toBe('Edit');
    expect(toolUse.id).toBe('fc_1');
    expect(toolUse.input.changes).toEqual([{ path: 'README.md', kind: 'update' }]);
    expect(events[1].type).toBe('tool_result');
    expect((events[1] as { toolUseId: string }).toolUseId).toBe('fc_1');
    expect((events[1] as { isError: boolean }).isError).toBe(false);
  });

  it('does not duplicate tool_use when file_change has item.started then item.completed', () => {
    const events = parse([
      JSON.stringify({
        type: 'item.started',
        item: {
          id: 'fc_2',
          type: 'file_change',
          status: 'in_progress',
          changes: [],
        },
      }),
      JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'fc_2',
          type: 'file_change',
          status: 'completed',
          changes: [{ path: 'a.ts', kind: 'add' }],
        },
      }),
    ]);
    const toolUses = events.filter((e) => e.type === 'tool_use');
    const toolResults = events.filter((e) => e.type === 'tool_result');
    expect(toolUses).toHaveLength(1);
    expect(toolResults).toHaveLength(1);
    expect((toolResults[0] as { toolUseId: string }).toolUseId).toBe('fc_2');
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

describe('extractToolResult — image extraction across CLI shapes', () => {
  it('lifts an Anthropic/Claude source-nested base64 image', () => {
    const { output, images } = extractToolResult([
      { type: 'text', text: 'the file' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'CLAUDE64' } },
    ]);
    expect(output).toContain('the file');
    expect(output).toContain('[image: image/png]');
    expect(output).not.toContain('CLAUDE64');
    expect(images).toEqual([{ mediaType: 'image/png', dataBase64: 'CLAUDE64' }]);
  });

  it('lifts a flat MCP-shape image (data + mimeType)', () => {
    const { output, images } = extractToolResult([
      { type: 'image', data: 'MCP64', mimeType: 'image/jpeg' },
    ]);
    expect(output).toBe('[image: image/jpeg]');
    expect(output).not.toContain('MCP64');
    expect(images).toEqual([{ mediaType: 'image/jpeg', dataBase64: 'MCP64' }]);
  });

  it('lifts an ACP-wrapped image ({type:content, content:<block>})', () => {
    const { output, images } = extractToolResult([
      { type: 'content', content: { type: 'image', data: 'ACP64', mimeType: 'image/webp' } },
    ]);
    expect(output).toBe('[image: image/webp]');
    expect(output).not.toContain('ACP64');
    expect(images).toEqual([{ mediaType: 'image/webp', dataBase64: 'ACP64' }]);
  });

  it('recurses into an MCP CallToolResult { content: [...] } wrapper', () => {
    const { output, images } = extractToolResult({
      content: [{ type: 'image', data: 'WRAP64', mimeType: 'image/png' }],
      isError: false,
    });
    expect(output).toBe('[image: image/png]');
    expect(images).toEqual([{ mediaType: 'image/png', dataBase64: 'WRAP64' }]);
  });

  it('returns no images for plain-text / non-image content', () => {
    expect(extractToolResult('just text').images).toEqual([]);
    expect(extractToolResult([{ type: 'text', text: 'a' }]).images).toEqual([]);
    expect(extractToolResult({ count: 3 }).images).toEqual([]);
  });
});

describe('image tool_result wiring — per CLI', () => {
  const IMG_B64 = 'iVBORw0KGgoAAAANS';

  it('Grok (ACP tool_call_update): extracts image, keeps base64 out of output', () => {
    const parser = createStreamParser('grok-cli');
    const events = [
      ...parser.feed(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'g1',
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 't1',
              status: 'completed',
              content: [
                {
                  type: 'content',
                  content: { type: 'image', data: IMG_B64, mimeType: 'image/png' },
                },
              ],
            },
          },
        }) + '\n',
      ),
      ...parser.flush(),
    ];
    const res = events.find((e) => e.type === 'tool_result') as any;
    expect(res.images).toEqual([{ mediaType: 'image/png', dataBase64: IMG_B64 }]);
    expect(res.output).not.toContain(IMG_B64);
  });

  it('Codex (mcp_tool_call): extracts image from a CallToolResult', () => {
    const parser = createStreamParser('codex-cli');
    const events = [
      ...parser.feed(
        JSON.stringify({
          type: 'item.completed',
          item: {
            id: 'mcp_img',
            type: 'mcp_tool_call',
            server: 'imgsrv',
            tool: 'render',
            result: { content: [{ type: 'image', data: IMG_B64, mimeType: 'image/png' }] },
            status: 'completed',
          },
        }) + '\n',
      ),
      ...parser.flush(),
    ];
    const res = events.find((e) => e.type === 'tool_result') as any;
    expect(res.images).toEqual([{ mediaType: 'image/png', dataBase64: IMG_B64 }]);
    expect(res.output).not.toContain(IMG_B64);
  });

  it('Gemini (generic tool_result): extracts an MCP-shape image', () => {
    const parser = createStreamParser('gemini-cli');
    const events = [
      ...parser.feed(
        JSON.stringify({
          type: 'tool_result',
          tool_id: 'g-img',
          content: [{ type: 'image', data: IMG_B64, mimeType: 'image/png' }],
        }) + '\n',
      ),
      ...parser.flush(),
    ];
    const res = events.find((e) => e.type === 'tool_result') as any;
    expect(res.images).toEqual([{ mediaType: 'image/png', dataBase64: IMG_B64 }]);
    expect(res.output).not.toContain(IMG_B64);
  });

  it('Cursor (forwarded MCP content): extracts image from result.success.content', () => {
    const parser = createStreamParser('cursor-agent');
    const events = [
      ...parser.feed(
        JSON.stringify({
          type: 'tool_call',
          subtype: 'completed',
          call_id: 'c-img',
          tool_call: {
            mcpToolCall: {
              args: {},
              result: {
                success: { content: [{ type: 'image', data: IMG_B64, mimeType: 'image/png' }] },
              },
            },
          },
        }) + '\n',
      ),
      ...parser.flush(),
    ];
    const res = events.find((e) => e.type === 'tool_result') as any;
    expect(res).toBeDefined();
    expect(res.images).toEqual([{ mediaType: 'image/png', dataBase64: IMG_B64 }]);
    expect(res.output).not.toContain(IMG_B64);
  });

  it('Cursor (MCP text content): renders the text, not a blank output', () => {
    const parser = createStreamParser('cursor-agent');
    const events = [
      ...parser.feed(
        JSON.stringify({
          type: 'tool_call',
          subtype: 'completed',
          call_id: 'c-txt',
          tool_call: {
            mcpToolCall: {
              args: {},
              result: { success: { content: [{ type: 'text', text: 'mcp says hi' }] } },
            },
          },
        }) + '\n',
      ),
      ...parser.flush(),
    ];
    const res = events.find((e) => e.type === 'tool_result') as any;
    expect(res.output).toBe('mcp says hi');
    expect(res.images).toBeUndefined();
  });

  it('Cursor (empty MCP content): falls back to the JSON dump, never blank', () => {
    const parser = createStreamParser('cursor-agent');
    const events = [
      ...parser.feed(
        JSON.stringify({
          type: 'tool_call',
          subtype: 'completed',
          call_id: 'c-empty',
          tool_call: {
            mcpToolCall: { args: {}, result: { success: { content: [], ok: true } } },
          },
        }) + '\n',
      ),
      ...parser.flush(),
    ];
    const res = events.find((e) => e.type === 'tool_result') as any;
    expect(res.output.length).toBeGreaterThan(0);
    expect(res.output).toContain('ok');
  });
});
