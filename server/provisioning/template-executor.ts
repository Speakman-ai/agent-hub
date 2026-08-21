/**
 * Production provisioning executor — materializes a starter template
 * into the project's workspace and runs its setup/test/lint commands,
 * streaming stdout/stderr back through `ctx.log`.
 *
 * The orchestrator (see `orchestrator.ts`) drives the phase sequence
 * and is unaware of templates; this executor slots into the
 * `copy-template` / `wire-tests` / `wire-lint` phases and otherwise
 * defers to the stub behaviour for git/gh phases so tests don't have
 * to mock the entire happy path.
 *
 * Phase → action mapping:
 *   copy-template  — copy templates/<id>/files into the workspace.
 *   rewrite-pkg    — noop (kept for compat; future work: inject project name).
 *   wire-tests     — run manifest.setup[*] in order, then manifest.test.
 *   wire-lint      — run manifest.lint.
 *   git-init       — `git init --initial-branch=main` in the workspace so
 *                    `gh repo create --source=.` can run in gh-create.
 *
 * Any phase that isn't one of the above delegates to the supplied fallback
 * executor (defaulting to the stub) for gh-* and validate/mint-token.
 */

import { cpSync, mkdirSync } from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import type {
  ProvisioningExecutor,
  ProvisioningPhaseId,
  ExecutorPhaseCtx,
  ExecutorPhaseResult,
} from './orchestrator.js';
import { stubExecutor } from './orchestrator.js';
import { resolveTemplateId, type TemplateId } from './stack-defaults.js';
import { getTemplate, type LoadedTemplate } from './templates.js';

export interface TemplateExecutorOptions {
  /**
   * Resolve the workspace directory for a given project. The template
   * tree is copied here during `copy-template`, and setup/test/lint
   * commands run with this as cwd.
   */
  resolveWorkspace: (projectId: string | null) => string;
  /** Optional executor invoked for phases this module does not handle. */
  fallback?: ProvisioningExecutor;
  /**
   * Maximum time (ms) for a single command. Defaults to 10 minutes —
   * cargo builds on a cold cache can approach this.
   */
  commandTimeoutMs?: number;
  /**
   * Spawner override. Tests can inject a fake that never touches disk
   * or the network.
   */
  spawnCommand?: SpawnCommand;
  /**
   * Copier override. Tests can swap in a fake to assert the resolved
   * template id without actually writing files.
   */
  copyTree?: (srcDir: string, destDir: string) => void;
}

export type SpawnCommand = (
  command: string,
  opts: { cwd: string; log: (line: string) => void; timeoutMs: number },
) => Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>;

/**
 * Build the env passed to template setup/test/lint commands.
 *
 * We deliberately do NOT propagate `NODE_ENV=production` or any of the
 * `npm_config_*` knobs that tell npm to skip devDependencies. PM2 sets
 * `NODE_ENV=production` for the agent-hub server (see
 * `ecosystem.config.cjs`), and npm honours that by skipping
 * `devDependencies` during `npm install` — which is exactly the wrong
 * behaviour for a starter template that ships its toolchain (tsx,
 * typescript, eslint, etc.) as devDependencies. The result was that a
 * freshly scaffolded `typescript-node-tsx` workspace had `tsx` listed
 * in package.json but absent from `node_modules/.bin`, and `npm test`
 * exited 127 with `sh: 1: tsx: not found`.
 *
 * Defense-in-depth: we both force `NODE_ENV=development` AND strip the
 * `NPM_CONFIG_PRODUCTION` / `NPM_CONFIG_OMIT` overrides (and their
 * snake_case aliases) — npm 7+ honours `--omit=dev` via
 * `npm_config_omit` even when NODE_ENV is unset, so just clearing
 * NODE_ENV isn't sufficient on its own. Other env vars — PATH, HOME,
 * NPM_TOKEN, proxy settings — pass through unchanged.
 *
 * Exported for tests; production callers should use
 * `defaultSpawnCommand` directly.
 */
export function buildTemplateSpawnEnv(parentEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...parentEnv };
  delete env.NPM_CONFIG_PRODUCTION;
  delete env.npm_config_production;
  delete env.NPM_CONFIG_OMIT;
  delete env.npm_config_omit;
  env.NODE_ENV = 'development';
  return env;
}

/** Default spawner — pipes stdout/stderr line-by-line into `log`. */
export const defaultSpawnCommand: SpawnCommand = (command, { cwd, log, timeoutMs }) => {
  return new Promise((resolve) => {
    log(`$ ${command}`);
    const child = spawn(command, {
      cwd,
      shell: true,
      env: buildTemplateSpawnEnv(process.env),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => {
      log(`[template-executor] timed out after ${timeoutMs}ms — killing`);
      child.kill('SIGKILL');
    }, timeoutMs);

    const pipe = (stream: NodeJS.ReadableStream): void => {
      let buffer = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk: string) => {
        buffer += chunk;
        let idx = buffer.indexOf('\n');
        while (idx >= 0) {
          log(buffer.slice(0, idx));
          buffer = buffer.slice(idx + 1);
          idx = buffer.indexOf('\n');
        }
      });
      stream.on('end', () => {
        if (buffer.length > 0) log(buffer);
      });
    };

    if (child.stdout) pipe(child.stdout);
    if (child.stderr) pipe(child.stderr);

    child.on('error', (err) => {
      log(`[template-executor] spawn error: ${err.message}`);
    });

    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      resolve({ exitCode, signal });
    });
  });
};

/** Default tree copier — recursive `cp -r` via `fs.cpSync`. */
export const defaultCopyTree: (srcDir: string, destDir: string) => void = (srcDir, destDir) => {
  mkdirSync(destDir, { recursive: true });
  cpSync(srcDir, destDir, { recursive: true });
};

/**
 * Build a production executor. The returned object satisfies
 * `ProvisioningExecutor` and can be handed directly to
 * `startProvisioningJob`.
 */
export function createTemplateExecutor(opts: TemplateExecutorOptions): ProvisioningExecutor {
  const {
    resolveWorkspace,
    fallback = stubExecutor,
    commandTimeoutMs = 10 * 60 * 1000,
    spawnCommand = defaultSpawnCommand,
    copyTree = defaultCopyTree,
  } = opts;

  async function runCommand(
    label: string,
    command: string,
    cwd: string,
    log: (line: string) => void,
  ): Promise<ExecutorPhaseResult> {
    try {
      const result = await spawnCommand(command, { cwd, log, timeoutMs: commandTimeoutMs });
      if (result.exitCode === 0) {
        return { status: 'ok', message: `${label} exited 0` };
      }
      const code = result.exitCode ?? -1;
      return {
        status: 'failed',
        message: `${label} exited ${code}`,
        error: {
          code,
          message: `${label} failed: \`${command}\` exited ${code}${
            result.signal ? ` (signal ${result.signal})` : ''
          }`,
        },
      };
    } catch (err: unknown) {
      const msg = (err as Error)?.message ?? 'unknown spawn error';
      return {
        status: 'failed',
        message: `${label} spawn error`,
        error: { code: -1, message: `${label} threw: ${msg}` },
      };
    }
  }

  function selectTemplate(ctx: ExecutorPhaseCtx): LoadedTemplate {
    const appType = typeof ctx.payload.appType === 'string' ? ctx.payload.appType : null;
    const stack = typeof ctx.payload.stack === 'string' ? ctx.payload.stack : null;
    const id: TemplateId = resolveTemplateId(appType, stack);
    ctx.log(`[template-executor] resolved template: ${id} (appType=${appType}, stack=${stack})`);
    return getTemplate(id);
  }

  return {
    async runPhase(
      phase: ProvisioningPhaseId,
      ctx: ExecutorPhaseCtx,
    ): Promise<ExecutorPhaseResult> {
      if (phase === 'copy-template') {
        const template = selectTemplate(ctx);
        const workspace = resolveWorkspace(ctx.projectId);
        try {
          copyTree(template.filesDir, workspace);
          ctx.log(`[template-executor] copied ${template.manifest.id} to ${workspace}`);
          return {
            status: 'ok',
            message: `Copied ${template.manifest.label} into workspace`,
          };
        } catch (err: unknown) {
          const msg = (err as Error)?.message ?? 'unknown copy error';
          // A denied write here is almost always a bind-mount ownership
          // mismatch on the projects data dir, not a transient failure —
          // give the operator the path and the actual fix instead of the
          // generic "template copy failed" hint.
          const syscallCode = (err as NodeJS.ErrnoException)?.code;
          const hint =
            syscallCode === 'EACCES' || syscallCode === 'EPERM'
              ? `Permission denied creating the workspace at ${workspace}. The projects data dir is not writable by the server process — align its ownership with the container UID:GID (e.g. chown the bind-mounted ~/.agent-hub/projects to match the user in docker-compose, or set UID/GID in .env). Retrying will not help until the ownership is fixed.`
              : undefined;
          return {
            status: 'failed',
            message: 'template copy failed',
            // code 3 == template copy failed (see client hintForCode); -1 is
            // reserved for container timeout and would render a misleading hint.
            error: { code: 3, message: `Failed to copy template: ${msg}`, hint },
          };
        }
      }

      if (phase === 'rewrite-pkg') {
        // Reserved for a future pass that rewrites package.json / Cargo.toml
        // / pyproject.toml with the user-supplied project name. Skipped
        // for now to keep this PR scoped.
        ctx.log('[template-executor] rewrite-pkg noop (reserved for follow-up)');
        return { status: 'ok', message: 'rewrite-pkg reserved' };
      }

      if (phase === 'wire-tests') {
        const template = selectTemplate(ctx);
        const workspace = resolveWorkspace(ctx.projectId);
        for (const cmd of template.manifest.setup) {
          const setupResult = await runCommand('setup', cmd, workspace, ctx.log);
          if (setupResult.status !== 'ok') return setupResult;
        }
        return runCommand('test', template.manifest.test, workspace, ctx.log);
      }

      if (phase === 'wire-lint') {
        const template = selectTemplate(ctx);
        const workspace = resolveWorkspace(ctx.projectId);
        return runCommand('lint', template.manifest.lint, workspace, ctx.log);
      }

      if (phase === 'git-init') {
        const workspace = resolveWorkspace(ctx.projectId);
        return runCommand('git-init', 'git init --initial-branch=main', workspace, ctx.log);
      }

      return fallback.runPhase(phase, ctx);
    },
  };
}

/**
 * Convenience wrapper used by the HTTP route. The workspace resolver
 * falls back to `<dataDir>/workspace` when the caller doesn't supply one.
 */
export function createTemplateExecutorForProject(
  getProjectDataDir: (projectId: string) => string,
): ProvisioningExecutor {
  return createTemplateExecutor({
    resolveWorkspace: (projectId) => {
      if (!projectId) {
        throw new Error('template executor requires a projectId');
      }
      return path.join(getProjectDataDir(projectId), 'workspace');
    },
  });
}
