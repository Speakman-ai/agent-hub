/**
 * errors.ts — NativePrError lives in its own dependency-free module so
 * route files (pr-list.ts, pr-actions.ts) can `instanceof` it without
 * importing the full service graph (store → db, card-on-merge → board,
 * git-read → child_process), which breaks tests that partially mock
 * `child_process`.
 */

export class NativePrError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'NativePrError';
  }
}
