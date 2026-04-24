import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { describe, it, expect } from 'vitest';

/**
 * Regression guard for server/Dockerfile.
 *
 * Context: the runtime loads `better-sqlite3` from /app/server/node_modules
 * (Node module resolution walks from the cwd /app/server upward). That copy
 * must have its native .node binding present. We install server deps with
 * `--ignore-scripts` for build-speed/supply-chain reasons, so the postinstall
 * hook that fetches/compiles the binding is skipped. We MUST follow the
 * server install with `npm rebuild better-sqlite3` — otherwise the server
 * crash-loops with "Could not locate the bindings file".
 */

describe('server/Dockerfile — better-sqlite3 native binding', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const dockerfile = readFileSync(resolve(here, 'Dockerfile'), 'utf8');

  it('rebuilds better-sqlite3 after the root npm ci', () => {
    expect(dockerfile).toMatch(
      /^\s*RUN\s+npm\s+ci\s+--ignore-scripts\s+&&\s+npm\s+rebuild\s+better-sqlite3\s*$/m,
    );
  });

  it('rebuilds better-sqlite3 after the server npm ci too', () => {
    // This is the regression that caused production to crash-loop:
    // the server install ran with --ignore-scripts but never rebuilt,
    // so /app/server/node_modules/better-sqlite3 had no .node binary.
    expect(dockerfile).toMatch(
      /^\s*RUN\s+cd\s+server\s+&&\s+npm\s+ci\s+--ignore-scripts\s+&&\s+npm\s+rebuild\s+better-sqlite3\s*$/m,
    );
  });

  it('still installs native-module build toolchain in the build stage', () => {
    // `npm rebuild better-sqlite3` falls back to compiling from source if the
    // prebuilt binary isn't available for the current Node version. That
    // fallback requires python3/make/g++ — make sure we don't accidentally
    // drop those without also moving to a Node version with guaranteed
    // prebuilts.
    expect(dockerfile).toMatch(/apt-get\s+install[\s\S]*?python3[\s\S]*?make[\s\S]*?g\+\+/);
  });
});
