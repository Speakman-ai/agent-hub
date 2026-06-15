import { describe, it, expect } from 'vitest';
import {
  FINALIZE_AUTOMATION_LEVELS,
  parseFinalizeAutomation,
  finalizeAutomationFromSession,
  finalizeAutomationLabel,
  deriveSessionFinalizeMode,
} from './finalizeAutomation.js';

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
  it('defaults to manual / not-ask when the session is null or missing fields', () => {
    expect(deriveSessionFinalizeMode(null)).toEqual({ automation: 'manual', askMode: false });
    expect(deriveSessionFinalizeMode(undefined)).toEqual({ automation: 'manual', askMode: false });
    expect(deriveSessionFinalizeMode({})).toEqual({ automation: 'manual', askMode: false });
  });

  it('reads the automation level and ask-mode flag from the session', () => {
    expect(deriveSessionFinalizeMode({ finalize_automation: 'merge', ask_mode: false })).toEqual({
      automation: 'merge',
      askMode: false,
    });
    expect(deriveSessionFinalizeMode({ finalize_automation: 'review', ask_mode: true })).toEqual({
      automation: 'review',
      askMode: true,
    });
  });

  it('validates the automation level (unknown collapses to manual)', () => {
    expect(deriveSessionFinalizeMode({ finalize_automation: 'bogus' }).automation).toBe('manual');
  });

  it('coerces ask_mode to a real boolean', () => {
    // SQLite persists booleans as 0/1; a truthy 1 must surface as `true` so the
    // bar disables Ask mode on the server when switching to a non-ask level.
    expect(deriveSessionFinalizeMode({ ask_mode: 1 }).askMode).toBe(true);
    expect(deriveSessionFinalizeMode({ ask_mode: 0 }).askMode).toBe(false);
  });

  it('agrees with finalizeAutomationFromSession for the automation half', () => {
    const session = { finalize_automation: 'push', ask_mode: 1 };
    expect(deriveSessionFinalizeMode(session).automation).toBe(
      finalizeAutomationFromSession(session),
    );
  });
});
