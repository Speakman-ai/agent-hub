import type Database from 'better-sqlite3';
import { AutopilotStore } from './store.js';

/**
 * Skip push/schedule deploys for an environment while an Autopilot run owns it.
 * The run's unattended authority applies only to that opted-in experiment
 * target; duplicate triggers for the same cycle/revision are dropped rather
 * than racing the Autopilot-owned pipeline.
 */
export function shouldSkipAutopilotDuplicateTrigger(input: {
  projectId: string;
  environment: string;
  ref?: string | null;
  db: Database.Database;
}): { skip: boolean; reason?: string } {
  let store: AutopilotStore;
  try {
    store = new AutopilotStore(input.db);
  } catch {
    return { skip: false };
  }
  const run = store
    .listActiveRuns()
    .find((r) => r.projectId === input.projectId && r.targetId === input.environment);
  if (!run) return { skip: false };

  const cycle = store.getCycle(run.id, run.cycleNumber);
  const intended = cycle?.testedCommitSha ?? null;
  if (input.ref && intended && input.ref === intended) {
    return {
      skip: true,
      reason: `Autopilot run ${run.id} already owns ${input.environment} at ${intended}`,
    };
  }
  return {
    skip: true,
    reason: `Autopilot run ${run.id} owns experiment target ${input.environment}`,
  };
}
