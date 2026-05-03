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
import type { NginxFsOps, NginxRunner } from './nginx-writer.js';
import type { PrEnvConfigRow } from '../pr-env-store.js';
import type { GitHubAppConfig } from '../types.js';

/**
 * Subset of `AppConfig` that PR-env runtime cares about. We accept this
 * narrow shape (rather than `AppConfig`) so the heartbeat / webhook callers
 * can pass `{ githubApp }` without dragging the full config dependency
 * graph into a unit-test fake.
 */
export interface PrEnvAppConfigRef {
  githubApp: GitHubAppConfig | null;
}

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
  /**
   * Route53 creds for DNS-01 wildcard-cert renewal. Required when the
   * PR-env feature is on — without it, the cert can't be renewed and
   * preview envs will eventually fail TLS handshake.
   */
  route53: {
    accessKeyId: string;
    secretAccessKey: string;
    hostedZoneId: string;
  };
  /**
   * Nginx config paths. Optional with sensible Linux defaults — override
   * per deploy if the platform uses a different layout (e.g. Alpine).
   */
  nginx: {
    sitesAvailableDir: string;
    sitesEnabledDir: string;
    /** Absolute path to the fullchain wildcard cert. */
    certPath: string;
    /** Absolute path to the matching private key. */
    keyPath: string;
    /** Base hostname the wildcard covers, e.g. `preview.agenthub.dev`. */
    previewHost: string;
    /**
     * Directory acme.sh / certbot keeps its state (certs, renewal
     * configs) under. Must be writable by the server process for
     * renewal to work.
     */
    certHome: string;
  };
  /**
   * When true, the cert-renewal heartbeat will do real renewals instead
   * of dry-run. Ships dark — default dry-run-only until ops flips it.
   */
  certRenewalLive?: boolean;
  /**
   * The GitHub `owner/repo` this pool serves. Used by the reaper to
   * cross-check PR state on GitHub when a webhook drop is suspected.
   * Single-repo pools (the current default) set this once; multi-repo
   * pools would override per-slot via `getRepoForSlot` on the reaper deps.
   */
  repoFullName: string;
}

function resolvePreviewBaseUrl(
  fileBlock: Partial<PrEnvRuntimeConfig>,
  env: NodeJS.ProcessEnv,
  dbRow: PrEnvConfigRow | null,
): string {
  const url =
    env.PR_ENV_PREVIEW_BASE_URL ||
    (dbRow?.previewBaseUrl ?? '') ||
    (fileBlock.previewBaseUrl ?? '');
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
 * Merge env-var overrides + `config.json`'s `prEnv` block + DB row into a
 * typed runtime config. Returns null if the feature flag isn't on.
 *
 * Precedence (highest → lowest):
 *   1. env vars (for CI/dev overrides)
 *   2. DB row (Tier-1/Tier-2 UI-owned fields) — AUTHORITATIVE once present
 *   3. config.json `prEnv` block (legacy; preserved for pre-migration compat)
 *   4. `appConfig.githubApp` for GitHub App fields ONLY — the registered
 *      Reviewer App is reused as PR-env's webhook identity, since both
 *      need the same `pull_requests:write` / `contents:write` /
 *      `checks:write` / `statuses:write` permission set. Operators no
 *      longer need to register a second App just for PR Environments.
 *   5. built-in defaults
 *
 * Route 53 access keys are OPTIONAL: when both `accessKeyId` and
 * `secretAccessKey` are empty after the precedence above, the cert-renewal
 * client falls back to the AWS SDK's default credential chain (env →
 * shared config → IAM Role / IMDSv2 on EC2). On instances launched by the
 * `ops/terraform/` module the EC2 role already has the required Route 53
 * policy, so leaving these fields blank is the supported "let infra do
 * it" path. `hostedZoneId` is still required because the cert client
 * needs to know which zone to write the DNS-01 record into — it's a
 * routing parameter, not a credential, and is sourced from
 * `prEnv.route53.hostedZoneId` in `config.json` (Tier-3, written by
 * Terraform at first boot).
 *
 * Boolean fields (`enabled`, `certRenewalLive`) follow strict precedence
 * — not OR-composition. Once a DB row exists, its value wins over the file
 * block in both directions, so flipping the UI toggle off actually turns
 * the feature off even if the legacy file block still has `enabled: true`.
 * Env vars remain a hard override for CI/dev unlock.
 *
 * The DB row is optional — callers that don't care about UI-written values
 * can pass `dbRow = null` and behaviour falls back to the pre-UI path.
 */
export function readPrEnvConfig(
  fileConfig: Record<string, unknown> | undefined,
  env: NodeJS.ProcessEnv = process.env,
  dbRow: PrEnvConfigRow | null = null,
  appConfig: PrEnvAppConfigRef | null = null,
): PrEnvRuntimeConfig | null {
  const envFlag = env.AGENT_HUB_PR_ENV_ENABLED === 'true';
  const fileBlock = (fileConfig?.prEnv as Partial<PrEnvRuntimeConfig> | undefined) ?? {};
  // Boolean precedence: env override → DB (authoritative if row exists) → file.
  // `dbRow != null` means the UI has written at least once, so the DB value is
  // canonical — including `false`, which must be able to authoritatively
  // disable the feature even if a legacy file block still says `enabled: true`.
  const enabled = envFlag
    ? true
    : dbRow != null
      ? dbRow.enabled === true
      : fileBlock.enabled === true;
  if (!enabled) return null;

  // Helper: pick env → DB → file → fallback. Empty strings are treated as
  // "not set" so a blank UI field doesn't shadow an env-var override.
  const pick = (
    envVal: string | undefined,
    dbVal: string | undefined,
    fileVal: string | undefined,
    fallback = '',
  ): string => envVal || dbVal || fileVal || fallback;

  // GitHub App fields fall back to the registered Reviewer App
  // (`appConfig.githubApp`) when env / DB / file are all empty. Same App,
  // same permission set — no need to register a second App just for PR
  // Environments. `installationId` in `GitHubAppConfig` is `number`; coerce
  // to string here so the rest of the runtime treats it uniformly.
  const reviewerApp = appConfig?.githubApp ?? null;
  const reviewerAppInstallationId =
    reviewerApp?.installationId != null ? String(reviewerApp.installationId) : '';
  const github = {
    appId: pick(
      env.PR_ENV_GITHUB_APP_ID,
      dbRow?.githubAppId,
      fileBlock.github?.appId,
      reviewerApp?.appId ?? '',
    ),
    installationId: pick(
      env.PR_ENV_GITHUB_INSTALLATION_ID,
      dbRow?.githubInstallationId,
      fileBlock.github?.installationId,
      reviewerAppInstallationId,
    ),
    privateKey: pick(
      env.PR_ENV_GITHUB_PRIVATE_KEY,
      dbRow?.githubPrivateKey,
      fileBlock.github?.privateKey,
      reviewerApp?.privateKey ?? '',
    ),
  };

  const prodDbPath = fileBlock.prodDbPath ?? env.PR_ENV_PROD_DB ?? '';
  const prEnvDataDir = fileBlock.prEnvDataDir ?? env.PR_ENV_DATA_DIR ?? '';
  const envFilesDir = fileBlock.envFilesDir ?? env.PR_ENV_FILES_DIR ?? '';
  const repoFullName = pick(env.PR_ENV_REPO_FULL_NAME, dbRow?.repoFullName, fileBlock.repoFullName);

  const route53 = {
    accessKeyId: pick(
      env.PR_ENV_ROUTE53_ACCESS_KEY_ID,
      dbRow?.route53AccessKeyId,
      fileBlock.route53?.accessKeyId,
    ),
    secretAccessKey: pick(
      env.PR_ENV_ROUTE53_SECRET_ACCESS_KEY,
      dbRow?.route53SecretAccessKey,
      fileBlock.route53?.secretAccessKey,
    ),
    hostedZoneId: pick(
      env.PR_ENV_ROUTE53_HOSTED_ZONE_ID,
      dbRow?.route53HostedZoneId,
      fileBlock.route53?.hostedZoneId,
    ),
  };

  const nginxBlock: Partial<PrEnvRuntimeConfig['nginx']> = fileBlock.nginx ?? {};
  const nginx = {
    sitesAvailableDir:
      nginxBlock.sitesAvailableDir ??
      env.PR_ENV_NGINX_SITES_AVAILABLE ??
      '/etc/nginx/sites-available',
    sitesEnabledDir:
      nginxBlock.sitesEnabledDir ?? env.PR_ENV_NGINX_SITES_ENABLED ?? '/etc/nginx/sites-enabled',
    certPath: nginxBlock.certPath ?? env.PR_ENV_NGINX_CERT_PATH ?? '',
    keyPath: nginxBlock.keyPath ?? env.PR_ENV_NGINX_KEY_PATH ?? '',
    previewHost: pick(env.PR_ENV_PREVIEW_HOST, dbRow?.previewHost, nginxBlock.previewHost),
    certHome: nginxBlock.certHome ?? env.PR_ENV_CERT_HOME ?? '/var/lib/agent-hub/acme',
  };

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
  // Route53 access keys are intentionally optional — when both are empty
  // the cert-renewal client falls back to the AWS SDK default chain
  // (IMDSv2 on EC2). Operators running the Terraform module get the
  // correct IAM policy attached to the instance role automatically. Only
  // partial-credentials are rejected here, since "AKIA without secret"
  // would silently break in production.
  if (!!route53.accessKeyId !== !!route53.secretAccessKey) {
    missing.push(
      'PR_ENV_ROUTE53_ACCESS_KEY_ID + PR_ENV_ROUTE53_SECRET_ACCESS_KEY ' +
        '(set both, or leave both empty to use the AWS SDK default chain / IMDS)',
    );
  }
  // hostedZoneId is required regardless — it tells certbot-dns-route53
  // which zone to write the DNS-01 record into. Sourced from
  // `prEnv.route53.hostedZoneId` in `config.json` (Tier-3, written by
  // Terraform at first boot) on a default EC2 install.
  if (!route53.hostedZoneId)
    missing.push('PR_ENV_ROUTE53_HOSTED_ZONE_ID / prEnv.route53.hostedZoneId');
  if (!nginx.certPath) missing.push('PR_ENV_NGINX_CERT_PATH / prEnv.nginx.certPath');
  if (!nginx.keyPath) missing.push('PR_ENV_NGINX_KEY_PATH / prEnv.nginx.keyPath');
  if (!nginx.previewHost) missing.push('PR_ENV_PREVIEW_HOST / prEnv.nginx.previewHost');
  if (!repoFullName) missing.push('PR_ENV_REPO_FULL_NAME / prEnv.repoFullName');
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
    previewBaseUrl: resolvePreviewBaseUrl(fileBlock, env, dbRow),
    github: {
      appId: github.appId ?? '',
      installationId: github.installationId ?? '',
      privateKey: github.privateKey ?? '',
    },
    portRange: resolvePortRange(fileBlock, dbRow),
    route53,
    nginx,
    // Same env → DB → file precedence as `enabled` — see docstring above.
    certRenewalLive:
      env.PR_ENV_CERT_RENEWAL_LIVE === 'true'
        ? true
        : dbRow != null
          ? dbRow.certRenewalLive === true
          : fileBlock.certRenewalLive === true,
    repoFullName,
  };
}

/**
 * Port range precedence: DB row → file block → undefined (PortPool uses
 * its built-in default 3100–3999). Only accept both min+max together so we
 * can't end up with a half-specified range.
 */
function resolvePortRange(
  fileBlock: Partial<PrEnvRuntimeConfig>,
  dbRow: PrEnvConfigRow | null,
): { min: number; max: number } | undefined {
  if (
    dbRow &&
    typeof dbRow.portRangeMin === 'number' &&
    typeof dbRow.portRangeMax === 'number' &&
    dbRow.portRangeMin > 0 &&
    dbRow.portRangeMax >= dbRow.portRangeMin
  ) {
    return { min: dbRow.portRangeMin, max: dbRow.portRangeMax };
  }
  return fileBlock.portRange;
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

/**
 * Real filesystem adapter for the nginx writer. Uses a `tempfile + rename`
 * pattern so nginx never sees a partially-written conf file. Reads return
 * null on ENOENT so the writer can distinguish "no existing file" from
 * "permission denied".
 */
export const realNginxFsOps: NginxFsOps = {
  async readFile(p) {
    try {
      return await fsp.readFile(p, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  },
  async writeFile(p, contents) {
    // 0o644 — nginx worker must be able to read. Directory mode stays
    // platform-default (usually 0o755) because sites-available is shared
    // across the nginx install.
    await fsp.mkdir(path.dirname(p), { recursive: true });
    const tmp = `${p}.tmp-${process.pid}`;
    await fsp.writeFile(tmp, contents, { encoding: 'utf-8', mode: 0o644 });
    await fsp.rename(tmp, p);
  },
  async mkdir(p) {
    await fsp.mkdir(p, { recursive: true });
  },
  async symlinkIfAbsent(target, linkPath) {
    try {
      await fsp.symlink(target, linkPath);
    } catch (err) {
      // A pre-existing symlink to the same target is fine.
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  },
  async rm(p) {
    await fsp.rm(p, { force: true });
  },
  async readlink(p) {
    try {
      return await fsp.readlink(p);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'EINVAL') return null;
      throw err;
    }
  },
};

/**
 * Real `child_process.spawn` adapter for nginx / systemctl invocations.
 * Captures stdout + stderr so the writer can include them in error
 * messages. Never logs creds — neither `nginx -t` nor `systemctl reload
 * nginx` take sensitive args.
 */
export const realNginxRunner: NginxRunner = {
  run(command, args) {
    return new Promise((resolve, reject) => {
      const proc = spawn(command, Array.from(args), { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      proc.stdout?.on('data', () => {
        /* discarded — nginx/systemctl are quiet on stdout. */
      });
      proc.stderr?.on('data', (b) => (stderr += String(b)));
      proc.on('error', reject);
      proc.on('close', (code) => resolve({ code: code ?? -1, stderr }));
    });
  },
};

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
    nginx: {
      writer: {
        fs: realNginxFsOps,
        runner: realNginxRunner,
        sitesAvailableDir: runtimeConfig.nginx.sitesAvailableDir,
        sitesEnabledDir: runtimeConfig.nginx.sitesEnabledDir,
      },
      templateDefaults: {
        previewHost: runtimeConfig.nginx.previewHost,
        certPath: runtimeConfig.nginx.certPath,
        keyPath: runtimeConfig.nginx.keyPath,
      },
    },
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
