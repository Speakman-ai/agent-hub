import { describe, it, expect } from 'vitest';
import { eventsToBlocks } from './SessionTail.jsx';

/**
 * `eventsToBlocks` turns a raw event stream into renderable blocks. The tail
 * used to route any unrecognized type to an `unknown` block, which rendered
 * literally as "unhandled event: { ...json... }". Autonomous review sessions
 * emit `progress_step` events (Gather / Analyze / Post) that are already
 * surfaced by the out-of-tail ProgressPanel, so they must be suppressed in
 * the tail — otherwise the chat fills up with noisy "unhandled event" rows
 * (observed in Electron client v1.2.1 bug report).
 */
describe('eventsToBlocks — progress_step handling', () => {
  const wrap = (events) => events.map((event, i) => ({ seq: i, event }));

  it('does not produce "unknown" blocks for progress_step events', () => {
    const events = wrap([
      {
        type: 'progress_step',
        step: 'Gather PR context',
        status: 'started',
        startedAt: 1764549458504,
      },
      {
        type: 'progress_step',
        step: 'Gather PR context',
        status: 'completed',
        startedAt: 1764549458504,
        finishedAt: 1764549459984,
      },
      {
        type: 'progress_step',
        step: 'Analyze diff and files',
        status: 'started',
        startedAt: 1764549459990,
      },
    ]);

    const blocks = eventsToBlocks(events);
    expect(blocks.filter((b) => b.kind === 'unknown')).toEqual([]);
    // progress_step is rendered by ProgressPanel, not the tail — so no
    // blocks at all should be produced for a stream that only contains
    // progress events.
    expect(blocks).toEqual([]);
  });

  it('still renders assistant_text and tool_use around progress_step events', () => {
    const events = wrap([
      { type: 'assistant_text', text: 'Starting review.', partial: false },
      {
        type: 'progress_step',
        step: 'Gather PR context',
        status: 'started',
        startedAt: 1,
      },
      {
        type: 'tool_use',
        id: 't1',
        tool: 'Bash',
        input: { command: 'gh pr view' },
      },
      { type: 'tool_result', toolUseId: 't1', output: 'ok', isError: false },
      {
        type: 'progress_step',
        step: 'Gather PR context',
        status: 'completed',
        startedAt: 1,
        finishedAt: 2,
      },
      { type: 'assistant_text', text: 'Done.', partial: false },
    ]);

    const kinds = eventsToBlocks(events).map((b) => b.kind);
    expect(kinds).toEqual(['text', 'tool', 'text']);
  });
});

/**
 * In Claude Code's `--permission-mode plan` flow, Claude calls the
 * `ExitPlanMode` tool with a `plan` string. When the CLI runs
 * non-interactively (`--print`), the permission prompt has no user to
 * approve, so the tool_result comes back flagged `is_error: true` —
 * and the generic ToolCard rendered the plan proposal as a red ERROR
 * box. This made ask-mode sessions look broken to users.
 *
 * The fix routes ExitPlanMode tool_use events to a dedicated
 * `plan_proposal` block kind so the client can render the plan as
 * markdown without ERROR styling. These tests pin that routing.
 *
 * Bug: "Plan mode doesn't function properly" (user report, v1.5.0).
 */
describe('eventsToBlocks — ExitPlanMode routing', () => {
  const wrap = (events) => events.map((event, i) => ({ seq: i, event }));

  it('routes ExitPlanMode tool_use to a plan_proposal block, not a generic tool block', () => {
    const events = wrap([
      {
        type: 'tool_use',
        id: 'exit1',
        tool: 'ExitPlanMode',
        input: { plan: '# Refactor\n\n- Step 1\n- Step 2' },
      },
      {
        type: 'tool_result',
        toolUseId: 'exit1',
        output: 'The user has chosen to stay in plan mode.',
        isError: true,
      },
    ]);

    const blocks = eventsToBlocks(events);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe('plan_proposal');
    expect(blocks[0].use.input.plan).toContain('Refactor');
    // The declined tool_result is still paired with the tool_use so the card
    // can render the "awaiting review" status. It must NOT surface as a
    // standalone error block.
    expect(blocks[0].result?.isError).toBe(true);
    expect(blocks.some((b) => b.kind === 'error')).toBe(false);
    expect(blocks.some((b) => b.kind === 'tool')).toBe(false);
  });

  it('still emits plan_proposal when the tool_result has not yet arrived (streaming)', () => {
    const events = wrap([
      {
        type: 'tool_use',
        id: 'exit2',
        tool: 'ExitPlanMode',
        input: { plan: 'Short plan.' },
      },
    ]);

    const blocks = eventsToBlocks(events);
    expect(blocks).toEqual([
      {
        kind: 'plan_proposal',
        use: {
          type: 'tool_use',
          id: 'exit2',
          tool: 'ExitPlanMode',
          input: { plan: 'Short plan.' },
        },
        result: undefined,
      },
    ]);
  });

  it('leaves a single Read tool_use as a generic tool block (no coalesce of one)', () => {
    const events = wrap([
      {
        type: 'tool_use',
        id: 'r1',
        tool: 'Read',
        input: { file_path: '/tmp/x.txt' },
      },
    ]);

    const blocks = eventsToBlocks(events);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe('tool');
  });
});

/**
 * "Explored 3 files" coalescer — runs of read/search tool calls collapse
 * into a single chip when there is no prose, error, or non-explore tool
 * between them. Mirrors Cursor's chat where the model gathering context
 * doesn't dominate the timeline.
 */
describe('eventsToBlocks — explored coalescer', () => {
  const wrap = (events) => events.map((event, i) => ({ seq: i, event }));
  const read = (id, file) => ({ type: 'tool_use', id, tool: 'Read', input: { file_path: file } });
  const grep = (id, pattern) => ({ type: 'tool_use', id, tool: 'Grep', input: { pattern } });
  const ok = (id) => ({ type: 'tool_result', toolUseId: id, output: 'ok', isError: false });

  it('coalesces 3 reads + 1 grep into a single explored block with all items', () => {
    const events = wrap([
      read('r1', '/a.ts'),
      ok('r1'),
      read('r2', '/b.ts'),
      ok('r2'),
      grep('g1', 'foo'),
      ok('g1'),
      read('r3', '/c.ts'),
      ok('r3'),
    ]);
    const blocks = eventsToBlocks(events);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe('explored');
    expect(blocks[0].items).toHaveLength(4);
    expect(blocks[0].items.map((i) => i.use.tool)).toEqual(['Read', 'Read', 'Grep', 'Read']);
  });

  it('breaks the burst on assistant_text — each phase is its own group', () => {
    const events = wrap([
      read('r1', '/a.ts'),
      ok('r1'),
      read('r2', '/b.ts'),
      ok('r2'),
      { type: 'assistant_text', text: 'Found the bug.', partial: false },
      read('r3', '/c.ts'),
      ok('r3'),
      read('r4', '/d.ts'),
      ok('r4'),
    ]);
    const kinds = eventsToBlocks(events).map((b) => b.kind);
    expect(kinds).toEqual(['explored', 'text', 'explored']);
  });

  it('errored read does not coalesce — the failure stays a visible tool card', () => {
    const events = wrap([
      read('r1', '/a.ts'),
      ok('r1'),
      read('r2', '/missing.ts'),
      { type: 'tool_result', toolUseId: 'r2', output: 'ENOENT', isError: true },
      read('r3', '/c.ts'),
      ok('r3'),
    ]);
    const kinds = eventsToBlocks(events).map((b) => b.kind);
    // The error breaks the run; the surrounding reads are each one-element
    // groups, which we render as a regular tool block (not a chip).
    expect(kinds).toEqual(['tool', 'tool', 'tool']);
  });

  it('non-explore tool (Edit) breaks the burst', () => {
    const events = wrap([
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
    ]);
    const kinds = eventsToBlocks(events).map((b) => b.kind);
    expect(kinds).toEqual(['explored', 'tool', 'explored']);
  });

  it('routes TodoWrite to a dedicated todos block', () => {
    const events = wrap([
      {
        type: 'tool_use',
        id: 't1',
        tool: 'TodoWrite',
        input: {
          todos: [
            { content: 'Write tests', status: 'completed' },
            { content: 'Wire up UI', status: 'in_progress' },
            { content: 'Ship PR', status: 'pending' },
          ],
        },
      },
      ok('t1'),
    ]);
    const blocks = eventsToBlocks(events);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe('todos');
    expect(blocks[0].use.input.todos).toHaveLength(3);
  });
});

/**
 * Regression tests for the "skill block renders as visible code block" bug
 * (agent-hub v1.13.0 / Electron, job-search project).
 *
 * Two related symptoms:
 *  1. The <agenthub:skill> block is visible in the chat transcript (either as
 *     raw XML or as a fenced code block).
 *  2. The skill is not loaded on the next turn (when the block is inside fences,
 *     the server-side detector misses it — fixed separately).
 *
 * This suite covers the client-side rendering half: `eventsToBlocks` must strip
 * control blocks from the final text before pushing a `{ kind: 'text' }` block.
 */
describe('eventsToBlocks — control block stripping (regression: v1.13.0)', () => {
  const wrap = (events) => events.map((event, i) => ({ seq: i, event }));

  it('strips a naked <agenthub:skill> block from a non-partial assistant_text event', () => {
    const events = wrap([
      {
        type: 'assistant_text',
        text: 'Done.\n\n<agenthub:skill>{"name":"kanban","reason":"need cards"}\n</agenthub:skill>',
        partial: false,
      },
    ]);
    const blocks = eventsToBlocks(events);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe('text');
    expect(blocks[0].text).not.toContain('<agenthub:skill>');
    expect(blocks[0].text).not.toContain('kanban');
    expect(blocks[0].text).toContain('Done.');
  });

  it('strips a fenced <agenthub:skill> block (the "visible code block" variant)', () => {
    const text = [
      'I need the kanban skill.',
      '',
      '```',
      '<agenthub:skill>{"name": "kanban", "reason": "create card"}',
      '</agenthub:skill>',
      '```',
    ].join('\n');
    const events = wrap([{ type: 'assistant_text', text, partial: false }]);
    const blocks = eventsToBlocks(events);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).not.toContain('<agenthub:skill>');
    expect(blocks[0].text).not.toContain('```');
    expect(blocks[0].text).toContain('I need the kanban skill.');
  });

  it('strips blocks accumulated from partial streaming events', () => {
    // Partial events build up in textBuf.partials; stripping applies to the
    // combined text at flush time regardless of partial/non-partial origin.
    const events = wrap([
      { type: 'assistant_text', text: 'Some work.\n\n<agenthub', partial: true },
      {
        type: 'assistant_text',
        text: ':skill>{"name":"kanban"}</agenthub:skill>',
        partial: true,
      },
    ]);
    const blocks = eventsToBlocks(events);
    // The only block should be the visible prose, with the control tag stripped.
    const textBlocks = blocks.filter((b) => b.kind === 'text');
    expect(textBlocks).toHaveLength(1);
    expect(textBlocks[0].text).not.toContain('<agenthub:skill>');
    expect(textBlocks[0].text).toContain('Some work.');
  });

  it('preserves normal prose that contains no control blocks', () => {
    const events = wrap([
      { type: 'assistant_text', text: 'Analysis complete. No issues found.', partial: false },
    ]);
    const blocks = eventsToBlocks(events);
    expect(blocks[0].text).toBe('Analysis complete. No issues found.');
  });

  it('produces no text block when the ONLY content is a control block (agent emitting just the invocation)', () => {
    const events = wrap([
      {
        type: 'assistant_text',
        text: '<agenthub:skill>{"name":"kanban"}</agenthub:skill>',
        partial: false,
      },
    ]);
    const blocks = eventsToBlocks(events);
    // After stripping, the text is empty — no block should be pushed.
    expect(blocks.filter((b) => b.kind === 'text')).toHaveLength(0);
  });
});
