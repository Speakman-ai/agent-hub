/**
 * Source-shape contract: feature integration branches are prepared lazily when
 * the first worktree-backed code session starts, not when the operator saves
 * the feature settings form.
 */

import './setup.js';
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

describe('feature branch lazy creation contract', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const boardSrc = readFileSync(path.resolve(here, '..', 'routes', 'board.ts'), 'utf8');
  const indexSrc = readFileSync(path.resolve(here, '..', 'index.ts'), 'utf8');

  it('does not create the remote branch while saving feature settings', () => {
    expect(boardSrc).not.toMatch(/ensureOperatorBaseBranch\(/);
  });

  it('prepares the branch from ensureWorktree before the session workspace is created', () => {
    expect(indexSrc).toMatch(
      /import\s*\{\s*ensureOperatorBaseBranch\s*\}\s*from\s*['"]\.\/autonomous\.js['"]/,
    );
    const ensureWorktreeStart = indexSrc.indexOf('async function ensureWorktree(');
    const ensureCall = indexSrc.indexOf(
      'await ensureOperatorBaseBranch(project, trimmedPrBase',
      ensureWorktreeStart,
    );
    const workspaceCall = indexSrc.indexOf('return ensureSessionWorkspace(', ensureWorktreeStart);
    expect(ensureWorktreeStart).toBeGreaterThanOrEqual(0);
    expect(ensureCall).toBeGreaterThan(ensureWorktreeStart);
    expect(workspaceCall).toBeGreaterThan(ensureCall);
  });
});
