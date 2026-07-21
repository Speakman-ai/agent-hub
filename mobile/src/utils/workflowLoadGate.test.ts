import { describe, expect, it } from 'vitest';
import { createWorkflowLoadGate } from './workflowLoadGate';

describe('workflowLoadGate', () => {
  it('skips overlapping loads for one project', () => {
    const gate = createWorkflowLoadGate();
    const first = gate.begin('project-a');

    expect(first).not.toBeNull();
    expect(gate.begin('project-a')).toBeNull();
    expect(gate.isCurrent(first!)).toBe(true);
  });

  it('invalidates an older project response without letting it finish the newer load', () => {
    const gate = createWorkflowLoadGate();
    const oldRequest = gate.begin('project-a')!;
    const currentRequest = gate.begin('project-b')!;

    expect(gate.isCurrent(oldRequest)).toBe(false);
    expect(gate.isCurrent(currentRequest)).toBe(true);

    gate.finish(oldRequest);
    expect(gate.isCurrent(currentRequest)).toBe(true);
    gate.finish(currentRequest);
    expect(gate.begin('project-b')).not.toBeNull();
  });

  it('allowReplace supersedes an in-flight same-key request instead of deduping', () => {
    const gate = createWorkflowLoadGate();
    const first = gate.begin('detail-key')!;
    // Without allowReplace a same-key call is deduped away (returns null).
    expect(gate.begin('detail-key')).toBeNull();

    // With allowReplace the poll tick re-arms: the older request is no longer
    // current, so its late response is ignored and it cannot wedge polling.
    const second = gate.begin('detail-key', { allowReplace: true })!;
    expect(second).not.toBeNull();
    expect(gate.isCurrent(first)).toBe(false);
    expect(gate.isCurrent(second)).toBe(true);

    // A late finish() from the superseded request must not clear the newer one.
    gate.finish(first);
    expect(gate.isCurrent(second)).toBe(true);
  });
});
