import { execFile } from 'child_process';
import { existsSync } from 'fs';
import { mkdtemp, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import type { Project } from '../types.js';
import { gitHostRepoPath } from '../git-host/repo-store.js';

const execFileAsync = promisify(execFile);

export class DeploymentCheckoutError extends Error {
  readonly reason: 'no_workspace' | 'git_error';
  constructor(reason: DeploymentCheckoutError['reason'], message: string) {
    super(message);
    this.name = 'DeploymentCheckoutError';
    this.reason = reason;
  }
}

function projectWorkspace(project: Project): string | null {
  if (project.gitHost === 'agenthub') {
    const hostedRepo = gitHostRepoPath(project.id);
    if (existsSync(path.join(hostedRepo, 'HEAD'))) return hostedRepo;
  }
  const candidate = project.cwd || project.ahw;
  return typeof candidate === 'string' && candidate.trim() ? candidate : null;
}

async function git(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    timeout: 60_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  return stdout.trim();
}

/** Repo-relative path of the deploy manifest read by the config endpoints. */
const DEPLOY_YAML_REL_PATH = '.agent-hub/deploy.yaml';

/**
 * `git show <ref>:<path>` failed because the blob is absent at that ref — the
 * repo has no commits yet, or the file simply isn't tracked at `ref`. All of
 * these mean "no deploy config here", which the caller maps to a not-found /
 * empty config, exactly as a clone-then-ENOENT did before.
 */
function isMissingBlobError(err: unknown): boolean {
  const stderr = String((err as { stderr?: unknown })?.stderr ?? '');
  return (
    /does not exist in/.test(stderr) ||
    /exists on disk, but not in/.test(stderr) ||
    /invalid object name/.test(stderr) ||
    /bad revision/.test(stderr) ||
    /unknown revision/.test(stderr) ||
    /not a valid object name/.test(stderr)
  );
}

/**
 * Read `.agent-hub/deploy.yaml` at `ref` WITHOUT materializing a working
 * checkout. The read-only config endpoints only need the file's contents at a
 * ref, so the full `git clone --no-hardlinks` in {@link prepareDeploymentCheckout}
 * is pure waste — on a large hosted repo (surveytracker.git ~141 MB) it ran
 * ~11 s and, under load, blew past the 60 s timeout, hanging the Deployments
 * page. A direct `git show <ref>:<path>` reads a single object (sub-100 ms).
 *
 * Returns the raw YAML, or `null` when the file does not exist at that ref.
 * Unlike {@link git}, the content is returned untrimmed so the parser sees the
 * file byte-for-byte. Throws {@link DeploymentCheckoutError} for a missing
 * workspace or an unexpected git failure.
 */
export async function readDeployYamlAtRef(args: {
  project: Project;
  ref: string;
}): Promise<string | null> {
  const source = projectWorkspace(args.project);
  if (!source) {
    throw new DeploymentCheckoutError('no_workspace', 'Project has no workspace configured.');
  }
  const spec = `${args.ref}:${DEPLOY_YAML_REL_PATH}`;
  try {
    // `-C <source>` works for both a bare hosted repo (source IS the git dir)
    // and a normal working checkout (git discovers `.git`).
    const { stdout } = await execFileAsync('git', ['-C', source, 'show', spec], {
      timeout: 60_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return stdout;
  } catch (err) {
    if (isMissingBlobError(err)) return null;
    const detail = err instanceof Error ? err.message : String(err);
    throw new DeploymentCheckoutError('git_error', `Could not read ${spec}: ${detail}`);
  }
}

/**
 * Materialize `ref` into an isolated detached checkout without mutating the
 * project's primary workspace. The caller owns the returned directory: gated
 * deployments retain it only while awaiting approval, and the orchestrator
 * removes REST-owned checkouts once the deployment is terminal or cancelled.
 */
export async function prepareDeploymentCheckout(args: {
  project: Project;
  ref: string;
}): Promise<{ worktreePath: string; resolvedRef: string }> {
  const source = projectWorkspace(args.project);
  if (!source) {
    throw new DeploymentCheckoutError('no_workspace', 'Project has no workspace configured.');
  }

  const dest = await mkdtemp(path.join(os.tmpdir(), `agent-hub-deploy-${args.project.id}-`));
  try {
    await git(['clone', '--quiet', '--no-hardlinks', source, dest]);
    await git(['checkout', '--quiet', '--detach', args.ref], dest);
    const resolvedRef = await git(['rev-parse', 'HEAD'], dest);
    if (!resolvedRef) throw new Error('empty rev-parse output');
    return { worktreePath: dest, resolvedRef };
  } catch (err) {
    await rm(dest, { recursive: true, force: true });
    const detail = err instanceof Error ? err.message : String(err);
    throw new DeploymentCheckoutError(
      'git_error',
      `Could not materialize deployment ref "${args.ref}": ${detail}`,
    );
  }
}
