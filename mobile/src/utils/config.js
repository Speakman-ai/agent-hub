import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'agent-hub-connection';

// ─── Connection config (AsyncStorage-backed) ───────────────────
// Mobile app is always remote — connects to an Agent Hub server.

const DEFAULT_CONFIG = {
  remoteUrl: '',
  apiKey: '',
};

let _cachedConfig = null;

/** Load connection config from AsyncStorage (cached after first read). */
export async function loadConnectionConfig() {
  if (_cachedConfig) return _cachedConfig;
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
      // Strip whitespace and surrounding quotes from apiKey (common paste artifacts)
      if (parsed.apiKey) parsed.apiKey = parsed.apiKey.replace(/\s+/g, '').replace(/^["']+|["']+$/g, '');
      _cachedConfig = parsed;
      return _cachedConfig;
    }
  } catch {}
  _cachedConfig = { ...DEFAULT_CONFIG };
  return _cachedConfig;
}

/** Save connection config. */
export async function saveConnectionConfig(config) {
  // Strip whitespace and surrounding quotes from apiKey (common paste artifacts)
  const cleaned = { ...config };
  if (cleaned.apiKey) {
    cleaned.apiKey = cleaned.apiKey.replace(/\s+/g, '').replace(/^["']+|["']+$/g, '');
  }
  _cachedConfig = { ...DEFAULT_CONFIG, ...cleaned };
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(_cachedConfig));
}

// ─── URL resolution ─────────────────────────────────────────────

/** Get API base URL — always remote. */
export function getApiBaseUrl() {
  if (_cachedConfig?.remoteUrl) {
    return `${_cachedConfig.remoteUrl.replace(/\/+$/, '')}/api`;
  }
  return ''; // No URL configured yet
}

/** Get WebSocket URL — always remote. */
export function getWsUrl() {
  if (_cachedConfig?.remoteUrl) {
    let wsUrl = _cachedConfig.remoteUrl.replace(/\/+$/, '').replace(/^http/, 'ws');
    if (_cachedConfig.apiKey) {
      wsUrl += `?apiKey=${encodeURIComponent(_cachedConfig.apiKey)}`;
    }
    return wsUrl;
  }
  return ''; // No URL configured yet
}

/** Get auth headers for API requests. */
export function getAuthHeaders() {
  if (_cachedConfig?.apiKey) {
    return { 'X-API-Key': _cachedConfig.apiKey };
  }
  return {};
}
