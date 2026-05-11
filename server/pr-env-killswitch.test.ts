/**
 * Kill-switch tests (epic 88367984 — strip PR Environments).
 *
 * After PR-Env Removal #4 the entire PR-env backing directory was
 * deleted along with `readPrEnvConfig()`, the cert-renewal / reaper
 * / pool-alerts crons, and the W4 observability routes. The kill switch
 * itself remains only as the source of truth for the `features.prEnv`
 * flag served by `/api/config` — the UI uses it to know that the PR-env
 * feature is dead. Surviving contract assertions:
 *
 *   - `isPrEnvKillSwitchOn()` returns `true` once enabled.
 *   - `detectPreviewBlock()` rejects `target: 'fullstack'` outright at
 *     parse time (the dispatcher never even sees a fullstack task).
 *   - PR-env webhook dispatch modules are gone — importing them fails.
 *   - The PR-env backing directory is gone — importing any module under
 *     it fails.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { __setPrEnvKillSwitchForTests, isPrEnvKillSwitchOn } from './pr-env-killswitch.js';

beforeEach(() => {
  __setPrEnvKillSwitchForTests(true);
});

afterEach(() => {
  __setPrEnvKillSwitchForTests(false);
});

describe('PR-env kill switch — production contract', () => {
  it('isPrEnvKillSwitchOn() returns true once enabled', () => {
    expect(isPrEnvKillSwitchOn()).toBe(true);
  });

  it('fullstack preview block is rejected at parse time — handler is gone', async () => {
    // PR-Env Removal #2 deleted the fullstack preview handler module and
    // dropped `'fullstack'` from `PreviewTarget`. The parse-time gate in
    // `detectPreviewBlock` rejects `target: 'fullstack'` outright, so the
    // dispatcher never even sees a fullstack task and the kill switch has
    // nothing left to gate. Pin that contract here so a future
    // re-introduction has to update this test.
    const { detectPreviewBlock } = await import('./preview/preview-block.js');
    const result = detectPreviewBlock(
      `<agenthub:preview>{"target":"fullstack","route":"/"}</agenthub:preview>`,
    );
    expect(result.present).toBe(true);
    expect(result.task).toBeNull();
    expect(result.reason).toBe('invalid-target');
  });

  it('PR-env webhook dispatch modules are gone — import fails', async () => {
    // PR-Env Removal #3 deleted the `dispatchPrEnvBuild` /
    // `dispatchPrEnvTeardown` invocations in `routes/webhooks.ts`, and
    // PR-Env Removal #4 deleted the entire backing directory. Pin that
    // here so a regression that re-introduces the import is caught.
    await expect(import('./pr-env-dispatch.js' as string)).rejects.toThrow();
  });

  it('the PR-env backing directory is gone — every module under it fails to import', async () => {
    // PR-Env Removal #4 deleted `server/<pr-env-dir>/` outright. Pin a
    // representative module (the runtime config reader) so any attempt
    // to resurrect the directory has to update this test.
    await expect(import('./pr-env-runtime.js' as string)).rejects.toThrow();
  });
});
