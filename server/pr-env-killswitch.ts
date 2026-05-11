/**
 * PR Environments — kill switch.
 *
 * First PR in the "Strip PR Environments" epic. The PR-env subsystem is on
 * the way out (epic 88367984-c56e-4d31-945c-3408ad151243). This module is
 * the single boot-time gate that no-ops every PR-env code path so the
 * subsequent cards (#2–#7) can delete code, backing tables, crons,
 * UI, and Terraform calmly — without ever leaving the system in a state
 * where new PR-env activity could be kicked off.
 *
 * Contract:
 *   - In production, the kill switch is ALWAYS on, regardless of
 *     `prEnv.enabled` in DB / config file / env.
 *   - The legacy `prEnv.enabled` flag is now ignored at the read path
 *     (`readPrEnvConfig` short-circuits to `null` when the kill switch is
 *     on).
 *   - Every PR-env route returns `410 Gone` with the same body.
 *   - The three PR-env crons (cert-renewal, reaper, pool-alerts) are
 *     no longer registered (PR-Env Removal #4 deleted them outright).
 *   - The `<agenthub:preview target="fullstack">` escape hatch and its
 *     handler module were deleted by card #2. The preview parser now
 *     rejects `target: "fullstack"` with `reason: "invalid-target"` so
 *     the dispatcher never sees a fullstack task in the first place.
 *
 * Tests opt out via `__setPrEnvKillSwitchForTests(false)` so the existing
 * legacy code paths can still be exercised until cards #2–#6 delete them.
 * Production code MUST NOT call that helper.
 */

let killSwitchEnabled = true;

/**
 * Returns `true` when every PR-env code path must short-circuit. Always
 * `true` in production; tests may opt out via
 * `__setPrEnvKillSwitchForTests`.
 */
export function isPrEnvKillSwitchOn(): boolean {
  return killSwitchEnabled;
}

/** Human-readable message used as the 410 body and as broadcast error text. */
export const PR_ENV_KILL_SWITCH_MESSAGE =
  'PR environments have been removed. See worktree previews.';

/**
 * @internal Test-only — flips the kill switch for one suite. Production
 * boot paths never call this. The default for tests is set in
 * `server/test/setup.ts` (kill switch OFF) so the historical PR-env
 * tests keep exercising the legacy paths until cards #2–#6 delete them.
 *
 * The new kill-switch test (`pr-env-killswitch.test.ts`) flips it back
 * on for the assertions that prove the production gates fire.
 */
export function __setPrEnvKillSwitchForTests(value: boolean): void {
  killSwitchEnabled = value === true;
}
