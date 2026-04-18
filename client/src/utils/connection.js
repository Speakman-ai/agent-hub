/**
 * Connection configuration for local vs remote mode.
 *
 * Stores settings in localStorage so they persist across sessions.
 * Defaults to local mode (same-origin server) — no config needed.
 *
 * Remote mode: point at a remote Agent Hub server with optional API key.
 */

import { getToken as getJwtToken } from './auth.js';

const STORAGE_KEY = 'agent-hub-connection';

const DEFAULT_CONFIG = {
  mode: 'local', // 'local' | 'remote'
  remoteUrl: '', // e.g. 'https://my-server.example.com:3051'
  apiKey: '', // optional API key for remote auth
};

/** Read the persisted connection config. */
export function getConnectionConfig() {
  // In Electron, check if the main process has a config override
  if (window.electronAPI?.getConnectionConfig) {
    const electronConfig = window.electronAPI.getConnectionConfig();
    if (electronConfig) return { ...DEFAULT_CONFIG, ...electronConfig };
  }

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {}
  return { ...DEFAULT_CONFIG };
}

/** Persist connection config. */
export function saveConnectionConfig(config) {
  // Strip whitespace and surrounding quotes from apiKey (common paste artifacts)
  const cleanedKey = config.apiKey
    ? config.apiKey.replace(/\s+/g, '').replace(/^["']+|["']+$/g, '')
    : config.apiKey;
  const merged = {
    ...DEFAULT_CONFIG,
    ...config,
    ...(cleanedKey !== undefined ? { apiKey: cleanedKey } : {}),
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));

  // Also save to Electron if available
  if (window.electronAPI?.saveConnectionConfig) {
    window.electronAPI.saveConnectionConfig(merged);
  }

  return merged;
}

/** Get the server base URL without /api (e.g. '' or 'https://remote:3051').
 *  Used for resolving server-relative paths like /uploads/... */
export function getServerBase() {
  const config = getConnectionConfig();
  if (config.mode === 'remote' && config.remoteUrl) {
    return config.remoteUrl.trim().replace(/\/+$/, '');
  }
  return ''; // local mode — same-origin, relative paths work
}

/** Get the base URL for API calls (e.g. '/api' or 'https://remote:3051/api'). */
export function getApiBase() {
  const base = getServerBase();
  return base ? `${base}/api` : '/api';
}

/** Get the LOCAL server's API base — always same-origin, ignoring remote config.
 *  Used for org management which must always talk to the local server. */
export function getLocalApiBase() {
  return '/api';
}

/** Get the WebSocket URL (e.g. 'ws://localhost:3051' or 'wss://remote:3051?apiKey=xxx'). */
export function getWsUrl() {
  const config = getConnectionConfig();
  const jwt = getJwtToken();
  if (config.mode === 'remote' && config.remoteUrl) {
    // Convert http(s) to ws(s)
    let wsUrl = config.remoteUrl.trim().replace(/\/+$/, '').replace(/^http/, 'ws');
    // Prefer JWT over apiKey — matches REST header behavior.
    if (jwt) {
      wsUrl += `?token=${encodeURIComponent(jwt)}`;
    } else if (config.apiKey) {
      wsUrl += `?apiKey=${encodeURIComponent(config.apiKey)}`;
    }
    return wsUrl;
  }
  // Local mode — if VITE_API_PORT is set, connect directly to that port
  // (dev mode with separate vite + server processes).
  // Otherwise, use same-origin WebSocket via /ws path
  // (production / Docker — nginx proxies the upgrade).
  if (import.meta.env.VITE_API_PORT) {
    const base = `ws://${window.location.hostname}:${import.meta.env.VITE_API_PORT}`;
    return jwt ? `${base}?token=${encodeURIComponent(jwt)}` : base;
  }
  const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const base = `${wsProto}//${window.location.host}/ws`;
  return jwt ? `${base}?token=${encodeURIComponent(jwt)}` : base;
}

/** Reload the app after an org switch. In Electron, navigates the window
 *  to the correct URL (local or remote). In the browser, just reloads. */
export function reloadForOrgSwitch() {
  if (window.electronAPI?.navigateToOrg) {
    window.electronAPI.navigateToOrg();
  } else {
    window.location.reload();
  }
}

/** Get auth headers for API requests. Empty object if no credentials stored.
 *  JWT (Authorization: Bearer) is preferred over the legacy X-API-Key when
 *  both are available. The server accepts either, but the middleware tries
 *  JWT first so it records the subject on the request. */
export function getAuthHeaders() {
  const jwt = getJwtToken();
  if (jwt) {
    return { Authorization: `Bearer ${jwt}` };
  }
  const config = getConnectionConfig();
  if (config.mode === 'remote' && config.apiKey) {
    return { 'X-API-Key': config.apiKey };
  }
  return {};
}

/** Test connection to a remote server. Returns { ok, message, serverInfo? }. */
export async function testConnection(url, apiKey) {
  const base = url.trim().replace(/\/+$/, '');
  const headers = {};
  if (apiKey) headers['X-API-Key'] = apiKey;

  try {
    // First: hit /api/health (public) to verify server is reachable
    const healthRes = await fetch(`${base}/api/health`, {
      headers,
      signal: AbortSignal.timeout(10000),
    });
    if (!healthRes.ok) {
      return {
        ok: false,
        message: `Server responded with ${healthRes.status}: ${healthRes.statusText}`,
      };
    }
    const data = await healthRes.json();

    // Second: if server requires auth, verify the API key by hitting an auth-required endpoint
    if (data.authRequired) {
      if (!apiKey) {
        return { ok: false, message: 'Server requires an API key. Enter one above.' };
      }
      const authRes = await fetch(`${base}/api/agents`, {
        headers: { 'X-API-Key': apiKey },
        signal: AbortSignal.timeout(10000),
      });
      if (authRes.status === 401 || authRes.status === 403) {
        return {
          ok: false,
          message: `Server reachable but API key is invalid (${authRes.status}).`,
        };
      }
      if (!authRes.ok) {
        return { ok: false, message: `Auth check failed: ${authRes.status} ${authRes.statusText}` };
      }
    }

    return {
      ok: true,
      message: `Connected — ${data.agents || 0} agents, uptime ${Math.round((data.uptime || 0) / 60)}m`,
      serverInfo: data,
    };
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      return { ok: false, message: 'Connection timed out after 10 seconds.' };
    }
    return { ok: false, message: `Connection failed: ${err.message}` };
  }
}
