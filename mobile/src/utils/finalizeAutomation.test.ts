// @ts-nocheck
import { describe, it, expect } from 'vitest';
import {
  FINALIZE_AUTOMATION_LEVELS,
  parseFinalizeAutomation,
  finalizeAutomationLabel,
  deriveSessionFinalizeMode,
  SESSION_CONTROL_OPTIONS,
  sessionControlValue,
  sessionControlLabel,
  planSessionControlChange,
  sessionControlPatch,
  sessionControlOptionsForAgent,
  sessionControlOptionsForProject,
  sessionControlValueForProject,
} from './finalizeAutomation';

describe('parseFinalizeAutomation', () => {
  it('passes through known levels', () => {
    for (const lvl of FINALIZE_AUTOMATION_LEVELS) {
      expect(parseFinalizeAutomation(lvl)).toBe(lvl);
    }
  });
  it('falls back to manual for unknown / missing values', () => {
    expect(parseFinalizeAutomation('bogus')).toBe('manual');
    expect(parseFinalizeAutomation(undefined)).toBe('manual');
    expect(parseFinalizeAutomation(null)).toBe('manual');
  });
});

describe('finalizeAutomationLabel', () => {
  it('maps level → label and defaults to Build', () => {
    expect(finalizeAutomationLabel('manual')).toBe('Build');
    expect(finalizeAutomationLabel('review')).toBe('Build and Review');
    expect(finalizeAutomationLabel('merge')).toBe('Auto Merge');
    expect(finalizeAutomationLabel('bogus')).toBe('Build');
  });
});

describe('deriveSessionFinalizeMode', () => {
  it('defaults to manual / not-legacy-ask when the session is null or missing fields', () => {
    expect(deriveSessionFinalizeMode(null)).toEqual({ automation: 'manual', askMode: false });
    expect(deriveSessionFinalizeMode(undefined)).toEqual({ automation: 'manual', askMode: false });
    expect(deriveSessionFinalizeMode({})).toEqual({ automation: 'manual', askMode: false });
  });
  it('reads the automation level and legacy ask-mode flag from the session', () => {
    expect(deriveSessionFinalizeMode({ finalize_automation: 'merge', ask_mode: false })).toEqual({
      automation: 'merge',
      askMode: false,
    });
    expect(deriveSessionFinalizeMode({ finalize_automation: 'review', ask_mode: true })).toEqual({
      automation: 'review',
      askMode: true,
    });
  });
});

describe('SESSION_CONTROL_OPTIONS', () => {
  it('lists Consult, Design, Scoping, Skill Builder, VM, then the four finalize levels', () => {
    expect(SESSION_CONTROL_OPTIONS.map((o: any) => o.value)).toEqual([
      'consult',
      'design',
      'scoping',
      'skill-builder',
      'isolated',
      'manual',
      'review',
      'push',
      'merge',
    ]);
  });
});

describe('sessionControlValue', () => {
  it('returns design when session_mode is design, regardless of ask/automation', () => {
    expect(sessionControlValue({ sessionMode: 'design', askMode: true, automation: 'merge' })).toBe(
      'design',
    );
  });
  it('returns consult for consult mode and legacy ask_mode', () => {
    expect(
      sessionControlValue({ sessionMode: 'consult', askMode: false, automation: 'merge' }),
    ).toBe('consult');
    expect(sessionControlValue({ sessionMode: 'chat', askMode: true, automation: 'merge' })).toBe(
      'consult',
    );
  });
  it('returns isolated for VM mode regardless of ship automation', () => {
    expect(
      sessionControlValue({ sessionMode: 'isolated', askMode: false, automation: 'push' }),
    ).toBe('isolated');
  });
  it('falls through to the finalize automation level', () => {
    expect(sessionControlValue({ sessionMode: 'chat', askMode: false, automation: 'push' })).toBe(
      'push',
    );
    expect(sessionControlValue({})).toBe('manual');
  });
});

describe('sessionControlLabel', () => {
  it('maps the folded values to labels', () => {
    expect(sessionControlLabel('consult')).toBe('Consult');
    expect(sessionControlLabel('design')).toBe('Design');
    expect(sessionControlLabel('isolated')).toBe('VM');
    expect(sessionControlLabel('merge')).toBe('Auto Merge');
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
  });
  it('legacy ask -> Design clears ask mode before entering design (regression)', () => {
    expect(
      planSessionControlChange(
        { sessionMode: 'chat', askMode: true, automation: 'manual' },
        'design',
      ),
    ).toEqual([
      { type: 'ask', value: false },
      { type: 'mode', value: 'design' },
    ]);
  });
  it('entering Consult clears ship intent', () => {
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
  it('entering VM clears ship intent; leaving VM for ship keeps isolated', () => {
    expect(
      planSessionControlChange(
        { sessionMode: 'chat', askMode: false, automation: 'merge' },
        'isolated',
      ),
    ).toEqual([
      { type: 'automation', value: 'manual' },
      { type: 'mode', value: 'isolated' },
    ]);
    expect(
      planSessionControlChange(
        { sessionMode: 'isolated', askMode: false, automation: 'manual' },
        'push',
      ),
    ).toEqual([{ type: 'automation', value: 'push' }]);
  });
  it('workflow project non-ship transitions do not write finalize automation', () => {
    expect(
      sessionControlPatch(
        { sessionMode: 'consult', askMode: false, automation: 'merge' },
        'scoping',
        { project: { mode: 'workflow' } },
      ),
    ).toEqual({ session_mode: 'scoping' });
  });
});

describe('sessionControlOptionsForProject', () => {
  it('offers only server-accepted workflow modes (incl. Design) on workflow projects', () => {
    const opts = sessionControlOptionsForProject({ mode: 'workflow' }, { role: 'sub' });
    expect(opts.map((o: any) => o.value)).toEqual(['consult', 'design', 'scoping', 'skill-builder']);
  });
  it('hides Skill Builder on workflow projects when the agent is a helper', () => {
    const opts = sessionControlOptionsForProject({ mode: 'workflow' }, { role: 'docs' });
    expect(opts.map((o: any) => o.value)).toEqual(['consult', 'design', 'scoping']);
  });
  it('includes Consult and VM on dev projects', () => {
    const opts = sessionControlOptionsForProject(
      { mode: 'dev' },
      { role: 'sub' },
      { canUseVm: true },
    );
    expect(opts.map((o: any) => o.value)).toContain('consult');
    expect(opts.map((o: any) => o.value)).toContain('isolated');
    expect(opts.map((o: any) => o.value)).toContain('manual');
  });
  it('hides VM on dev projects until the server capability is enabled', () => {
    const opts = sessionControlOptionsForProject({ mode: 'dev' }, { role: 'sub' });
    expect(opts.map((o: any) => o.value)).not.toContain('isolated');
  });
  it('maps legacy ship automation to Consult for display', () => {
    expect(sessionControlValueForProject({ mode: 'workflow' }, { automation: 'merge' })).toBe(
      'consult',
    );
  });
});

describe('sessionControlOptionsForAgent', () => {
  it('keeps Skill Builder for a dev agent and hides it for helpers', () => {
    expect(
      sessionControlOptionsForAgent({ role: 'sub' }).some((o) => o.value === 'skill-builder'),
    ).toBe(true);
    for (const role of ['docs', 'reviewer', 'skill-builder']) {
      expect(sessionControlOptionsForAgent({ role }).some((o) => o.value === 'skill-builder')).toBe(
        false,
      );
    }
    expect(sessionControlOptionsForAgent(null).some((o) => o.value === 'skill-builder')).toBe(
      false,
    );
  });
});
