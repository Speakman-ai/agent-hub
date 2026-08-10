import { describe, it, expect } from 'vitest';
import { eventsToBlocks } from './SessionTail';

/**
 * Two ways the tail used to render content the user never asked for:
 *
 *  1. Inner-subagent frames (tagged `parentToolUseId`) arrived as ordinary
 *     top-level events, so a subagent's whole research report rendered as
 *     expanded chat *in addition to* its collapsed SubagentCard.
 *  2. A tool call landing between a text block's streamed deltas and its
 *     finalized frame flushed the partial buffer, emitting a truncated
 *     fragment that the final then repeated verbatim.
 */
const wrap = (events: any) => events.map((event: any, i: any) => ({ seq: i, event }));

const textOf = (blocks: any[]) =>
  blocks.filter((b) => b.kind === 'text').map((b) => b.text ?? b.event?.text ?? '');

describe('eventsToBlocks — subagent sidechain frames', () => {
  it('keeps a subagent report out of the top-level tail', () => {
    const blocks = eventsToBlocks(
      wrap([
        { type: 'tool_use', id: 'toolu_task_1', tool: 'Task', input: { description: 'Explore' } },
        {
          type: 'assistant_text',
          text: 'Three thousand words of subagent research.',
          partial: false,
          parentToolUseId: 'toolu_task_1',
        },
        { type: 'tool_result', toolUseId: 'toolu_task_1', output: 'report' },
        { type: 'assistant_text', text: 'Short answer.', partial: false },
      ]),
    );

    expect(textOf(blocks).join('')).toBe('Short answer.');
    expect(JSON.stringify(blocks)).not.toContain('subagent research');
  });

  it('still renders the parent turn Task card itself', () => {
    const blocks = eventsToBlocks(
      wrap([
        { type: 'tool_use', id: 'toolu_task_1', tool: 'Task', input: { description: 'Explore' } },
        { type: 'tool_result', toolUseId: 'toolu_task_1', output: 'report' },
      ]),
    );
    expect(blocks.some((b) => b.kind === 'subagent')).toBe(true);
  });

  it('does not drop a subagent inner tool call from the subagent card pairing', () => {
    // Sidechain tool rows must not surface as top-level tool cards.
    const blocks = eventsToBlocks(
      wrap([
        { type: 'tool_use', id: 'toolu_task_1', tool: 'Task', input: {} },
        {
          type: 'tool_use',
          id: 'inner_1',
          tool: 'Grep',
          input: { pattern: 'x' },
          parentToolUseId: 'toolu_task_1',
        },
        { type: 'tool_result', toolUseId: 'toolu_task_1', output: 'report' },
      ]),
    );
    expect(blocks.filter((b) => b.kind === 'tool')).toHaveLength(0);
  });
});

describe('eventsToBlocks — duplicated assistant paragraphs', () => {
  it('renders a paragraph once when a tool call splits its deltas from its final', () => {
    const blocks = eventsToBlocks(
      wrap([
        { type: 'assistant_text', text: 'Fair chall', partial: true },
        { type: 'tool_use', id: 'b1', tool: 'Bash', input: { command: 'ls' } },
        { type: 'tool_result', toolUseId: 'b1', output: 'ok' },
        { type: 'assistant_text', text: 'enge, here is why.', partial: true },
        { type: 'assistant_text', text: 'Fair challenge, here is why.', partial: false },
      ]),
    );

    expect(textOf(blocks)).toEqual(['Fair challenge, here is why.']);
  });

  it('keeps streaming partials visible while the turn is still in flight', () => {
    const blocks = eventsToBlocks(
      wrap([
        { type: 'assistant_text', text: 'Still ', partial: true },
        { type: 'assistant_text', text: 'typing', partial: true },
      ]),
    );
    expect(textOf(blocks)).toEqual(['Still typing']);
  });

  it('keeps a second block streaming after an earlier block finalized', () => {
    const blocks = eventsToBlocks(
      wrap([
        { type: 'assistant_text', text: 'First block.', partial: false },
        { type: 'tool_use', id: 'b1', tool: 'Bash', input: { command: 'ls' } },
        { type: 'tool_result', toolUseId: 'b1', output: 'ok' },
        { type: 'assistant_text', text: 'Second block in flight', partial: true },
      ]),
    );
    expect(textOf(blocks)).toEqual(['First block.', 'Second block in flight']);
  });
});
