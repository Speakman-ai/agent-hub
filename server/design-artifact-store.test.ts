import { describe, it, expect } from 'vitest';
import path from 'path';
import {
  resolveDesignArtifactLocation,
  resolveDesignLocationForServe,
  worktreeDesignLocation,
  dataDirDesignLocation,
  DESIGN_DATA_DIR_SUBDIR,
} from './design-artifact-store.js';
import type { Project } from './types.js';

const devProject = { id: 'p1', name: 'Dev', cwd: '/repo' } as Project;
const workflowProject = { id: 'p2', name: 'Flow', cwd: '/repo', mode: 'workflow' } as Project;
const DATA = '/data';

describe('worktreeDesignLocation', () => {
  it('roots at <worktree>/design, anchored at the worktree parent', () => {
    const loc = worktreeDesignLocation('/ws/session-abc');
    expect(loc.kind).toBe('worktree');
    expect(loc.root).toBe(path.join('/ws/session-abc', 'design'));
    expect(loc.safeAnchorParent).toBe('/ws');
  });
});

describe('dataDirDesignLocation', () => {
  it('roots at <dataDir>/design-sessions/<id>, anchored at design-sessions', () => {
    const loc = dataDirDesignLocation(DATA, 'sess-1');
    expect(loc.kind).toBe('data-dir');
    expect(loc.root).toBe(path.join(DATA, DESIGN_DATA_DIR_SUBDIR, 'sess-1'));
    expect(loc.safeAnchorParent).toBe(path.join(DATA, DESIGN_DATA_DIR_SUBDIR));
  });
});

describe('resolveDesignArtifactLocation (project-aware)', () => {
  it('returns null when the session is not in design mode', () => {
    expect(
      resolveDesignArtifactLocation({
        session: { session_mode: 'chat', worktree_path: '/ws/s1' },
        sessionId: 's1',
        project: devProject,
        dataDir: DATA,
      }),
    ).toBeNull();
  });

  it('uses the worktree store for a dev session with a worktree', () => {
    const loc = resolveDesignArtifactLocation({
      session: { session_mode: 'design', worktree_path: '/ws/s1' },
      sessionId: 's1',
      project: devProject,
      dataDir: DATA,
    });
    expect(loc?.kind).toBe('worktree');
    expect(loc?.root).toBe(path.join('/ws/s1', 'design'));
  });

  it('uses the data-dir store for a workflow session with no worktree', () => {
    const loc = resolveDesignArtifactLocation({
      session: { session_mode: 'design', worktree_path: null },
      sessionId: 's2',
      project: workflowProject,
      dataDir: DATA,
    });
    expect(loc?.kind).toBe('data-dir');
    expect(loc?.root).toBe(path.join(DATA, DESIGN_DATA_DIR_SUBDIR, 's2'));
  });

  it('returns null for a dev session with no worktree (design cannot run)', () => {
    expect(
      resolveDesignArtifactLocation({
        session: { session_mode: 'design', worktree_path: null },
        sessionId: 's3',
        project: devProject,
        dataDir: DATA,
      }),
    ).toBeNull();
  });

  it('prefers the worktree even on a workflow project when one exists', () => {
    const loc = resolveDesignArtifactLocation({
      session: { session_mode: 'design', worktree_path: '/ws/s4' },
      sessionId: 's4',
      project: workflowProject,
      dataDir: DATA,
    });
    expect(loc?.kind).toBe('worktree');
  });
});

describe('resolveDesignLocationForServe (project-less mount)', () => {
  it('serves from the worktree when the session has one', () => {
    const loc = resolveDesignLocationForServe({
      session: { worktree_path: '/ws/s1' },
      sessionId: 's1',
      dataDir: DATA,
    });
    expect(loc.kind).toBe('worktree');
    expect(loc.root).toBe(path.join('/ws/s1', 'design'));
  });

  it('falls back to the data-dir store when the session has no worktree', () => {
    const loc = resolveDesignLocationForServe({
      session: { worktree_path: '' },
      sessionId: 's2',
      dataDir: DATA,
    });
    expect(loc.kind).toBe('data-dir');
    expect(loc.root).toBe(path.join(DATA, DESIGN_DATA_DIR_SUBDIR, 's2'));
  });
});
