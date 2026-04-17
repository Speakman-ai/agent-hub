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
