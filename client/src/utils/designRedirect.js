/**
 * Design Studio → design-mode session migration: once a standalone design has
 * been imported (server sets `designs.imported_session_id`), the old design
 * views should send the user to the design-mode session instead of rendering
 * the read-only standalone canvas. This pure helper resolves the redirect
 * target so App.jsx and DesignsList stay declarative and the logic unit-tests
 * without React.
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
