import { describe, it, expect } from 'vitest';
import {
  FINALIZE_AUTOMATION_LEVELS,
  parseFinalizeAutomation,
  finalizeAutomationLabel,
  SESSION_CONTROL_OPTIONS,
  DESIGN_AUTOMATION_OPTION,
  CONSULT_AUTOMATION_OPTION,
  sessionControlValue,
  sessionControlLabel,
  planSessionControlChange,
  sessionControlPatch,
  sessionControlOptionsForAgent,
  sessionControlOptionsForProject,
  sessionControlValueForProject,
  isSkillBuilderEligibleAgent,
} from './finalizeAutomation';

describe('parseFinalizeAutomation', () => {
  it('passes through known levels and defaults to manual', () => {
    for (const lvl of FINALIZE_AUTOMATION_LEVELS) {
      expect(parseFinalizeAutomation(lvl)).toBe(lvl);
    }
    expect(parseFinalizeAutomation('bogus')).toBe('manual');
    expect(parseFinalizeAutomation(undefined)).toBe('manual');
  });
});

describe('SESSION_CONTROL_OPTIONS', () => {
  it('folds Consult + Design + Scoping + Skill Builder + the four finalize levels', () => {
    expect(SESSION_CONTROL_OPTIONS.map((o: any) => (o as any).value)).toEqual([
      'consult',
      'design',
      'scoping',
      'skill-builder',
      'manual',
      'review',
      'push',
      'merge',
    ]);
  });

  it('puts Consult first and Design second as no-ship options', () => {
    expect(SESSION_CONTROL_OPTIONS[0]).toBe(CONSULT_AUTOMATION_OPTION);
    expect(SESSION_CONTROL_OPTIONS[1]).toBe(DESIGN_AUTOMATION_OPTION);
    expect(DESIGN_AUTOMATION_OPTION.label).toBe('Design');
  });
});

describe('sessionControlValue', () => {
  it('design takes precedence over legacy ask and automation', () => {
    expect(sessionControlValue({ sessionMode: 'design', askMode: true, automation: 'merge' })).toBe(
      'design',
    );
  });

  it('consult mode and legacy ask_mode both map to consult', () => {
    expect(
      sessionControlValue({ sessionMode: 'consult', askMode: false, automation: 'push' }),
    ).toBe('consult');
    expect(sessionControlValue({ sessionMode: 'chat', askMode: true, automation: 'push' })).toBe(
      'consult',
    );
  });

  it('falls through to the finalize automation level (default manual)', () => {
    expect(sessionControlValue({ sessionMode: 'chat', askMode: false, automation: 'review' })).toBe(
      'review',
    );
    expect(sessionControlValue({})).toBe('manual');
  });
});

describe('sessionControlLabel', () => {
  it('agrees with finalizeAutomationLabel for ship levels and adds Consult/Design', () => {
    expect(sessionControlLabel('consult')).toBe('Consult');
    expect(sessionControlLabel('design')).toBe('Design');
    expect(sessionControlLabel('merge')).toBe(finalizeAutomationLabel('merge'));
    expect(sessionControlLabel('bogus')).toBe('Build');
  });
});

describe('planSessionControlChange', () => {
  it('returns no steps for a no-op selection', () => {
    expect(
      planSessionControlChange({ sessionMode: 'chat', askMode: false, automation: 'push' }, 'push'),
    ).toEqual([]);
    expect(
      planSessionControlChange(
        { sessionMode: 'design', askMode: false, automation: 'push' },
        'design',
      ),
    ).toEqual([]);
    expect(
      planSessionControlChange(
        { sessionMode: 'consult', askMode: false, automation: 'manual' },
        'consult',
      ),
    ).toEqual([]);
  });

  it('legacy ask -> Design clears ask mode before entering design (regression)', () => {
    const steps = planSessionControlChange(
      { sessionMode: 'chat', askMode: true, automation: 'manual' },
      'design',
    );
    expect(steps!).toEqual([
      { type: 'ask', value: false },
      { type: 'mode', value: 'design' },
    ]);
  });

  it('chat (no ask) -> Design only switches mode', () => {
    expect(
      planSessionControlChange(
        { sessionMode: 'chat', askMode: false, automation: 'manual' },
        'design',
      ),
    ).toEqual([{ type: 'mode', value: 'design' }]);
  });

  it('ship level -> Design resets automation to manual before entering design (regression)', () => {
    expect(
      planSessionControlChange(
        { sessionMode: 'chat', askMode: false, automation: 'merge' },
        'design',
      ),
    ).toEqual([
      { type: 'automation', value: 'manual' },
      { type: 'mode', value: 'design' },
    ]);
  });

  it('legacy ask + ship level -> Design clears both ask and ship intent', () => {
    expect(
      planSessionControlChange(
        { sessionMode: 'chat', askMode: true, automation: 'push' },
        'design',
      ),
    ).toEqual([
      { type: 'ask', value: false },
      { type: 'automation', value: 'manual' },
      { type: 'mode', value: 'design' },
    ]);
  });

  it('entering Consult clears legacy ask and ship intent', () => {
    expect(
      planSessionControlChange(
        { sessionMode: 'chat', askMode: false, automation: 'merge' },
        'consult',
      ),
    ).toEqual([
      { type: 'automation', value: 'manual' },
      { type: 'mode', value: 'consult' },
    ]);
  });

  it('leaving Consult for a ship level resets session_mode first', () => {
    expect(
      planSessionControlChange(
        { sessionMode: 'consult', askMode: false, automation: 'manual' },
        'push',
      ),
    ).toEqual([
      { type: 'mode', value: 'chat' },
      { type: 'automation', value: 'push' },
    ]);
  });

  it('Design -> a ship level resets to chat first, then sets the level', () => {
    expect(
      planSessionControlChange(
        { sessionMode: 'design', askMode: false, automation: 'manual' },
        'push',
      ),
    ).toEqual([
      { type: 'mode', value: 'chat' },
      { type: 'automation', value: 'push' },
    ]);
  });

  it('legacy ask -> a ship level clears ask then sets the level', () => {
    expect(
      planSessionControlChange(
        { sessionMode: 'chat', askMode: true, automation: 'manual' },
        'review',
      ),
    ).toEqual([
      { type: 'ask', value: false },
      { type: 'automation', value: 'review' },
    ]);
  });

  it('Build -> Consult switches mode and clears ship intent', () => {
    expect(
      planSessionControlChange(
        { sessionMode: 'chat', askMode: false, automation: 'merge' },
        'consult',
      ),
    ).toEqual([
      { type: 'automation', value: 'manual' },
      { type: 'mode', value: 'consult' },
    ]);
  });

  it('workflow project non-ship transitions do not write finalize automation', () => {
    expect(
      planSessionControlChange(
        { sessionMode: 'consult', askMode: false, automation: 'merge' },
        'scoping',
        { project: { mode: 'workflow' } },
      ),
    ).toEqual([{ type: 'mode', value: 'scoping' }]);
  });
});

describe('sessionControlPatch', () => {
  it('returns null for a no-op', () => {
    expect(
      sessionControlPatch({ sessionMode: 'chat', askMode: false, automation: 'push' }, 'push'),
    ).toBeNull();
  });

  it('collapses a single-axis change to one key', () => {
    expect(
      sessionControlPatch({ sessionMode: 'chat', askMode: false, automation: 'manual' }, 'merge'),
    ).toEqual({ finalize_automation: 'merge' });
    expect(
      sessionControlPatch({ sessionMode: 'chat', askMode: false, automation: 'manual' }, 'consult'),
    ).toEqual({ session_mode: 'consult' });
  });

  it('collapses Design-from-merge into one atomic patch (mode + ship reset)', () => {
    expect(
      sessionControlPatch({ sessionMode: 'chat', askMode: false, automation: 'merge' }, 'design'),
    ).toEqual({ session_mode: 'design', finalize_automation: 'manual' });
  });

  it('collapses legacy ask + ship -> Design into one atomic patch (all three axes)', () => {
    expect(
      sessionControlPatch({ sessionMode: 'chat', askMode: true, automation: 'push' }, 'design'),
    ).toEqual({ session_mode: 'design', ask_mode: false, finalize_automation: 'manual' });
  });

  it('collapses leaving Design for a ship level (mode reset + level)', () => {
    expect(
      sessionControlPatch({ sessionMode: 'design', askMode: false, automation: 'manual' }, 'push'),
    ).toEqual({ session_mode: 'chat', finalize_automation: 'push' });
  });

  it('omits finalize_automation for workflow project Consult -> Scoping patches', () => {
    expect(
      sessionControlPatch(
        { sessionMode: 'consult', askMode: false, automation: 'merge' },
        'scoping',
        { project: { mode: 'workflow' } },
      ),
    ).toEqual({ session_mode: 'scoping' });
  });
});

describe('sessionControlOptionsForProject / sessionControlValueForProject', () => {
  it('offers only server-accepted workflow modes (incl. Design) on workflow projects', () => {
    const opts = sessionControlOptionsForProject({ mode: 'workflow' }, { role: 'sub' });
    // Design is offered on workflow projects (data-dir artifact store). Order
    // follows SESSION_CONTROL_OPTIONS: consult, design, scoping, skill-builder.
    expect(opts.map((o: any) => o.value)).toEqual([
      'consult',
      'design',
      'scoping',
      'skill-builder',
    ]);
  });

  it('hides Skill Builder on workflow projects when the agent is a helper', () => {
    const opts = sessionControlOptionsForProject({ mode: 'workflow' }, { role: 'docs' });
    expect(opts.map((o: any) => o.value)).toEqual(['consult', 'design', 'scoping']);
  });

  it('includes Consult and Build modes on dev projects', () => {
    const opts = sessionControlOptionsForProject({ mode: 'dev' }, { role: 'sub' });
    expect(opts.map((o: any) => o.value)).toContain('consult');
    expect(opts.map((o: any) => o.value)).toContain('manual');
    expect(opts.map((o: any) => o.value)).not.toContain('ask');
  });

  it('maps legacy ship automation to Consult for display on workflow projects', () => {
    expect(
      sessionControlValueForProject({ mode: 'workflow' }, { automation: 'push', askMode: false }),
    ).toBe('consult');
    expect(
      sessionControlValueForProject({ mode: 'dev' }, { automation: 'push', askMode: false }),
    ).toBe('push');
  });
});

describe('sessionControlOptionsForAgent / isSkillBuilderEligibleAgent', () => {
  it('keeps the Skill Builder option for a dev agent', () => {
    const opts = sessionControlOptionsForAgent({ role: 'sub' });
    expect(opts).toBe(SESSION_CONTROL_OPTIONS);
    expect(opts.some((o: any) => o.value === 'skill-builder')).toBe(true);
  });

  it('hides the Skill Builder option for helper agents (docs/reviewer/skill-builder)', () => {
    for (const role of ['docs', 'reviewer', 'skill-builder']) {
      const opts = sessionControlOptionsForAgent({ role });
      expect(opts.some((o: any) => o.value === 'skill-builder')).toBe(false);
      expect(opts.some((o: any) => o.value === 'consult')).toBe(true);
      expect(opts.length).toBe(SESSION_CONTROL_OPTIONS.length - 1);
    }
  });

  it('hides Skill Builder when the agent is unknown (cannot prove eligibility)', () => {
    expect(sessionControlOptionsForAgent(null).some((o: any) => o.value === 'skill-builder')).toBe(
      false,
    );
    expect(isSkillBuilderEligibleAgent(undefined)).toBe(false);
  });
});
