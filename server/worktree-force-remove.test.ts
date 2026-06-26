/**
 * Tests for `forceRemoveWorkspaceTree` — the async, EACCES-resilient removal
 * helper behind the stale-clone sweep and the archived-session purge.
 *
 * Focus is the SAFETY guard (never delete outside `WORKSPACES_ROOT`) and the
 * "true only when something was actually unlinked" contract. The privileged
 * docker escalation is disabled in tests via `AGENT_HUB_DISABLE_FORCE_RM_DOCKER`
 * (set in `test/setup.ts`), so these exercise stage 1 (`rm -rf` as the node
 * user) against real node-owned temp dirs.
 */
import './test/setup.js';

import { mkdirSync, writeFileSync, existsSync, rmSync } from 'fs';
import path from 'path';
import os from 'os';

import { WORKSPACES_ROOT, forceRemoveWorkspaceTree } from './worktree.js';

describe('forceRemoveWorkspaceTree', () => {
  const created: string[] = [];

  afterEach(() => {
    for (const p of created.splice(0)) {
      try {
        if (existsSync(p)) rmSync(p, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  });

  function makeUnderRoot(name: string): string {
    const dir = path.join(
      WORKSPACES_ROOT,
      `${name}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
    );
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'README'), 'fixture\n');
    created.push(dir);
    return dir;
  }

  it('removes an existing dir under the managed root and returns true', async () => {
    const dir = makeUnderRoot('force-rm-happy');
    expect(existsSync(dir)).toBe(true);

    const removed = await forceRemoveWorkspaceTree(dir);

    expect(removed).toBe(true);
    expect(existsSync(dir)).toBe(false);
  });

  it('refuses a path OUTSIDE the managed root and leaves it untouched', async () => {
    const outside = path.join(
      os.tmpdir(),
      `force-rm-outside-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
    );
    mkdirSync(outside, { recursive: true });
    created.push(outside);

    const removed = await forceRemoveWorkspaceTree(outside);

    expect(removed).toBe(false);
    // Critical: the guard must not have deleted a path outside the root.
    expect(existsSync(outside)).toBe(true);
  });

  it('rejects a path that merely shares the root as a string prefix (sibling dir)', async () => {
    // `WORKSPACES_ROOT` + "-evil" starts-with the root string but is NOT inside
    // it; the `+ path.sep` guard must reject it.
    const sibling = `${WORKSPACES_ROOT}-evil-${process.pid}`;
    mkdirSync(sibling, { recursive: true });
    created.push(sibling);

    const removed = await forceRemoveWorkspaceTree(sibling);

    expect(removed).toBe(false);
    expect(existsSync(sibling)).toBe(true);
  });

  it('returns false for empty input', async () => {
    expect(await forceRemoveWorkspaceTree('')).toBe(false);
  });

  it('returns false for a non-existent path under the root (nothing unlinked)', async () => {
    const missing = path.join(WORKSPACES_ROOT, `does-not-exist-${process.pid}`);
    expect(existsSync(missing)).toBe(false);
    expect(await forceRemoveWorkspaceTree(missing)).toBe(false);
  });
});
