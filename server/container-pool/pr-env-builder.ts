/**
 * PR-env builder (script-mode).
 *
 * Orchestrates the per-PR preview-env lifecycle. Unlike the previous
 * canned compose-template path, this builder actually runs the PR's code:
 *
 *   1. Allocate a host port from the PR-env port pool.
 *   2. Mint a short-lived installation token from the registered Reviewer
 *      App (private repos need it for the clone).
 *   3. Clone (or update) the PR's head ref into a per-project working
 *      directory under `paths.checkoutBaseDir`.
 *   4. Optionally `docker build` an image from the project's Dockerfile.
 *      When `dockerfilePath` is null we use the configured
 *      `defaultBaseImage` (currently `node:20`) and bind-mount the
 *      checkout — small / dynamic projects don't need a Dockerfile.
 *   5. Run a container that bind-mounts the checkout, exposes the
 *      assigned host port → the project-configured `internalPort`,
 *      injects `PORT=<internalPort>`, and execs the project's start
 *      script (optionally prefixed with a one-shot setup command, e.g.
 *      `npm install`).
 *   6. Emit the per-PR nginx server block + reload, exactly as before.
 *
 * Cleanup-on-failure walks each created resource in reverse and swallows
 * its own errors so the caller sees the original failure. `teardownPrEnv`
 * is the explicit close/merge path and assumes everything was created.
 *
 * Every host-touching surface (Docker, git, fs, nginx) goes through
 * injected dependencies so unit tests run against in-memory fakes.
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
import type { PrEnvProjectConfig } from '../types.js';
import { resolveSsmRefs } from '../ssm-resolver.js';

/** Minimal container-runtime surface the builder needs (Docker in prod). */
export interface ContainerRunner {
  /**
   * Build an image from the cloned checkout. When `dockerfilePath` is
   * null/undefined the runner returns `imageTag = defaultBaseImage`
   * unchanged — the run step will mount the checkout into `node:20`
   * (or whatever default the install ships) and rely on the start
   * script to bring everything up.
   */
  build(opts: {
    /** Build context directory — resolved on the Docker daemon host when DinD mapping applies. */
    contextDir: string;
    dockerfilePath: string | null;
    imageTag: string;
    defaultBaseImage: string;
  }): Promise<{ imageTag: string }>;
  /**
   * Start a detached container. The runner is expected to:
   *   - publish `hostPort:internalPort`
   *   - bind-mount `checkoutDir` → /workspace, set workdir to /workspace
   *     (`checkoutDir` here is the path the **Docker daemon host** must use
   *     for `-v`; when Agent Hub runs in DinD it may differ from the git
   *     checkout path inside the server container — see
   *     `checkoutPathForDockerDaemon`.)
   *   - inject `PORT=<internalPort>` plus any caller-supplied env
   *   - exec `setupCommand && startScript` under `sh -c` (setupCommand
   *     is optional — when omitted, just the start script runs).
   */
  run(opts: {
    containerName: string;
    imageTag: string;
    hostPort: number;
    internalPort: number;
    checkoutDir: string;
    startScript: string;
    setupCommand?: string;
    env?: Record<string, string>;
  }): Promise<{ containerId: string }>;
  /** `docker rm -f <containerName>` — must not throw if absent. */
  stop(opts: { containerName: string }): Promise<void>;
}

/** Minimal git surface the builder needs (real `git` in prod). */
export interface GitOps {
  /**
   * Clone the PR head ref into `checkoutDir`. If the directory already
   * exists (synchronize event), the runner is expected to fetch the
   * latest commit and reset to it instead of re-cloning.
   *
   * `cloneToken` is a GitHub installation token usable as an HTTPS
   * Basic-auth password (`x-access-token:<token>`); the runner is
   * responsible for not letting it leak into git's reflog or process
   * args. Pass an empty string for public-repo clones.
   */
  cloneOrUpdate(opts: {
    repoFullName: string;
    branch: string;
    commitSha?: string;
    checkoutDir: string;
    cloneToken: string;
  }): Promise<void>;
}

/** Minimal filesystem surface — directory-only ops, swallows ENOENT. */
export interface FsOps {
  /** Recursive remove. Must not throw on ENOENT. */
  rmDir(target: string): Promise<void>;
  /** mkdir -p with parents. */
  mkdirP(target: string): Promise<void>;
}

export interface PrEnvBuildRequest {
  repoFullName: string;
  prNumber: number;
  branch: string;
  commitSha?: string;
  /** Per-project config (start script, port, optional Dockerfile). */
  projectConfig: PrEnvProjectConfig;
  /**
   * Filesystem-safe project slug used to namespace checkouts and
   * containers. Dispatcher derives this from the linked Project.id (or
   * a slugified repoFullName fallback).
   */
  projectSlug: string;
}

export interface PrEnvBuildResult {
  port: number;
  slotId: string;
  checkoutDir: string;
  containerName: string;
  imageTag: string;
  previewUrl: string;
  /** Whatever the container runtime surfaced. */
  containerId?: string;
}

export interface PrEnvGithubCreds {
  appId: string;
  installationId: string;
  privateKey: string;
}

export interface PrEnvBuilderDeps {
  portPool: PortPool;
  container: ContainerRunner;
  git: GitOps;
  fs: FsOps;
  github: PrEnvGithubCreds;
  /**
   * Mints a short-lived GitHub installation token for the clone. Tests
   * pass a fake that returns a fixed string; production wires this to
   * `getInstallationToken` from the github-app module. Returning `''`
   * is supported (public-repo path).
   */
  getCloneToken: (creds: PrEnvGithubCreds) => Promise<string>;
  paths: {
    /**
     * Base dir for per-PR checkouts; the builder places each PR under
     * `<checkoutBaseDir>/<projectSlug>/pr-<N>/`. Default in production
     * is `~/.agent-hub/pr-envs`.
     */
    checkoutBaseDir: string;
    /**
     * When set, paths passed to `docker build` / `docker run -v` use this
     * directory as the host-visible prefix instead of `checkoutBaseDir`
     * (see `checkoutPathForDockerDaemon`). Omit on bare-metal installs.
     */
    dockerHostCheckoutBaseDir?: string;
  };
  /**
   * Generic image used when `projectConfig.dockerfilePath` is null —
   * defaults to `node:20` so JS/TS projects work out of the box. Python
   * / Ruby / etc. supply their own Dockerfile via the wizard.
   */
  defaultBaseImage: string;
  previewBaseUrl: string;
  /**
   * Optional per-deploy nginx wiring. Same shape as the previous
   * builder — when present the builder writes a per-PR server block
   * after the container starts and rolls it back on failure.
   */
  nginx?: {
    writer: NginxWriterDeps;
    templateDefaults: Pick<PreviewServerBlockInput, 'previewHost' | 'certPath' | 'keyPath'>;
  };
}

/** What was created at each step — drives precise rollback on failure. */
interface BuildAudit {
  portAllocated: boolean;
  cloned: boolean;
  imageBuilt: boolean;
  containerStarted: boolean;
  nginxWritten: boolean;
}

/**
 * Docker CLI resolves bind-mount sources and build contexts on the **daemon
 * host**. When the Agent Hub server runs inside a container that exposes the
 * host Docker socket, clones land under `checkoutBaseDir` (often something
 * like `/home/node/.agent-hub/pr-envs`) inside that container — but the same
 * files appear on the host under `dockerHostCheckoutBaseDir` (e.g.
 * `/var/lib/agent-hub/pr-envs`) when ops bind-mounts the volume there.
 *
 * Pass every absolute path that will be handed to `docker build` / `docker run
 * -v` through this helper when `dockerHostCheckoutBaseDir` is configured.
 * Git / FS paths stay on the in-process checkout paths unchanged.
 */
export function checkoutPathForDockerDaemon(
  absoluteCheckoutPath: string,
  checkoutBaseDir: string,
  dockerHostCheckoutBaseDir?: string,
): string {
  const trimmed = dockerHostCheckoutBaseDir?.trim();
  if (!trimmed) {
    return absoluteCheckoutPath;
  }
  const base = path.resolve(checkoutBaseDir);
  const abs = path.resolve(absoluteCheckoutPath);
  const rel = path.relative(base, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(
      `[pr-env] Checkout path ${abs} is not under checkout base ${base}. ` +
        `Cannot map to Docker daemon bind path (dockerHostCheckoutBaseDir=${trimmed}).`,
    );
  }
  return path.join(path.resolve(trimmed), rel);
}

/**
 * Resolve deterministic, collision-free paths and identifiers for a
 * given (project, pr) pair. Separated out so tests + dispatcher can
 * predict exact filenames and container names.
 */
export function prEnvPaths(
  baseDir: { checkoutBaseDir: string },
  projectSlug: string,
  prNumber: number,
): { checkoutDir: string; containerName: string; imageTag: string } {
  // Project ids are validated against /^[a-zA-Z0-9-]+$/ in routes/projects.ts,
  // so a slug like `MyApp` is legal. Docker repository-name grammar requires
  // the path component to be lowercase — `docker build --tag agent-hub-pr/MyApp:…`
  // exits non-zero with `invalid reference format: repository name must be
  // lowercase`. Container names accept uppercase, but we lowercase here too
  // so checkout/container/image identifiers stay consistent for a project.
  const dockerSafeSlug = projectSlug.toLowerCase();
  return {
    checkoutDir: path.join(baseDir.checkoutBaseDir, projectSlug, `pr-${prNumber}`),
    containerName: `agent-hub-pr-${dockerSafeSlug}-${prNumber}`,
    imageTag: `agent-hub-pr/${dockerSafeSlug}:pr-${prNumber}`,
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
  const { portPool, container, git, fs, github, paths, previewBaseUrl, getCloneToken } = deps;
  const { repoFullName, prNumber, branch, commitSha, projectConfig, projectSlug } = request;

  const { checkoutDir, containerName, imageTag } = prEnvPaths(paths, projectSlug, prNumber);
  const slotId = `pr-env-${projectSlug}-${prNumber}`;
  const previewUrl = joinUrl(previewBaseUrl, `pr-${prNumber}`);
  let resolvedImageTag = imageTag;

  const audit: BuildAudit = {
    portAllocated: false,
    cloned: false,
    imageBuilt: false,
    containerStarted: false,
    nginxWritten: false,
  };

  try {
    // 1. Port. Idempotent for the same (repo, pr).
    const port = portPool.allocatePort(repoFullName, prNumber);
    audit.portAllocated = true;

    // 2. Clone token. `getCloneToken` may return '' for public repos /
    //    test fakes; the GitOps fake / real impl decides what to do
    //    with an empty token.
    const cloneToken = await getCloneToken(github);

    // 3. Clone (or update) the PR head ref.
    await fs.mkdirP(path.dirname(checkoutDir));
    await git.cloneOrUpdate({
      repoFullName,
      branch,
      commitSha,
      checkoutDir,
      cloneToken,
    });
    audit.cloned = true;

    // 4. Build image (or pass through the default base image).
    const dockerfilePath = projectConfig.dockerfilePath?.trim() || null;
    const dockerCheckoutDir = checkoutPathForDockerDaemon(
      checkoutDir,
      paths.checkoutBaseDir,
      paths.dockerHostCheckoutBaseDir,
    );
    const resolvedDockerfileForDaemon =
      dockerfilePath != null
        ? checkoutPathForDockerDaemon(
            path.resolve(checkoutDir, dockerfilePath),
            paths.checkoutBaseDir,
            paths.dockerHostCheckoutBaseDir,
          )
        : null;
    const builtImage = await container.build({
      contextDir: dockerCheckoutDir,
      dockerfilePath: resolvedDockerfileForDaemon,
      imageTag,
      defaultBaseImage: deps.defaultBaseImage,
    });
    resolvedImageTag = builtImage.imageTag;
    audit.imageBuilt = true;

    // 5. Run container. The runner:
    //    - publishes hostPort:internalPort
    //    - bind-mounts the checkout to /workspace
    //    - exports PORT=internalPort
    //    - execs `setupCommand && startScript` (or just startScript)
    //
    // On `pull_request.synchronize`, dispatchPrEnvBuild chains the new
    // build onto the previous one — but the previous build leaves a
    // running, detached container under this exact `containerName`.
    // Without a stop here, `docker run --name <name>` would fail with
    // `Conflict. The container name "/<name>" is already in use`. The
    // `stop` adapter is idempotent (`docker rm -f` exits 0 against an
    // absent container at the runner level) so calling it on every
    // build is safe.
    //
    // Best-effort: a transient stop failure must not block the new
    // build — `container.run` will surface the real conflict error if
    // the previous container is still alive, and that error reaches
    // rollback through the normal failure path.
    try {
      await container.stop({ containerName });
    } catch (e) {
      console.warn('[pr-env-builder] pre-run container.stop failed (continuing)', e);
    }
    // Resolve any `${ssm:/...}` references in the project's env map
    // before handing it to the runner. Plain string values pass
    // through unchanged. A failure here (missing param, AccessDenied,
    // etc.) throws and is caught by the surrounding try/catch, which
    // walks the rollback path the same as any other build failure.
    const resolvedEnv =
      projectConfig.env && Object.keys(projectConfig.env).length > 0
        ? await resolveSsmRefs(projectConfig.env)
        : undefined;

    const result = await container.run({
      containerName,
      imageTag: resolvedImageTag,
      hostPort: port,
      internalPort: projectConfig.internalPort,
      checkoutDir: dockerCheckoutDir,
      startScript: projectConfig.startScript,
      setupCommand: projectConfig.setupCommand?.trim() || undefined,
      // Per-project env vars (e.g. AWS credentials, upstream API URLs).
      // The runner translates these into `docker run --env K=V` pairs
      // alongside the runner-injected `PORT=<internalPort>`. The
      // validator already rejects `PORT` and any non-POSIX-name keys,
      // so we can pass the map through unmodified — except for SSM
      // references, which are swapped for their decrypted values
      // immediately above.
      env: resolvedEnv,
    });
    audit.containerStarted = true;

    // 6. Optional nginx wiring (unchanged from the previous builder).
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
      checkoutDir,
      containerName,
      imageTag: resolvedImageTag,
      previewUrl,
      containerId: result.containerId,
    };
  } catch (err) {
    await rollback(deps, {
      repoFullName,
      prNumber,
      checkoutDir,
      containerName,
      audit,
    });
    throw err;
  }
}

/**
 * Explicit teardown used on `pull_request.closed` / merged. Runs every
 * cleanup step regardless of state because the lifecycle guarantees
 * they were all created on a successful build.
 */
export async function teardownPrEnv(
  deps: PrEnvBuilderDeps,
  request: { repoFullName: string; prNumber: number; projectSlug: string },
): Promise<void> {
  const { checkoutDir, containerName } = prEnvPaths(
    deps.paths,
    request.projectSlug,
    request.prNumber,
  );
  await rollback(deps, {
    repoFullName: request.repoFullName,
    prNumber: request.prNumber,
    checkoutDir,
    containerName,
    audit: {
      portAllocated: true,
      cloned: true,
      imageBuilt: true,
      containerStarted: true,
      nginxWritten: true,
    },
  });
}

async function rollback(
  deps: PrEnvBuilderDeps,
  ctx: {
    repoFullName: string;
    prNumber: number;
    checkoutDir: string;
    containerName: string;
    audit: BuildAudit;
  },
): Promise<void> {
  const { portPool, container, fs } = deps;

  // 1. Nginx first — point traffic away before tearing down the
  //    container it routes to. removePreviewConf is idempotent so we
  //    attempt regardless of the audit flag (a partial write may have
  //    leaked even if the final reload threw).
  if (deps.nginx) {
    try {
      await removePreviewConf(deps.nginx.writer, {
        filename: previewConfFilename(ctx.prNumber),
      });
      await reloadNginx(deps.nginx.writer);
    } catch (e) {
      console.warn('[pr-env-builder] nginx conf rm during rollback failed', e);
    }
  }

  // 2. Container. We `stop` regardless of audit.containerStarted: the
  //    runner's stop is idempotent, and if `run` threw mid-creation
  //    the container may still exist as a zombie.
  try {
    await container.stop({ containerName: ctx.containerName });
  } catch (e) {
    console.warn('[pr-env-builder] container.stop during rollback failed', e);
  }

  // 3. Checkout dir. Always attempt cleanup — git may have written a
  //    partial tree even if `cloneOrUpdate` threw.
  try {
    await fs.rmDir(ctx.checkoutDir);
  } catch (e) {
    console.warn('[pr-env-builder] checkout rm during rollback failed', e);
  }

  // 4. Port. Only release if we successfully allocated.
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
