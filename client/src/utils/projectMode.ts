/**
 * @param {{ mode?: string } | null | undefined} project
 * @returns {boolean}
 */
export function isWorkflowProject(project: any) {
  return project?.mode === 'workflow';
}
