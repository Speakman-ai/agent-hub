import { describe, it, expect } from 'vitest';
import {
  backgroundSessionAgents,
  backgroundSessionModeOptions,
  defaultBackgroundSessionMode,
} from './backgroundSessionModes';

describe('backgroundSessionModeOptions', () => {
  it('offers build levels and non-shipping modes on dev projects, never Design or VM', () => {
    const values = backgroundSessionModeOptions({ mode: 'dev' }).map((o) => o.value);
    expect(values).toContain('manual');
    expect(values).toContain('merge');
    expect(values).toContain('consult');
    expect(values).toContain('autopilot');
    expect(values).not.toContain('design');
    expect(values).not.toContain('isolated');
  });

  it('limits workflow projects to non-shipping modes', () => {
    const values = backgroundSessionModeOptions({ mode: 'workflow' }).map((o) => o.value);
    expect(values).toEqual(['consult', 'scoping', 'skill-builder']);
    expect(defaultBackgroundSessionMode({ mode: 'workflow' })).toBe('consult');
    expect(defaultBackgroundSessionMode({ mode: 'dev' })).toBe('manual');
  });
});

describe('backgroundSessionAgents', () => {
  it('drops helper roles that cannot host sessions', () => {
    const agents = backgroundSessionAgents({
      agents: [
        { id: 'dev', role: 'dev' },
        { id: 'docs', role: 'docs' },
        { id: 'rev', role: 'Reviewer' },
        { id: 'plain' },
      ],
    });
    expect(agents.map((a) => a.id)).toEqual(['dev', 'plain']);
  });
});
