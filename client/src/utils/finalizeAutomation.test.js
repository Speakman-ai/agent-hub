import { describe, it, expect } from 'vitest';
import {
  FINALIZE_AUTOMATION_LEVELS,
  parseFinalizeAutomation,
  finalizeAutomationLabel,
  SESSION_CONTROL_OPTIONS,
  DESIGN_AUTOMATION_OPTION,
  sessionControlValue,
  sessionControlLabel,
  planSessionControlChange,
  sessionControlPatch,
} from './finalizeAutomation.js';

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
  it('folds Design + Ask + the four finalize levels into one ordered list', () => {
    expect(SESSION_CONTROL_OPTIONS.map((o) => o.value)).toEqual([
      'design',
      'ask',
      'manual',
      'review',
      'push',
      'merge',
    ]);
  });

  it('puts Design first as the no-ship option', () => {
    expect(SESSION_CONTROL_OPTIONS[0]).toBe(DESIGN_AUTOMATION_OPTION);
    expect(DESIGN_AUTOMATION_OPTION.label).toBe('Design');
  });
});

describe('sessionControlValue', () => {
  it('design takes precedence over ask and automation', () => {
    expect(sessionControlValue({ sessionMode: 'design', askMode: true, automation: 'merge' })).toBe(
      'design',
    );
  });

  it('ask takes precedence over the automation level when not in design', () => {
    expect(sessionControlValue({ sessionMode: 'chat', askMode: true, automation: 'push' })).toBe(
      'ask',
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
  it('agrees with finalizeAutomationLabel for ship levels and adds Design/Ask', () => {
    expect(sessionControlLabel('design')).toBe('Design');
    expect(sessionControlLabel('ask')).toBe('Ask');
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
      planSessionControlChange({ sessionMode: 'chat', askMode: true, automation: 'push' }, 'ask'),
    ).toEqual([]);
  });

  it('Ask -> Design clears ask mode before entering design (regression)', () => {
    // The bug: Design would win display precedence while ask_mode stayed on,
    // leaving the session read-only underneath so design prompts never write
    // artifacts. The plan must clear ask first.
    const steps = planSessionControlChange(
      { sessionMode: 'chat', askMode: true, automation: 'manual' },
      'design',
    );
    expect(steps).toEqual([
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
    // The bug: entering Design from push/merge left the ship intent stored
    // underneath, resurfacing when later leaving Design.
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

  it('Ask + ship level -> Design clears both ask and ship intent', () => {
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

  it('Design -> Ask resets to chat then enables ask', () => {
    expect(
      planSessionControlChange(
        { sessionMode: 'design', askMode: false, automation: 'manual' },
        'ask',
      ),
    ).toEqual([
      { type: 'mode', value: 'chat' },
      { type: 'ask', value: true },
    ]);
  });

  it('Ask -> a ship level clears ask then sets the level', () => {
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

  it('Build -> Ask just enables ask', () => {
    expect(
      planSessionControlChange(
        { sessionMode: 'chat', askMode: false, automation: 'manual' },
        'ask',
      ),
    ).toEqual([{ type: 'ask', value: true }]);
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
      sessionControlPatch({ sessionMode: 'chat', askMode: false, automation: 'manual' }, 'ask'),
    ).toEqual({ ask_mode: true });
  });

  it('collapses Design-from-merge into one atomic patch (mode + ship reset)', () => {
    expect(
      sessionControlPatch({ sessionMode: 'chat', askMode: false, automation: 'merge' }, 'design'),
    ).toEqual({ session_mode: 'design', finalize_automation: 'manual' });
  });

  it('collapses Ask + ship -> Design into one atomic patch (all three axes)', () => {
    expect(
      sessionControlPatch({ sessionMode: 'chat', askMode: true, automation: 'push' }, 'design'),
    ).toEqual({ session_mode: 'design', ask_mode: false, finalize_automation: 'manual' });
  });

  it('collapses leaving Design for a ship level (mode reset + level)', () => {
    expect(
      sessionControlPatch({ sessionMode: 'design', askMode: false, automation: 'manual' }, 'push'),
    ).toEqual({ session_mode: 'chat', finalize_automation: 'push' });
  });
});
