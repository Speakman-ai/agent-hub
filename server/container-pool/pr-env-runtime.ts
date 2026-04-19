/**
 * Production adapters for the PR-env builder (W2).
 *
 * The builder itself (pr-env-builder.ts) accepts injected `ComposeRunner`
 * and `FsOps`; tests pass in in-memory fakes. This file wires up the real
 * implementations that run against the host's Docker daemon and
 * filesystem, plus a memoised factory that lazily constructs the
 * `PrEnvBuilderDeps` bundle the webhook handler calls into.
 *
 * Everything is gated behind the feature flag `PR_ENV_BUILDS_ENABLED`
 * (either the `AGENT_HUB_PR_ENV_ENABLED=true` env var or a `prEnv.enabled`
 * field in `config.json`). When disabled, `getPrEnvBuilderDeps()` returns
 * null and the webhook hook becomes a no-op — we don't want an
 * uninstalled compose binary to crash the server on every PR event.
 */

import { promises as fsp } from 'fs';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { buildPrEnvFile } from './env-template.js';
import { PortPool, PORT_POOL_SCHEMA } from './port-pool.js';
import type { ComposeRunner, FsOps, PrEnvBuilderDeps } from './pr-env-builder.js';

// ─── Shared runtime config ────────────────────────────────────────────────

export interface PrEnvRuntimeConfig {
  enabled: boolean;
  prodDbPath: string;
  prEnvDataDir: string;
  envFilesDir: string;
  composeTemplatePath: string;
  previewBaseUrl: string;
  github: {
    appId: string;
    installationId: string;
    privateKey: string;
  };
  portRange?: { min: number; max: number };
}

function resolvePreviewBaseUrl(
  fileBlock: Partial<PrEnvRuntimeConfig>,
  env: NodeJS.ProcessEnv,
): string {
  const url = fileBlock.previewBaseUrl ?? env.PR_ENV_PREVIEW_BASE_URL ?? '';
  if (!url) {
    console.warn(
      '[pr-env] PR_ENV_PREVIEW_BASE_URL / prEnv.previewBaseUrl is unset — ' +
        'preview URLs will point at http://localhost which is almost certainly wrong. ' +
        'Set an explicit base URL before enabling the feature.',
    );
    return 'http://localhost';
  }
  return url;
}

/**
 * Merge env-var overrides + `config.json`'s `prEnv` block into a typed
 * runtime config. Returns null if the feature flag isn't on.
 */
export function readPrEnvConfig(
  fileConfig: Record<string, unknown> | undefined,
  env: NodeJS.ProcessEnv = process.env,
): PrEnvRuntimeConfig | null {
  const envFlag = env.AGENT_HUB_PR_ENV_ENABLED === 'true';
  const fileBlock = (fileConfig?.prEnv as Partial<PrEnvRuntimeConfig> | undefined) ?? {};
  const enabled = envFlag || fileBlock.enabled === true;
  if (!enabled) return null;

  const github = fileBlock.github ?? {
    appId: env.PR_ENV_GITHUB_APP_ID ?? '',
    installationId: env.PR_ENV_GITHUB_INSTALLATION_ID ?? '',
    privateKey: env.PR_ENV_GITHUB_PRIVATE_KEY ?? '',
  };

  const prodDbPath = fileBlock.prodDbPath ?? env.PR_ENV_PROD_DB ?? '';
  const prEnvDataDir = fileBlock.prEnvDataDir ?? env.PR_ENV_DATA_DIR ?? '';
  const envFilesDir = fileBlock.envFilesDir ?? env.PR_ENV_FILES_DIR ?? '';

  // Fail fast: if the feature is on but required paths are missing, the
  // first webhook event would fail deep inside fs.copyFile('', …) with a
  // cryptic error. Surface the misconfiguration at config-read time.
  const missing: string[] = [];
  if (!prodDbPath) missing.push('PR_ENV_PROD_DB / prEnv.prodDbPath');
  if (!prEnvDataDir) missing.push('PR_ENV_DATA_DIR / prEnv.prEnvDataDir');
  if (!envFilesDir) missing.push('PR_ENV_FILES_DIR / prEnv.envFilesDir');
  if (!github.appId) missing.push('PR_ENV_GITHUB_APP_ID / prEnv.github.appId');
  if (!github.installationId)
    missing.push('PR_ENV_GITHUB_INSTALLATION_ID / prEnv.github.installationId');
  if (!github.privateKey) missing.push('PR_ENV_GITHUB_PRIVATE_KEY / prEnv.github.privateKey');
  if (missing.length > 0) {
    throw new Error(
      `AGENT_HUB_PR_ENV_ENABLED=true but required config is unset: ${missing.join(', ')}`,
    );
  }

  return {
    enabled: true,
    prodDbPath,
    prEnvDataDir,
    envFilesDir,
    composeTemplatePath:
      fileBlock.composeTemplatePath ??
      env.PR_ENV_COMPOSE_TEMPLATE ??
      path.resolve(
        // Default ships with the repo: server/container-pool/templates/pr-env.compose.yml
        path.dirname(fileURLToPath(import.meta.url)),
        'templates',
        'pr-env.compose.yml',
      ),
    previewBaseUrl: resolvePreviewBaseUrl(fileBlock, env),
    github: {
      appId: github.appId ?? '',
      installationId: github.installationId ?? '',
      privateKey: github.privateKey ?? '',
    },
    portRange: fileBlock.portRange,
  };
}

// ─── Production adapters ──────────────────────────────────────────────────

/**
 * Real filesystem ops. `rm` swallows ENOENT so rollback can be called
 * on partially-built envs without tripping over the files that never
 * got created.
 */
export const realFsOps: FsOps = {
  async copyFile(src, dest) {
    await fsp.mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
    await fsp.copyFile(src, dest);
    // DB copy contains prod session data — restrict to owner-only.
    await fsp.chmod(dest, 0o600);
  },
  async writeFile(dest, contents) {
    await fsp.mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
    await fsp.writeFile(dest, contents, { encoding: 'utf-8', mode: 0o600 });
  },
  async rm(target) {
    // `force: true` already suppresses ENOENT. Other errors bubble up and
    // get logged by the rollback layer; we don't want to swallow them
    // here in case a permissions bug is causing the cleanup to silently
    // leak files.
    await fsp.rm(target, { force: true });
  },
};

/**
 * `docker compose` via child_process. `projectName` becomes
 * `--project-name` so concurrent PR envs get their own namespace
 * (containers, networks, volumes).
 */
export const dockerComposeRunner: ComposeRunner = {
  async up({ templatePath, envFilePath, projectName }) {
    await runDockerCompose([
      '--project-name',
      projectName,
      '--file',
      templatePath,
      '--env-file',
      envFilePath,
      'up',
      '--detach',
      '--remove-orphans',
    ]);
    return { containerId: undefined };
  },
  async down({ templatePath, envFilePath, projectName }) {
    await runDockerCompose([
      '--project-name',
      projectName,
      '--file',
      templatePath,
      '--env-file',
      envFilePath,
      'down',
      '--remove-orphans',
      '--volumes',
    ]);
  },
};

function runDockerCompose(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('docker', ['compose', ...args], { stdio: 'pipe' });
    let stderr = '';
    proc.stderr?.on('data', (b) => (stderr += String(b)));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else
        reject(new Error(`docker compose ${args.join(' ')} failed with code ${code}: ${stderr}`));
    });
  });
}

// ─── Memoised PrEnvBuilderDeps factory ─────────────────────────────────────

// Singleton — intentionally never re-reads config after first construction.
// Config changes require a server restart.
let cached: PrEnvBuilderDeps | null = null;

/**
 * Returns the singleton PrEnvBuilderDeps, or null if the feature is
 * disabled / misconfigured. The webhook handler calls this per event;
 * the first call constructs the deps, later calls reuse the cache.
 */
export function getPrEnvBuilderDeps(
  runtimeConfig: PrEnvRuntimeConfig | null,
  db: Database.Database,
): PrEnvBuilderDeps | null {
  if (!runtimeConfig) return null;
  if (cached) return cached;

  // Apply the port-pool schema here so `db.ts` doesn't have to know about
  // it — keeps the container-pool subsystem self-contained.
  db.exec(PORT_POOL_SCHEMA);

  const portPool = new PortPool(db, { range: runtimeConfig.portRange });
  cached = {
    portPool,
    compose: dockerComposeRunner,
    fs: realFsOps,
    github: runtimeConfig.github,
    paths: {
      prodDbPath: runtimeConfig.prodDbPath,
      prEnvDataDir: runtimeConfig.prEnvDataDir,
      envFilesDir: runtimeConfig.envFilesDir,
      composeTemplatePath: runtimeConfig.composeTemplatePath,
    },
    previewBaseUrl: runtimeConfig.previewBaseUrl,
    renderEnvFile: buildPrEnvFile,
  };
  return cached;
}

/**
 * Test hook — reset the memoised deps so a fresh config can be threaded
 * through. Exported only for the unit tests; not used in production.
 */
export function __resetPrEnvBuilderDepsForTests(): void {
  cached = null;
}
