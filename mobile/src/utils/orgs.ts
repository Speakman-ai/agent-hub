/**
 * Organization (remote server connection) management.
 *
 * On mobile, every org is a remote server connection.
 * Each org stores a server URL, optional API key, display name, and color.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { saveConnectionConfig, loadConnectionConfig } from './config';
const STORAGE_KEY = 'agent-hub-orgs';
function uid() {
    return Math.random().toString(36).slice(2, 10);
}
let _cachedOrgs: any = null;
/** Load orgs from AsyncStorage. */
export async function loadOrgs() {
    if (_cachedOrgs)
        return _cachedOrgs;
    try {
        const raw = await AsyncStorage.getItem(STORAGE_KEY);
        if (raw) {
            const parsed = JSON.parse(raw);
            if (parsed && Array.isArray(parsed.orgs) && parsed.orgs.length > 0) {
                _cachedOrgs = parsed;
                return _cachedOrgs;
            }
        }
    }
    catch { }
    _cachedOrgs = null;
    return null;
}
async function saveOrgs(state: any) {
    _cachedOrgs = state;
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}
/** Sync an org's connection fields into the shared connection config. */
function syncToConnection(org: any) {
    saveConnectionConfig({
        remoteUrl: org.remoteUrl || '',
        apiKey: org.apiKey || '',
    });
}
export function getOrgs() {
    return _cachedOrgs;
}
export function getActiveOrg() {
    const state = _cachedOrgs;
    if (!state)
        return null;
    return state.orgs.find((o: any) => o.id === state.activeOrgId) || state.orgs[0] || null;
}
/**
 * Switch to a different org by ID.
 * Updates connection config to point at the new server.
 */
export async function switchOrg(orgId: any) {
    const state = _cachedOrgs;
    if (!state)
        return;
    const org = state.orgs.find((o: any) => o.id === orgId);
    if (!org)
        return;
    state.activeOrgId = orgId;
    await saveOrgs(state);
    syncToConnection(org);
}
/** Create a new org (remote server connection). Returns the new org. */
export async function createOrg({ name, remoteUrl = '', apiKey = '', color = '#6366f1' }: any) {
    const org = {
        id: uid(),
        name,
        color,
        remoteUrl,
        apiKey,
        createdAt: new Date().toISOString(),
    };
    const state = _cachedOrgs || { activeOrgId: null, orgs: [] };
    state.orgs.push(org);
    if (!state.activeOrgId) {
        state.activeOrgId = org.id;
        syncToConnection(org);
    }
    await saveOrgs(state);
    return org;
}
/** Update an existing org. If it's the active org, sync connection config. */
export async function updateOrg(orgId: any, updates: any) {
    const state = _cachedOrgs;
    if (!state)
        return null;
    const idx = state.orgs.findIndex((o: any) => o.id === orgId);
    if (idx === -1)
        return null;
    state.orgs[idx] = { ...state.orgs[idx], ...updates };
    await saveOrgs(state);
    if (state.activeOrgId === orgId) {
        syncToConnection(state.orgs[idx]);
    }
    return state.orgs[idx];
}
/** Delete an org. Cannot delete the last one. Returns true if deleted. */
export async function deleteOrg(orgId: any) {
    const state = _cachedOrgs;
    if (!state || state.orgs.length <= 1)
        return false;
    state.orgs = state.orgs.filter((o: any) => o.id !== orgId);
    if (state.activeOrgId === orgId) {
        const newActive = state.orgs[0];
        state.activeOrgId = newActive.id;
        await saveOrgs(state);
        syncToConnection(newActive);
    }
    else {
        await saveOrgs(state);
    }
    return true;
}
/**
 * Migrate from legacy connection config to org system.
 * Creates a "Default" org from the existing connection config.
 */
export async function migrateFromLegacy() {
    const existing = await loadOrgs();
    if (existing)
        return;
    const conn = await loadConnectionConfig();
    const org = {
        id: 'default',
        name: 'Default',
        color: '#6366f1',
        remoteUrl: conn.remoteUrl || '',
        apiKey: conn.apiKey || '',
        createdAt: new Date().toISOString(),
    };
    await saveOrgs({ activeOrgId: org.id, orgs: [org] });
}
/**
 * Test a remote server connection.
 * Returns { ok: boolean, message: string }.
 */
export async function testConnection(url: any, apiKey: any) {
    if (!url)
        return { ok: false, message: 'Enter a server URL first.' };
    const base = url.replace(/\/+$/, '');
    try {
        const headers = (apiKey ? { 'X-API-Key': apiKey } : {}) as Record<string, string>;
        // First: hit /api/health (public) to verify server is reachable
        const healthRes = await fetch(`${base}/api/health`, {
            headers,
            signal: AbortSignal.timeout(10000),
        });
        if (!healthRes.ok) {
            return { ok: false, message: `Server responded with ${healthRes.status}: ${healthRes.statusText}` };
        }
        const data = await healthRes.json();
        // Second: if server requires auth, verify the API key by hitting an auth-required endpoint
        if (data.authRequired) {
            if (!apiKey) {
                return { ok: false, message: `Server requires an API key. Enter one above.` };
            }
            const authRes = await fetch(`${base}/api/agents`, {
                headers: { 'X-API-Key': apiKey },
                signal: AbortSignal.timeout(10000),
            });
            if (authRes.status === 401 || authRes.status === 403) {
                return { ok: false, message: `Server reachable but API key is invalid (${authRes.status}).` };
            }
            if (!authRes.ok) {
                return { ok: false, message: `Auth check failed: ${authRes.status} ${authRes.statusText}` };
            }
        }
        return { ok: true, message: `Connected — ${data.agents || 0} agents, uptime ${Math.round((data.uptime || 0) / 60)}m` };
    }
    catch (err: any) {
        if (err.name === 'AbortError' || err.name === 'TimeoutError') {
            return { ok: false, message: 'Connection timed out after 10 seconds.' };
        }
        return { ok: false, message: `Connection failed: ${err.message}` };
    }
}
