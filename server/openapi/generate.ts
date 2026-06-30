#!/usr/bin/env tsx
/**
 * Generate the canonical OpenAPI spec from the Zod schemas registered by
 * route modules.
 *
 * Pipeline:
 *
 *   route files (side-effect registerPath / registerComponent calls)
 *           │
 *           ▼
 *   server/openapi/registry.ts ← singleton OpenAPIRegistry
 *           │
 *           ▼
 *   this script — collect, serialize as YAML, write to docs/api/openapi.yaml
 *           │
 *           ▼
 *   .github/workflows/api-docs.yml — runs `npm run generate:openapi`,
 *   then `scripts/build-openapi-public.ts` strips `x-internal: true`
 *   operations and assembles the Redoc bundle for GitHub Pages.
 *
 * Usage:
 *
 *   npm run generate:openapi                    # writes docs/api/openapi.yaml
 *   npx tsx server/openapi/generate.ts --out custom.yaml
 *
 * The legacy hand-curated spec is gone — this generator is now the
 * single source of truth. The first wave of route-group migration cards
 * will fill the registry; until then the emitted document is a stub
 * with only the info / servers / security-scheme metadata.
 */

import { readdirSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stringify as stringifyYaml } from 'yaml';

import { OpenApiGeneratorV3 } from '@asteasolutions/zod-to-openapi';

import { registry, registerSecurityScheme } from './registry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverRoot = resolve(__dirname, '..');
const repoRoot = resolve(serverRoot, '..');

interface Args {
  out: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { out: 'docs/api/openapi.yaml' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') {
      args.out = argv[++i];
    } else if (a === '-h' || a === '--help') {
      process.stdout.write('Usage: generate.ts [--out path]\n');
      process.exit(0);
    }
  }
  return args;
}

/**
 * Read the root `package.json` so the spec version stays in lock-step
 * with the published app version. We read it as JSON (rather than import
 * assertions) so the script works under both TS and packaged builds.
 */
function readPackageVersion(): string {
  const pkgPath = join(repoRoot, 'package.json');
  const raw = readFileSync(pkgPath, 'utf8');
  const pkg = JSON.parse(raw) as { version?: string };
  if (!pkg.version) {
    throw new Error(`generate-openapi: no "version" in ${pkgPath}`);
  }
  return pkg.version;
}

/**
 * Walk `server/routes/` and import every route module so its top-level
 * `registerPath` / `registerComponent` calls run. We deliberately import
 * dynamically by file URL — static imports would require this file to
 * change every time a new route file lands.
 *
 * Test files (`*.test.ts`) and type-only declaration files (`*.d.ts`) are
 * skipped. The list is sorted so the registration order is deterministic
 * (this affects the order of `paths:` entries in the emitted YAML).
 */
async function loadRouteModules(): Promise<string[]> {
  const routesDir = join(serverRoot, 'routes');
  const loaded: string[] = [];
  const failures: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(routesDir);
  } catch {
    console.warn(`generate-openapi: routes dir not found at ${routesDir} — skipping`);
    return loaded;
  }
  const routeFiles = entries
    .filter((name) => name.endsWith('.ts'))
    .filter((name) => !name.endsWith('.test.ts'))
    .filter((name) => !name.endsWith('.d.ts'))
    .sort();
  for (const name of routeFiles) {
    const full = join(routesDir, name);
    try {
      await import(pathToFileURL(full).href);
      loaded.push(basename(name, '.ts'));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failures.push(`${full}: ${msg}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(
      [
        `failed to import ${failures.length} route module(s); refusing to emit a partial OpenAPI spec`,
        ...failures.map((failure) => `  - ${failure}`),
      ].join('\n'),
    );
  }
  return loaded;
}

/**
 * Register the security schemes referenced from `security` in the doc
 * envelope. Keeping these in the generator (rather than scattered across
 * route files) avoids the "who owns the bearerAuth scheme?" question.
 */
function registerBaseSecuritySchemes(): void {
  registerSecurityScheme('bearerAuth', {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'ahub_...',
    description:
      'User-owned API key minted via `POST /api/auth/keys`. Send as `Authorization: Bearer ahub_...`.',
  });
  registerSecurityScheme('apiKeyHeader', {
    type: 'apiKey',
    in: 'header',
    name: 'X-API-Key',
    description:
      'Either a per-user `ahub_*` key or the break-glass instance API key from `~/.agent-hub/data/config.json` (`apiKey`).',
  });
  registerSecurityScheme('cookieAuth', {
    type: 'apiKey',
    in: 'cookie',
    name: 'agent_hub_session',
    description: 'Session cookie issued by `POST /api/auth/login`.',
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const version = readPackageVersion();

  registerBaseSecuritySchemes();
  const loaded = await loadRouteModules();

  const generator = new OpenApiGeneratorV3(registry.definitions);
  const document = generator.generateDocument({
    openapi: '3.0.3',
    info: {
      title: 'Agent Hub REST API',
      version,
      description: [
        'REST API for **Agent Hub** — a full-stack platform for managing AI',
        'agent sessions, kanban boards, per-project wikis, heartbeats, and',
        'cron jobs.',
        '',
        '### Authentication',
        'Most endpoints require one of:',
        '- A session cookie issued by `POST /api/auth/login`.',
        '- A user-owned API key minted via `POST /api/auth/keys`, sent as',
        '  `Authorization: Bearer ahub_…` or `X-API-Key: ahub_…`.',
        '- The break-glass instance API key (`X-API-Key`), set via',
        '  `~/.agent-hub/data/config.json` `apiKey`. Treated as Owner across',
        '  every org — use only for automation / sub-agent spawn.',
        '',
        '### Realtime',
        'Live updates (chat streaming, kanban / wiki events, cron output)',
        'are delivered over WebSocket on the same port as HTTP. This',
        'document covers the REST surface only.',
      ].join('\n'),
      contact: {
        name: 'Agent Hub',
        url: 'https://github.com/Speakman-ai/agent-hub',
      },
      license: { name: 'Proprietary' },
    },
    servers: [
      { url: 'http://localhost:3051', description: 'Local development server' },
      {
        url: 'https://hub.example.com',
        description: 'Self-hosted production deployment (operator-defined)',
      },
    ],
    security: [{ bearerAuth: [] }, { apiKeyHeader: [] }, { cookieAuth: [] }],
    tags: [
      { name: 'Health', description: 'Liveness and runtime info.' },
      { name: 'Auth', description: 'Sign-in, API keys, per-user credential management.' },
      { name: 'Google', description: 'Per-user Google Workspace proxy endpoints.' },
      { name: 'Projects', description: 'Project CRUD and metadata.' },
      { name: 'Agents', description: 'Agent configuration under a project.' },
      { name: 'Sessions', description: 'Chat sessions and message history.' },
      {
        name: 'Board',
        description: 'Per-project kanban boards (columns, cards, epics, comments).',
      },
      { name: 'Wiki', description: 'Per-project wiki with FTS5 + semantic search.' },
      { name: 'Heartbeats', description: 'Per-agent scheduled check-ins.' },
      { name: 'Crons', description: 'Project-scoped automated jobs.' },
      { name: 'Admin', description: 'Owner-only administrative endpoints.' },
    ],
  });

  // OpenAPI 3.0 requires a `paths` object. zod-to-openapi happily emits
  // `paths: undefined` when no routes have registered — coerce to an
  // empty object so the document validates.
  if (!document.paths) {
    document.paths = {};
  }

  const yaml = stringifyYaml(document, { lineWidth: 0 });
  const outAbs = resolve(repoRoot, args.out);
  mkdirSync(dirname(outAbs), { recursive: true });
  writeFileSync(outAbs, yaml, 'utf8');

  const pathCount = Object.keys(document.paths ?? {}).length;
  const schemaCount = Object.keys(document.components?.schemas ?? {}).length;
  console.log(
    `generate-openapi: wrote ${outAbs} (version ${version}, ${pathCount} path(s), ${schemaCount} schema(s), ${loaded.length} route module(s) loaded)`,
  );
}

main().catch((err) => {
  console.error('generate-openapi: failed');
  console.error(err);
  process.exit(1);
});
