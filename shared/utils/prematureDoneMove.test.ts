import { describe, expect, it } from 'vitest';
import { isPrematureDoneMoveError, PREMATURE_DONE_MOVE_ERROR } from './prematureDoneMove';

describe('isPrematureDoneMoveError', () => {
  it('matches the fetchJSON error shape both clients throw', () => {
    // client/src/utils/api.ts and mobile/src/utils/api.ts both throw
    // `Error("<status>: <body.error>")` for non-OK responses.
    expect(isPrematureDoneMoveError(new Error(`409: ${PREMATURE_DONE_MOVE_ERROR}`))).toBe(true);
  });

  it('matches plain strings carrying the marker', () => {
    expect(isPrematureDoneMoveError(`409: ${PREMATURE_DONE_MOVE_ERROR}`)).toBe(true);
  });

  it('rejects other move failures', () => {
    expect(isPrematureDoneMoveError(new Error('409: some_other_conflict'))).toBe(false);
    expect(isPrematureDoneMoveError(new Error('API error: 500'))).toBe(false);
    expect(isPrematureDoneMoveError(new Error("404: Column not found on this card's board"))).toBe(
      false,
    );
  });

  it('rejects non-error values', () => {
    expect(isPrematureDoneMoveError(undefined)).toBe(false);
    expect(isPrematureDoneMoveError(null)).toBe(false);
    expect(isPrematureDoneMoveError(409)).toBe(false);
    expect(isPrematureDoneMoveError({ error: PREMATURE_DONE_MOVE_ERROR })).toBe(false);
  });
});
