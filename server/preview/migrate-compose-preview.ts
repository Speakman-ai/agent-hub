/**
 * Migration mapping: legacy compose app-wrapping preview → managed dev-server.
 *
 * The 2026-05 Compose Pivot ran the WHOLE app (frontend + backing services)
 * inside a per-session `docker compose` project, exposing the entry service's
 * port to the preview iframe. The dev-server pivot reverses the app-wrapping
 * half: the app now runs as a managed long-lived host process
 * (`startCommand`), and `docker compose` is kept ONLY for the project's own
 * backing services (Postgres, Redis, Mailhog, …).
 *
 * This module turns an existing {@link PreviewComposeConfig} into the
 * equivalent {@link DevServerConfig} plus a human-readable migration plan:
 *
 *   - `startCommand` runs `docker compose up -d --wait` for the backing
 *     services, then the app's dev command on the host.
 *   - the entry service's `entryPort` becomes the primary `portMap` entry.
 *   - `healthPath` / `readyTimeoutMs` carry over unchanged.
 *   - compose live-mount fields (`entryWorkdir` / `shadowDirs`) and the
 *     compose `envFile` become follow-up warnings, because the host process
 *     reads the worktree directly and does not consume compose's env-file.
 *
 * The function is pure — no disk / network — so it drives both the per-project
 * migration-plan endpoint and the setup-wizard skill. Because we can't read
 * the compose file's service list from the config alone, the caller may pass
 * the backing-service names (`opts.services`) and the real app dev command
 * (`opts.appDevCommand`); both fall back to safe defaults with a warning.
 */
import {
  DEV_SERVER_DEFAULT_START_COMMAND,
  parseDevServerConfig,
  type DevServerConfig,
} from '../dev-server-config.js';
import type { PreviewComposeConfig } from '../types.js';

/** Default compose file name when `PreviewComposeConfig.file` is unset. */
export const DEFAULT_COMPOSE_FILE = 'docker-compose.yml';

export interface ComposePreviewMigrationOptions {
  /**
   * Command that starts the app dev server on the host, appended after the
   * `docker compose up -d` for backing services. Defaults to
   * {@link DEV_SERVER_DEFAULT_START_COMMAND} (`npm run dev`) with a warning —
   * the migrated app rarely ran `npm run dev` verbatim inside compose.
   */
  appDevCommand?: string;
  /**
   * Backing-service names to bring up (everything in the compose file that
   * ISN'T the entry service). When provided the generated `startCommand`
   * lists them explicitly, so the entry service can stay declared in the
   * compose file without double-starting. The entry service is always
   * filtered out of this list (with a warning) — it now runs as the host dev
   * server, so listing it would double-start the app. When the list is empty
   * (or omitted), the command falls back to `up -d --wait --scale <app>=0` —
   * every OTHER service starts but the app stays off — plus a warning nudging
   * the operator toward an explicit list or removing the app service.
   */
  services?: string[];
}

export interface ComposePreviewMigrationPlan {
  /** Normalized, validated dev-server config ready to persist under `prEnv.devServer`. */
  devServer: DevServerConfig;
  /** The generated `startCommand` (also present on `devServer`), surfaced for docs/UI. */
  startCommand: string;
  /** Per-project follow-ups the operator must resolve by hand. */
  warnings: string[];
}

/** Shell-quote a token for a POSIX `sh -c` command line (single-quote wrap). */
function shQuote(value: string): string {
  // Only quote when the token contains something the shell would treat
  // specially — keeps the common `docker-compose.yml` / service-name case
  // readable in the generated command and in per-project docs.
  if (/^[A-Za-z0-9._/-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface ComposeServicesUpOptions {
  /**
   * Explicit backing-service names to bring up positionally. When non-empty,
   * `up -d` starts exactly these plus their dependencies (the precise form).
   */
  services?: string[];
  /**
   * The app/entry service that must NOT start (it now runs as the host dev
   * server). Always emitted as `--scale <svc>=0`, in BOTH forms:
   *   - with no positional `services`, it turns a bare `up -d` into "every
   *     other service, app at 0 replicas";
   *   - with positional `services`, it defends against the app being pulled in
   *     as a `depends_on` dependency of a listed service — the scale override
   *     applies even to dependency-resolved services, so the app stays off.
   */
  excludeService?: string;
  /**
   * Relative prefix prepended to `compose.file` and `compose.envFile` so they
   * resolve when the command runs from a monorepo subdirectory (`devServer.cwd`)
   * rather than the worktree root — e.g. `../../` for `cwd = apps/web`. The
   * compose paths are documented as worktree-root-relative, so without this the
   * process (running from the subdir) can't find the root compose file.
   */
  filePathPrefix?: string;
}

/**
 * Build the `docker compose up -d` prefix for the backing services.
 *
 * Always safe against double-starting the app: when `excludeService` is set it
 * emits `--scale <app>=0` in every form, so neither a bare `up -d` (all
 * services) nor an explicit `up -d db` (which resolves `db`'s `depends_on`) can
 * launch the app service. Positional `services`, when given, still scope which
 * services (and their deps) come up.
 *
 * With no `excludeService` it falls back to a plain `up -d --wait [services…]`
 * — only for direct callers that have already ensured the file has no app
 * service.
 *
 * Exposed for tests and for the wizard's per-service preview.
 */
export function buildComposeServicesUpCommand(
  compose: Pick<PreviewComposeConfig, 'file' | 'envFile'>,
  optsOrServices?: string[] | ComposeServicesUpOptions,
): string {
  const opts: ComposeServicesUpOptions = Array.isArray(optsOrServices)
    ? { services: optsOrServices }
    : (optsOrServices ?? {});
  const prefix = opts.filePathPrefix ?? '';
  const file = prefix + (compose.file?.trim() || DEFAULT_COMPOSE_FILE);
  const parts = ['docker', 'compose', '-f', shQuote(file)];
  const envFile = compose.envFile?.trim();
  if (envFile) parts.push('--env-file', shQuote(prefix + envFile));
  parts.push('up', '-d', '--wait');
  // `--scale <app>=0` guards BOTH the default (all-services) and explicit
  // (services + their depends_on) forms against launching the app service.
  const exclude = opts.excludeService?.trim();
  if (exclude) parts.push('--scale', `${shQuote(exclude)}=0`);
  const svc = (opts.services ?? []).map((s) => s.trim()).filter((s) => s.length > 0);
  for (const s of svc) parts.push(shQuote(s));
  return parts.join(' ');
}

/**
 * Map a legacy {@link PreviewComposeConfig} to a {@link DevServerConfig} plus
 * a migration plan (see module doc). Throws only on a programmer error (the
 * generated config failing its own validator, which shouldn't happen for an
 * already-validated compose config).
 */
export function migrateComposePreviewToDevServer(
  compose: PreviewComposeConfig,
  opts: ComposePreviewMigrationOptions = {},
): ComposePreviewMigrationPlan {
  const warnings: string[] = [];

  const label = compose.entryService.trim() || 'app';

  // The entry service now runs as the host dev server, NOT as a compose
  // service — so it must never appear in the backing-services `up -d` list, or
  // the command would start the legacy app service AND the host dev server
  // (the exact double-start this migration prevents). Filter it out and warn.
  const requestedServices = (opts.services ?? []).map((s) => s.trim()).filter((s) => s.length > 0);
  const backingServices = requestedServices.filter((s) => s !== label);
  const entryServiceWasRequested = requestedServices.length !== backingServices.length;

  // A monorepo build context (`entrySourceDir`) is the closest analogue to the
  // dev-server `cwd` — the subdir the app's package.json lives in. When set, the
  // managed process runs the whole `startCommand` from that subdir, so the
  // worktree-root-relative compose paths must be lifted back up to the root
  // with a `../` prefix or `docker compose -f docker-compose.yml` won't resolve.
  const sourceDir = compose.entrySourceDir?.trim();
  const cwd = sourceDir && sourceDir !== '.' ? sourceDir : undefined;
  const rootPathPrefix = cwd
    ? cwd
        .replace(/\\/g, '/')
        .split('/')
        .filter((seg) => seg.length > 0 && seg !== '.')
        .map(() => '..')
        .join('/') + '/'
    : '';

  // `--scale <app>=0` (always, via excludeService) guards both the default
  // all-services form AND explicit `up -d db` — where the app could otherwise
  // start as a `depends_on` dependency of a listed service. `filePathPrefix`
  // keeps the compose/env-file reachable from a monorepo `cwd`.
  const composeUp = buildComposeServicesUpCommand(compose, {
    services: backingServices,
    excludeService: label,
    filePathPrefix: rootPathPrefix,
  });
  const appDevCommand = opts.appDevCommand?.trim() || DEV_SERVER_DEFAULT_START_COMMAND;
  const startCommand = `${composeUp} && ${appDevCommand}`;
  const raw: Record<string, unknown> = {
    startCommand,
    portMap: [{ internalPort: compose.entryPort, label, primary: true }],
  };

  const healthPath = compose.healthPath?.trim();
  if (healthPath) raw.healthPath = healthPath;
  if (typeof compose.readyTimeoutMs === 'number') raw.readyTimeoutMs = compose.readyTimeoutMs;

  if (cwd) raw.cwd = cwd;

  const parsed = parseDevServerConfig(raw);
  if (!parsed.ok) {
    // Inputs are an already-validated compose config, so a failure here is a
    // mapping bug, not user error — surface it loudly rather than silently
    // returning a half-baked plan.
    throw new Error(`compose→devServer migration produced an invalid config: ${parsed.error}`);
  }

  // ── Per-project follow-ups ────────────────────────────────────────────
  if (entryServiceWasRequested) {
    warnings.push(
      `Excluded the app service "${label}" from the backing-services list — it now runs as the ` +
        `host dev server, not a compose service, so starting it in compose would double-start it.`,
    );
  }
  if (backingServices.length === 0) {
    // The command is kept safe by `--scale <app>=0`, but it still brings up
    // EVERY other service in the file. Nudge the operator to scope it (or drop
    // the app service) so the plan is precise rather than "everything else".
    warnings.push(
      `No backing services were enumerated — the command uses \`--scale ${label}=0\` to start ` +
        `every OTHER service in ${compose.file?.trim() || DEFAULT_COMPOSE_FILE} while keeping the app ` +
        `off (it runs as the host dev server). Pass an explicit backing-service list, or remove the ` +
        `app service "${label}" from the compose file, for a tighter command.`,
    );
  }
  if (!opts.appDevCommand) {
    warnings.push(
      `Verify the app dev command — defaulted to "${DEV_SERVER_DEFAULT_START_COMMAND}". ` +
        `Set devServer.startCommand's app portion to whatever "${label}" ran inside compose.`,
    );
  }
  if (cwd) {
    warnings.push(
      `devServer.cwd is "${cwd}" (from entrySourceDir), so startCommand runs from that subdir. ` +
        `The compose \`-f\`${compose.envFile?.trim() ? ' / `--env-file`' : ''} path(s) were rewritten ` +
        `with a "${rootPathPrefix}" prefix to reach the worktree-root compose file — verify they ` +
        `resolve, or run the compose step from the repo root.`,
    );
  }
  if (compose.envFile?.trim()) {
    warnings.push(
      `compose envFile "${compose.envFile.trim()}" only feeds \${VAR} interpolation in the compose ` +
        `file. The host dev-server process does not read it — move any vars the app needs into ` +
        `devServer.env (non-secret) or devServer.secretKeys (secrets in the project-secrets store).`,
    );
  }
  if (compose.entryWorkdir?.trim() || (compose.shadowDirs && compose.shadowDirs.length > 0)) {
    warnings.push(
      `compose live-mount fields (entryWorkdir/shadowDirs) are obsolete — the host process reads ` +
        `the worktree directly, so file watching / HMR needs no bind mount.`,
    );
  }

  return { devServer: parsed.value, startCommand, warnings };
}
