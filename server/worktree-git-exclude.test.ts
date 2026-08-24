import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import path from 'path';
import os from 'os';
import { homedir } from 'os';
import type { SessionRow } from './types.js';

vi.mock('./config.js', () => ({
  default: { defaultCwd: '/tmp' },
}));

const { ensureSessionWorkspace, removeWorkspace, computeGitExcludeContent } =
  await import('./worktree.js');

describe('computeGitExcludeContent', () => {
  const managed = [
    '# agent-hub: keep Agent-Hub-injected Claude settings out of git status',
    '.claude/settings.json',
    '.claude/settings.local.json',
    '.claude/mcp-config.json',
    '',
  ].join('\n');

  it('appends the managed block to an empty exclude file', () => {
    expect(computeGitExcludeContent('')).toBe(managed);
  });

  it('preserves existing content and adds a separating newline', () => {
    const existing = '# git-style default\n*.log';
    const out = computeGitExcludeContent(existing);
    expect(out).toBe(existing + '\n' + managed);
    expect(out).toContain('.claude/settings.json');
  });

  it('does not add a double newline when existing content already ends in one', () => {
    const existing = 'node_modules\n';
    expect(computeGitExcludeContent(existing)).toBe(existing + managed);
  });

  it('is idempotent — returns null when the block is already present', () => {
    const once = computeGitExcludeContent('');
    expect(once).not.toBeNull();
    expect(computeGitExcludeContent(once as string)).toBeNull();
  });
});

describe('ensureSessionWorkspace — Claude settings git exclude', () => {
  let tmpRoot: string;
  let originBare: string;
  let sourceRepo: string;
  let sessionId: string;
  let createdWorkspace: string | null = null;

  function git(cwd: string, cmd: string): string {
    return execSync(`git ${cmd}`, { cwd, stdio: 'pipe' }).toString().trim();
  }

  beforeEach(() => {
    tmpRoot = path.join(
      os.tmpdir(),
      `worktree-exclude-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tmpRoot, { recursive: true });

    originBare = path.join(tmpRoot, 'origin.git');
    mkdirSync(originBare, { recursive: true });
    execSync('git init --bare --initial-branch=main', { cwd: originBare, stdio: 'pipe' });

    sourceRepo = path.join(tmpRoot, 'source');
    execSync(`git clone --quiet "${originBare}" "${sourceRepo}"`, { stdio: 'pipe' });
    git(sourceRepo, 'config user.email "test@example.com"');
    git(sourceRepo, 'config user.name "Test"');
    git(sourceRepo, 'checkout -b main');
    writeFileSync(path.join(sourceRepo, 'README.md'), 'v1\n');
    git(sourceRepo, 'add README.md');
    git(sourceRepo, 'commit -m "initial"');
    git(sourceRepo, 'push -u origin main');

    sessionId = `sess${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    createdWorkspace = null;
  });

  afterEach(() => {
    if (createdWorkspace) {
      removeWorkspace(createdWorkspace);
    }
    try {
      const wsParent = path.join(homedir(), '.agent-hub', 'workspaces', path.basename(sourceRepo));
      if (existsSync(wsParent)) {
        rmSync(wsParent, { recursive: true, force: true });
      }
    } catch {
      /* best-effort */
    }
    if (existsSync(tmpRoot)) {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  function makeSession(workspacePath: string | null = null): SessionRow {
    return {
      id: sessionId,
      agent_id: 'test-agent',
      name: 'test',
      engine: 'claude',
      model: 'claude-sonnet-4-20250514',
      engine_session_id: null,
      use_worktree: 1,
      worktree_path: workspacePath,
      worktree_branch: null,
      git_worktree_detected: 0,
      changes_ready: null,
      stale_pr_notified_at: null,
      ask_mode: 0,
      cron_id: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      deleted_at: null,
    };
  }

  it('registers Claude settings files in .git/info/exclude, so an injected settings.json stays out of git status', async () => {
    const persist = vi.fn();

    const clonePath = await ensureSessionWorkspace(
      makeSession(null),
      sourceRepo,
      'test-agent',
      persist,
    );
    createdWorkspace = clonePath;

    const excludePath = path.join(clonePath, '.git', 'info', 'exclude');
    expect(existsSync(excludePath)).toBe(true);
    const exclude = readFileSync(excludePath, 'utf-8');
    expect(exclude).toContain('.claude/settings.json');
    expect(exclude).toContain('.claude/settings.local.json');
    expect(exclude).toContain('.claude/mcp-config.json');

    // The whole point: a written .claude/settings.json is invisible to git status.
    mkdirSync(path.join(clonePath, '.claude'), { recursive: true });
    writeFileSync(path.join(clonePath, '.claude', 'settings.json'), '{"hooks":{}}\n');
    const status = git(clonePath, 'status --porcelain');
    expect(status).not.toContain('.claude/settings.json');
  });

  it('does not duplicate the managed block across reuse', async () => {
    const persist = vi.fn();

    const clonePath = await ensureSessionWorkspace(
      makeSession(null),
      sourceRepo,
      'test-agent',
      persist,
    );
    createdWorkspace = clonePath;

    // Second ensure hits the reuse path and re-runs the exclude helper.
    await ensureSessionWorkspace(makeSession(null), sourceRepo, 'test-agent', persist);

    const exclude = readFileSync(path.join(clonePath, '.git', 'info', 'exclude'), 'utf-8');
    const markerCount = exclude.split('# agent-hub: keep Agent-Hub-injected').length - 1;
    expect(markerCount).toBe(1);
  });
});
