/**
 * Cascade — when a user is deleted, sweep their private projects.
 *
 * A private project is by definition unreachable to everyone except its
 * owner; if the owner ceases to exist, the project becomes orphaned with
 * no way for any non-Owner user to interact with it. Per the design
 * decision (call (a)), we auto-delete private projects when their owner is
 * removed.
 *
 * Shared projects owned by the deleted user survive — they're visible to
 * the whole org, so losing the owner is a metadata gap, not a lockout.
 * Their `ownerUserId` stays pointing at the deleted id; a follow-up could
 * reassign to the actor that performed the deletion, but that's out of
 * scope for the visibility feature.
 *
 * This helper is intentionally side-effect-only — no JSON return, no
 * thrown errors for partial failure. Each project delete is attempted
 * independently; one failure does not block the sweep. The caller logs.
 */

import type { Project } from './types.js';
import type { Stmts } from './types.js';
import { deleteAllPreviewSecretsForProject } from './preview/preview-secrets-store.js';

export interface CascadeDeps {
  stmts: Stmts;
  getProjects: () => Project[];
  saveProjects: () => void;
}

export interface CascadeResult {
  deletedProjectIds: string[];
  /** Shared projects that were owned by the deleted user; left alone but reported for audit. */
  orphanedSharedProjectIds: string[];
}

/**
 * Delete all project-scoped rows from the database for a single project.
 * Used by both the DELETE /api/projects/:projectId route handler and the
 * user-deletion cascade below — keep in sync with the database schema.
 *
 * If you add a new project-scoped table, add its statement here; both
 * delete paths will pick it up automatically.
 */
export function deleteProjectScopedRows(stmts: Stmts, project: Project): void {
  try {
    deleteAllPreviewSecretsForProject(project.id);
  } catch (err) {
    console.error(
      `[deleteProjectScopedRows] Failed to delete project secrets for "${project.id}":`,
      (err as Error).message,
    );
  }
  stmts.deleteEscalationsByProject.run(project.id);
  stmts.deleteNotesByProject.run(project.id);
  stmts.deleteWikiPagesByProject.run(project.id);
  stmts.deleteBoardsByProject.run(project.id);
  stmts.deleteWorkflowsByProject.run(project.id);
  stmts.deleteThreadsByProject.run(project.id);
  stmts.deleteCronsByProject.run(project.id);
  for (const agent of project.agents ?? []) {
    stmts.deleteSessionsByAgent.run(agent.id);
  }
}

/**
 * Delete every private project whose `ownerUserId` matches the given
 * userId. Returns the ids that were deleted plus any shared projects
 * that survived (caller may log).
 */
export function cascadeDeleteUserPrivateProjects(deps: CascadeDeps, userId: string): CascadeResult {
  const projects = deps.getProjects();
  const deletedProjectIds: string[] = [];
  const orphanedSharedProjectIds: string[] = [];

  // Iterate backwards because we splice from the array as we go.
  for (let i = projects.length - 1; i >= 0; i--) {
    const p = projects[i];
    if (p.ownerUserId !== userId) continue;

    // Default visibility is `'shared'` — only sweep `private` projects.
    if (p.visibility !== 'private') {
      orphanedSharedProjectIds.push(p.id);
      continue;
    }

    try {
      deleteProjectScopedRows(deps.stmts, p);
      projects.splice(i, 1);
      deletedProjectIds.push(p.id);
    } catch (err) {
      console.error(
        `[project-owner-cascade] Failed to delete private project "${p.id}":`,
        (err as Error).message,
      );
    }
  }

  if (deletedProjectIds.length > 0) {
    try {
      deps.saveProjects();
    } catch (err) {
      console.error(
        '[project-owner-cascade] Failed to persist projects.json after cascade:',
        (err as Error).message,
      );
    }
  }

  return { deletedProjectIds, orphanedSharedProjectIds };
}
