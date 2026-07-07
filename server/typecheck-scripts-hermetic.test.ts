/**
 * Guards the repo-root `typecheck:*` scripts against the `npx tsc` footgun that
 * blew a whole Finalize run's 45-min pipeline budget on a single hang.
 *
 * Background (support ticket d00f0f77): the `build / Typecheck (all packages)`
 * step ran ~44min and was force-killed at the pipeline timeout. GitHub Actions
 * ran the identical `npm run typecheck` green. The divergence: `typecheck:electron`
 * and `typecheck:e2e` were `cd <dir> && npx tsc --noEmit`. `electron/` and `e2e/`
 * have NO `package.json` and no local `node_modules`, so when `npx` fails to
 * resolve `tsc` locally on the Finalize DinD runner (restricted egress) it falls
 * back to a REGISTRY install. Our own `.npmrc` network hardening
 * (`fetch-timeout=600000`, `fetch-retries=5`) then makes that fallback retry for
 * tens of minutes instead of failing fast — a hang, not an error. GitHub's open
 * egress never hits the fallback, so the two engines disagree.
 *
 * Fix + invariant guarded here: every `typecheck:*` script must invoke a
 * locally-resolved `tsc` (root `node_modules/.bin/tsc`, on PATH inside an npm
 * script) and must NEVER use `npx tsc`, so a typecheck can never reach the
 * network and can never hang on a registry install.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function rootScripts(): Record<string, string> {
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  return pkg.scripts ?? {};
}

describe('repo-root typecheck scripts are hermetic', () => {
  const scripts = rootScripts();
  const typecheckEntries = Object.entries(scripts).filter(([name]) => name.startsWith('typecheck'));

  it('has the expected set of typecheck scripts', () => {
    // Fails loudly if a new typecheck:<pkg> is added, so the author has to
    // opt it into the hermeticity guard below rather than slipping a fresh
    // `npx tsc` past CI.
    expect(
      Object.keys(scripts)
        .filter((n) => n.startsWith('typecheck:'))
        .sort(),
    ).toEqual([
      'typecheck:client',
      'typecheck:e2e',
      'typecheck:electron',
      'typecheck:mobile',
      'typecheck:server',
      'typecheck:shared',
    ]);
  });

  for (const [name, cmd] of typecheckEntries) {
    it(`${name} never uses \`npx tsc\` (registry-install hang footgun)`, () => {
      expect(
        /\bnpx\s+(?:-\S+\s+)*tsc\b/.test(cmd),
        `${name} = "${cmd}" must not run \`npx tsc\`: on a restricted-egress runner npx ` +
          `falls back to a registry install that hangs for the whole pipeline timeout. ` +
          `Use a locally-resolved \`tsc\` (e.g. \`tsc -p <dir>/tsconfig.json\`) instead.`,
      ).toBe(false);
    });
  }

  // electron/ and e2e/ have no package.json, so their typecheck runs from the
  // repo root against an explicit project file. Assert that exact hermetic
  // shape so a future edit can't reintroduce a `cd <dir> && npx tsc`.
  for (const [name, dir] of [
    ['typecheck:electron', 'electron'],
    ['typecheck:e2e', 'e2e'],
  ] as const) {
    it(`${name} typechecks ${dir}/ via a root-resolved \`tsc -p\``, () => {
      expect(scripts[name]).toBe(`tsc -p ${dir}/tsconfig.json`);
    });
  }
});
