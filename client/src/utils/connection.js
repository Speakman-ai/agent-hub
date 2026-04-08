/**
 * Connection configuration for local vs remote mode.
 *
 * Stores settings in localStorage so they persist across sessions.
 * Defaults to local mode (same-origin server) — no config needed.
 *
 * Remote mode: point at a remote Agent Hub server with optional API key.
 */

const STORAGE_KEY = 'agent-hub-connection';

const DEFAULT_CONFIG = {
  mode: 'local',        // 'local' | 'remote'
  remoteUrl: '',        // e.g. 'https://my-server.example.com:3051'
  apiKey: '',           // optional API key for remote auth
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
  const merged = { ...DEFAULT_CONFIG, ...config };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));

  // Also save to Electron if available
  if (window.electronAPI?.saveConnectionConfig) {
    window.electronAPI.saveConnectionConfig(merged);
  }

  return merged;
}

/** Get the base URL for API calls (e.g. '/api' or 'https://remote:3051/api'). */
export function getApiBase() {
  const config = getConnectionConfig();
  if (config.mode === 'remote' && config.remoteUrl) {
    // Strip trailing whitespace and slashes from the URL
    const base = config.remoteUrl.trim().replace(/\/+$/, '');
    return `${base}/api`;
  }
  return '/api'; // local mode — same-origin
}

/** Get the WebSocket URL (e.g. 'ws://localhost:3051' or 'wss://remote:3051?apiKey=xxx'). */
export function getWsUrl() {
  const config = getConnectionConfig();
  if (config.mode === 'remote' && config.remoteUrl) {
    // Convert http(s) to ws(s)
    let wsUrl = config.remoteUrl
      .trim()
      .replace(/\/+$/, '')
      .replace(/^http/, 'ws');
    if (config.apiKey) {
      wsUrl += `?apiKey=${encodeURIComponent(config.apiKey)}`;
    }
    return wsUrl;
  }
  // Local mode — connect to same hostname on server port
  return `ws://${window.location.hostname}:3051`;
}

/** Get auth headers for API requests. Empty object if no key configured. */
export function getAuthHeaders() {
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
    const res = await fetch(`${base}/api/health`, { headers, signal: AbortSignal.timeout(10000) });
    if (!res.ok) {
      return { ok: false, message: `Server responded with ${res.status}: ${res.statusText}` };
    }
    const data = await res.json();
    return {
      ok: true,
      message: 'Connected successfully!',
      serverInfo: data,
    };
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      return { ok: false, message: 'Connection timed out after 10 seconds.' };
    }
    return { ok: false, message: `Connection failed: ${err.message}` };
  }
}
