import Constants from 'expo-constants';
import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'agent-hub-connection';

// ─── Connection config (AsyncStorage-backed) ───────────────────

const DEFAULT_CONFIG = {
  mode: 'local',
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
      _cachedConfig = { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
      return _cachedConfig;
    }
  } catch {}
  _cachedConfig = { ...DEFAULT_CONFIG };
  return _cachedConfig;
}

/** Save connection config. */
export async function saveConnectionConfig(config) {
  _cachedConfig = { ...DEFAULT_CONFIG, ...config };
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(_cachedConfig));
}

// ─── URL resolution ─────────────────────────────────────────────

function getServerHost() {
  const debuggerHost = Constants.expoConfig?.hostUri || Constants.manifest?.debuggerHost;
  if (debuggerHost) {
    return debuggerHost.split(':')[0];
  }
  return 'localhost';
}

const LOCAL_HOST = getServerHost();
const SERVER_PORT = 3051;

/** Get API base URL — uses cached config (call loadConnectionConfig first). */
export function getApiBaseUrl() {
  if (_cachedConfig?.mode === 'remote' && _cachedConfig.remoteUrl) {
    return `${_cachedConfig.remoteUrl.replace(/\/+$/, '')}/api`;
  }
  return `http://${LOCAL_HOST}:${SERVER_PORT}/api`;
}

/** Get WebSocket URL — uses cached config. */
export function getWsUrl() {
  if (_cachedConfig?.mode === 'remote' && _cachedConfig.remoteUrl) {
    let wsUrl = _cachedConfig.remoteUrl.replace(/\/+$/, '').replace(/^http/, 'ws');
    if (_cachedConfig.apiKey) {
      wsUrl += `?apiKey=${encodeURIComponent(_cachedConfig.apiKey)}`;
    }
    return wsUrl;
  }
  return `ws://${LOCAL_HOST}:${SERVER_PORT}`;
}

/** Get auth headers for API requests. */
export function getAuthHeaders() {
  if (_cachedConfig?.mode === 'remote' && _cachedConfig.apiKey) {
    return { 'X-API-Key': _cachedConfig.apiKey };
  }
  return {};
}

// ─── Legacy exports (backward compatible) ───────────────────────
export const API_BASE_URL = `http://${LOCAL_HOST}:${SERVER_PORT}/api`;
export const WS_URL = `ws://${LOCAL_HOST}:${SERVER_PORT}`;
