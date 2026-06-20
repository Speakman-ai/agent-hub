/**
 * Design Studio → design-mode session migration (mobile parity with the web
 * client's utils/designRedirect.js). Once a standalone design has been imported
 * (server sets `designs.imported_session_id`), tapping it should open the
 * design-mode session instead of the read-only standalone canvas. Pure so it
 * unit-tests without React Navigation.
 *
 * Returns `{ sessionId }` when the design has been migrated, otherwise null.
 */
export function resolveDesignRedirect(design) {
  const sid = design?.imported_session_id;
  if (typeof sid === 'string' && sid.trim()) {
    return { sessionId: sid.trim() };
  }
  return null;
}

/** True when a design has been migrated and is now read-only. */
export function isDesignMigrated(design) {
  return resolveDesignRedirect(design) !== null;
}
