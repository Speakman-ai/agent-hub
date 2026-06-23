// @ts-nocheck
import { describe, it, expect } from 'vitest';
import { FINALIZE_AUTOMATION_LEVELS, parseFinalizeAutomation, finalizeAutomationFromSession, finalizeAutomationLabel, deriveSessionFinalizeMode, SESSION_CONTROL_OPTIONS, sessionControlValue, sessionControlLabel, planSessionControlChange, sessionControlPatch, } from './finalizeAutomation';
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
        expect(deriveSessionFinalizeMode(session).automation).toBe(finalizeAutomationFromSession(session));
    });
});
describe('SESSION_CONTROL_OPTIONS', () => {
    it('lists Design first, then Ask, then the four finalize levels', () => {
        expect(SESSION_CONTROL_OPTIONS.map((o: any) => o.value)).toEqual([
            'design',
            'ask',
            'manual',
            'review',
            'push',
            'merge',
        ]);
    });
});
describe('sessionControlValue', () => {
    it('returns design when session_mode is design, regardless of ask/automation', () => {
        expect(sessionControlValue({ sessionMode: 'design', askMode: true, automation: 'merge' })).toBe('design');
    });
    it('returns ask when not in design and ask_mode is on', () => {
        expect(sessionControlValue({ sessionMode: 'chat', askMode: true, automation: 'merge' })).toBe('ask');
    });
    it('falls through to the finalize automation level', () => {
        expect(sessionControlValue({ sessionMode: 'chat', askMode: false, automation: 'push' })).toBe('push');
        expect(sessionControlValue({})).toBe('manual');
    });
});
describe('sessionControlLabel', () => {
    it('maps the folded values to labels', () => {
        expect(sessionControlLabel('design')).toBe('Design');
        expect(sessionControlLabel('ask')).toBe('Ask');
        expect(sessionControlLabel('merge')).toBe('Auto Merge');
        expect(sessionControlLabel('bogus')).toBe('Build');
    });
});
describe('planSessionControlChange', () => {
    it('returns no steps for a no-op selection', () => {
        expect(planSessionControlChange({ sessionMode: 'chat', askMode: false, automation: 'push' }, 'push')).toEqual([]);
        expect(planSessionControlChange({ sessionMode: 'design', askMode: false, automation: 'push' }, 'design')).toEqual([]);
    });
    it('Ask -> Design clears ask mode before entering design (regression)', () => {
        // Guards the mobile state leak: choosing Design must call setSessionAskMode(false)
        // so the session is not left read-only ask underneath the Design label.
        expect(planSessionControlChange({ sessionMode: 'chat', askMode: true, automation: 'manual' }, 'design')).toEqual([
            { type: 'ask', value: false },
            { type: 'mode', value: 'design' },
        ]);
    });
    it('chat (no ask) -> Design only switches mode', () => {
        expect(planSessionControlChange({ sessionMode: 'chat', askMode: false, automation: 'manual' }, 'design')).toEqual([{ type: 'mode', value: 'design' }]);
    });
    it('ship level -> Design resets automation to manual (regression)', () => {
        // Mobile parity: entering Design from push/merge must clear ship intent so
        // it cannot resurface when leaving Design.
        expect(planSessionControlChange({ sessionMode: 'chat', askMode: false, automation: 'merge' }, 'design')).toEqual([
            { type: 'automation', value: 'manual' },
            { type: 'mode', value: 'design' },
        ]);
    });
    it('Ask + ship level -> Design clears both ask and ship intent', () => {
        expect(planSessionControlChange({ sessionMode: 'chat', askMode: true, automation: 'push' }, 'design')).toEqual([
            { type: 'ask', value: false },
            { type: 'automation', value: 'manual' },
            { type: 'mode', value: 'design' },
        ]);
    });
    it('Design -> a ship level resets to chat first, then sets the level', () => {
        expect(planSessionControlChange({ sessionMode: 'design', askMode: false, automation: 'manual' }, 'push')).toEqual([
            { type: 'mode', value: 'chat' },
            { type: 'automation', value: 'push' },
        ]);
    });
    it('Ask -> a ship level clears ask then sets the level', () => {
        expect(planSessionControlChange({ sessionMode: 'chat', askMode: true, automation: 'manual' }, 'review')).toEqual([
            { type: 'ask', value: false },
            { type: 'automation', value: 'review' },
        ]);
    });
});
describe('sessionControlPatch', () => {
    it('returns null for a no-op', () => {
        expect(sessionControlPatch({ sessionMode: 'chat', askMode: false, automation: 'push' }, 'push')).toBeNull();
    });
    it('collapses Design-from-merge into one atomic patch (mode + ship reset)', () => {
        expect(sessionControlPatch({ sessionMode: 'chat', askMode: false, automation: 'merge' }, 'design')).toEqual({ session_mode: 'design', finalize_automation: 'manual' });
    });
    it('collapses Ask + ship -> Design into one atomic patch (all three axes)', () => {
        expect(sessionControlPatch({ sessionMode: 'chat', askMode: true, automation: 'push' }, 'design')).toEqual({ session_mode: 'design', ask_mode: false, finalize_automation: 'manual' });
    });
    it('collapses leaving Design for a ship level (mode reset + level)', () => {
        expect(sessionControlPatch({ sessionMode: 'design', askMode: false, automation: 'manual' }, 'push')).toEqual({ session_mode: 'chat', finalize_automation: 'push' });
    });
});
