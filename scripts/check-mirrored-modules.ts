#!/usr/bin/env tsx
/**
 * Fail when `client/src/<scope>/X.ts` and `mobile/src/<scope>/X.ts` both exist.
 *
 * A shared basename across the two clients means one module was typed twice.
 * SPEC-3 moved pure logic to `shared/` with the platform seam injected and made
 * this check part of that decision, because without enforcement the mirroring
 * grows back (48 of 50 pairs had already drifted when the spec was written).
 *
 * Ratcheted in both directions against `scripts/mirrored-modules-baseline.json`:
 * a pair missing from the baseline fails (new mirroring), and a baseline entry
 * with no pair on disk also fails (the baseline must shrink as modules migrate).
 *
 * Exit codes:
 *   0 — on-disk pairs exactly match the baseline.
 *   1 — new mirroring, or a stale baseline entry (CI must fail).
 *   2 — script invocation error (bad flag, missing directory).
 *
 * Usage:
 *   npm run check:mirrored-modules
 *   npx tsx scripts/check-mirrored-modules.ts --write   # rewrite the baseline
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  compareWithBaseline,
  fromBaselineShape,
  mirroredBasenames,
  toBaselineShape,
  type MirroredPair,
  type ScanScope,
} from '../server/mirrored-modules.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

const SCOPES: ScanScope[] = [
  { id: 'utils', clientDir: 'client/src/utils', mobileDir: 'mobile/src/utils' },
  { id: 'hooks', clientDir: 'client/src/hooks', mobileDir: 'mobile/src/hooks' },
];

const BASELINE_PATH = join(repoRoot, 'scripts', 'mirrored-modules-baseline.json');

const BASELINE_DOC = [
  'Mirrored client/mobile modules that predate SPEC-3. Every entry is a module',
  'implemented twice; the fix is to move the pure logic into shared/ and inject',
  'the platform seam. This list may only shrink: scripts/check-mirrored-modules.ts',
  'fails on a pair that is not listed AND on a listed pair that no longer exists.',
];

function listDir(rel: string): string[] {
  const abs = join(repoRoot, rel);
  if (!existsSync(abs)) {
    process.stderr.write(`check-mirrored-modules: directory not found: ${rel}\n`);
    process.exit(2);
  }
  return readdirSync(abs);
}

function scanCurrent(): MirroredPair[] {
  const out: MirroredPair[] = [];
  for (const scope of SCOPES) {
    for (const basename of mirroredBasenames(listDir(scope.clientDir), listDir(scope.mobileDir))) {
      out.push({ scope: scope.id, basename });
    }
  }
  return out;
}

function loadBaseline(): MirroredPair[] {
  if (!existsSync(BASELINE_PATH)) return [];
  return fromBaselineShape(JSON.parse(readFileSync(BASELINE_PATH, 'utf8')));
}

function writeBaseline(pairs: readonly MirroredPair[]): void {
  const body = { _comment: BASELINE_DOC, ...toBaselineShape(pairs) };
  writeFileSync(BASELINE_PATH, `${JSON.stringify(body, null, 2)}\n`);
}

function dirFor(scopeId: string, side: 'clientDir' | 'mobileDir'): string {
  return SCOPES.find((s) => s.id === scopeId)?.[side] ?? scopeId;
}

function main(): void {
  const argv = process.argv.slice(2);
  const write = argv.includes('--write');
  for (const a of argv) {
    if (a !== '--write') {
      process.stderr.write(`check-mirrored-modules: unknown argument: ${a}\n`);
      process.exit(2);
    }
  }

  const current = scanCurrent();

  if (write) {
    writeBaseline(current);
    console.log(
      `Wrote ${current.length} mirrored pair(s) to scripts/mirrored-modules-baseline.json`,
    );
    return;
  }

  let baseline: MirroredPair[];
  try {
    baseline = loadBaseline();
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  }

  const verdict = compareWithBaseline(current, baseline);

  if (verdict.added.length > 0) {
    console.log('New mirrored client/mobile modules — these must not be added:');
    for (const p of verdict.added) {
      console.log(`  - ${dirFor(p.scope, 'clientDir')}/${p.basename}.ts`);
      console.log(`    ${dirFor(p.scope, 'mobileDir')}/${p.basename}.ts`);
    }
    console.log('');
    console.log('Move the pure logic to shared/ and import it from both clients:');
    console.log('  shared/utils/<name>.ts   →  import from "@shared/utils/<name>"');
    console.log('Inject the platform seam (WS URL, API base, styling) as a parameter');
    console.log('instead of forking the module. See CLAUDE.md and SPEC-3.');
  }

  if (verdict.stale.length > 0) {
    if (verdict.added.length > 0) console.log('');
    console.log('Baseline entries with no mirrored pair on disk — ratchet the baseline down:');
    for (const p of verdict.stale) {
      console.log(`  - ${p.scope}/${p.basename}`);
    }
    console.log('');
    console.log('Run: npx tsx scripts/check-mirrored-modules.ts --write');
  }

  if (verdict.added.length > 0 || verdict.stale.length > 0) {
    process.exit(1);
  }

  console.log(
    `Mirrored-module check OK — ${verdict.current.length} known pair(s), no new mirroring.`,
  );
}

main();
