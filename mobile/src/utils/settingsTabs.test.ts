// @ts-nocheck
import { describe, it, expect } from 'vitest';
import { normalizeSettingsTab } from './settingsTabs';
const VALID = ['notifications', 'general', 'servers', 'account', 'logs'];
const LEGACY = new Set(['orgs', 'heartbeats', 'crons', 'projects', 'agents', 'config']);
describe('normalizeSettingsTab', () => {
    it('keeps an exact valid tab id (e.g. the dashboard account shortcut)', () => {
        expect(normalizeSettingsTab('account', VALID, LEGACY)).toBe('account');
        expect(normalizeSettingsTab('logs', VALID, LEGACY)).toBe('logs');
    });
    it('aliases the renamed orgs tab to servers', () => {
        expect(normalizeSettingsTab('orgs', VALID, LEGACY)).toBe('servers');
    });
    it('collapses other legacy tab ids to general', () => {
        expect(normalizeSettingsTab('heartbeats', VALID, LEGACY)).toBe('general');
        expect(normalizeSettingsTab('agents', VALID, LEGACY)).toBe('general');
    });
    it('falls back to general for unknown or empty input', () => {
        expect(normalizeSettingsTab('mystery', VALID, LEGACY)).toBe('general');
        expect(normalizeSettingsTab('', VALID, LEGACY)).toBe('general');
        expect(normalizeSettingsTab(null, VALID, LEGACY)).toBe('general');
        expect(normalizeSettingsTab(undefined, VALID, LEGACY)).toBe('general');
    });
    it('accepts a Set of valid ids as well as an array', () => {
        expect(normalizeSettingsTab('account', new Set(VALID), LEGACY)).toBe('account');
    });
});
