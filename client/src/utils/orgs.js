/**
 * Organization (connection profile) management.
 *
 * Each org is a named connection profile stored in localStorage.
 * Switching orgs syncs connection fields into `connection.js` and
 * tells the server to switch its data directory (each org gets
 * an isolated database and projects.json).
 */

import { getConnectionConfig, saveConnectionConfig, getApiBase, getAuthHeaders } from './connection.js';

const STORAGE_KEY = 'agent-hub-orgs';

/** Generate a short random ID. */
function uid() {
  return Math.random().toString(36).slice(2, 10);
}

/** Read the full orgs state from localStorage (or null if none). */
export function getOrgs() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.orgs) && parsed.orgs.length > 0) {
        return parsed;
      }
    }
  } catch {}
  return null;
}

/** Persist the full orgs state. */
function saveOrgs(state) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

/** Sync an org's connection fields into the shared connection config. */
function syncToConnection(org) {
  saveConnectionConfig({
    mode: org.mode || 'local',
    remoteUrl: org.remoteUrl || '',
    apiKey: org.apiKey || '',
  });
}

/** Get the currently active org, or null. */
export function getActiveOrg() {
  const state = getOrgs();
  if (!state) return null;
  return state.orgs.find((o) => o.id === state.activeOrgId) || state.orgs[0] || null;
}

/**
 * Switch to a different org by ID.
 * Updates the connection config FIRST (so subsequent API calls target the
 * correct server), then tells that server to switch its data directory.
 * Returns a promise — await it before reloading the page.
 */
export async function switchOrg(orgId) {
  const state = getOrgs();
  if (!state) return;
  const org = state.orgs.find((o) => o.id === orgId);
  if (!org) return;

  // Update connection config BEFORE making any API calls so getApiBase()
  // returns the TARGET server URL, not the previous one.
  state.activeOrgId = orgId;
  saveOrgs(state);
  syncToConnection(org);

  // For local orgs, tell the local server to switch its data directory.
  // Remote servers manage their own org state — don't send client-side
  // org IDs to them (it would create empty data directories).
  if (org.mode !== 'remote') {
    try {
      await fetch(`${getApiBase()}/org/switch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({ orgId }),
      });
    } catch (err) {
      console.warn('[Orgs] Server switch failed:', err.message);
    }
  }
}

/** Create a new org and add it to the list. Returns the new org. */
export function createOrg({ name, mode = 'local', remoteUrl = '', apiKey = '', color = '#6366f1' }) {
  const org = {
    id: uid(),
    name,
    mode,
    color,
    remoteUrl,
    apiKey,
    createdAt: new Date().toISOString(),
  };

  const state = getOrgs() || { activeOrgId: null, orgs: [] };
  state.orgs.push(org);
  // If this is the first org, make it active
  if (!state.activeOrgId) {
    state.activeOrgId = org.id;
    syncToConnection(org);
  }
  saveOrgs(state);
  return org;
}

/** Update an existing org. If it's the active org, sync connection config. */
export function updateOrg(orgId, updates) {
  const state = getOrgs();
  if (!state) return null;
  const idx = state.orgs.findIndex((o) => o.id === orgId);
  if (idx === -1) return null;
  state.orgs[idx] = { ...state.orgs[idx], ...updates };
  saveOrgs(state);
  // If this is the active org, sync connection
  if (state.activeOrgId === orgId) {
    syncToConnection(state.orgs[idx]);
  }
  return state.orgs[idx];
}

/** Delete an org. Cannot delete the last one. Returns true if deleted. */
export async function deleteOrg(orgId) {
  const state = getOrgs();
  if (!state || state.orgs.length <= 1) return false;
  state.orgs = state.orgs.filter((o) => o.id !== orgId);
  // If we deleted the active org, switch to the first remaining
  if (state.activeOrgId === orgId) {
    const newActive = state.orgs[0];
    state.activeOrgId = newActive.id;
    saveOrgs(state);
    syncToConnection(newActive);
    // Tell server to switch data directory
    if (newActive.mode !== 'remote') {
      try {
        await fetch(`${getApiBase()}/org/switch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
          body: JSON.stringify({ orgId: newActive.id }),
        });
      } catch {}
    }
  } else {
    saveOrgs(state);
  }
  return true;
}

/**
 * Migrate from legacy connection config to org system.
 * Call on first load if getOrgs() returns null.
 * Creates a "Default" org from the existing connection config.
 */
export function migrateFromLegacy() {
  if (getOrgs()) return; // already migrated
  const conn = getConnectionConfig();
  const org = {
    id: 'default', // Special ID — maps to the server's original data directory
    name: 'Default',
    mode: conn.mode || 'local',
    color: '#6366f1',
    remoteUrl: conn.remoteUrl || '',
    apiKey: conn.apiKey || '',
    createdAt: new Date().toISOString(),
  };
  saveOrgs({ activeOrgId: org.id, orgs: [org] });
}
