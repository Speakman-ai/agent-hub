/**
 * Client-side detection + copy for the server's premature-Done move guard
 * (`server/kanban-premature-done.ts`).
 *
 * The board move endpoint answers `409 { error: 'premature_done_move' }`
 * when a card is dragged into a Done column while its linked session is
 * Finalize-gated and has not pushed yet. Both API layers
 * (`client/src/utils/api.ts`, `mobile/src/utils/api.ts`) surface non-OK
 * responses as `Error("<status>: <body.error>")`, so the marker string in
 * the message is the contract both UIs match on to offer the
 * `force: true` retry instead of a silent snap-back.
 */
export const PREMATURE_DONE_MOVE_ERROR = 'premature_done_move';

export const PREMATURE_DONE_MOVE_TITLE = 'Done is written on merge';

export const PREMATURE_DONE_MOVE_EXPLANATION =
  'This card is linked to a session that has not pushed through Finalize yet. ' +
  'The platform moves the card to Done automatically when the merge lands. ' +
  'Move it to Done anyway?';

/** True when a failed move was rejected by the premature-Done guard. */
export function isPrematureDoneMoveError(err: unknown): boolean {
  if (err instanceof Error) return err.message.includes(PREMATURE_DONE_MOVE_ERROR);
  return typeof err === 'string' && err.includes(PREMATURE_DONE_MOVE_ERROR);
}
