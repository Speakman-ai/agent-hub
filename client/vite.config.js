import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'fs';
import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { resolveBuildVersion } from './src/utils/resolveBuildVersion.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// In Docker production builds, set VITE_API_PORT="" so the client uses
// same-origin WebSocket via nginx. In dev, defaults to 3051.
const apiPort = process.env.VITE_API_PORT ?? '3051';

// Resolve the app version baked into the bundle. Implementation lives in
// `./src/utils/resolveBuildVersion.js` so it's directly unit-testable; see
// that file for the priority order (env var → repo-root package.json) and
// for the rationale on why we no longer fall back to client/package.json.
const clientVersion = resolveBuildVersion({
  env: process.env,
  rootPkgPath: path.resolve(__dirname, '..', 'package.json'),
  readFile: readFileSync,
});

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
  resolve: {
    // rrweb-player's package `exports` map only exposes `.` and
    // `./dist/style.css`, so the UMD bundle isn't reachable as a bare subpath
    // specifier. We need it as a raw string to inline into the sandboxed
    // replay-player iframe, so alias a clean id straight at the UMD file and
    // import it with `?raw`. Regex/array form (prefix, no `$`) so the `?raw`
    // query is preserved through the rewrite. Mirrored in vitest.config.js.
    alias: [
      {
        find: /^rrweb-player-umd/,
        replacement: path.resolve(
          __dirname,
          'node_modules/rrweb-player/dist/rrweb-player.umd.min.cjs',
        ),
      },
    ],
  },
  define: {
    // Expose the API port to the client so connection.js can use it
    'import.meta.env.VITE_API_PORT': JSON.stringify(apiPort),
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(clientVersion),
    'import.meta.env.VITE_GIT_HASH': JSON.stringify(gitHash),
    // Optional absolute origin for local Electron when `publicUrl` is unset (e.g. CI DMG)
    'import.meta.env.VITE_DESKTOP_UPDATE_CHECK_URL': JSON.stringify(
      process.env.VITE_DESKTOP_UPDATE_CHECK_URL || '',
    ),
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
