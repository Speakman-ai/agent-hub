# Electron Desktop Shell

Agent Hub ships as a desktop app that wraps the same Express server — the
shell lives in `electron/` (`main.js` + `preload.cjs`). A few things agents
should know when reasoning about bug reports or config-path issues:

## No-Origin CORS bypass

Browser clients are gated by `ALLOWED_ORIGINS` (see `server/cors-config.ts`).
Electron and React Native requests have **no `Origin` header**, so CORS
short-circuits to "allow" at the top of the cors callback. That's why the
desktop shell and mobile app "just work" without being added to the
allowlist — not a bug, by design. If you're debugging a cross-origin
failure that only reproduces in the browser, check `ALLOWED_ORIGINS`; if it
repros in Electron too, it's not CORS.

## Packaged vs. dev config paths

- In development (`NODE_ENV=development`), the shell resolves data paths
  relative to the repo (`server/` next to the sources).
- In a packaged build, it uses `app.getPath('userData')`:
  - macOS: `~/Library/Application Support/Agent Hub`
  - Windows: `%APPDATA%/Agent Hub`
  - Linux: `~/.config/Agent Hub`
  - …and serves the built client from `client/dist`.

If a user reports "my config didn't carry over after upgrading" or "the app
can't find my sessions", this path divergence is the usual culprit —
check which build they're on before chasing data loss.

## Releases are out-of-band

A macOS DMG build script (`electron/release-mac.mjs`) exists for ops, but
there's no in-app auto-updater wired up. **Agents don't and shouldn't
trigger releases** — propose a PR, let a human run the release pipeline.

## Lifecycle quirks worth knowing

- The Electron main process spawns the Express server as a child; killing
  the window tears the server down with it.
- Dev mode launches `npm run dev` in both `client/` and `server/` and
  points the BrowserWindow at the Vite dev server on port 3050.
- Preload uses a `contextBridge` to expose only a narrow `electron` API to
  the renderer — no Node globals leak in.
