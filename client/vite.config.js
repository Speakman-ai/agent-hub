import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'fs';
import { execSync } from 'child_process';

// In Docker production builds, set VITE_API_PORT="" so the client uses
// same-origin WebSocket via nginx. In dev, defaults to 3051.
const apiPort = process.env.VITE_API_PORT ?? '3051';
let clientVersion = '0.0.0';
try {
  clientVersion = JSON.parse(readFileSync('../package.json', 'utf-8')).version;
} catch {
  // In Docker, the root package.json isn't available — fall back gracefully
  try {
    clientVersion = JSON.parse(readFileSync('./package.json', 'utf-8')).version || '0.0.0';
  } catch {
    /* use fallback */
  }
}

// Bake the current git short SHA into the bundle so a stale client is
// diagnosable at a glance. Prefer the VITE_GIT_HASH env (e.g. CI builds
// without .git metadata); otherwise shell out to git. Empty string if
// neither is available (Docker/asar with no git).
let gitHash = process.env.VITE_GIT_HASH || '';
if (!gitHash) {
  try {
    gitHash = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    /* no git available — leave empty */
  }
}

export default defineConfig({
  plugins: [react()],
  define: {
    // Expose the API port to the client so connection.js can use it
    'import.meta.env.VITE_API_PORT': JSON.stringify(apiPort),
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(clientVersion),
    'import.meta.env.VITE_GIT_HASH': JSON.stringify(gitHash),
  },
  server: {
    port: 3050,
    host: '0.0.0.0',
    // Proxy only applies in dev mode (not production builds)
    proxy: apiPort
      ? {
          '/api': `http://localhost:${apiPort}`,
          '/uploads': `http://localhost:${apiPort}`,
          // Design Studio + PDF export fetch `/design-files/*` from the Vite
          // origin (Electron dev loads :3050). Without this proxy, requests
          // never reach Express on the API port.
          '/design-files': `http://localhost:${apiPort}`,
        }
      : undefined,
  },
});
