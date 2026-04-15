import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'fs';

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

export default defineConfig({
  plugins: [react()],
  define: {
    // Expose the API port to the client so connection.js can use it
    'import.meta.env.VITE_API_PORT': JSON.stringify(apiPort),
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(clientVersion),
  },
  server: {
    port: 3050,
    host: '0.0.0.0',
    // Proxy only applies in dev mode (not production builds)
    proxy: apiPort
      ? {
          '/api': `http://localhost:${apiPort}`,
          '/uploads': `http://localhost:${apiPort}`,
        }
      : undefined,
  },
});
