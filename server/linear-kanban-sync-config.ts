/**
 * Operator config for the `linear-kanban-sync` cron (surveytracker ↔ Linear MCS).
 * Column names are resolved at runtime against the project board so stale UUIDs
 * in the legacy agent prompt cannot break sync.
 */

export const LINEAR_KANBAN_SYNC_CRON_NAME = 'linear-kanban-sync';

/** Per-cron wall timeout when unset in the DB (45 minutes). */
export const LINEAR_KANBAN_SYNC_DEFAULT_TIMEOUT_MS = 45 * 60 * 1000;

export const LINEAR_REQUEST_TIMEOUT_MS = 30_000;

export interface LinearKanbanSyncProjectConfig {
  projectId: string;
  teamKey: string;
  /** Linear workflow state names to pull (Done/Canceled/Duplicate excluded). */
  linearActiveStates: string[];
  /** Linear state name → kanban column name. */
  linearStateToColumn: Record<string, string>;
  /** Kanban column name used when pushing "done" to Linear (not synced inbound). */
  doneColumnName: string;
}

export const SURVEYTRACKER_LINEAR_SYNC: LinearKanbanSyncProjectConfig = {
  projectId: 'surveytracker',
  teamKey: 'MCS',
  linearActiveStates: [
    'New Issues',
    'On Hold',
    'Blocked/Awaiting Feedback',
    'Backlog for Agents',
    'In Progress',
    'In Review',
  ],
  linearStateToColumn: {
    'New Issues': 'To Do',
    'On Hold': 'To Do',
    'Blocked/Awaiting Feedback': 'To Do',
    'Backlog for Agents': 'To Do',
    'In Progress': 'In Progress',
    'In Review': 'Review',
  },
  doneColumnName: 'Done',
};

export function linearKanbanSyncConfigForCron(
  cronProjectId: string | null,
): LinearKanbanSyncProjectConfig | null {
  if (cronProjectId === SURVEYTRACKER_LINEAR_SYNC.projectId) {
    return SURVEYTRACKER_LINEAR_SYNC;
  }
  return null;
}
