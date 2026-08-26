/**
 * hosted-git-bootstrap.ts — make Agent Hub-originating projects Hub-native
 * end to end, out of the box.
 *
 * Runs once when a provisioning job finishes (phase stream emits `done`
 * without a fatal error):
 *
 *   1. Seeds a starter `.agent-hub/ci.yaml` (version 2) from the scaffold
 *      template's manifest — the same setup/test/lint commands the
 *      wire-tests/wire-lint phases just proved work — so Finalize checks,
 *      PR-level CI, and CI-on-push all light up from the first commit.
 *   2. Commits the scaffold (the pipeline `git init`s but leaves the tree
 *      uncommitted unless GitHub integration pushed it).
 *   3. Points `project.cwd` at the scaffolded workspace.
 *   4. Enables CI-on-push and Agent Hub git hosting (`gitHost:
 *      'agenthub'`, bare repo imported from the workspace).
 *
 * GitHub stays optional: when the wizard's GitHub integration ran,
 * `repoUrl` is already set and the hosting layer's default mirror keeps
 * GitHub in sync; otherwise it can be linked later from settings.
 * Best-effort throughout — a failure here leaves a normal (non-hosted)
 * project, never a wedged one.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import type { Project } from '../types.js';
import { enableGitHost, type EnableGitHostDeps } from '../git-host/lifecycle.js';
import { parseGithubRemote } from '../github-remote-owner.js';
import type { TemplateManifest } from './templates.js';

const execFileP = promisify(execFile);

const GIT_TIMEOUT_MS = 60_000;

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileP('git', ['-C', cwd, ...args], { timeout: GIT_TIMEOUT_MS });
  return stdout;
}

/** Commit any pending/unborn tree so the checkout has a HEAD to branch from. */
async function commitScaffoldIfNeeded(workspaceDir: string): Promise<void> {
  let hasHead = true;
  try {
    await git(workspaceDir, ['rev-parse', '--verify', 'HEAD']);
  } catch {
    hasHead = false;
  }
  const dirty = (await git(workspaceDir, ['status', '--porcelain'])).trim();
  if (hasHead && !dirty) return;
  await git(workspaceDir, ['add', '-A']);
  await git(workspaceDir, [
    '-c',
    'user.name=Agent Hub',
    '-c',
    'user.email=scaffold@agent-hub.local',
    'commit',
    '-m',
    'chore: initial scaffold (Agent Hub)',
  ]);
}

/** Record the GitHub remote (repoUrl + owner/repo) on the project when known. */
function persistRemoteMetadata(project: Project, repoUrl: string | null | undefined): void {
  if (!repoUrl) return;
  project.repoUrl = repoUrl;
  const parsed = parseGithubRemote(repoUrl);
  if (parsed) project.githubRepo = `${parsed.owner}/${parsed.repo}`;
}

/** Resolve the workspace's `origin` remote URL, or null when unset/failed. */
async function resolveOriginUrl(workspaceDir: string): Promise<string | null> {
  try {
    const url = (await git(workspaceDir, ['remote', 'get-url', 'origin'])).trim();
    return url || null;
  } catch {
    return null;
  }
}

function yamlQuote(cmd: string): string {
  return JSON.stringify(cmd); // valid YAML double-quoted scalar
}

/**
 * Starter v2 ci.yaml from a template manifest. Falls back to a passing
 * placeholder job when the stack is unknown so the CI surface is wired
 * (and visibly editable) rather than absent.
 */
export function buildStarterCiYaml(
  manifest: Pick<TemplateManifest, 'setup' | 'test' | 'lint'> | null,
): string {
  const lines: string[] = [
    '# Agent Hub CI — generated from your project scaffold.',
    '# Runs in Finalize, on PR pushes, and (when enabled) on pushes to the',
    '# default branch. Jobs execute in clean ubuntu-24.04 runner containers.',
    'version: 2',
    'on: [finalize, manual, push]',
    'timeout_minutes: 30',
    'jobs:',
  ];
  const setup = (manifest?.setup ?? []).filter(Boolean);
  const pushJob = (name: string, run: string): void => {
    lines.push(`  ${name}:`);
    lines.push('    runs-on: ubuntu-24.04');
    lines.push('    steps:');
    for (const [i, cmd] of setup.entries()) {
      lines.push(`      - name: setup ${i + 1}`);
      lines.push(`        run: ${yamlQuote(cmd)}`);
    }
    lines.push(`      - name: ${name}`);
    lines.push(`        run: ${yamlQuote(run)}`);
  };
  if (manifest?.test) pushJob('tests', manifest.test);
  if (manifest?.lint) pushJob('lint', manifest.lint);
  if (!manifest?.test && !manifest?.lint) {
    lines.push('  checks:');
    lines.push('    runs-on: ubuntu-24.04');
    lines.push('    steps:');
    lines.push('      - name: placeholder');
    lines.push('        run: "echo \'Replace this job with your real test/lint commands.\'"');
  }
  return lines.join('\n') + '\n';
}

export interface HostedGitBootstrapOpts {
  project: Project;
  /** The scaffolded repo tree (`<projectDataDir>/workspace`). */
  workspaceDir: string;
  manifest: Pick<TemplateManifest, 'setup' | 'test' | 'lint'> | null;
  saveProjects: () => void;
  broadcast: (data: Record<string, unknown>) => void;
  requestingUserId?: string | null;
  /**
   * GitHub remote URL from the provisioning `done` event (present when the
   * wizard's GitHub integration ran). Recorded so the mirror + webhook
   * config have `repoUrl` / `githubRepo` without a later remote probe.
   */
  repoUrl?: string | null;
  /** Test seams forwarded to enableGitHost. */
  enableDeps?: Partial<EnableGitHostDeps>;
}

/** See module header. Never throws. */
export async function bootstrapHostedGit(opts: HostedGitBootstrapOpts): Promise<void> {
  const { project, workspaceDir, manifest, saveProjects, broadcast } = opts;
  try {
    if (!existsSync(path.join(workspaceDir, '.git'))) {
      console.warn(
        `[provisioning] ${project.id}: workspace is not a git repo — skipping Hub hosting bootstrap`,
      );
      return;
    }

    // 1. Starter CI config (only when the scaffold didn't provide one).
    const ciPath = path.join(workspaceDir, '.agent-hub', 'ci.yaml');
    if (!existsSync(ciPath)) {
      mkdirSync(path.dirname(ciPath), { recursive: true });
      writeFileSync(ciPath, buildStarterCiYaml(manifest));
    }

    // 2. Commit the scaffold (incl. the ci.yaml just seeded). The pipeline
    // `git init`s but only the optional GitHub phase commits; without it
    // the tree is unborn.
    await commitScaffoldIfNeeded(workspaceDir);

    // 3. Point the project at the scaffolded repo — sessions, worktrees,
    // and the hosted import all key off cwd — and record the GitHub remote
    // when the integration produced one.
    if (project.cwd !== workspaceDir) {
      project.cwd = workspaceDir;
    }
    persistRemoteMetadata(project, opts.repoUrl ?? (await resolveOriginUrl(workspaceDir)));

    // 4. CI on push + Hub hosting (background import from cwd).
    project.ciOnPush = { enabled: true };
    saveProjects();
    enableGitHost(project, {
      saveProjects,
      broadcast,
      importFrom: 'cwd',
      requestingUserId: opts.requestingUserId ?? null,
      ...opts.enableDeps,
    });
    console.log(`[provisioning] ${project.id}: Hub git hosting + CI bootstrapped`);
  } catch (err: unknown) {
    console.warn(
      `[provisioning] ${project.id}: hosted-git bootstrap failed (project remains non-hosted): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

export interface ScaffoldCheckoutOpts {
  project: Project;
  /** The scaffolded repo tree (`<projectDataDir>/workspace`). */
  workspaceDir: string;
  /** GitHub remote URL from the provisioning `done` event, if the gh phases ran. */
  repoUrl?: string | null;
  saveProjects: () => void;
  broadcast?: (data: Record<string, unknown>) => void;
}

/**
 * GitHub-only (non-Hub-hosted) provisioning path. The scaffold was pushed
 * to GitHub by the gh-push phase, but nothing repointed the project at the
 * git checkout or recorded the remote — so the project still points at the
 * non-git data dir and neither `repoUrl` nor `githubRepo` is persisted.
 * `ensureWorktree` would then have no valid checkout or clone source and
 * the first build could not start.
 *
 * This adopts the scaffold checkout (commit any pending/unborn tree,
 * repoint `cwd`) and persists the GitHub remote metadata so the first
 * build session's worktree can branch/clone from it. Never throws — a
 * failure leaves a usable (if not build-ready) scaffolded project.
 */
export async function persistScaffoldCheckout(opts: ScaffoldCheckoutOpts): Promise<boolean> {
  const { project, workspaceDir, saveProjects } = opts;
  try {
    if (!existsSync(path.join(workspaceDir, '.git'))) {
      console.warn(
        `[provisioning] ${project.id}: workspace is not a git repo — cannot adopt scaffold checkout`,
      );
      return false;
    }
    await commitScaffoldIfNeeded(workspaceDir);
    if (project.cwd !== workspaceDir) {
      project.cwd = workspaceDir;
    }
    persistRemoteMetadata(project, opts.repoUrl ?? (await resolveOriginUrl(workspaceDir)));
    saveProjects();
    opts.broadcast?.({ type: 'projects_updated', reason: 'provisioning-github-checkout' });
    console.log(`[provisioning] ${project.id}: scaffold checkout adopted (GitHub-hosted)`);
    return true;
  } catch (err: unknown) {
    console.warn(
      `[provisioning] ${project.id}: scaffold checkout adoption failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return false;
  }
}
