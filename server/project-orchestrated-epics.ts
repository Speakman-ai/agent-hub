import type { Project } from './types.js';

/**
 * Whether the project runs its autonomous epics through an epic manager
 * thread (`server/epic-manager.ts`). Off unless the project opts in, so every
 * other project keeps the per-card dispatch in `server/autonomous.ts`.
 */
export function orchestratedEpicsEnabled(
  project: Pick<Project, 'orchestratedEpics'> | null | undefined,
): boolean {
  return project?.orchestratedEpics === true;
}

/**
 * The board's epic rows as clients see them. Manager presence only means
 * something on projects with orchestrated epics, so elsewhere a leftover
 * manager link reports no manager (`manager_state: 'none'`).
 */
export function presentEpicManagerFields<
  T extends { manager_agent_id?: string | null; manager_state?: string },
>(project: Pick<Project, 'orchestratedEpics'> | null | undefined, epics: T[]): T[] {
  if (orchestratedEpicsEnabled(project)) return epics;
  return epics.map((epic) =>
    epic.manager_state === undefined && epic.manager_agent_id === undefined
      ? epic
      : { ...epic, manager_agent_id: null, manager_state: 'none' },
  );
}
