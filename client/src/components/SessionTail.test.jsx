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

    const blocks = eventsToBlocks(events, false);
    expect(blocks.filter((b) => b.kind === 'unknown')).toEqual([]);
    // progress_step is rendered by ProgressPanel, not the tail — so no
    // blocks at all should be produced for a stream that only contains
    // progress events.
    expect(blocks).toEqual([]);
  });

  it('hides progress_step in verbose mode too (ProgressPanel owns it)', () => {
    const events = wrap([
      {
        type: 'progress_step',
        step: 'Post formal review',
        status: 'completed',
        startedAt: 1,
        finishedAt: 2,
      },
    ]);

    expect(eventsToBlocks(events, true)).toEqual([]);
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

    const kinds = eventsToBlocks(events, false).map((b) => b.kind);
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

    const blocks = eventsToBlocks(events, false);
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

    const blocks = eventsToBlocks(events, false);
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

  it('leaves non-ExitPlanMode tool_use events as generic tool blocks', () => {
    const events = wrap([
      {
        type: 'tool_use',
        id: 'r1',
        tool: 'Read',
        input: { file_path: '/tmp/x.txt' },
      },
    ]);

    const blocks = eventsToBlocks(events, false);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe('tool');
  });
});
