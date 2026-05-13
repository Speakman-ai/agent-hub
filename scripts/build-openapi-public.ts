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

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
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
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    out: 'docs/api/_site',
    inSpec: 'docs/api/openapi.yaml',
    inHtml: 'docs/api/index.html',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') args.out = argv[++i];
    else if (a === '--spec') args.inSpec = argv[++i];
    else if (a === '--html') args.inHtml = argv[++i];
    else if (a === '-h' || a === '--help') {
      process.stdout.write(
        'Usage: build-openapi-public.ts [--out dir] [--spec file] [--html file]\n',
      );
      process.exit(0);
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const specPath = resolve(repoRoot, args.inSpec);
const htmlPath = resolve(repoRoot, args.inHtml);
const outDir = resolve(repoRoot, args.out);

if (!existsSync(specPath)) {
  console.error(`error: spec not found at ${specPath}`);
  process.exit(1);
}
if (!existsSync(htmlPath)) {
  console.error(`error: index.html not found at ${htmlPath}`);
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
