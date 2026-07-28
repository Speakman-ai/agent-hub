import { describe, it, expect } from 'vitest';
import { parseDelegateBlock } from './delegation.js';
import {
  accumulateAssistantStream,
  applyAssistantTextChunk,
  foldAssistantTextChunk,
} from './assistant-stream-buffer.js';

const DELEGATE_ROW =
  '{"agentId":"sub-1","task":"x","owner":"hub-backend","scope":"server only","expectedArtifact":"patch + tests","deadline":"end-of-turn","returnFormat":"summary"}';

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
    const step = applyAssistantTextChunk(state, text, partial);
    state = step.next;
    if (bufferWouldKickoffDelegation(step.accumulatedText)) return i;
  }
  return null;
}

describe('assistant-stream-buffer', () => {
  it('accumulateAssistantStream matches finalText + partialFallback concatenation', () => {
    expect(accumulateAssistantStream('a', 'b')).toBe('ab');
    expect(accumulateAssistantStream('', 'partial')).toBe('partial');
    expect(accumulateAssistantStream('final', '')).toBe('final');
  });

  it('detects kickoff only after </delegate> closes the block (concatenated buffer)', () => {
    const chunks = [
      'Preamble.\n<delegate>',
      `[${DELEGATE_ROW.replace('"x"', '"Do the thing"')}]`,
      '</delegate>',
      '\nTrailing prose after delegate.',
    ];
    let state = { finalText: '', partialFallback: '' };
    for (let i = 0; i < chunks.length; i++) {
      state = foldAssistantTextChunk(state, chunks[i], false);
      const acc = accumulateAssistantStream(state.finalText, state.partialFallback);
      const kick = bufferWouldKickoffDelegation(acc);
      if (i < 2) expect(kick).toBe(false);
      if (i === 2) expect(kick).toBe(true);
    }
  });

  it('kickoff works when the delegate block is split across partial-only chunks (realistic stream-json)', () => {
    const events = [
      { text: 'Intro\n', partial: true },
      { text: '<delegate>', partial: true },
      { text: `[${DELEGATE_ROW}]`, partial: true },
      { text: '</delegate>', partial: true },
      { text: '\nAfter.', partial: false },
    ];
    expect(firstEventIndexWhereKickoff(events)).toBe(3);
  });

  it('kickoff works when finalized segments arrive before partial tail', () => {
    const events = [
      {
        text: `Plan:\n<delegate>[{"agentId":"a","task":"t","owner":"hub-backend","scope":"api","expectedArtifact":"diff","deadline":"today","returnFormat":"summary"}]</delegate>`,
        partial: false,
      },
      { text: '\nMore', partial: true },
    ];
    expect(firstEventIndexWhereKickoff(events)).toBe(0);
  });
});

describe('parseDelegateBlock gating (unchanged semantics)', () => {
  it('returns null until the closing </delegate> tag completes the block', () => {
    expect(
      parseDelegateBlock(
        '<delegate>[{"agentId":"sub","task":"x","owner":"o","scope":"s","expectedArtifact":"a","deadline":"d","returnFormat":"r"}',
      ),
    ).toBeNull();
    expect(
      parseDelegateBlock(
        '<delegate>[{"agentId":"sub","task":"x","owner":"o","scope":"s","expectedArtifact":"a","deadline":"d","returnFormat":"r"}]</delegate>',
      ),
    ).not.toBeNull();
  });
});

/** Parity fixtures — keep in sync with `client/src/utils/coordinationBlocks.test.js`. */
describe('parseDelegateBlock payload shapes (client/server parity)', () => {
  const row = (agentId: string, task: string) => ({
    agentId,
    task,
    owner: 'o',
    scope: 's',
    expectedArtifact: 'ea',
    deadline: 'd',
    returnFormat: 'rf',
  });

  it('accepts a single JSON object when the full contract is present', () => {
    const one = row('hub-backend', 'fix API');
    expect(parseDelegateBlock(`<delegate>${JSON.stringify(one)}</delegate>`)).toEqual([one]);
  });

  it('accepts toAgent as an alias for agentId when the full contract is present', () => {
    const full = row('a', 'do A');
    const { agentId, ...rest } = full;
    const payload = { toAgent: agentId, ...rest };
    expect(parseDelegateBlock(`<delegate>${JSON.stringify([payload])}</delegate>`)).toEqual([full]);
  });

  it('returns null when some rows lack contract fields (missing-contract-fields)', () => {
    expect(
      parseDelegateBlock(
        `<delegate>${JSON.stringify([row('a', 'x'), { agentId: 'b', task: 'y' }])}</delegate>`,
      ),
    ).toBeNull();
  });

  it('returns null when the payload is an empty array', () => {
    expect(parseDelegateBlock('<delegate>[]</delegate>')).toBeNull();
  });

  it('returns null when no row is a valid contract', () => {
    expect(parseDelegateBlock('<delegate>[{"agentId":""}]</delegate>')).toBeNull();
  });
});

describe('applyAssistantTextChunk (chat.ts handleEvent slice)', () => {
  it('matches manual fold + accumulate for each chunk', () => {
    let state = { finalText: '', partialFallback: '' };
    const chunks = [
      { text: 'a', partial: false },
      { text: 'b', partial: true },
      { text: 'c', partial: false },
    ];
    for (const ch of chunks) {
      const manualFold = foldAssistantTextChunk(state, ch.text, ch.partial);
      const manualAcc = accumulateAssistantStream(manualFold.finalText, manualFold.partialFallback);
      const step = applyAssistantTextChunk(state, ch.text, ch.partial);
      expect(step.accumulatedText).toBe(manualAcc);
      expect(step.next).toEqual(manualFold);
      state = step.next;
    }
  });

  it('replace option overwrites buffers so Cursor result tail can complete delegate blocks', () => {
    let state = { finalText: '', partialFallback: 'partial-only' };
    const delegateClose = `<delegate>[${DELEGATE_ROW}]</delegate>`;
    const step = applyAssistantTextChunk(state, `Intro\n${delegateClose}`, false, {
      replace: true,
    });
    expect(step.next).toEqual({ finalText: `Intro\n${delegateClose}`, partialFallback: '' });
    expect(bufferWouldKickoffDelegation(step.accumulatedText)).toBe(true);
  });

  it('matches absorbStreamEvents: partial deltas then canonical replace', () => {
    let state = { finalText: '', partialFallback: '' };
    state = applyAssistantTextChunk(state, 'stream', true).next;
    state = applyAssistantTextChunk(state, 'ed', true).next;
    const canonical = `streamed\n\n<delegate>[${DELEGATE_ROW}]</delegate>`;
    state = applyAssistantTextChunk(state, canonical, false, {
      replace: true,
    }).next;
    expect(state).toEqual({ finalText: canonical, partialFallback: '' });
    expect(
      bufferWouldKickoffDelegation(
        accumulateAssistantStream(state.finalText, state.partialFallback),
      ),
    ).toBe(true);
  });
});
