/**
 * Keys whose desktop computers are being deleted along with their profile.
 *
 * Marked before the disks are torn down and cleared only after the profile
 * row is gone. Each deletion also bumps the key's generation, which never
 * goes back down: a start records the generation when it arrives and is
 * refused if it changed by the time the start gets the lifecycle lock. That
 * catches starts queued behind the teardown that only reach the lock after
 * the mark has been cleared.
 */
import type { DesktopComputerKey } from './desktop-runtime.js';

const pending = new Map<string, number>();
const generations = new Map<string, number>();

function id(key: DesktopComputerKey): string {
  return JSON.stringify([key.userId, key.agentId, key.projectId]);
}

export class DesktopComputerDeletingError extends Error {
  readonly code = 'desktop_computer_deleting';
  constructor() {
    super('This desktop computer is being deleted with its browser profile; try again afterwards');
    this.name = 'DesktopComputerDeletingError';
  }
}

/** Mark `key` as deleting. Returns the function that clears the mark. */
export function beginDesktopDeletion(key: DesktopComputerKey): () => void {
  const k = id(key);
  pending.set(k, (pending.get(k) ?? 0) + 1);
  generations.set(k, (generations.get(k) ?? 0) + 1);
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    const n = (pending.get(k) ?? 1) - 1;
    if (n <= 0) pending.delete(k);
    else pending.set(k, n);
  };
}

export function isDesktopDeletionPending(key: DesktopComputerKey): boolean {
  return pending.has(id(key));
}

/** How many deletions have begun for `key`. Compare across an await to spot one. */
export function desktopDeletionGeneration(key: DesktopComputerKey): number {
  return generations.get(id(key)) ?? 0;
}

export interface DesktopDeletionGuard {
  isPending(key: DesktopComputerKey): boolean;
  generation(key: DesktopComputerKey): number;
}

export const desktopDeletionGuard: DesktopDeletionGuard = {
  isPending: isDesktopDeletionPending,
  generation: desktopDeletionGeneration,
};
