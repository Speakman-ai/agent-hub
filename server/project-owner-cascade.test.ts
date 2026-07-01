/**
 * Unit tests for `cascadeDeleteUserPrivateProjects`.
 *
 * The cascade is the one piece of the visibility feature that has
 * irreversible side effects (it deletes projects). It must:
 *   - Delete private projects owned by the deleted user.
 *   - Leave shared projects untouched (they remain visible to other org
 *     members; ownership goes stale, which the wider org handles).
 *   - Persist `projects.json` exactly once at the end, not per-project.
 *   - Survive a single project's delete throwing — others still run.
 *
 * We mock the `Stmts` API at the call-site level rather than spinning up
 * the real DB; the cascade dispatches to prepared statements that the
 * caller supplies. That keeps this test tightly focused on the cascade logic.
 */

import { describe, it, expect, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import path from 'path';
import { cascadeDeleteUserPrivateProjects } from './project-owner-cascade.js';
import { resolveProjectSkillsDir } from './project-skill-paths.js';
import type { Project, Stmts } from './types.js';

function makeStmts(
  overrides: Partial<Record<keyof Stmts, { run: (...args: unknown[]) => unknown }>> = {},
): Stmts {
  // Every delete-by-project statement is a no-op spy unless the test
  // wants to inspect it. Cast at the boundary; the cascade only touches
  // the keys listed in `deleteProjectRow`.
  const noop = { run: vi.fn() };
  const all = {
    deleteEscalationsByProject: noop,
    deleteSupportTicketsByProject: noop,
    deleteNotesByProject: noop,
    deleteWikiPagesByProject: noop,
    deleteWebhookConfigsByProject: noop,
    deleteBoardsByProject: noop,
    deleteWorkflowsByProject: noop,
    deleteThreadsByProject: noop,
    deleteRoomsByProject: noop,
    deleteCronsByProject: noop,
    deleteSessionsByAgent: noop,
    ...overrides,
  };
  return all as unknown as Stmts;
}

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: overrides.id ?? 'p',
    name: 'p',
    cwd: '/tmp/p',
    ahw: '/tmp/p-ahw',
    agents: [],
    ...overrides,
  };
}

describe('cascadeDeleteUserPrivateProjects', () => {
  it('deletes private projects owned by the user', () => {
    const projects: Project[] = [
      makeProject({ id: 'p1', visibility: 'private', ownerUserId: 'u1' }),
      makeProject({ id: 'p2', visibility: 'private', ownerUserId: 'u1' }),
    ];
    const saveProjects = vi.fn();
    const result = cascadeDeleteUserPrivateProjects(
      { stmts: makeStmts(), getProjects: () => projects, saveProjects },
      'u1',
    );
    expect(result.deletedProjectIds.sort()).toEqual(['p1', 'p2']);
    expect(projects).toHaveLength(0);
    expect(saveProjects).toHaveBeenCalledTimes(1);
  });

  it('removes canonical project skill stores for deleted private projects', () => {
    const project = makeProject({
      id: `skill-cleanup-${Date.now()}`,
      visibility: 'private',
      ownerUserId: 'u1',
    });
    const skillsDir = resolveProjectSkillsDir(project);
    rmSync(skillsDir, { recursive: true, force: true });
    mkdirSync(path.join(skillsDir, 'owned-skill'), { recursive: true });
    writeFileSync(path.join(skillsDir, 'owned-skill', 'SKILL.md'), '---\nname: Owned\n---\n');

    try {
      const projects: Project[] = [project];
      const result = cascadeDeleteUserPrivateProjects(
        { stmts: makeStmts(), getProjects: () => projects, saveProjects: vi.fn() },
        'u1',
      );

      expect(result.deletedProjectIds).toEqual([project.id]);
      expect(existsSync(skillsDir)).toBe(false);
    } finally {
      rmSync(skillsDir, { recursive: true, force: true });
    }
  });

  it('leaves shared projects in place and reports them as orphaned', () => {
    const projects: Project[] = [
      makeProject({ id: 'shared1', visibility: 'shared', ownerUserId: 'u1' }),
      makeProject({ id: 'priv1', visibility: 'private', ownerUserId: 'u1' }),
      // Pre-feature projects without a visibility field are treated as shared.
      makeProject({ id: 'legacy', ownerUserId: 'u1' }),
    ];
    const saveProjects = vi.fn();
    const result = cascadeDeleteUserPrivateProjects(
      { stmts: makeStmts(), getProjects: () => projects, saveProjects },
      'u1',
    );
    expect(result.deletedProjectIds).toEqual(['priv1']);
    expect(result.orphanedSharedProjectIds.sort()).toEqual(['legacy', 'shared1']);
    expect(projects.map((p) => p.id).sort()).toEqual(['legacy', 'shared1']);
  });

  it('does not touch projects owned by other users', () => {
    const projects: Project[] = [
      makeProject({ id: 'mine', visibility: 'private', ownerUserId: 'u1' }),
      makeProject({ id: 'yours', visibility: 'private', ownerUserId: 'u2' }),
      makeProject({ id: 'shared-yours', visibility: 'shared', ownerUserId: 'u2' }),
    ];
    const saveProjects = vi.fn();
    const result = cascadeDeleteUserPrivateProjects(
      { stmts: makeStmts(), getProjects: () => projects, saveProjects },
      'u1',
    );
    expect(result.deletedProjectIds).toEqual(['mine']);
    expect(result.orphanedSharedProjectIds).toEqual([]);
    expect(projects.map((p) => p.id).sort()).toEqual(['shared-yours', 'yours']);
  });

  it('no-op when the user owns nothing — saveProjects not called', () => {
    const projects: Project[] = [
      makeProject({ id: 'other', visibility: 'private', ownerUserId: 'u2' }),
    ];
    const saveProjects = vi.fn();
    const result = cascadeDeleteUserPrivateProjects(
      { stmts: makeStmts(), getProjects: () => projects, saveProjects },
      'u1',
    );
    expect(result.deletedProjectIds).toEqual([]);
    expect(saveProjects).not.toHaveBeenCalled();
    expect(projects).toHaveLength(1);
  });

  it('continues sweeping when one project delete throws', () => {
    const projects: Project[] = [
      makeProject({ id: 'p1', visibility: 'private', ownerUserId: 'u1' }),
      makeProject({ id: 'p2', visibility: 'private', ownerUserId: 'u1' }),
    ];
    // Make the very first delete-by-project call throw exactly once, on
    // the first project the cascade reaches. The cascade iterates the
    // array back-to-front, so the first project it touches is `p2`.
    const failingNotes = {
      run: vi.fn().mockImplementationOnce(() => {
        throw new Error('boom');
      }),
    };
    const saveProjects = vi.fn();
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = cascadeDeleteUserPrivateProjects(
        {
          stmts: makeStmts({ deleteNotesByProject: failingNotes }),
          getProjects: () => projects,
          saveProjects,
        },
        'u1',
      );
      // One survived, one was deleted — but specifically the second one
      // (p1) was reached after p2 failed.
      expect(result.deletedProjectIds).toEqual(['p1']);
      expect(projects.map((p) => p.id)).toEqual(['p2']);
      expect(saveProjects).toHaveBeenCalledTimes(1);
      expect(consoleErr).toHaveBeenCalled();
    } finally {
      consoleErr.mockRestore();
    }
  });

  it('iterates the project list in reverse so splices stay consistent', () => {
    // Regression guard for the obvious bug: forward iteration + splice
    // skips entries. With three consecutive private projects, forward
    // iteration would only delete two of them.
    const projects: Project[] = [
      makeProject({ id: 'a', visibility: 'private', ownerUserId: 'u1' }),
      makeProject({ id: 'b', visibility: 'private', ownerUserId: 'u1' }),
      makeProject({ id: 'c', visibility: 'private', ownerUserId: 'u1' }),
    ];
    const result = cascadeDeleteUserPrivateProjects(
      { stmts: makeStmts(), getProjects: () => projects, saveProjects: vi.fn() },
      'u1',
    );
    expect(result.deletedProjectIds.sort()).toEqual(['a', 'b', 'c']);
    expect(projects).toHaveLength(0);
  });
});
