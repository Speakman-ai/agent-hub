/**
 * The preview-block probe must answer from the PR's exact head commit, never
 * from the default branch. Real git repos: an "origin" bare repo with a main
 * branch and a PR branch that disagree about `preview:`, and a workspace
 * cloned from it.
 */
import '../test/setup.js';
import { describe, it, expect, beforeAll } from 'vitest';
import { execSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { probePreviewConfigAtSha } from './pr-environment-config.js';
import type { Project } from '../types.js';

const PREVIEW_YAML =
  'version: 1\npreview:\n  compose: docker-compose.yml\n  service: app\n  port: 3000\n';
const DEPLOY_ONLY_YAML =
  'version: 1\nenvironments:\n  prod:\n    steps:\n      - name: deploy\n        run: echo deploy\n';

function git(cwd: string, cmd: string): string {
  return execSync(`git ${cmd}`, { cwd, stdio: 'pipe' }).toString().trim();
}

function commitDeployYaml(work: string, content: string | null, msg: string): string {
  const file = path.join(work, '.agent-hub', 'deploy.yaml');
  if (content === null) {
    rmSync(file, { force: true });
    git(work, 'add -A');
  } else {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
    git(work, 'add .agent-hub/deploy.yaml');
  }
  git(work, `commit --allow-empty -m "${msg}"`);
  return git(work, 'rev-parse HEAD');
}

/** Origin whose main has `mainYaml` and whose PR branch head has `prYaml`. */
function setupRepos(mainYaml: string | null, prYaml: string | null) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pr-env-probe-'));
  const origin = path.join(root, 'origin.git');
  const work = path.join(root, 'work');
  execSync(`git init --bare --initial-branch=main "${origin}"`, { stdio: 'pipe' });
  mkdirSync(work);
  execSync('git init --initial-branch=main', { cwd: work, stdio: 'pipe' });
  git(work, 'config user.email t@example.com');
  git(work, 'config user.name T');
  writeFileSync(path.join(work, 'README'), 'x\n');
  git(work, 'add README');
  git(work, 'commit -m base');
  commitDeployYaml(work, mainYaml, 'main config');
  git(work, `remote add origin "${origin}"`);
  git(work, 'push -q origin main');
  git(work, 'checkout -q -b pr-branch');
  const prSha = commitDeployYaml(work, prYaml, 'pr config');
  git(work, 'push -q origin pr-branch');
  const workspace = path.join(root, 'workspace');
  execSync(`git clone -q --no-local "${origin}" "${workspace}"`, { stdio: 'pipe' });
  const project = { id: 'probe-project', cwd: workspace } as Project;
  return { project, prSha };
}

describe('probePreviewConfigAtSha', () => {
  let removed: ReturnType<typeof setupRepos>;
  let added: ReturnType<typeof setupRepos>;
  beforeAll(() => {
    removed = setupRepos(PREVIEW_YAML, DEPLOY_ONLY_YAML);
    added = setupRepos(null, PREVIEW_YAML);
  });

  it('PR head removed the block while main has it → absent (not main’s answer)', async () => {
    expect(await probePreviewConfigAtSha(removed.project, removed.prSha)).toBe('absent');
  });

  it('PR head adds the block while main lacks it → present', async () => {
    expect(await probePreviewConfigAtSha(added.project, added.prSha)).toBe('present');
  });

  it('a commit that cannot be read is unresolved, not a guess from main', async () => {
    expect(await probePreviewConfigAtSha(removed.project, 'f'.repeat(40))).toBe('unresolved');
  });
});
