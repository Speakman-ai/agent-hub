/**
 * Prevent duplicate workflow list loads for one project while allowing a
 * project switch to invalidate the older response.
 */
export interface WorkflowLoadRequest {
  projectId: string;
  requestId: number;
}

export interface WorkflowBeginOptions {
  /**
   * When true, a call for the SAME key supersedes an in-flight request instead
   * of being deduped away. The older request's `isCurrent` immediately becomes
   * false, so its late response is ignored and it can never wedge polling.
   * Used by the detail poll, where each tick must be able to re-arm even if a
   * prior request is still resolving.
   */
  allowReplace?: boolean;
}

export function createWorkflowLoadGate() {
  let nextRequestId = 0;
  let active: WorkflowLoadRequest | null = null;

  const isCurrent = (request: WorkflowLoadRequest): boolean =>
    active?.requestId === request.requestId && active?.projectId === request.projectId;

  return {
    begin(projectId: string, options: WorkflowBeginOptions = {}): WorkflowLoadRequest | null {
      if (!options.allowReplace && active?.projectId === projectId) return null;
      active = { projectId, requestId: ++nextRequestId };
      return active;
    },

    isCurrent,

    finish(request: WorkflowLoadRequest): void {
      if (isCurrent(request)) active = null;
    },
  };
}
