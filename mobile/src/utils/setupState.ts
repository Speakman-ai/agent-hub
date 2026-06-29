/**
 * First-run setup detection helpers for the mobile app.
 *
 * Mobile is always a remote client — first run means there is no org with a
 * configured `remoteUrl`. `migrateFromLegacy` always leaves behind a default
 * org (possibly with an empty URL), so we must inspect the orgs array rather
 * than just checking whether any org exists.
 *
 * A separate "setup dismissed" flag in AsyncStorage lets users skip the
 * wizard even if they never entered a URL (so returning to Settings later is
 * possible without the wizard blocking the entire UI forever).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
export const SETUP_DISMISSED_KEY = 'agent-hub-setup-dismissed';
/**
 * Given the orgs state (as returned by `getOrgs()`), determine whether the
 * first-run wizard should be shown.
 *
 * Rules:
 *   - null / empty orgs list → needs setup
 *   - no active org selected and none of the orgs has a remoteUrl → needs setup
 *   - active org has an empty/whitespace remoteUrl → needs setup
 *
 * @param {{activeOrgId?: string|null, orgs?: Array}|null|undefined} state
 * @returns {boolean}
 */
export function needsFirstRunSetup(state: any) {
    if (!state || !Array.isArray(state.orgs) || state.orgs.length === 0) {
        return true;
    }
    const active = state.orgs.find((o: any) => o && o.id === state.activeOrgId) || state.orgs[0];
    if (!active)
        return true;
    const url = typeof active.remoteUrl === 'string' ? active.remoteUrl.trim() : '';
    return url.length === 0;
}
/**
 * Returns true when the wizard should be presented to the user — i.e.
 * `needsFirstRunSetup` is true AND the user hasn't previously dismissed it.
 *
 * @param {{activeOrgId?: string|null, orgs?: Array}|null|undefined} state
 * @param {boolean} dismissed
 * @returns {boolean}
 */
export function shouldShowWizard(state: any, dismissed: any) {
    if (dismissed)
        return false;
    return needsFirstRunSetup(state);
}
/**
 * After the first-run server address is saved, decide whether to raise the
 * login gate. Mobile is a pure client: once a server URL exists, the user must
 * authenticate against that server — so we route to the LoginScreen rather than
 * dropping into a main app that can't load data. The only time we skip the gate
 * is when a valid token is already held for the server.
 *
 * @param {{ hasServerUrl: boolean, isAuthenticated: boolean }} params
 * @returns {boolean} true when the LoginScreen should be shown next
 */
export function shouldGateLoginAfterSetup({ hasServerUrl, isAuthenticated }: any = {}) {
    return Boolean(hasServerUrl) && !isAuthenticated;
}
/**
 * Decide whether the app-level auth gate should be raised from
 * `/api/auth/status`. Local bundled installs deliberately allow unauthenticated
 * local bypass, while remote servers and already-authenticated sessions still
 * enforce login/email-update state.
 */
export function shouldGateAuthFromStatus({ status, isAuthenticated, needsEmailUpdate }: any = {}) {
    if (!status?.authConfigured)
        return false;
    if (status.activeOrgIsLocal && !isAuthenticated && !status.needsEmailUpdate)
        return false;
    return !isAuthenticated || Boolean(needsEmailUpdate) || Boolean(status.needsEmailUpdate);
}
/** Read the persisted dismissed flag. Defaults to `false` on error. */
export async function loadSetupDismissed() {
    try {
        const raw = await AsyncStorage.getItem(SETUP_DISMISSED_KEY);
        return raw === '1' || raw === 'true';
    }
    catch {
        return false;
    }
}
/** Persist the dismissed flag so the wizard won't reappear after completion. */
export async function saveSetupDismissed(value: any) {
    try {
        await AsyncStorage.setItem(SETUP_DISMISSED_KEY, value ? '1' : '0');
    }
    catch {
        /* best-effort — wizard will simply re-prompt next launch */
    }
}
/**
 * Normalize a user-entered server URL. Trims whitespace, strips trailing
 * slashes, and prepends `https://` when the user omitted a scheme.
 *
 * Returns an empty string if the input is empty after trimming.
 *
 * @param {string} input
 * @returns {string}
 */
export function normalizeServerUrl(input: any) {
    if (typeof input !== 'string')
        return '';
    const trimmed = input.trim();
    if (!trimmed)
        return '';
    const stripped = trimmed.replace(/\/+$/, '');
    if (/^https?:\/\//i.test(stripped))
        return stripped;
    return `https://${stripped}`;
}
/**
 * Lightweight validation for the URL field before hitting the network.
 *
 * Returns `null` if valid, or a short error message describing why not.
 *
 * @param {string} input
 * @returns {string|null}
 */
export function validateServerUrl(input: any) {
    if (typeof input !== 'string' || !input.trim()) {
        return 'Server URL is required.';
    }
    const normalized = normalizeServerUrl(input);
    try {
        const u = new URL(normalized);
        if (!u.hostname)
            return 'Server URL must include a hostname.';
        return null;
    }
    catch {
        return 'Server URL is not valid.';
    }
}
