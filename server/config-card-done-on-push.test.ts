/**
 * Regression: the `cardDoneOnPush` config flag must default to OFF.
 *
 * "Done means merged, not pushed" — a successful push parks the linked kanban
 * card in Review and only the PR-merge moves it to Done. The loader in
 * `config.ts` resolves the flag to `false` when neither the
 * `AGENT_HUB_CARD_DONE_ON_PUSH` env var nor `config.json`'s `cardDoneOnPush`
 * key is set. The test data dir (see `test/setup.ts`) is a fresh temp dir
 * with no config.json, and the env var is unset, so the default applies.
 */
import { describe, it, expect } from 'vitest';
import config from './config.js';

describe('config.cardDoneOnPush', () => {
  it('is a boolean and defaults to false (Done == merged, not pushed)', () => {
    expect(typeof config.cardDoneOnPush).toBe('boolean');
    // Neither env nor file config sets it in the test harness → default OFF.
    expect(config.cardDoneOnPush).toBe(false);
  });
});
