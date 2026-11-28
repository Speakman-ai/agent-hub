/** Shape of `GET /api/sessions/:sessionId/epic-close-impact`. */
export interface EpicCloseImpact {
  epic: { id: string; name: string } | null;
  runningWorkers: Array<{
    sessionId: string;
    sessionName: string;
    cardId: string;
    cardTitle: string;
  }>;
  runningWorkerCount: number;
}

/**
 * Confirm text for archiving a session that manages an epic with running
 * workers, or null when archiving it stops nothing and needs no prompt.
 */
export function epicCloseConfirmMessage(impact: EpicCloseImpact | null | undefined): string | null {
  if (!impact?.epic) return null;
  const count = impact.runningWorkerCount ?? impact.runningWorkers?.length ?? 0;
  if (count <= 0) return null;
  const sessions = count === 1 ? '1 running worker session' : `${count} running worker sessions`;
  return (
    `This session manages the epic "${impact.epic.name}". Archiving it stops the epic and ` +
    `${sessions}. Their cards stay where they are and no commits are lost. Are you sure?`
  );
}

/** Shape of `GET /api/agents/:agentId/sessions/epic-close-impact`. */
export interface BulkEpicCloseImpact {
  epics: Array<{ id: string; name: string }>;
  runningWorkers: EpicCloseImpact['runningWorkers'];
  runningWorkerCount: number;
}

/**
 * Confirm text for a bulk archive that would stop epics with running workers,
 * or null when it stops none.
 */
export function bulkEpicCloseConfirmMessage(
  impact: BulkEpicCloseImpact | null | undefined,
): string | null {
  const epics = impact?.epics ?? [];
  const count = impact?.runningWorkerCount ?? impact?.runningWorkers?.length ?? 0;
  if (epics.length === 0 || count <= 0) return null;
  const names = epics.map((e) => `"${e.name}"`).join(', ');
  const epicWord = epics.length === 1 ? 'the epic' : 'the epics';
  const sessions = count === 1 ? '1 running worker session' : `${count} running worker sessions`;
  return (
    `This archives the session managing ${epicWord} ${names}, which stops ` +
    `${epics.length === 1 ? 'it' : 'them'} and ${sessions}. Their cards stay where they are and no commits are lost. Are you sure?`
  );
}
