/**
 * Regression: the `cardDoneOnPush` config flag must default to ON.
 *
 * "When a card's session gets pushed to GitHub, mark it as Done" is the
 * default behavior — a successful push moves the linked kanban card straight
 * to Done rather than parking it in Review until the PR-merge webhook. The
 * loader in `config.ts` resolves the flag to `true` when neither the
 * `AGENT_HUB_CARD_DONE_ON_PUSH` env var nor `config.json`'s `cardDoneOnPush`
 * key is set. The test data dir (see `test/setup.ts`) is a fresh temp dir
 * with no config.json, and the env var is unset, so the default applies.
 */
import { describe, it, expect } from 'vitest';
import config from './config.js';

describe('config.cardDoneOnPush', () => {
  it('is a boolean and defaults to true', () => {
    expect(typeof config.cardDoneOnPush).toBe('boolean');
    // Neither env nor file config sets it in the test harness → default ON.
    expect(config.cardDoneOnPush).toBe(true);
  });
});
