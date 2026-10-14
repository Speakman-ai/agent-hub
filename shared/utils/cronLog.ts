/** Identifies one expanded run in the Settings cron list. */
export function cronLogKey(cronId: number | string, logId: number | string): string {
  return `${cronId}:${logId}`;
}

/**
 * Key of the newest run for a cron, or null when it has never run. Logs come
 * from `GET /api/crons/:id/logs`, which returns newest first.
 */
export function latestCronLogKey(
  cronId: number | string,
  logs: ReadonlyArray<{ id: number | string }> | null | undefined,
): string | null {
  const latest = logs?.[0];
  return latest ? cronLogKey(cronId, latest.id) : null;
}
