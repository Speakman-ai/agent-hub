// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('@react-native-async-storage/async-storage', () => {
    const store = new Map();
    return {
        default: {
            getItem: vi.fn(async (key: any) => (store.has(key) ? store.get(key) : null)),
            setItem: vi.fn(async (key: any, value: any) => {
                store.set(key, value);
            }),
            removeItem: vi.fn(async (key: any) => {
                store.delete(key);
            }),
            __store: store,
        },
    };
});
import AsyncStorage from '@react-native-async-storage/async-storage';
import { needsFirstRunSetup, shouldShowWizard, shouldGateLoginAfterSetup, loadSetupDismissed, saveSetupDismissed, normalizeServerUrl, validateServerUrl, SETUP_DISMISSED_KEY, } from './setupState';
describe('needsFirstRunSetup', () => {
    it('returns true for null / undefined state', () => {
        expect(needsFirstRunSetup(null)).toBe(true);
        expect(needsFirstRunSetup(undefined)).toBe(true);
    });
    it('returns true when orgs array is empty or missing', () => {
        expect(needsFirstRunSetup({ orgs: [] })).toBe(true);
        expect(needsFirstRunSetup({ activeOrgId: 'a', orgs: [] })).toBe(true);
        expect(needsFirstRunSetup({ activeOrgId: 'a' })).toBe(true);
    });
    it('returns true when the active org has no remoteUrl', () => {
        expect(needsFirstRunSetup({
            activeOrgId: 'a',
            orgs: [{ id: 'a', remoteUrl: '' }],
        })).toBe(true);
        expect(needsFirstRunSetup({
            activeOrgId: 'a',
            orgs: [{ id: 'a', remoteUrl: '   ' }],
        })).toBe(true);
        expect(needsFirstRunSetup({
            activeOrgId: 'a',
            orgs: [{ id: 'a' }],
        })).toBe(true);
    });
    it('returns false when the active org has a remoteUrl', () => {
        expect(needsFirstRunSetup({
            activeOrgId: 'a',
            orgs: [{ id: 'a', remoteUrl: 'https://example.com' }],
        })).toBe(false);
    });
    it('falls back to first org when activeOrgId does not match any org', () => {
        expect(needsFirstRunSetup({
            activeOrgId: 'missing',
            orgs: [{ id: 'a', remoteUrl: 'https://example.com' }],
        })).toBe(false);
        expect(needsFirstRunSetup({
            activeOrgId: 'missing',
            orgs: [{ id: 'a', remoteUrl: '' }],
        })).toBe(true);
    });
    it('treats non-string remoteUrl values as missing', () => {
        expect(needsFirstRunSetup({
            activeOrgId: 'a',
            orgs: [{ id: 'a', remoteUrl: null }],
        })).toBe(true);
        expect(needsFirstRunSetup({
            activeOrgId: 'a',
            orgs: [{ id: 'a', remoteUrl: 42 }],
        })).toBe(true);
    });
});
describe('shouldShowWizard', () => {
    const fresh = { activeOrgId: 'a', orgs: [{ id: 'a', remoteUrl: '' }] };
    const configured = {
        activeOrgId: 'a',
        orgs: [{ id: 'a', remoteUrl: 'https://example.com' }],
    };
    it('shows the wizard when first-run and not dismissed', () => {
        expect(shouldShowWizard(fresh, false)).toBe(true);
    });
    it('hides the wizard when dismissed, even if first-run', () => {
        expect(shouldShowWizard(fresh, true)).toBe(false);
    });
    it('never shows the wizard when already configured', () => {
        expect(shouldShowWizard(configured, false)).toBe(false);
        expect(shouldShowWizard(configured, true)).toBe(false);
    });
});
describe('shouldGateLoginAfterSetup', () => {
    it('gates on login once a server URL exists and no token is held', () => {
        expect(shouldGateLoginAfterSetup({ hasServerUrl: true, isAuthenticated: false })).toBe(true);
    });
    it('does not gate when a valid token is already held', () => {
        expect(shouldGateLoginAfterSetup({ hasServerUrl: true, isAuthenticated: true })).toBe(false);
    });
    it('does not gate when no server URL is configured (e.g. skipped)', () => {
        expect(shouldGateLoginAfterSetup({ hasServerUrl: false, isAuthenticated: false })).toBe(false);
        expect(shouldGateLoginAfterSetup({ hasServerUrl: false, isAuthenticated: true })).toBe(false);
    });
    it('treats missing args as not-gated rather than throwing', () => {
        expect(shouldGateLoginAfterSetup()).toBe(false);
        expect(shouldGateLoginAfterSetup({})).toBe(false);
    });
});
describe('AsyncStorage dismissed flag', () => {
    beforeEach(() => {
        AsyncStorage.__store.clear();
    });
    it('defaults to false when nothing is stored', async () => {
        expect(await loadSetupDismissed()).toBe(false);
    });
    it('round-trips the dismissed flag via AsyncStorage', async () => {
        await saveSetupDismissed(true);
        expect(AsyncStorage.__store.get(SETUP_DISMISSED_KEY)).toBe('1');
        expect(await loadSetupDismissed()).toBe(true);
        await saveSetupDismissed(false);
        expect(AsyncStorage.__store.get(SETUP_DISMISSED_KEY)).toBe('0');
        expect(await loadSetupDismissed()).toBe(false);
    });
    it('accepts legacy "true" string as dismissed', async () => {
        AsyncStorage.__store.set(SETUP_DISMISSED_KEY, 'true');
        expect(await loadSetupDismissed()).toBe(true);
    });
    it('treats unknown values as not-dismissed', async () => {
        AsyncStorage.__store.set(SETUP_DISMISSED_KEY, 'maybe');
        expect(await loadSetupDismissed()).toBe(false);
    });
});
describe('normalizeServerUrl', () => {
    it('returns empty string for non-string or empty input', () => {
        expect(normalizeServerUrl(null)).toBe('');
        expect(normalizeServerUrl(undefined)).toBe('');
        expect(normalizeServerUrl('')).toBe('');
        expect(normalizeServerUrl('   ')).toBe('');
        expect(normalizeServerUrl(123)).toBe('');
    });
    it('trims whitespace and trailing slashes', () => {
        expect(normalizeServerUrl('  https://x.com/  ')).toBe('https://x.com');
        expect(normalizeServerUrl('https://x.com///')).toBe('https://x.com');
    });
    it('prepends https:// when a scheme is missing', () => {
        expect(normalizeServerUrl('example.com')).toBe('https://example.com');
        expect(normalizeServerUrl('example.com:3051')).toBe('https://example.com:3051');
    });
    it('preserves existing http:// and https:// schemes', () => {
        expect(normalizeServerUrl('http://localhost:3051')).toBe('http://localhost:3051');
        expect(normalizeServerUrl('HTTPS://x.com')).toBe('HTTPS://x.com');
    });
});
describe('validateServerUrl', () => {
    it('rejects empty / whitespace input', () => {
        expect(validateServerUrl('')).toMatch(/required/i);
        expect(validateServerUrl('   ')).toMatch(/required/i);
        expect(validateServerUrl(null)).toMatch(/required/i);
    });
    it('accepts a bare hostname (https:// is inferred)', () => {
        expect(validateServerUrl('example.com')).toBeNull();
    });
    it('accepts full URLs', () => {
        expect(validateServerUrl('https://example.com:3051')).toBeNull();
        expect(validateServerUrl('http://localhost:3051')).toBeNull();
    });
    it('rejects obviously malformed URLs', () => {
        // Spaces survive trim() mid-string, producing an invalid URL.
        expect(validateServerUrl('not a url')).toMatch(/valid|hostname/i);
    });
});
