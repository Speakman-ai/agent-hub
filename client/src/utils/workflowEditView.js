/** @type {string} */
export const WORKFLOW_EDIT_PREFIX = 'workflow-edit:';

/**
 * @param {string} projectId
 * @param {string} workflowId — server id or literal `new`
 */
export function toWorkflowEditView(projectId, workflowId) {
  return `${WORKFLOW_EDIT_PREFIX}${projectId}/${workflowId}`;
}

/**
 * @param {string|undefined|null} view
 * @returns {{ projectId: string, workflowId: string } | null}
 */
export function parseWorkflowEditView(view) {
  if (!view || typeof view !== 'string' || !view.startsWith(WORKFLOW_EDIT_PREFIX)) return null;
  const rest = view.slice(WORKFLOW_EDIT_PREFIX.length);
  const i = rest.indexOf('/');
  if (i <= 0 || i >= rest.length - 1) return null;
  return { projectId: rest.slice(0, i), workflowId: rest.slice(i + 1) };
}
