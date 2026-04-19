/**
 * PR-env builder (W2).
 *
 * Orchestrates the end-to-end build of a Docker-Compose PR preview env:
 *
 *   1. Allocate a host port from the PR-env port pool (3100–3999).
 *   2. Copy `prod.db` → `pr-<num>.db` so the preview env has an isolated
 *      SQLite file it can mutate without touching production.
 *   3. Render `.env.preview` with the assigned port, DB path, and sandbox
 *      GitHub App credentials.
 *   4. `docker compose up -d` via the injected compose runner, passing
 *      the rendered env file.
 *
 * Cleanup-on-failure is the hot path the tests care about (spec §1,
 * card: "Cleanup on failure: release port, delete DB copy, remove
 * .env.preview, compose down."). Every step records what it created so
 * the rollback block can undo precisely the resources that did get
 * created and skip the ones that didn't. A failure during cleanup is
 * logged but never re-raised — the caller sees the original failure.
 *
 * Everything that touches disk or Docker goes through injected
 * dependencies so the tests run with in-memory fakes and no real
 * containers.
 */

import path from 'path';
import type { PortPool } from './port-pool.js';
import {
  renderPreviewServerBlock,
  previewConfFilename,
  type PreviewServerBlockInput,
} from './nginx-template.js';
import {
  writePreviewConf,
  removePreviewConf,
  reloadNginx,
  type NginxWriterDeps,
} from './nginx-writer.js';

/** Minimal docker-compose surface the builder needs. */
export interface ComposeRunner {
  /**
   * `docker compose -f <templatePath> --env-file <envFilePath> up -d`.
   * Should resolve on success and reject on any non-zero exit. The
   * returned containerId (if known) is stashed on the result for the
   * reaper; callers may return empty string if the compose project
   * doesn't surface it synchronously.
   */
  up(opts: {
    templatePath: string;
    envFilePath: string;
    projectName: string;
  }): Promise<{ containerId?: string }>;
  /**
   * `docker compose -f <templatePath> --env-file <envFilePath> down`.
   * Best-effort — cleanup callers swallow errors. Should still resolve
   * cleanly if the project is already torn down.
   */
  down(opts: { templatePath: string; envFilePath: string; projectName: string }): Promise<void>;
}

/** Minimal filesystem surface the builder needs (injectable for tests). */
export interface FsOps {
  /** Copy prod DB → per-PR DB path. */
  copyFile(src: string, dest: string): Promise<void>;
  /** Write the rendered env file contents. */
  writeFile(dest: string, contents: string): Promise<void>;
  /** Best-effort remove — must not throw on ENOENT. */
  rm(target: string): Promise<void>;
}

export interface PrEnvBuildRequest {
  repoFullName: string;
  prNumber: number;
  branch: string;
  commitSha?: string;
}

export interface PrEnvBuildResult {
  port: number;
  slotId: string;
  dbPath: string;
  envFilePath: string;
  composeProjectName: string;
  previewUrl: string;
  /** Whatever the compose runner surfaced, if anything. */
  containerId?: string;
}

export interface PrEnvGithubCreds {
  appId: string;
  installationId: string;
  privateKey: string;
}

export interface PrEnvBuilderDeps {
  portPool: PortPool;
  compose: ComposeRunner;
  fs: FsOps;
  github: PrEnvGithubCreds;
  /**
   * Paths + formatting config. `prEnvDataDir` holds per-PR SQLite copies,
   * `envFilesDir` holds the rendered `.env.preview` files, and
   * `composeTemplatePath` points at `pr-env.compose.yml`.
   */
  paths: {
    prodDbPath: string;
    prEnvDataDir: string;
    envFilesDir: string;
    composeTemplatePath: string;
  };
  /**
   * Base URL used to build the preview URL we advertise back to the PR
   * comment. The builder appends `/pr-<num>/` — override in tests that
   * care about exact shape.
   */
  previewBaseUrl: string;
  /**
   * Renderer for the `.env.preview` body. Defaults to `buildPrEnvFile`
   * from `env-template.ts` — injectable so tests can force failures.
   */
  renderEnvFile: (values: {
    repoFullName: string;
    prNumber: number;
    slotId: string;
    hostPort: number;
    dbPath: string;
    githubAppId: string;
    githubInstallationId: string;
    githubPrivateKey: string;
    previewUrl: string;
  }) => string;
  /**
   * Nginx wiring. Optional — when omitted (existing tests, or the feature
   * is gated off at the caller level) the builder skips server-block
   * emission entirely. When present, the builder writes + reloads the
   * per-PR server block after compose-up succeeds, and includes a
   * rollback step so a failed write undoes the partial config.
   */
  nginx?: {
    writer: NginxWriterDeps;
    /**
     * Subset of the template inputs that are fixed per-deploy: host,
     * cert paths. The PR-specific fields (prNumber, port) are filled in
     * by the builder.
     */
    templateDefaults: Pick<PreviewServerBlockInput, 'previewHost' | 'certPath' | 'keyPath'>;
  };
}

/** What was created at each step — drives precise rollback on failure. */
interface BuildAudit {
  portAllocated: boolean;
  dbCopied: boolean;
  envWritten: boolean;
  composeUp: boolean;
  nginxWritten: boolean;
}

/**
 * Resolve deterministic, collision-free paths for a given PR. Separated
 * out so tests can assert exact filenames.
 */
export function prEnvPaths(
  baseDir: { prEnvDataDir: string; envFilesDir: string },
  prNumber: number,
): { dbPath: string; envFilePath: string; composeProjectName: string } {
  return {
    dbPath: path.join(baseDir.prEnvDataDir, `pr-${prNumber}.db`),
    envFilePath: path.join(baseDir.envFilesDir, `.env.preview.pr-${prNumber}`),
    composeProjectName: `agent-hub-pr-${prNumber}`,
  };
}

/**
 * Build a PR preview env. On any failure, all partial state is rolled
 * back and the original error is re-thrown.
 */
export async function buildPrEnv(
  deps: PrEnvBuilderDeps,
  request: PrEnvBuildRequest,
): Promise<PrEnvBuildResult> {
  const { portPool, compose, fs, github, paths, previewBaseUrl, renderEnvFile } = deps;
  const { repoFullName, prNumber } = request;

  const { dbPath, envFilePath, composeProjectName } = prEnvPaths(paths, prNumber);
  const slotId = `pr-env-${prNumber}`;
  const previewUrl = joinUrl(previewBaseUrl, `pr-${prNumber}`);

  const audit: BuildAudit = {
    portAllocated: false,
    dbCopied: false,
    envWritten: false,
    composeUp: false,
    nginxWritten: false,
  };

  try {
    // 1. Port. PortPool.allocatePort is idempotent for the same PR, so
    //    synchronize events don't consume new ports.
    const port = portPool.allocatePort(repoFullName, prNumber);
    audit.portAllocated = true;

    // 2. DB copy. `prod.db` → `pr-<num>.db` so the preview env can mutate
    //    freely without touching production data.
    await fs.copyFile(paths.prodDbPath, dbPath);
    audit.dbCopied = true;

    // 3. Env file. Missing values throw EnvTemplateError — the catch
    //    below handles the rollback.
    const body = renderEnvFile({
      repoFullName,
      prNumber,
      slotId,
      hostPort: port,
      dbPath,
      githubAppId: github.appId,
      githubInstallationId: github.installationId,
      githubPrivateKey: github.privateKey,
      previewUrl,
    });
    await fs.writeFile(envFilePath, body);
    audit.envWritten = true;

    // 4. Compose up. The runner may throw (image pull failed, port
    //    already in use on the host, daemon unreachable, etc.).
    const result = await compose.up({
      templatePath: paths.composeTemplatePath,
      envFilePath,
      projectName: composeProjectName,
    });
    audit.composeUp = true;

    // 5. Nginx server-block emission. Optional — only runs if the deps
    //    object opted into nginx wiring. If the write or reload fails,
    //    the rollback unwinds everything above (port/db/env/compose).
    if (deps.nginx) {
      const nginxBody = renderPreviewServerBlock({
        prNumber,
        port,
        previewHost: deps.nginx.templateDefaults.previewHost,
        certPath: deps.nginx.templateDefaults.certPath,
        keyPath: deps.nginx.templateDefaults.keyPath,
      });
      await writePreviewConf(deps.nginx.writer, {
        filename: previewConfFilename(prNumber),
        body: nginxBody,
      });
      audit.nginxWritten = true;
    }

    return {
      port,
      slotId,
      dbPath,
      envFilePath,
      composeProjectName,
      previewUrl,
      containerId: result.containerId,
    };
  } catch (err) {
    // Rollback in reverse order of creation. Each step swallows its own
    // errors so a single stuck resource can't hide the original failure.
    await rollback(deps, {
      repoFullName,
      prNumber,
      envFilePath,
      dbPath,
      composeProjectName,
      templatePath: paths.composeTemplatePath,
      audit,
    });
    throw err;
  }
}

/**
 * Explicit teardown used on `pull_request.closed` / merged. Unlike the
 * rollback path this runs all four cleanup steps regardless of state
 * because the lifecycle guarantees they were all created.
 */
export async function teardownPrEnv(
  deps: PrEnvBuilderDeps,
  request: { repoFullName: string; prNumber: number },
): Promise<void> {
  const { dbPath, envFilePath, composeProjectName } = prEnvPaths(deps.paths, request.prNumber);
  await rollback(deps, {
    repoFullName: request.repoFullName,
    prNumber: request.prNumber,
    envFilePath,
    dbPath,
    composeProjectName,
    templatePath: deps.paths.composeTemplatePath,
    audit: {
      portAllocated: true,
      dbCopied: true,
      envWritten: true,
      composeUp: true,
      nginxWritten: true,
    },
  });
}

async function rollback(
  deps: PrEnvBuilderDeps,
  ctx: {
    repoFullName: string;
    prNumber: number;
    envFilePath: string;
    dbPath: string;
    composeProjectName: string;
    templatePath: string;
    audit: BuildAudit;
  },
): Promise<void> {
  const { portPool, compose, fs } = deps;

  // Nginx cleanup first — if we installed a conf for a compose project
  // we're about to tear down, routing traffic to a stopped container is
  // the worst-of-both-worlds state. Attempt regardless of audit flag
  // because a partial write + symlink can leak even when the final
  // reload threw. removePreviewConf is idempotent.
  if (deps.nginx) {
    try {
      await removePreviewConf(deps.nginx.writer, {
        filename: previewConfFilename(ctx.prNumber),
      });
      // removePreviewConf intentionally doesn't reload (batching concern),
      // but teardown/rollback is a single-PR path — reload now so nginx
      // stops routing to the about-to-be-stopped container.
      await reloadNginx(deps.nginx.writer);
    } catch (e) {
      console.warn('[pr-env-builder] nginx conf rm during rollback failed', e);
    }
  }

  if (ctx.audit.composeUp) {
    try {
      await compose.down({
        templatePath: ctx.templatePath,
        envFilePath: ctx.envFilePath,
        projectName: ctx.composeProjectName,
      });
    } catch (e) {
      console.warn('[pr-env-builder] compose.down during rollback failed', e);
    }
  }

  // Always attempt env-file cleanup: if writeFile threw mid-write a
  // partial file may exist on disk even though audit.envWritten is false.
  // fs.rm already swallows ENOENT so this is safe when no file landed.
  try {
    await fs.rm(ctx.envFilePath);
  } catch (e) {
    console.warn('[pr-env-builder] env-file rm during rollback failed', e);
  }

  if (ctx.audit.dbCopied) {
    try {
      await fs.rm(ctx.dbPath);
    } catch (e) {
      console.warn('[pr-env-builder] db rm during rollback failed', e);
    }
  }

  if (ctx.audit.portAllocated) {
    try {
      portPool.releasePort(ctx.repoFullName, ctx.prNumber);
    } catch (e) {
      console.warn('[pr-env-builder] port release during rollback failed', e);
    }
  }
}

function joinUrl(base: string, suffix: string): string {
  const trimmed = base.replace(/\/+$/, '');
  return `${trimmed}/${suffix}`;
}
