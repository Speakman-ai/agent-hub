/** True when a project response is complete enough to open project-scoped UI. */
export function isCompleteProject(
  project: any,
  projectId: string,
  hostOnAgentHub = true,
): boolean {
  return (
    !!project &&
    typeof project === 'object' &&
    !Array.isArray(project) &&
    project.id === projectId &&
    typeof project.name === 'string' &&
    project.name.trim().length > 0 &&
    (!hostOnAgentHub ||
      (typeof project.cwd === 'string' && project.cwd.trim().length > 0))
  );
}
