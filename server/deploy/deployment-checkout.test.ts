import '../test/setup.js';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Project } from '../types.js';
import { prepareDeploymentCheckout } from './deployment-checkout.js';

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
