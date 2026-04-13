/**
 * Organization management — hybrid approach.
 *
 * LOCAL orgs: stored on the server in SQLite (survive browser clears).
 *   These represent data-isolated workspaces on the current server.
 *
 * REMOTE orgs: stored in localStorage as connection bookmarks.
 *   These are pointers to other Agent Hub servers. They must live client-side
 *   because you need them to know WHERE to connect — the server can't serve
 *   them if you're not connected to it yet.
 *
 * The unified org list shown in the UI is a merge of both sources.
 */

import { getLocalApiBase, saveConnectionConfig } from './connection.js';

const REMOTE_ORGS_KEY = 'agent-hub-remote-orgs';

// ─── In-memory cache ──────────────────────────────────────────────
let _localOrgs = []; // from server
let _remoteOrgs = []; // from localStorage (browser) or file-backed (Electron)
let _activeOrgId = _loadActiveOrgId();

/** Load active org ID — prefer Electron file-backed storage (origin-independent). */
function _loadActiveOrgId() {
  if (window.electronAPI?.getActiveOrgId) {
    return window.electronAPI.getActiveOrgId() || null;
  }
  return localStorage.getItem('agent-hub-active-org') || null;
}

/** Persist active org ID to both localStorage and Electron file storage. */
function _saveActiveOrgId(orgId) {
  localStorage.setItem('agent-hub-active-org', orgId);
  if (window.electronAPI?.saveActiveOrgId) {
    window.electronAPI.saveActiveOrgId(orgId);
  }
}

/** Get the merged list of all orgs (local + remote). */
function allOrgs() {
  return [..._localOrgs, ..._remoteOrgs];
}

// ─── Remote orgs (localStorage) ──────────────────────────────────

function loadRemoteOrgs() {
  // In Electron, use file-backed storage (survives origin changes when
  // navigating between remote servers).
  if (window.electronAPI?.getRemoteOrgs) {
    _remoteOrgs = window.electronAPI.getRemoteOrgs() || [];
    return;
  }
  // Browser fallback — localStorage (origin-scoped)
  try {
    const raw = localStorage.getItem(REMOTE_ORGS_KEY);
    if (raw) {
      _remoteOrgs = JSON.parse(raw);
      return;
    }
  } catch {}
  _remoteOrgs = [];
}

function saveRemoteOrgs() {
  // Always write to localStorage for browser compatibility
  localStorage.setItem(REMOTE_ORGS_KEY, JSON.stringify(_remoteOrgs));
  // In Electron, also persist to file-backed storage
  if (window.electronAPI?.saveRemoteOrgs) {
    window.electronAPI.saveRemoteOrgs(_remoteOrgs);
  }
}

// ─── Public API ───────────────────────────────────────────────────

/** Fetch local orgs from server + load remote orgs from localStorage. */
export async function fetchOrgs() {
  // Load remote orgs from localStorage
  loadRemoteOrgs();

  // Fetch local orgs from the server
  try {
    const res = await fetch(`${getLocalApiBase()}/orgs`, {});
    if (res.ok) {
      _localOrgs = await res.json();
    }
  } catch {
    // Server may not be reachable — keep whatever was cached
  }

  // If no active org set, default to first
  const merged = allOrgs();
  if (!_activeOrgId && merged.length > 0) {
    _activeOrgId = merged[0].id;
    _saveActiveOrgId(_activeOrgId);
  }

  return { orgs: merged, activeOrgId: _activeOrgId };
}

/** Get cached orgs (synchronous). Returns { orgs, activeOrgId } or null. */
export function getOrgs() {
  const merged = allOrgs();
  if (merged.length === 0) return null;
  return { orgs: merged, activeOrgId: _activeOrgId };
}

/** Get the active org from cache. */
export function getActiveOrg() {
  const merged = allOrgs();
  if (merged.length === 0) return null;
  return merged.find((o) => o.id === _activeOrgId) || merged[0] || null;
}

/**
 * Switch to a different org by ID.
 * For local orgs: tells the server to switch data directories.
 * For remote orgs: updates connection config to point at the remote server.
 */
export async function switchOrg(orgId) {
  const merged = allOrgs();
  const org = merged.find((o) => o.id === orgId);
  if (!org) return;

  _activeOrgId = orgId;
  _saveActiveOrgId(orgId);

  syncToConnection(org);

  // For local orgs, tell the server to switch its data directory
  if (org.mode !== 'remote') {
    try {
      await fetch(`${getLocalApiBase()}/orgs/${orgId}/switch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (err) {
      console.warn('[Orgs] Server switch failed:', err.message);
    }
  }
}

/** Create a new org. Returns the created org. */
export async function createOrg({
  name,
  mode = 'local',
  remoteUrl = '',
  apiKey = '',
  color = '#6366f1',
}) {
  if (mode === 'remote') {
    // Remote orgs are stored in localStorage
    const org = {
      id: uid(),
      name,
      mode: 'remote',
      color,
      remote_url: remoteUrl,
      api_key: apiKey,
      created_at: new Date().toISOString(),
    };
    _remoteOrgs.push(org);
    saveRemoteOrgs();
    return org;
  }

  // Local orgs go to the server
  const res = await fetch(`${getLocalApiBase()}/orgs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mode, color, remoteUrl, apiKey }),
  });
  if (!res.ok) throw new Error('Failed to create org');
  const org = await res.json();
  await fetchOrgs();
  return org;
}

/** Update an existing org. Returns the updated org. */
export async function updateOrg(orgId, updates) {
  // Check if it's a remote org
  const remoteIdx = _remoteOrgs.findIndex((o) => o.id === orgId);
  if (remoteIdx !== -1) {
    _remoteOrgs[remoteIdx] = { ..._remoteOrgs[remoteIdx], ...updates };
    // Normalize field names for remote orgs
    if (updates.remoteUrl !== undefined) _remoteOrgs[remoteIdx].remote_url = updates.remoteUrl;
    if (updates.apiKey !== undefined) _remoteOrgs[remoteIdx].api_key = updates.apiKey;
    saveRemoteOrgs();
    if (_activeOrgId === orgId) syncToConnection(_remoteOrgs[remoteIdx]);
    return _remoteOrgs[remoteIdx];
  }

  // Local org — update on server
  const res = await fetch(`${getLocalApiBase()}/orgs/${orgId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  });
  if (!res.ok) throw new Error('Failed to update org');
  const org = await res.json();
  await fetchOrgs();
  if (_activeOrgId === orgId) syncToConnection(org);
  return org;
}

/** Delete an org. Cannot delete the last org overall. Returns true if deleted. */
export async function deleteOrg(orgId) {
  const merged = allOrgs();
  if (merged.length <= 1) return false;

  // Check if it's a remote org
  const remoteIdx = _remoteOrgs.findIndex((o) => o.id === orgId);
  if (remoteIdx !== -1) {
    _remoteOrgs.splice(remoteIdx, 1);
    saveRemoteOrgs();
  } else {
    // Local org — delete on server
    const res = await fetch(`${getLocalApiBase()}/orgs/${orgId}`, {
      method: 'DELETE',
    });
    if (!res.ok) return false;
    await fetchOrgs();
  }

  // If we deleted the active org, switch to first remaining
  if (_activeOrgId === orgId) {
    const remaining = allOrgs()[0];
    if (remaining) {
      await switchOrg(remaining.id);
    }
  }
  return true;
}

/**
 * Migrate from legacy localStorage orgs to the hybrid system.
 * - Local legacy orgs → pushed to server
 * - Remote legacy orgs → moved to REMOTE_ORGS_KEY localStorage
 */
export async function migrateFromLegacy() {
  const LEGACY_KEY = 'agent-hub-orgs';
  const raw = localStorage.getItem(LEGACY_KEY);
  if (!raw) return;

  try {
    const legacy = JSON.parse(raw);
    if (!legacy || !Array.isArray(legacy.orgs) || legacy.orgs.length === 0) return;

    // Check if server already has orgs beyond default — don't double-migrate
    const serverOrgs = await fetchOrgs();
    if (serverOrgs && serverOrgs.orgs.length > 1) {
      localStorage.removeItem(LEGACY_KEY);
      return;
    }

    const remotes = [];

    for (const legacyOrg of legacy.orgs) {
      if (legacyOrg.id === 'default') continue;

      if (legacyOrg.mode === 'remote') {
        // Remote orgs stay in localStorage (new key)
        remotes.push({
          id: legacyOrg.id,
          name: legacyOrg.name,
          mode: 'remote',
          color: legacyOrg.color || '#6366f1',
          remote_url: legacyOrg.remoteUrl || '',
          api_key: legacyOrg.apiKey || '',
          created_at: legacyOrg.createdAt || new Date().toISOString(),
        });
      } else {
        // Local orgs go to the server
        try {
          await fetch(`${getLocalApiBase()}/orgs`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              id: legacyOrg.id,
              name: legacyOrg.name,
              mode: 'local',
              color: legacyOrg.color || '#6366f1',
            }),
          });
        } catch {}
      }
    }

    // Save remote orgs to their new localStorage key
    if (remotes.length > 0) {
      _remoteOrgs = remotes;
      saveRemoteOrgs();
    }

    // Preserve active org
    if (legacy.activeOrgId) {
      _activeOrgId = legacy.activeOrgId;
      _saveActiveOrgId(_activeOrgId);
    }

    // Remove legacy storage
    localStorage.removeItem(LEGACY_KEY);
    await fetchOrgs();
  } catch {
    // If migration fails, leave localStorage intact for next attempt
  }
}

/** Sync an org's connection fields into the shared connection config. */
function syncToConnection(org) {
  saveConnectionConfig({
    mode: org.mode || 'local',
    remoteUrl: org.remote_url || org.remoteUrl || '',
    apiKey: org.api_key || org.apiKey || '',
  });
}

function uid() {
  return Math.random().toString(36).slice(2, 10);
}
