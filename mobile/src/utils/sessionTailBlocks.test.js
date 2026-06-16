import { describe, it, expect } from 'vitest';
import { eventsToBlocks, describeTool } from './sessionTailBlocks.js';

const wrap = (events) => events.map((event, i) => ({ seq: i, event }));

describe('eventsToBlocks — browser_tool_activity handling', () => {
  it('does not produce unknown blocks for browser_tool_activity-only streams', () => {
    const blocks = eventsToBlocks(
      wrap([
        {
          type: 'browser_tool_activity',
          actionId: 'a1',
          phase: 'started',
          op: 'navigate',
          label: 'Navigating to example.com…',
          startedAtMs: 1,
        },
        {
          type: 'browser_tool_activity',
          actionId: 'a1',
          phase: 'ended',
          op: 'navigate',
          label: 'Navigating to example.com…',
          startedAtMs: 1,
          ok: true,
          summary: 'Opened example.com',
          durationMs: 12,
        },
      ]),
    );
    expect(blocks.filter((b) => b.kind === 'unknown')).toEqual([]);
    expect(blocks).toEqual([]);
  });
});

describe('eventsToBlocks — benign unknown stream events', () => {
  const wrap = (events) => events.map((event, i) => ({ seq: i, event }));

  it('suppresses historical Claude control_request unknown rows', () => {
    const events = wrap([
      { type: 'unknown', text: 'unhandled claude event: control_request' },
      { type: 'assistant_text', text: 'ok', partial: false },
    ]);
    const blocks = eventsToBlocks(events);
    expect(blocks.filter((b) => b.kind === 'unknown')).toEqual([]);
    expect(blocks.map((b) => b.kind)).toEqual(['text']);
  });
});

describe('eventsToBlocks — progress_step handling', () => {
  it('does not produce unknown blocks for progress_step-only streams', () => {
    const blocks = eventsToBlocks(
      wrap([
        { type: 'progress_step', step: 'Gather', status: 'started', startedAt: 1 },
        { type: 'progress_step', step: 'Gather', status: 'completed', startedAt: 1, finishedAt: 2 },
      ]),
    );
    expect(blocks.filter((b) => b.kind === 'unknown')).toEqual([]);
    expect(blocks).toEqual([]);
  });

  it('still renders assistant_text and tool_use around progress_step events', () => {
    const blocks = eventsToBlocks(
      wrap([
        { type: 'assistant_text', text: 'Starting review.', partial: false },
        { type: 'progress_step', step: 'Gather', status: 'started', startedAt: 1 },
        {
          type: 'tool_use',
          id: 't1',
          tool: 'Bash',
          input: { command: 'gh pr view' },
        },
        { type: 'tool_result', toolUseId: 't1', output: 'ok', isError: false },
        { type: 'assistant_text', text: 'Done.', partial: false },
      ]),
    );
    expect(blocks.map((b) => b.kind)).toEqual(['text', 'tool', 'text']);
  });
});

describe('eventsToBlocks — ExitPlanMode routing', () => {
  it('routes ExitPlanMode to plan_proposal with paired result', () => {
    const blocks = eventsToBlocks(
      wrap([
        {
          type: 'tool_use',
          id: 'exit1',
          tool: 'ExitPlanMode',
          input: { plan: '# Refactor\n\n- Step 1' },
        },
        {
          type: 'tool_result',
          toolUseId: 'exit1',
          output: 'stay in plan mode',
          isError: true,
        },
      ]),
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe('plan_proposal');
    expect(blocks[0].use.input.plan).toContain('Refactor');
    expect(blocks[0].result?.isError).toBe(true);
  });

  it('emits plan_proposal while result is still streaming', () => {
    const blocks = eventsToBlocks(
      wrap([
        {
          type: 'tool_use',
          id: 'exit2',
          tool: 'ExitPlanMode',
          input: { plan: 'Short plan.' },
        },
      ]),
    );
    expect(blocks[0]).toEqual({
      kind: 'plan_proposal',
      use: {
        type: 'tool_use',
        id: 'exit2',
        tool: 'ExitPlanMode',
        input: { plan: 'Short plan.' },
      },
      result: undefined,
    });
  });

  it('leaves a single Read as a tool block', () => {
    const blocks = eventsToBlocks(
      wrap([
        { type: 'tool_use', id: 'r1', tool: 'Read', input: { file_path: '/tmp/x.txt' } },
      ]),
    );
    expect(blocks).toEqual([
      {
        kind: 'tool',
        use: { type: 'tool_use', id: 'r1', tool: 'Read', input: { file_path: '/tmp/x.txt' } },
        result: undefined,
      },
    ]);
  });
});

describe('eventsToBlocks — explored coalescer', () => {
  const read = (id, file) => ({ type: 'tool_use', id, tool: 'Read', input: { file_path: file } });
  const grep = (id, pattern) => ({ type: 'tool_use', id, tool: 'Grep', input: { pattern } });
  const ok = (id) => ({ type: 'tool_result', toolUseId: id, output: 'ok', isError: false });

  it('coalesces reads + grep into one explored block', () => {
    const blocks = eventsToBlocks(
      wrap([
        read('r1', '/a.ts'),
        ok('r1'),
        read('r2', '/b.ts'),
        ok('r2'),
        grep('g1', 'foo'),
        ok('g1'),
        read('r3', '/c.ts'),
        ok('r3'),
      ]),
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe('explored');
    expect(blocks[0].items).toHaveLength(4);
  });

  it('breaks burst on assistant_text', () => {
    const kinds = eventsToBlocks(
      wrap([
        read('r1', '/a.ts'),
        ok('r1'),
        read('r2', '/b.ts'),
        ok('r2'),
        { type: 'assistant_text', text: 'Found the bug.', partial: false },
        read('r3', '/c.ts'),
        ok('r3'),
        read('r4', '/d.ts'),
        ok('r4'),
      ]),
    ).map((b) => b.kind);
    expect(kinds).toEqual(['explored', 'text', 'explored']);
  });

  it('errored read does not coalesce into explored', () => {
    const kinds = eventsToBlocks(
      wrap([
        read('r1', '/a.ts'),
        ok('r1'),
        read('r2', '/missing.ts'),
        { type: 'tool_result', toolUseId: 'r2', output: 'ENOENT', isError: true },
        read('r3', '/c.ts'),
        ok('r3'),
      ]),
    ).map((b) => b.kind);
    expect(kinds).toEqual(['tool', 'tool', 'tool']);
  });

  it('non-explore tool breaks the burst', () => {
    const kinds = eventsToBlocks(
      wrap([
        read('r1', '/a.ts'),
        ok('r1'),
        read('r2', '/b.ts'),
        ok('r2'),
        {
          type: 'tool_use',
          id: 'e1',
          tool: 'Edit',
          input: { file_path: '/a.ts', old_string: 'x', new_string: 'y' },
        },
        ok('e1'),
        read('r3', '/c.ts'),
        ok('r3'),
        read('r4', '/d.ts'),
        ok('r4'),
      ]),
    ).map((b) => b.kind);
    expect(kinds).toEqual(['explored', 'tool', 'explored']);
  });

  it('routes TodoWrite to todos block', () => {
    const blocks = eventsToBlocks(
      wrap([
        {
          type: 'tool_use',
          id: 't1',
          tool: 'TodoWrite',
          input: {
            todos: [
              { content: 'Write tests', status: 'completed' },
              { content: 'Wire up UI', status: 'in_progress' },
            ],
          },
        },
        ok('t1'),
      ]),
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe('todos');
  });
});

describe('eventsToBlocks — misc', () => {
  it('returns [] for missing/empty input', () => {
    expect(eventsToBlocks(undefined)).toEqual([]);
    expect(eventsToBlocks([])).toEqual([]);
  });

  it('pairs tool_result and hides orphans', () => {
    const blocks = eventsToBlocks(
      wrap([
        { type: 'tool_use', id: 't1', tool: 'Bash', input: { command: 'ls' } },
        { type: 'tool_result', toolUseId: 't1', output: 'hello', isError: false },
      ]),
    );
    expect(blocks[0].kind).toBe('tool');
    expect(blocks[0].result?.output).toBe('hello');
  });

  it('prefers final assistant_text over partials', () => {
    const blocks = eventsToBlocks(
      wrap([
        { type: 'assistant_text', text: 'Hel', partial: true },
        { type: 'assistant_text', text: 'lo', partial: true },
        { type: 'assistant_text', text: 'Hello world', partial: false },
      ]),
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({ kind: 'text', text: 'Hello world' });
  });

  it('drops checkpoint and rate_limit (web parity)', () => {
    const blocks = eventsToBlocks(
      wrap([
        { type: 'system', model: 'm', cwd: '/tmp' },
        { type: 'checkpoint', uuid: 'x', turnIndex: 1 },
        { type: 'rate_limit', retryAfterMs: 1000, message: 'slow' },
        { type: 'thinking', text: 'hmm' },
      ]),
    );
    expect(blocks.map((b) => b.kind)).toEqual(['system', 'thinking']);
  });

  it('maps ask_user_question with event payload', () => {
    const blocks = eventsToBlocks(
      wrap([{ type: 'ask_user_question', askId: 'q1', questions: [{ question: 'why?' }] }]),
    );
    expect(blocks[0].kind).toBe('ask_question');
    expect(blocks[0].event.askId).toBe('q1');
  });

  it('flushes text before ask_question', () => {
    const blocks = eventsToBlocks(
      wrap([
        { type: 'assistant_text', text: 'Choose wisely', partial: false },
        { type: 'ask_user_question', askId: 'q1', questions: [{ question: 'pick' }] },
      ]),
    );
    expect(blocks.map((b) => b.kind)).toEqual(['text', 'ask_question']);
    expect(blocks[0].text).toBe('Choose wisely');
  });

  it('subagent tools', () => {
    const kinds = eventsToBlocks(
      wrap([
        { type: 'tool_use', id: 'a', tool: 'Task', input: { description: 'x' } },
        { type: 'tool_use', id: 'b', tool: 'Agent', input: { description: 'y' } },
      ]),
    ).map((b) => b.kind);
    expect(kinds).toEqual(['subagent', 'subagent']);
  });

  it('skips null events', () => {
    expect(eventsToBlocks([{ seq: 0, event: null }])).toEqual([]);
  });
});

describe('eventsToBlocks — thinking coalescing', () => {
  it('merges consecutive thinking chunks into one block', () => {
    const blocks = eventsToBlocks(
      wrap([
        { type: 'thinking', text: 'The user ' },
        { type: 'thinking', text: 'said Hi' },
        { type: 'assistant_text', text: 'Hi there!', partial: false },
      ]),
    );
    expect(blocks.filter((b) => b.kind === 'thinking')).toHaveLength(1);
    expect(blocks[0].event.text).toBe('The user said Hi');
    expect(blocks[1].kind).toBe('text');
  });
});

describe('describeTool', () => {
  it('matches web headlines for Read/Grep', () => {
    expect(describeTool('Read', { file_path: '/project/src/foo.ts' }).headline).toBe('Read foo.ts');
    expect(describeTool('Grep', { pattern: 'TODO' }).headline).toBe('Search for /TODO/');
    expect(describeTool('Grep', { pattern: 'TODO', path: '/src/utils.ts' }).headline).toBe(
      'Search utils.ts for /TODO/',
    );
  });
});
