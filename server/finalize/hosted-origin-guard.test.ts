import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { assertHostedOriginMatchesProject } from './push-and-create-pr-agenthub.js';
import { assertMainlineOrigin } from './push-to-default-branch.js';
import { bareRepoPath } from '../native-pr/host.js';

const PROJECT = 'proj-hosted-guard';
const BASES = { baseUrls: ['https://hub.example.com'] };

describe('assertHostedOriginMatchesProject (real git config)', () => {
  let root: string;
  let wt: string;
  const git = (...args: string[]) => execFileSync('git', args, { cwd: wt, encoding: 'utf8' });

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'hosted-guard-'));
    wt = join(root, 'wt');
    execFileSync('git', ['init', '-q', wt]);
    git('remote', 'add', 'origin', bareRepoPath(PROJECT));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const reset = (fetchUrl: string) => {
    git('remote', 'set-url', 'origin', fetchUrl);
    try {
      git('config', '--unset-all', 'remote.origin.pushurl');
    } catch {
      /* none set */
    }
  };

  it('accepts the bare path and a Hub HTTP URL', async () => {
    reset(bareRepoPath(PROJECT));
    await expect(assertHostedOriginMatchesProject(PROJECT, wt, BASES)).resolves.toBeUndefined();
    reset(`https://hub.example.com/git/${PROJECT}.git`);
    await expect(assertHostedOriginMatchesProject(PROJECT, wt, BASES)).resolves.toBeUndefined();
  });

  it('refuses a valid fetch URL whose pushurl points elsewhere', async () => {
    reset(bareRepoPath(PROJECT));
    git('config', 'remote.origin.pushurl', join(root, 'elsewhere.git'));
    await expect(assertHostedOriginMatchesProject(PROJECT, wt, BASES)).rejects.toThrow(
      /elsewhere\.git/,
    );
  });

  it('refuses when any of several pushurls is foreign', async () => {
    reset(bareRepoPath(PROJECT));
    git('config', '--add', 'remote.origin.pushurl', bareRepoPath(PROJECT));
    git(
      'config',
      '--add',
      'remote.origin.pushurl',
      `https://other-host.example/git/${PROJECT}.git`,
    );
    await expect(assertHostedOriginMatchesProject(PROJECT, wt, BASES)).rejects.toThrow(
      /other-host/,
    );
  });

  it('refuses the right path on an unrelated host', async () => {
    reset(`https://other-host.example/git/${PROJECT}.git`);
    await expect(assertHostedOriginMatchesProject(PROJECT, wt, BASES)).rejects.toThrow(
      /push refused/,
    );
  });

  it('mainline refuses an origin with more than one push URL, even if each is valid', async () => {
    reset(bareRepoPath(PROJECT));
    const project = { id: PROJECT, cwd: '', gitHost: 'agenthub' as const };
    // A single push URL passes (the Hub base is irrelevant for a bare path).
    await expect(
      assertMainlineOrigin({ project, worktreePath: wt, env: undefined }),
    ).resolves.toBeUndefined();
    git('config', '--add', 'remote.origin.pushurl', bareRepoPath(PROJECT));
    git('config', '--add', 'remote.origin.pushurl', bareRepoPath(PROJECT));
    await expect(
      assertMainlineOrigin({ project, worktreePath: wt, env: undefined }),
    ).rejects.toThrow(/2 push URLs/);
  });
});
