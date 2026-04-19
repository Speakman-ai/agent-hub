/**
 * Scaffolding job builder (W3).
 *
 * Orchestrates an end-to-end scaffold request:
 *
 *   1. Validate the request (template name, repo name, owner).
 *   2. Mint a short-lived GitHub App installation token — the container
 *      uses it as `gh auth login --with-token` to create the repo and
 *      push. Requires the installation to carry the
 *      `administration: write` permission.
 *   3. Run a short-lived container (30–90s typical) from the scaffold
 *      base image. The container does the inside work (copy template →
 *      rewrite package.json → drop CLAUDE.md/AGENTS.md/workflow file →
 *      git init + commit → gh repo create --push → exit).
 *   4. On any failure, force-remove the container and surface a
 *      structured error. No host-side state is created outside the
 *      container, so cleanup is just the `docker rm -f` + no partial
 *      GitHub repo (because step 5 is `gh repo create --source=. --push`
 *      which is nearly atomic — either the remote exists with the
 *      initial commit, or it doesn't exist at all. However, a network
 *      failure after `gh repo create` but before the push completes
 *      can leave an empty remote; a retry would then 422).
 *
 * Why the Node side orchestrates via a `ContainerRunner` and not compose:
 *   Scaffold jobs are single-shot, short-lived, and don't need a
 *   multi-service compose project. A direct `docker run` (or the
 *   equivalent compose-project one-off) keeps the dispatcher's surface
 *   tight. The runner is an injected interface so tests run with a fake
 *   and the production caller plugs in a real `docker run` wrapper.
 *
 * Fail-fast contract:
 *   If mint-token fails → no container spawned.
 *   If container run exits non-zero → container force-removed; the
 *   scaffold.sh exit codes (2 bad spec, 3 template copy, 4 git, 5 gh)
 *   are preserved in the thrown error so the caller can disambiguate.
 *   At no step does the dispatcher write persistent host state (no files
 *   in /srv, no DB rows) — the kanban / pool_queue accounting is the
 *   caller's concern. This is intentional: a partially-failed scaffold
 *   leaves zero host-side cleanup work.
 */

export interface ScaffoldTemplate {
  /** Name of the template inside the base image (e.g. "next", "expo"). */
  id: string;
}

/**
 * Files that the scaffold job should drop into the generated tree
 * *before* the git commit. Extended into SCAFFOLD_SPEC.postScaffoldFiles
 * and written inside the container by scaffold.sh.
 *
 * `relativePath` is resolved against the root of the scaffolded project
 * (i.e. `/work/<name>/<relativePath>`). Path traversal is rejected
 * (no `..`, no absolute paths) by both the dispatcher and scaffold.sh.
 */
export interface ScaffoldPostFile {
  relativePath: string;
  contents: string;
}

/**
 * Minimal docker-surface the builder needs. Production wires this to a
 * `child_process.spawn('docker', [...])` wrapper that honors the scaffold
 * compose template + env file + resource caps; tests substitute a fake
 * that records the spec and returns a canned exit.
 */
export interface ContainerRunner {
  /**
   * Start a scaffold container synchronously (blocking) and wait for it
   * to exit. Must force-remove the container on any non-zero exit and
   * on timeout. Returns the structured exit info.
   *
   * The runner is responsible for injecting the env vars the container
   * expects (SCAFFOLD_SPEC, SCAFFOLD_GH_TOKEN, SCAFFOLD_SLOT_ID). It
   * MUST NOT echo SCAFFOLD_GH_TOKEN in logs.
   */
  run(spec: {
    /** Docker image reference (e.g. `ghcr.io/.../scaffold-base:2026-04-19`). */
    image: string;
    /** Stable id for this job — used as container name + label. */
    slotId: string;
    /** JSON-encoded SCAFFOLD_SPEC. */
    scaffoldSpec: string;
    /** GitHub App installation token; passed as SCAFFOLD_GH_TOKEN. */
    githubToken: string;
    /** Hard wall-clock timeout in ms. Exceeded → exitCode -1, timedOut true. */
    timeoutMs: number;
  }): Promise<ContainerRunResult>;
}

export interface ContainerRunResult {
  exitCode: number;
  /** True iff the runner force-killed the container because `timeoutMs` elapsed. */
  timedOut: boolean;
  /** Best-effort stderr capture (last ~8 KiB). Safe to log — the runner strips tokens. */
  stderr: string;
  /** Docker container id, if the runner captured one. */
  containerId?: string;
}

/**
 * Mints a GitHub App installation token for the given installation.
 * Tests substitute a stub; production points this at
 * `getInstallationToken(appId, privateKey, installationId)` from
 * `server/github-app.ts`.
 */
export type InstallationTokenMinter = (args: {
  appId: string | number;
  privateKey: string;
  installationId: string | number;
}) => Promise<string>;

export interface ScaffoldBuilderDeps {
  runner: ContainerRunner;
  mintInstallationToken: InstallationTokenMinter;
  /**
   * Image tag the runner should use. Typically the pinned date tag
   * (e.g. `ghcr.io/acme/agent-hub/scaffold-base:2026-04-19`) so scaffold
   * jobs are reproducible day-to-day; the :latest tag is acceptable in
   * dev/loop builds.
   */
  scaffoldImage: string;
  /**
   * Upper bound for the whole `docker run` — 90s hard cap by default,
   * matching the pre-baked `node_modules` SLA in the card description.
   */
  containerTimeoutMs?: number;
}

export interface ScaffoldRequest {
  /** Which pre-baked template — "next" | "expo" for now, checked by the container too. */
  template: string;
  /** GitHub owner (user login or org name) to create the repo under. */
  owner: string;
  /** Repo name — must pass GitHub's name rules + our stricter validation. */
  name: string;
  /** Optional description (stored in package.json and the GitHub repo description). */
  description?: string;
  /** Default true (private repo). Pass false explicitly to publish public. */
  private?: boolean;
  /**
   * Files dropped into the generated tree before the initial commit.
   * Typical usage: CLAUDE.md, AGENTS.md, `.github/workflows/ci.yml`.
   */
  postScaffoldFiles?: ScaffoldPostFile[];
  /** GitHub App credentials for the owner's installation. */
  github: {
    appId: string | number;
    privateKey: string;
    installationId: string | number;
  };
  /** Stable id — used as container name, pool slot binding, logs. */
  slotId: string;
}

export interface ScaffoldResult {
  /** `https://github.com/<owner>/<name>` — success URL. */
  repoUrl: string;
  /** Container id the runner saw, for audit/log correlation. */
  containerId?: string;
  /** Wall-clock time the container took, in ms. */
  durationMs: number;
}

/**
 * Thrown on any failure during scaffold. Preserves the shell exit code
 * from scaffold.sh where possible so callers can classify:
 *   2 → bad spec, 3 → template copy, 4 → git init/commit, 5 → gh auth/push.
 *   -1 → container timed out.
 *   -2 → mint-token or pre-flight failure (container never ran).
 */
export class ScaffoldError extends Error {
  readonly exitCode: number;
  readonly timedOut: boolean;
  readonly stderr: string;

  constructor(message: string, opts: { exitCode: number; timedOut?: boolean; stderr?: string }) {
    super(message);
    this.name = 'ScaffoldError';
    this.exitCode = opts.exitCode;
    this.timedOut = opts.timedOut ?? false;
    this.stderr = opts.stderr ?? '';
  }
}

// ─── validation ───────────────────────────────────────────────────────────

/**
 * Validates repo name against both GitHub's rules and a stricter local
 * policy that makes the same string safe to use as a directory name
 * inside the container (no leading dot, no `..`).
 *
 * Kept in sync with the regex in scaffold.sh — if you touch one, touch
 * both. A mismatch would let the dispatcher accept a name the shell
 * then rejects with exit 2.
 */
export function validateRepoName(name: string): void {
  if (typeof name !== 'string' || !name) {
    throw new ScaffoldError('name is required', { exitCode: -2 });
  }
  if (name.length > 100) {
    throw new ScaffoldError('name too long (max 100 chars)', { exitCode: -2 });
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(name)) {
    throw new ScaffoldError(`invalid name "${name}" (allowed: [a-zA-Z0-9][a-zA-Z0-9._-]*)`, {
      exitCode: -2,
    });
  }
  if (name.includes('..')) {
    throw new ScaffoldError(`invalid name "${name}" (contains "..")`, { exitCode: -2 });
  }
}

/**
 * Validate a single post-scaffold file. Blocks absolute paths and any
 * `..` traversal — the files end up inside `/work/<name>/` and a
 * crafted `relativePath` could otherwise escape the project tree.
 */
export function validatePostFile(f: ScaffoldPostFile): void {
  if (!f || typeof f.relativePath !== 'string' || !f.relativePath) {
    throw new ScaffoldError('postScaffoldFiles entry missing relativePath', { exitCode: -2 });
  }
  if (f.relativePath.startsWith('/')) {
    throw new ScaffoldError(`postScaffoldFiles: absolute path "${f.relativePath}" not allowed`, {
      exitCode: -2,
    });
  }
  // Split on both slashes so Windows-style paths in user input don't
  // escape the check.
  const segments = f.relativePath.split(/[\\/]/);
  if (segments.some((s) => s.includes('..'))) {
    throw new ScaffoldError(
      `postScaffoldFiles: ".." traversal in "${f.relativePath}" not allowed`,
      { exitCode: -2 },
    );
  }
  if (typeof f.contents !== 'string') {
    throw new ScaffoldError(`postScaffoldFiles[${f.relativePath}]: contents must be a string`, {
      exitCode: -2,
    });
  }
}

const ALLOWED_TEMPLATES = new Set(['next', 'expo']);

/**
 * Validate the scaffold request up front. Any problem throws a
 * ScaffoldError with exit code -2 (pre-flight); the container is never
 * spawned.
 */
export function validateRequest(req: ScaffoldRequest): void {
  if (!ALLOWED_TEMPLATES.has(req.template)) {
    throw new ScaffoldError(
      `unknown template "${req.template}" (allowed: ${[...ALLOWED_TEMPLATES].join(', ')})`,
      { exitCode: -2 },
    );
  }
  if (!req.owner || !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38})$/.test(req.owner)) {
    throw new ScaffoldError(`invalid owner "${req.owner}"`, { exitCode: -2 });
  }
  validateRepoName(req.name);
  for (const f of req.postScaffoldFiles ?? []) validatePostFile(f);
  if (!req.github?.appId || !req.github?.privateKey || !req.github?.installationId) {
    throw new ScaffoldError('github credentials missing', { exitCode: -2 });
  }
  if (!req.slotId) {
    throw new ScaffoldError('slotId is required', { exitCode: -2 });
  }
}

// ─── spec serialization ───────────────────────────────────────────────────

/**
 * Build the SCAFFOLD_SPEC JSON payload consumed by scaffold.sh. Kept as
 * a pure function so tests can pin the exact wire format without
 * spinning up the runner.
 *
 * Shape (must stay in sync with scaffold.sh parser):
 *   {
 *     template: "next" | "expo",
 *     owner: "...",
 *     name: "...",
 *     description: "...",
 *     private: true | false,
 *     postScaffoldFiles: [{ path: "CLAUDE.md", contents: "..." }, ...]
 *   }
 */
export function buildScaffoldSpec(req: ScaffoldRequest): string {
  const payload = {
    template: req.template,
    owner: req.owner,
    name: req.name,
    description: req.description ?? '',
    private: req.private ?? true,
    postScaffoldFiles: (req.postScaffoldFiles ?? []).map((f) => ({
      path: f.relativePath,
      contents: f.contents,
    })),
  };
  return JSON.stringify(payload);
}

// ─── main orchestrator ────────────────────────────────────────────────────

/**
 * Run the full scaffold workflow. Returns the created repo URL on
 * success; throws a ScaffoldError on any failure. No host-side state
 * persists on failure (nothing to clean — the container is force-
 * removed and the dispatcher never wrote anything to the host fs).
 */
export async function scaffoldRepo(
  deps: ScaffoldBuilderDeps,
  request: ScaffoldRequest,
): Promise<ScaffoldResult> {
  validateRequest(request);

  // Mint a short-lived installation token. Failure here is a pre-flight
  // error (exit -2) and the container never spawns. Token lives for
  // ~1 hour; the container uses it for a <90 s scaffold and then exits.
  let token: string;
  try {
    token = await deps.mintInstallationToken({
      appId: request.github.appId,
      privateKey: request.github.privateKey,
      installationId: request.github.installationId,
    });
  } catch (err) {
    throw new ScaffoldError(`failed to mint installation token: ${errMessage(err)}`, {
      exitCode: -2,
    });
  }
  if (!token) {
    throw new ScaffoldError('mintInstallationToken returned an empty token', { exitCode: -2 });
  }

  const scaffoldSpec = buildScaffoldSpec(request);
  const timeoutMs = deps.containerTimeoutMs ?? 90_000;

  const startedAt = Date.now();
  let result: ContainerRunResult;
  try {
    result = await deps.runner.run({
      image: deps.scaffoldImage,
      slotId: request.slotId,
      scaffoldSpec,
      githubToken: token,
      timeoutMs,
    });
  } catch (err) {
    // Runner failed *before* giving us a structured result — treat as
    // pre-flight failure. The runner's contract is to force-remove the
    // container itself on any failure.
    throw new ScaffoldError(`container runner failed to start: ${errMessage(err)}`, {
      exitCode: -2,
    });
  }
  const durationMs = Date.now() - startedAt;

  if (result.timedOut) {
    throw new ScaffoldError(`scaffold timed out after ${timeoutMs}ms (container force-removed)`, {
      exitCode: -1,
      timedOut: true,
      stderr: result.stderr,
    });
  }
  if (result.exitCode !== 0) {
    throw new ScaffoldError(describeExitCode(result.exitCode, result.stderr), {
      exitCode: result.exitCode,
      stderr: result.stderr,
    });
  }

  return {
    repoUrl: `https://github.com/${request.owner}/${request.name}`,
    containerId: result.containerId,
    durationMs,
  };
}

function describeExitCode(exitCode: number, stderr: string): string {
  // These map to scaffold.sh `fail` calls. If scaffold.sh changes, keep
  // this in sync so operators see the right disambiguation in logs.
  const phase =
    exitCode === 2
      ? 'bad spec (missing/invalid template, owner, or name)'
      : exitCode === 3
        ? 'template copy failed inside container'
        : exitCode === 4
          ? 'git init/commit failed'
          : exitCode === 5
            ? 'gh auth / repo create / push failed'
            : `container exited ${exitCode}`;
  // Keep stderr tail short — 400 chars is enough for the scaffold.sh
  // one-liners without flooding logs if something deeper exploded.
  const tail = stderr ? `: ${stderr.slice(-400)}` : '';
  return `scaffold failed — ${phase}${tail}`;
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
