import { execFile } from 'child_process';
import { mkdtemp, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import type { Project } from '../types.js';

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
  const candidate = project.ahw || project.cwd;
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
