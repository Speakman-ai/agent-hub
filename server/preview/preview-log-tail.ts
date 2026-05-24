/**
 * Shared preview boot-log retention — compose + legacy spawn runtimes.
 */

/** Default lines kept in memory and rebroadcast on WS `preview_starting`. */
export const DEFAULT_PREVIEW_LOG_TAIL_LINES = 4_000;

/** Append a line and drop the oldest rows when over `maxLines`. */
export function appendPreviewLogTailLine(tail: string[], line: string, maxLines: number): void {
  tail.push(line);
  if (tail.length > maxLines) {
    tail.splice(0, tail.length - maxLines);
  }
}

/** Return the last `maxLines` entries (for docker compose logs pull). */
export function trimPreviewLogTail(tail: string[], maxLines: number): string[] {
  if (tail.length <= maxLines) return tail;
  return tail.slice(-maxLines);
}
