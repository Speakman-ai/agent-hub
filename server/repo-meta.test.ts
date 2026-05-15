/**
 * Repo-meta regression guards.
 *
 * Consolidates a cluster of tiny static-file inspection tests that each used
 * to live in their own file. Folding them into one file pays the vitest
 * cold-start tax (~430ms per file) once instead of five times. Each describe
 * block below was previously a standalone file:
 *
 *   typecheck-preflight.test.ts   — npm `typecheck` script shape
 *   run-eslint-script.test.ts     — npm `lint` script + scripts/run-eslint.mjs
 *   husky-precommit-path.test.ts  — .husky/pre-commit + .npmrc
 *   native-load.test.ts           — better-sqlite3 native ABI smoke test
 *   dockerfile.test.ts            — server/Dockerfile regression guards
 */
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, it, expect } from 'vitest';

const serverDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(serverDir, '..');

describe('typecheck preflight', () => {
  it('runs assert-dev-types before tsc so missing devDeps fail with a clear message', () => {
    const pkg = JSON.parse(readFileSync(path.join(serverDir, 'package.json'), 'utf8')) as {
      scripts?: { typecheck?: string };
    };
    expect(pkg.scripts?.typecheck).toContain('assert-dev-types.mjs');
    expect(pkg.scripts?.typecheck).toContain('tsc --noEmit');
  });
});

describe('scripts/run-eslint.mjs', () => {
  it('npm lint script ends with `.` so `npm run lint -- <flags>` still lints the repo root (matches eslint . + tail)', () => {
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    expect(pkg.scripts.lint).toBe('node scripts/run-eslint.mjs .');
  });

  it('guards missing eslint and runs the package bin via node (portable PATH)', () => {
    const src = readFileSync(path.join(repoRoot, 'scripts', 'run-eslint.mjs'), 'utf8');
    expect(src).toContain('node_modules/eslint');
    expect(src).toContain('spawnSync(process.execPath');
    expect(src).toContain('ESLint is not installed');
    expect(src.split(/from ['"]fs['"]/).length - 1).toBe(1);
  });
});

describe('.husky/pre-commit — GUI / Electron PATH bootstrap', () => {
  it('exports PATH with repo node_modules/.bin and common Node locations before lint-staged', () => {
    const script = readFileSync(path.join(repoRoot, '.husky', 'pre-commit'), 'utf-8');
    expect(script).toContain('ROOT="$(cd "$(dirname "$0")/.." && pwd)"');
    expect(script).toContain('node_modules/.bin');
    expect(script).toContain('/opt/homebrew/bin');
    expect(script).toContain('node_modules/.bin/eslint');
    expect(script).toContain('exec npx --no-install lint-staged');
  });
});

describe('.npmrc — devDependencies for hooks', () => {
  it('includes dev so eslint/husky install with npm install', () => {
    const rc = readFileSync(path.join(repoRoot, '.npmrc'), 'utf-8');
    expect(rc).toMatch(/include\s*=\s*dev/);
  });
});

/**
 * Smoke test: better-sqlite3's native addon loads against the current Node
 * runtime's ABI. If this fails with ERR_DLOPEN_FAILED / NODE_MODULE_VERSION
 * mismatch, the compiled `.node` binary is stale for the current Node version.
 *
 * Recovery: `npm run rebuild:native` (or `npm rebuild better-sqlite3`).
 *
 * Pairs with the `.nvmrc` + `engines.node` constraint in the repo root.
 */
describe('native module ABI', () => {
  it('loads better-sqlite3 against the current Node runtime', async () => {
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(':memory:');
    try {
      const row = db.prepare('SELECT 1 AS ok').get() as { ok: number };
      expect(row.ok).toBe(1);
    } finally {
      db.close();
    }
  });
});

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
  const dockerfile = readFileSync(path.join(serverDir, 'Dockerfile'), 'utf8');

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

describe('server/Dockerfile — git (husky / lint-staged in Docker)', () => {
  const dockerfile = readFileSync(path.join(serverDir, 'Dockerfile'), 'utf8');

  it('sets safe.directory so mounted clones are not rejected as dubious ownership', () => {
    expect(dockerfile).toContain("git config --system --add safe.directory '*'");
  });
});

/**
 * Hub container defaults (`server/config.ts`) expect `codex` at /usr/local/bin and
 * Cursor's `agent` at ~/.local/bin/agent for HOME=/home/node. The prod Dockerfile
 * must bake both in so shipped environments don't require manual bin paths.
 */
describe('server/Dockerfile — Cursor Agent + Codex CLI', () => {
  const dockerfile = readFileSync(path.join(serverDir, 'Dockerfile'), 'utf8');

  it('installs @openai/codex globally (npm bin matches codexBin fallback)', () => {
    expect(dockerfile).toMatch(/npm\s+install\s+-g\s+@openai\/codex/);
  });

  it('runs the Cursor installer as node before Playwright so ~/.local/bin/agent exists', () => {
    expect(dockerfile).toMatch(
      /USER node\s*\nRUN\s+curl[^\n]*cursor\.com\/install[^\n]*\|\s*bash/s,
    );
    const curlInstall = dockerfile.search(/RUN\s+curl[^\n]*cursor\.com\/install[^\n]*\|\s*bash/);
    const playwright = dockerfile.indexOf('playwright install chromium');
    expect(curlInstall).toBeGreaterThan(-1);
    expect(playwright).toBeGreaterThan(curlInstall);
  });
});
