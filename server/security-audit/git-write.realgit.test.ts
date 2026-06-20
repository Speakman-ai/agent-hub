/**
 * Real-git integration for commitFilesToBareBranch: builds a throwaway bare
 * repo (git only — the test guard permits git, just not the agent CLIs) and
 * proves the worktree-free branch write + idempotency.
 */
import '../test/setup.js';
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync } from 'fs';
import path from 'path';
import os from 'os';
import { commitFilesToBareBranch } from './git-write.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}

let barePath: string;
let baseSha: string;

beforeAll(() => {
  const work = mkdtempSync(path.join(os.tmpdir(), 'gw-work-'));
  git(work, ['init', '-q']);
  git(work, ['config', 'user.email', 'test@test.dev']);
  git(work, ['config', 'user.name', 'Test']);
  git(work, ['checkout', '-q', '-b', 'main']);
  writeFileSync(path.join(work, 'package-lock.json'), '{"lockfileVersion":3}\n');
  writeFileSync(path.join(work, 'README.md'), '# fixture\n');
  git(work, ['add', '-A']);
  git(work, ['commit', '-q', '-m', 'init']);

  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'gw-bare-'));
  barePath = path.join(dataDir, 'repo.git');
  git(dataDir, ['init', '--bare', '-q', barePath]);
  git(work, ['push', '-q', barePath, 'main']);
  baseSha = execFileSync('git', ['-C', barePath, 'rev-parse', 'refs/heads/main']).toString().trim();
});

function showFile(branch: string, file: string): string {
  return execFileSync('git', ['-C', barePath, 'show', `refs/heads/${branch}:${file}`]).toString();
}

describe('commitFilesToBareBranch', () => {
  it('writes a new branch carrying the modified files, parented on baseSha', async () => {
    const res = await commitFilesToBareBranch({
      repoPath: barePath,
      baseSha,
      branch: 'agenthub/security/bump-lodash-4.17.21',
      files: { 'package-lock.json': '{"lockfileVersion":3,"bumped":true}\n' },
      message: 'security: bump lodash to 4.17.21',
    });
    expect(res.created).toBe(true);

    // File content landed
    expect(showFile('agenthub/security/bump-lodash-4.17.21', 'package-lock.json')).toContain(
      '"bumped":true',
    );
    // Untouched file is carried over from the base tree
    expect(showFile('agenthub/security/bump-lodash-4.17.21', 'README.md')).toContain('# fixture');
    // Parent is the base commit
    const parent = execFileSync('git', ['-C', barePath, 'rev-parse', `${res.headSha}^`])
      .toString()
      .trim();
    expect(parent).toBe(baseSha);
  });

  it('is idempotent: an identical re-run reuses the existing commit (no churn)', async () => {
    const args = {
      repoPath: barePath,
      baseSha,
      branch: 'agenthub/security/bump-idem',
      files: { 'package-lock.json': '{"lockfileVersion":3,"v":1}\n' },
      message: 'security: bump',
    };
    const first = await commitFilesToBareBranch(args);
    expect(first.created).toBe(true);
    const second = await commitFilesToBareBranch(args);
    expect(second.created).toBe(false);
    expect(second.headSha).toBe(first.headSha);
  });

  it('rewrites the branch when the file content changes', async () => {
    const base = {
      repoPath: barePath,
      baseSha,
      branch: 'agenthub/security/bump-change',
      message: 'security: bump',
    };
    const first = await commitFilesToBareBranch({
      ...base,
      files: { 'package-lock.json': '{"v":1}\n' },
    });
    const second = await commitFilesToBareBranch({
      ...base,
      files: { 'package-lock.json': '{"v":2}\n' },
    });
    expect(second.created).toBe(true);
    expect(second.headSha).not.toBe(first.headSha);
    expect(showFile('agenthub/security/bump-change', 'package-lock.json')).toContain('"v":2');
  });

  it('throws when given no files', async () => {
    await expect(
      commitFilesToBareBranch({
        repoPath: barePath,
        baseSha,
        branch: 'agenthub/security/empty',
        files: {},
        message: 'noop',
      }),
    ).rejects.toThrow(/no files/);
  });

  it('advances an existing branch via compare-and-swap against its current value', async () => {
    const branch = 'agenthub/security/bump-cas-existing';
    const ref = `refs/heads/${branch}`;
    // The branch already exists (at an unrelated commit). The write must CAS
    // against that exact value to advance it — not blindly overwrite.
    git(barePath, ['update-ref', ref, baseSha]);
    const res = await commitFilesToBareBranch({
      repoPath: barePath,
      baseSha,
      branch,
      files: { 'package-lock.json': '{"cas":"existing"}\n' },
      message: 'security: bump',
    });
    expect(res.created).toBe(true);
    const finalSha = git(barePath, ['rev-parse', ref]).trim();
    expect(finalSha).toBe(res.headSha);
    expect(showFile(branch, 'package-lock.json')).toContain('"cas":"existing"');
  });

  it('two concurrent writers to the same branch do not lose an update (CAS + retry)', async () => {
    const branch = 'agenthub/security/bump-race';
    const ref = `refs/heads/${branch}`;
    // Interleave two writers to the same new branch. One wins the CAS create;
    // the other's CAS misses and retries against the now-existing ref. Neither
    // throws, and the final ref is one of the two returned commits (not lost).
    const [a, b] = await Promise.all([
      commitFilesToBareBranch({
        repoPath: barePath,
        baseSha,
        branch,
        files: { 'package-lock.json': '{"w":"a"}\n' },
        message: 'security: bump a',
      }),
      commitFilesToBareBranch({
        repoPath: barePath,
        baseSha,
        branch,
        files: { 'package-lock.json': '{"w":"b"}\n' },
        message: 'security: bump b',
      }),
    ]);
    const finalSha = git(barePath, ['rev-parse', ref]).trim();
    expect([a.headSha, b.headSha]).toContain(finalSha);
  });
});
