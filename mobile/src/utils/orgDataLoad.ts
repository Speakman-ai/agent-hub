/**
 * Whether the signed-in project/agent bootstrap should run.
 *
 * The provider stays mounted behind the login screen, so a fetch keyed only on
 * "config is ready" runs before the JWT exists and stores an empty project
 * list. Login used to leave that list in place until the app was reloaded.
 */
export function shouldLoadOrgData(input: {
  configReady: boolean;
  needsAuth: boolean;
  hasServerUrl: boolean;
}): boolean {
  return input.configReady && !input.needsAuth && input.hasServerUrl;
}

/**
 * Monotonic guard for overlapping org-data fetches. A login that starts after
 * an unauthenticated org switch must win; the earlier response is discarded.
 */
export function createOrgDataGeneration() {
  let generation = 0;
  return {
    begin(): () => boolean {
      const gen = ++generation;
      return () => generation === gen;
    },
  };
}
