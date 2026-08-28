import '../test/setup.js';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Project } from '../types.js';
import { prepareDeploymentCheckout, readDeployYamlAtRef } from './deployment-checkout.js';

const roots: string[] = [];

function makeRoot(prefix: string): string {
  const root = path.join(tmpdir(), `${prefix}${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(root, { recursive: true });
  roots.push(root);
  return root;
}

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, {
    cwd,
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Agent Hub Test',
      GIT_AUTHOR_EMAIL: 'agent-hub-test@example.com',
      GIT_COMMITTER_NAME: 'Agent Hub Test',
      GIT_COMMITTER_EMAIL: 'agent-hub-test@example.com',
    },
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('prepareDeploymentCheckout', () => {
  it('uses project cwd before ahw because ahw is the Hub data directory', async () => {
    const root = makeRoot('deployment-checkout-');
    const cwd = path.join(root, 'repo');
    const ahw = path.join(root, 'ahw');
    mkdirSync(path.join(cwd, '.agent-hub'), { recursive: true });
    mkdirSync(ahw, { recursive: true });
    writeFileSync(
      path.join(cwd, '.agent-hub', 'deploy.yaml'),
      'version: 1\nenvironments:\n  prod:\n    steps:\n      - run: ./deploy.sh\n',
    );
    git(cwd, ['init', '--initial-branch=main']);
    git(cwd, ['add', '.agent-hub/deploy.yaml']);
    git(cwd, ['commit', '-m', 'add deploy config']);

    const checkout = await prepareDeploymentCheckout({
      project: {
        id: 'deployment-checkout-proj',
        name: 'Deployment Checkout Project',
        cwd,
        ahw,
        agents: [],
      } as Project,
      ref: 'HEAD',
    });
    roots.push(checkout.worktreePath);

    expect(existsSync(path.join(checkout.worktreePath, '.agent-hub', 'deploy.yaml'))).toBe(true);
  });
});

describe('readDeployYamlAtRef', () => {
  function commitRepo(): { cwd: string; ahw: string } {
    const root = makeRoot('deploy-yaml-read-');
    const cwd = path.join(root, 'repo');
    const ahw = path.join(root, 'ahw');
    mkdirSync(path.join(cwd, '.agent-hub'), { recursive: true });
    mkdirSync(ahw, { recursive: true });
    return { cwd, ahw };
  }

  it('reads the deploy.yaml blob at HEAD without materializing a checkout', async () => {
    const { cwd, ahw } = commitRepo();
    const yaml = 'version: 1\nenvironments:\n  prod:\n    steps:\n      - run: ./deploy.sh\n';
    writeFileSync(path.join(cwd, '.agent-hub', 'deploy.yaml'), yaml);
    git(cwd, ['init', '--initial-branch=main']);
    git(cwd, ['add', '.agent-hub/deploy.yaml']);
    git(cwd, ['commit', '-m', 'add deploy config']);

    const raw = await readDeployYamlAtRef({
      project: { id: 'p', name: 'P', cwd, ahw, agents: [] } as Project,
      ref: 'HEAD',
    });

    // Byte-for-byte content, and no tmp worktree was created.
    expect(raw).toBe(yaml);
    expect(roots.some((r) => existsSync(path.join(r, '.git', 'HEAD')) && r !== cwd)).toBe(false);
  });

  it('returns null when deploy.yaml does not exist at the ref', async () => {
    const { cwd, ahw } = commitRepo();
    writeFileSync(path.join(cwd, 'README.md'), '# repo\n');
    git(cwd, ['init', '--initial-branch=main']);
    git(cwd, ['add', 'README.md']);
    git(cwd, ['commit', '-m', 'no deploy config']);

    const raw = await readDeployYamlAtRef({
      project: { id: 'p', name: 'P', cwd, ahw, agents: [] } as Project,
      ref: 'HEAD',
    });

    expect(raw).toBeNull();
  });

  it('returns null for an empty repo with no commits (invalid HEAD)', async () => {
    const { cwd, ahw } = commitRepo();
    git(cwd, ['init', '--initial-branch=main']);

    const raw = await readDeployYamlAtRef({
      project: { id: 'p', name: 'P', cwd, ahw, agents: [] } as Project,
      ref: 'HEAD',
    });

    expect(raw).toBeNull();
  });
});
