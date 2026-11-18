import { describe, expect, it } from 'vitest';
import { orchestrateComposerCopy } from './orchestrateComposer';

describe('orchestrateComposerCopy', () => {
  it('returns the Orchestrate hint and placeholder for an Orchestrate chat', () => {
    expect(orchestrateComposerCopy('orchestrate')).toEqual({
      hint: 'Orchestrate — this chat starts other sessions and does not ship',
      placeholder: 'Plan the work, then start a session…',
    });
  });

  it('returns null for every other mode', () => {
    for (const mode of ['consult', 'chat', 'hub', null, undefined]) {
      expect(orchestrateComposerCopy(mode)).toBeNull();
    }
  });
});
