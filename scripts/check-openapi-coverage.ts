#!/usr/bin/env tsx
/**
 * Verify every route handler in `server/routes/*.ts` has a matching
 * `registry.registerPath(...)` call (either inline or in a sibling
 * `<name>.openapi.ts` companion).
 *
 * Coverage is ratcheted: per-file `allowed_unregistered` lives in
 * `scripts/openapi-coverage-baseline.json`. Any file whose actual
 * undocumented count exceeds its baseline fails the check. Files not
 * listed in the baseline default to `allowed_unregistered: 0` — new
 * routes must come with Zod schemas.
 *
 * Exit codes:
 *   0  — every file at or below its baseline.
 *   1  — at least one file exceeded the baseline (CI must fail).
 *   2  — script invocation error (bad flag, missing files, etc).
 *
 * Usage:
 *   npm run check:openapi-coverage
 *   npx tsx scripts/check-openapi-coverage.ts --routes server/routes
 *   npx tsx scripts/check-openapi-coverage.ts --baseline path/to/baseline.json
 *   npx tsx scripts/check-openapi-coverage.ts --strict   # no allowed debt (zero tolerance)
 *
 * Side note: this script does NOT enforce that the *generated*
 * `docs/api/openapi.yaml` matches the registry — that's the second
 * acceptance criterion of card 3ed3bfc9, handled by
 * `scripts/check-openapi-freshness.ts`. Both are wired into CI.
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  analyzeFile,
  compareWithBaseline,
  type Baseline,
  type BaselineEntry,
  type CoverageVerdict,
  type FileCoverage,
} from '../server/openapi-coverage.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

interface Args {
  routesDir: string;
  baselinePath: string;
  strict: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    routesDir: join(repoRoot, 'server', 'routes'),
    baselinePath: join(repoRoot, 'scripts', 'openapi-coverage-baseline.json'),
    strict: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--routes') {
      args.routesDir = resolve(repoRoot, argv[++i]);
    } else if (a === '--baseline') {
      args.baselinePath = resolve(repoRoot, argv[++i]);
    } else if (a === '--strict') {
      args.strict = true;
    } else if (a === '-h' || a === '--help') {
      process.stdout.write(
        'Usage: check-openapi-coverage.ts [--routes DIR] [--baseline FILE] [--strict]\n',
      );
      process.exit(0);
    } else {
      process.stderr.write(`check-openapi-coverage: unknown argument: ${a}\n`);
      process.exit(2);
    }
  }
  return args;
}

/**
 * Read the JSON baseline, stripping `_comment` / `_schema` doc keys that
 * aren't actual route names. Throws on malformed JSON so CI yells loud.
 */
function loadBaseline(path: string): Baseline {
  if (!existsSync(path)) {
    return {};
  }
  const raw = readFileSync(path, 'utf8');
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const out: Baseline = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (key.startsWith('_')) continue;
    if (
      typeof value === 'object' &&
      value !== null &&
      typeof (value as BaselineEntry).allowed_unregistered === 'number'
    ) {
      out[key] = value as BaselineEntry;
    } else {
      throw new Error(
        `check-openapi-coverage: baseline entry "${key}" must be { allowed_unregistered: number, note?: string }`,
      );
    }
  }
  return out;
}

function listRouteModules(routesDir: string): string[] {
  return readdirSync(routesDir)
    .filter((n) => n.endsWith('.ts'))
    .filter((n) => !n.endsWith('.test.ts'))
    .filter((n) => !n.endsWith('.openapi.ts'))
    .filter((n) => !n.endsWith('.d.ts'))
    .map((n) => n.slice(0, -3))
    .sort();
}

function readOptional(path: string): string | null {
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf8');
}

function analyzeAll(routesDir: string): FileCoverage[] {
  const names = listRouteModules(routesDir);
  const out: FileCoverage[] = [];
  for (const name of names) {
    const routeSrc = readFileSync(join(routesDir, `${name}.ts`), 'utf8');
    const companion = readOptional(join(routesDir, `${name}.openapi.ts`));
    out.push(analyzeFile(name, routeSrc, companion));
  }
  return out;
}

/**
 * Stale baseline entries (route names listed in the baseline but with no
 * matching file on disk) usually mean a route file was deleted or
 * renamed; the entry should be removed in the same commit.
 */
function findStaleBaselineEntries(baseline: Baseline, files: FileCoverage[]): string[] {
  const known = new Set(files.map((f) => f.name));
  return Object.keys(baseline)
    .filter((name) => !known.has(name))
    .sort();
}

function fmtFile(file: FileCoverage): string {
  const companion =
    file.companionRegistrations === null ? '(none)' : String(file.companionRegistrations);
  return (
    `${file.name.padEnd(22)} handlers=${String(file.handlers).padStart(3)}  ` +
    `inline=${String(file.inlineRegistrations).padStart(3)}  ` +
    `companion=${companion.padStart(6)}  ` +
    `unregistered=${String(file.unregistered).padStart(3)}`
  );
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(args.routesDir)) {
    process.stderr.write(`check-openapi-coverage: routes dir not found: ${args.routesDir}\n`);
    process.exit(2);
  }

  let baseline: Baseline;
  try {
    baseline = args.strict ? {} : loadBaseline(args.baselinePath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${msg}\n`);
    process.exit(2);
  }

  const files = analyzeAll(args.routesDir);
  const verdicts: CoverageVerdict[] = files.map((f) => compareWithBaseline(f, baseline));

  const failures = verdicts.filter(
    (v): v is Extract<CoverageVerdict, { kind: 'fail' }> => v.kind === 'fail',
  );
  const slacks = verdicts.filter(
    (v): v is Extract<CoverageVerdict, { kind: 'slack' }> => v.kind === 'slack',
  );
  const stale = findStaleBaselineEntries(baseline, files);

  console.log('Per-file coverage:');
  for (const v of verdicts) {
    const marker = v.kind === 'fail' ? 'FAIL' : v.kind === 'slack' ? 'SLACK' : 'OK';
    console.log(`  [${marker.padEnd(5)}] ${fmtFile(v.file)}  allowed=${v.allowed}`);
  }

  if (failures.length > 0) {
    console.log('');
    console.log(
      `OpenAPI coverage check FAILED — ${failures.length} file(s) exceed their baseline:`,
    );
    for (const v of failures) {
      console.log(
        `  - ${v.file.name}: ${v.file.unregistered} undocumented handler(s), baseline allows ${v.allowed} (over by ${v.overflow})`,
      );
    }
    console.log('');
    console.log('Fix one of:');
    console.log('  1. Add registry.registerPath(...) for each new handler (preferred).');
    console.log(
      '  2. If the route truly has no schema (legacy / compat / experimental), raise the',
    );
    console.log(
      '     baseline in scripts/openapi-coverage-baseline.json and explain why in `note`.',
    );
    console.log('     Reviewers will scrutinize baseline bumps closely.');
    console.log('');
    console.log('See CLAUDE.md \u00a7 "OpenAPI Schema Coverage" and the wiki page');
    console.log('  "openapi-coverage-enforcement-zod-schema-lint".');
  }

  if (slacks.length > 0) {
    console.log('');
    console.log('Files now BELOW their baseline — please ratchet down before merging:');
    const suggestion: Record<string, BaselineEntry> = {};
    for (const v of slacks) {
      console.log(
        `  - ${v.file.name}: unregistered=${v.file.unregistered}, baseline=${v.allowed} (surplus ${v.surplus})`,
      );
      const existing = baseline[v.file.name];
      if (v.file.unregistered > 0) {
        suggestion[v.file.name] = {
          allowed_unregistered: v.file.unregistered,
          ...(existing?.note ? { note: existing.note } : {}),
        };
      }
    }
    console.log('');
    console.log('Suggested baseline patch (remove files dropped to 0; lower the others):');
    console.log(JSON.stringify(suggestion, null, 2));
  }

  if (stale.length > 0) {
    console.log('');
    console.log(`Stale baseline entries (no matching server/routes/*.ts file):`);
    for (const name of stale) {
      console.log(`  - ${name}`);
    }
    console.log('Remove these from scripts/openapi-coverage-baseline.json.');
  }

  const hardFail = failures.length > 0 || stale.length > 0;
  if (hardFail) {
    process.exit(1);
  }

  console.log('');
  console.log(`OpenAPI coverage OK — ${files.length} route module(s) scanned, no regressions.`);
}

main();
