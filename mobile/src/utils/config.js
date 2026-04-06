import Constants from 'expo-constants';

// Determine server URL automatically
// In development, use the Expo dev server host which points to the local machine
function getServerHost() {
  // Try to get the local dev machine IP from Expo
  const debuggerHost = Constants.expoConfig?.hostUri || Constants.manifest?.debuggerHost;
  if (debuggerHost) {
    const host = debuggerHost.split(':')[0];
    return host;
  }
  // Fallback to localhost (works for emulators/simulators)
  return 'localhost';
}

const SERVER_HOST = getServerHost();
const SERVER_PORT = 3051;

export const API_BASE_URL = `http://${SERVER_HOST}:${SERVER_PORT}/api`;
export const WS_URL = `ws://${SERVER_HOST}:${SERVER_PORT}`;
