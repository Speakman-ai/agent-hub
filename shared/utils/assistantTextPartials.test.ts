import { describe, it, expect } from 'vitest';
import { lastFinalAssistantTextIndex, isSupersededPartialText } from './assistantTextPartials.js';

const partial = (text = 'x') => ({ type: 'assistant_text', partial: true, text });
const final = (text = 'x') => ({ type: 'assistant_text', partial: false, text });
const tool = () => ({ type: 'tool_use', tool: 'Bash' });

/** Which indices survive the reducer's superseded-partial filter. */
function kept(events: Array<Record<string, unknown> | null>): number[] {
  const lastFinal = lastFinalAssistantTextIndex(events);
  const out: number[] = [];
  for (let i = 0; i < events.length; i++) {
    if (!events[i]) continue;
    if (isSupersededPartialText(events[i], i, lastFinal)) continue;
    out.push(i);
  }
  return out;
}

describe('superseded partial assistant text', () => {
  it('reports -1 when no final has arrived', () => {
    expect(lastFinalAssistantTextIndex([partial(), tool(), partial()])).toBe(-1);
  });

  it('keeps in-flight partials while a turn is still streaming', () => {
    // Nothing finalized yet: this is the live streaming bubble.
    expect(kept([partial('a'), partial('b')])).toEqual([0, 1]);
  });

  it('drops partials that a later final already covers', () => {
    // The reported shape: deltas, a tool call that flushes them, then the
    // finalized frame carrying the whole paragraph.
    expect(kept([partial('Fair chall'), tool(), partial('enge'), final('Fair challenge')])).toEqual(
      [1, 3],
    );
  });

  it('drops every fragment across a long interleaved run', () => {
    // Mirrors session_events seq 130-164 of the reported message: partials
    // repeatedly flushed by Bash rows, one final at the end.
    const events = [
      partial(),
      partial(),
      tool(),
      partial(),
      tool(),
      partial(),
      tool(),
      final('whole paragraph'),
    ];
    expect(kept(events)).toEqual([2, 4, 6, 7]);
  });

  it('keeps partials that arrive after the last final', () => {
    // Block A finalized, block B still streaming — B must keep rendering.
    expect(kept([partial('a'), final('a'), partial('b'), partial('b2')])).toEqual([1, 2, 3]);
  });

  it('never drops finalized text or non-text events', () => {
    const events = [final('a'), tool(), final('b')];
    expect(kept(events)).toEqual([0, 1, 2]);
  });

  it('ignores nulled-out entries when locating the last final', () => {
    // Callers null out subagent sidechain frames so a subagent's final cannot
    // suppress the parent turn's in-flight partials.
    expect(lastFinalAssistantTextIndex([final('parent'), null])).toBe(0);
    expect(kept([partial('parent in flight'), null])).toEqual([0]);
  });
});
