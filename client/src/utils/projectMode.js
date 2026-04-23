/**
 * @param {{ mode?: string } | null | undefined} project
 * @returns {boolean}
 */
export function isWorkflowProject(project) {
  return project?.mode === 'workflow';
}
