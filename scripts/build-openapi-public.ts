#!/usr/bin/env tsx
/**
 * Build the public-facing OpenAPI bundle for GitHub Pages.
 *
 * Reads `docs/api/openapi.yaml`, strips every operation flagged
 * `x-internal: true` (see `server/openapi-filter.ts`), and writes the
 * filtered spec + the Redoc shell to an output directory ready for
 * `actions/upload-pages-artifact@v3`.
 *
 * Usage:
 *   npx tsx scripts/build-openapi-public.ts             # writes to docs/api/_site
 *   npx tsx scripts/build-openapi-public.ts --out dist  # custom output dir
 *
 * The filter logic lives in `server/openapi-filter.ts` (testable, no I/O).
 * This script is the thin CLI shim that handles YAML parsing + file I/O so
 * the workflow has a single entry point.
 */

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { filterInternalOperations } from '../server/openapi-filter.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

interface Args {
  out: string;
  inSpec: string;
  inHtml: string;
  outExplicit: boolean;
  specExplicit: boolean;
  htmlExplicit: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    out: 'docs/api/_site',
    inSpec: 'docs/api/openapi.yaml',
    inHtml: 'docs/api/index.html',
    outExplicit: false,
    specExplicit: false,
    htmlExplicit: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') {
      args.out = argv[++i];
      args.outExplicit = true;
    } else if (a === '--spec') {
      args.inSpec = argv[++i];
      args.specExplicit = true;
    } else if (a === '--html') {
      args.inHtml = argv[++i];
      args.htmlExplicit = true;
    } else if (a === '-h' || a === '--help') {
      process.stdout.write(
        'Usage: build-openapi-public.ts [--out dir] [--spec file] [--html file]\n',
      );
      process.exit(0);
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

// Defaults are anchored to the repo root so the script works no matter
// where it's invoked from. Explicit args follow normal POSIX CLI behavior
// and resolve against the user's current working directory.
function anchor(value: string, explicit: boolean): string {
  return explicit ? resolve(process.cwd(), value) : resolve(repoRoot, value);
}

const specPath = anchor(args.inSpec, args.specExplicit);
const htmlPath = anchor(args.inHtml, args.htmlExplicit);
const outDir = anchor(args.out, args.outExplicit);

if (!existsSync(specPath)) {
  console.error(`error: spec not found at ${specPath}`);
  process.exit(1);
}
if (!existsSync(htmlPath) || !statSync(htmlPath).isFile()) {
  console.error(`error: index.html not found or is not a file at ${htmlPath}`);
  process.exit(1);
}

const rawYaml = readFileSync(specPath, 'utf8');
const parsed = parseYaml(rawYaml);
if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
  console.error('error: openapi.yaml did not parse to a YAML mapping');
  process.exit(1);
}

const { spec: filtered, removedOperations, removedPaths } = filterInternalOperations(parsed);
console.log(
  `filter: removed ${removedOperations} operation(s) across ${removedPaths} path entry(ies) flagged x-internal`,
);

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'openapi.yaml'), stringifyYaml(filtered), 'utf8');
copyFileSync(htmlPath, join(outDir, 'index.html'));

console.log(`wrote ${join(outDir, 'openapi.yaml')}`);
console.log(`wrote ${join(outDir, 'index.html')}`);
