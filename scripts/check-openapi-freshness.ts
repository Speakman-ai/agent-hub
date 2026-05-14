#!/usr/bin/env tsx
/**
 * Verify `docs/api/openapi.yaml` is up to date with the Zod registry.
 *
 * Algorithm:
 *   1. Snapshot the committed `docs/api/openapi.yaml`.
 *   2. Run the generator (`server/openapi/generate.ts`) into a tmp file.
 *   3. Diff. Any difference means a contributor changed a schema or
 *      added a route but didn't regenerate the spec — CI must fail.
 *
 * The check exists because the spec is committed (so GitHub Pages can
 * publish it without a build step) but also auto-generated. Without this
 * gate, the committed YAML silently drifts out of sync with the registry
 * until someone notices a missing endpoint in the docs.
 *
 * Acceptance: PR changing a Zod schema without running
 * `npm run generate:openapi` fails CI here. (Card 3ed3bfc9.)
 *
 * Exit codes:
 *   0 — yaml matches the generator's output.
 *   1 — yaml is stale; contributor must run `npm run generate:openapi`.
 *   2 — script invocation error (missing files, generator crashed, etc).
 *
 * Usage:
 *   npm run check:openapi-freshness
 *   npx tsx scripts/check-openapi-freshness.ts --spec docs/api/openapi.yaml
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

interface Args {
  spec: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { spec: join(repoRoot, 'docs', 'api', 'openapi.yaml') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--spec') {
      args.spec = resolve(repoRoot, argv[++i]);
    } else if (a === '-h' || a === '--help') {
      process.stdout.write('Usage: check-openapi-freshness.ts [--spec docs/api/openapi.yaml]\n');
      process.exit(0);
    } else {
      process.stderr.write(`check-openapi-freshness: unknown argument: ${a}\n`);
      process.exit(2);
    }
  }
  return args;
}

/**
 * Run the generator into a scratch file via `npx tsx`. We deliberately
 * spawn a fresh process rather than importing generate.ts directly: the
 * generator dynamically imports every route module, which mutates a
 * singleton registry. Doing that in-process would pollute any future
 * import the test runner or watcher cares about.
 */
function regenerate(targetAbs: string): { ok: boolean; stderr: string } {
  const result = spawnSync(
    'npx',
    ['tsx', 'server/openapi/generate.ts', '--out', relative(repoRoot, targetAbs)],
    {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    },
  );
  if (result.status !== 0) {
    return {
      ok: false,
      stderr: `generator exited ${result.status}\n${result.stderr || ''}\n${result.stdout || ''}`,
    };
  }
  return { ok: true, stderr: '' };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(args.spec)) {
    process.stderr.write(`check-openapi-freshness: committed spec not found: ${args.spec}\n`);
    process.exit(2);
  }

  const committed = readFileSync(args.spec, 'utf8');
  const tmpDir = mkdtempSync(join(tmpdir(), 'openapi-fresh-'));
  const tmpFile = join(tmpDir, 'openapi.yaml');

  const gen = regenerate(tmpFile);
  if (!gen.ok) {
    process.stderr.write(`check-openapi-freshness: ${gen.stderr}\n`);
    rmSync(tmpDir, { recursive: true, force: true });
    process.exit(2);
  }
  if (!existsSync(tmpFile)) {
    process.stderr.write(`check-openapi-freshness: generator wrote nothing to ${tmpFile}\n`);
    rmSync(tmpDir, { recursive: true, force: true });
    process.exit(2);
  }
  const generated = readFileSync(tmpFile, 'utf8');
  if (generated === committed) {
    console.log(
      `OpenAPI spec OK — committed ${relative(repoRoot, args.spec)} matches the generator's output.`,
    );
    rmSync(tmpDir, { recursive: true, force: true });
    return;
  }

  console.error('');
  console.error('OpenAPI spec is STALE — committed YAML does not match the generator output.');
  console.error('');
  console.error('A Zod schema or route registration changed without regenerating the spec.');
  console.error('Run:');
  console.error('');
  console.error('    npm run generate:openapi');
  console.error('');
  console.error('and commit the updated docs/api/openapi.yaml.');
  console.error('');
  console.error(`Snapshot of generated YAML kept for inspection at ${tmpFile}`);
  // Intentionally leave tmpDir in place so CI can `cat` it / diff it.
  process.exit(1);
}

main();
