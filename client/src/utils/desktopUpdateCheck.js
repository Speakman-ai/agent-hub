import { getConnectionConfig, getServerBase } from './connection.js';

/**
 * Resolve `/api/health` for Electron desktop update + sidebar footer.
 *
 * - **Remote mode:** same hub the UI uses (renderer fetch; page origin matches).
 * - **Local bundled:** `publicUrl` from `/api/config` → main-process fetch (no CORS),
 *   then optional `VITE_DESKTOP_UPDATE_CHECK_URL`, then embedded `/api/health`.
 *
 * @returns {Promise<{ version: string, gitHash: string } | null>}
 */
export async function fetchDesktopUpdateHealth() {
  if (typeof window === 'undefined' || !window.electronAPI?.isElectron) {
    return null;
  }

  const cfg = getConnectionConfig();

  if (cfg.mode === 'remote' && cfg.remoteUrl) {
    const base = cfg.remoteUrl.trim().replace(/\/+$/, '');
    try {
      const r = await fetch(`${base}/api/health`);
      if (!r.ok) return null;
      const d = await r.json();
      if (!d?.version) return null;
      return { version: String(d.version).trim(), gitHash: d.gitHash ? String(d.gitHash) : '' };
    } catch {
      return null;
    }
  }

  let publicUrl = '';
  try {
    const r = await fetch('/api/config');
    if (r.ok) {
      const j = await r.json();
      publicUrl = (j.publicUrl || '').trim().replace(/\/+$/, '');
    }
  } catch {
    /* ignore */
  }

  if (publicUrl && window.electronAPI.fetchRemoteHealth) {
    const h = await window.electronAPI.fetchRemoteHealth(`${publicUrl}/api/health`);
    if (h?.version) {
      return { version: h.version, gitHash: h.gitHash || '' };
    }
  }

  const envBase = (import.meta.env.VITE_DESKTOP_UPDATE_CHECK_URL || '').trim().replace(/\/+$/, '');
  if (envBase && window.electronAPI.fetchRemoteHealth) {
    const h = await window.electronAPI.fetchRemoteHealth(`${envBase}/api/health`);
    if (h?.version) {
      return { version: h.version, gitHash: h.gitHash || '' };
    }
  }

  try {
    const base = getServerBase();
    const r = await fetch(`${base}/api/health`);
    if (!r.ok) return null;
    const d = await r.json();
    if (!d?.version) return null;
    return { version: String(d.version).trim(), gitHash: d.gitHash ? String(d.gitHash) : '' };
  } catch {
    return null;
  }
}
