import { describe, it, expect } from 'vitest';
import { parseDelegateBlock } from './delegation.js';
import {
  accumulateAssistantStreamForDelegateKickoff,
  applyAssistantTextChunkForDelegationKickoff,
  foldAssistantTextChunk,
  planDelegationRoundOnProcClose,
} from './delegation-kickoff-buffer.js';

/**
 * Same predicate as `tryKickoffDelegationFromStream` after role checks: whether
 * the accumulated buffer contains a parseable non-empty delegate block.
 */
function bufferWouldKickoffDelegation(accumulated: string): boolean {
  const tasks = parseDelegateBlock(accumulated);
  return tasks != null && tasks.length > 0;
}

/** Same control flow as `chat.ts` `handleEvent` for `assistant_text` → `tryKickoffDelegationFromStream`. */
function firstEventIndexWhereKickoff(
  events: Array<{ text: string; partial: boolean }>,
): number | null {
  let state = { finalText: '', partialFallback: '' };
  for (let i = 0; i < events.length; i++) {
    const { text, partial } = events[i];
    const step = applyAssistantTextChunkForDelegationKickoff(state, text, partial);
    state = step.next;
    if (bufferWouldKickoffDelegation(step.accumulatedForKickoff)) return i;
  }
  return null;
}

describe('delegation-kickoff-buffer (wired from chat.ts handleEvent)', () => {
  it('accumulateAssistantStreamForDelegateKickoff matches finalText + partialFallback concatenation', () => {
    expect(accumulateAssistantStreamForDelegateKickoff('a', 'b')).toBe('ab');
    expect(accumulateAssistantStreamForDelegateKickoff('', 'partial')).toBe('partial');
    expect(accumulateAssistantStreamForDelegateKickoff('final', '')).toBe('final');
  });

  it('detects kickoff only after </delegate> closes the block (concatenated buffer)', () => {
    const chunks = [
      'Preamble.\n<delegate>',
      '[{"agentId":"sub-1","task":"Do the thing"}]',
      '</delegate>',
      '\nTrailing prose after delegate.',
    ];
    let state = { finalText: '', partialFallback: '' };
    for (let i = 0; i < chunks.length; i++) {
      state = foldAssistantTextChunk(state, chunks[i], false);
      const acc = accumulateAssistantStreamForDelegateKickoff(
        state.finalText,
        state.partialFallback,
      );
      const kick = bufferWouldKickoffDelegation(acc);
      if (i < 2) expect(kick).toBe(false);
      if (i === 2) expect(kick).toBe(true);
    }
  });

  it('kickoff works when the delegate block is split across partial-only chunks (realistic stream-json)', () => {
    const events = [
      { text: 'Intro\n', partial: true },
      { text: '<delegate>', partial: true },
      { text: '[{"agentId":"sub-1","task":"x"}]', partial: true },
      { text: '</delegate>', partial: true },
      { text: '\nAfter.', partial: false },
    ];
    expect(firstEventIndexWhereKickoff(events)).toBe(3);
  });

  it('kickoff works when finalized segments arrive before partial tail', () => {
    const events = [
      { text: 'Plan:\n<delegate>[{"agentId":"a","task":"t"}]</delegate>', partial: false },
      { text: '\nMore', partial: true },
    ];
    expect(firstEventIndexWhereKickoff(events)).toBe(0);
  });
});

describe('parseDelegateBlock gating (unchanged semantics)', () => {
  it('returns null until the closing </delegate> tag completes the block', () => {
    expect(parseDelegateBlock('<delegate>[{"agentId":"sub","task":"x"}')).toBeNull();
    expect(
      parseDelegateBlock('<delegate>[{"agentId":"sub","task":"x"}]</delegate>'),
    ).not.toBeNull();
  });
});

describe('applyAssistantTextChunkForDelegationKickoff (chat.ts handleEvent slice)', () => {
  it('matches manual fold + accumulate for each chunk', () => {
    let state = { finalText: '', partialFallback: '' };
    const chunks = [
      { text: 'a', partial: false },
      { text: 'b', partial: true },
      { text: 'c', partial: false },
    ];
    for (const ch of chunks) {
      const manualFold = foldAssistantTextChunk(state, ch.text, ch.partial);
      const manualAcc = accumulateAssistantStreamForDelegateKickoff(
        manualFold.finalText,
        manualFold.partialFallback,
      );
      const step = applyAssistantTextChunkForDelegationKickoff(state, ch.text, ch.partial);
      expect(step.accumulatedForKickoff).toBe(manualAcc);
      expect(step.next).toEqual(manualFold);
      state = step.next;
    }
  });
});

describe('planDelegationRoundOnProcClose (chat.ts proc close delegation branch)', () => {
  const tasks = [{ agentId: 's', task: 't' }];

  it('skips when there is no delegate block and no early promise', () => {
    expect(
      planDelegationRoundOnProcClose({
        delegateTasks: null,
        hadEarlyDelegationPromise: false,
      }),
    ).toEqual({ mode: 'skip' });
  });

  it('starts when final content has delegate and there was no stream kickoff', () => {
    expect(
      planDelegationRoundOnProcClose({
        delegateTasks: tasks,
        hadEarlyDelegationPromise: false,
      }),
    ).toEqual({ mode: 'delegate', startIfNeeded: true });
  });

  it('does not start again when stream kickoff already created a promise', () => {
    expect(
      planDelegationRoundOnProcClose({
        delegateTasks: tasks,
        hadEarlyDelegationPromise: true,
      }),
    ).toEqual({ mode: 'delegate', startIfNeeded: false });
  });

  it('still chains completion when only early stream delegation exists (parse mismatch on close)', () => {
    expect(
      planDelegationRoundOnProcClose({
        delegateTasks: null,
        hadEarlyDelegationPromise: true,
      }),
    ).toEqual({ mode: 'delegate', startIfNeeded: false });
  });
});
