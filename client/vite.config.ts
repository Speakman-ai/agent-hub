import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'fs';
import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { resolveBuildVersion } from './src/utils/resolveBuildVersion';
import { buildPreviewServerConfig, isPreviewMode } from './src/utils/previewServerConfig';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Agent Hub session-preview (live HMR) mode — gated entirely on AGENT_HUB_PREVIEW=1
// so normal `npm run dev` / `npm run build` are unaffected. See
// ./src/utils/previewServerConfig.ts + ops/RUNBOOK-subdomain-preview-hmr.md.
const previewServer = buildPreviewServerConfig(process.env);

// In Docker production builds, set VITE_API_PORT="" so the client uses
// same-origin WebSocket via nginx. In dev, defaults to 3051. In preview mode the
// client talks same-origin (Vite proxies /api to the nested API on loopback).
const apiPort = isPreviewMode(process.env) ? '' : (process.env.VITE_API_PORT ?? '3051');

// Resolve the app version baked into the bundle. Implementation lives in
// `./src/utils/resolveBuildVersion.ts` so it's directly unit-testable; see
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
    alias: {
      '@shared': path.resolve(__dirname, '../shared'),
    },
  },
  define: {
    // Expose the API port to the client so connection.ts can use it
    'import.meta.env.VITE_API_PORT': JSON.stringify(apiPort),
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(clientVersion),
    'import.meta.env.VITE_GIT_HASH': JSON.stringify(gitHash),
    // Optional absolute origin for local Electron when `publicUrl` is unset (e.g. CI DMG)
    'import.meta.env.VITE_DESKTOP_UPDATE_CHECK_URL': JSON.stringify(
      process.env.VITE_DESKTOP_UPDATE_CHECK_URL || '',
    ),
  },
  // In preview mode use the HMR-over-proxy server config; otherwise the normal
  // local dev server (untouched).
  server: previewServer ?? {
    // `npm run dev:client` runs bare `vite`, so this is the local dev port.
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
