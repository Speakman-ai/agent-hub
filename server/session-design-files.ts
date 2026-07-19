/**
 * Session design-mode artifact listing.
 *
 * The web Design-mode pane renders the session worktree's `design/index.html`
 * live in an iframe (SessionDesignModePane → DesignCanvas). Mobile/Electron have
 * no in-app iframe canvas, so instead of rendering the artifact they show a flat
 * "files produced" list plus an open-in-browser affordance. This module computes
 * that list from the same worktree `design/` dir the static `/session-files`
 * mount serves, so the two surfaces never disagree about what exists.
 *
 * Pure (no DB, no Express) so it unit-tests against a temp worktree dir.
 */
import path from 'path';
import { DESIGN_MODE_SUBDIR } from './design-mode-prompt.js';
import { listFilesUnder, type DesignFileEntry } from './designs-store.js';

/**
 * List every regular file the agent produced under `<worktree>/design/`.
 *
 * Returns forward-slash paths relative to the `design/` dir (so a caller can
 * append a path directly onto `/session-files/<id>/design/`). A null/blank
 * worktree, or a session that never wrote any design artifact, yields `[]`.
 * Symlinks are never followed — mirrors the static mount's no-follow guard.
 */
export function listSessionDesignFiles(
  worktreePath: string | null | undefined,
  subdir: string = DESIGN_MODE_SUBDIR,
): DesignFileEntry[] {
  if (!worktreePath || typeof worktreePath !== 'string') return [];
  const root = path.join(path.resolve(worktreePath), subdir);
  return listFilesUnder(root);
}

/**
 * List design artifacts under an already-resolved absolute artifact `root` —
 * e.g. the workflow data-dir store `<dataDir>/design-sessions/<sessionId>`, whose
 * files live directly at the root (no `design/` subdir). Callers resolve the
 * store via `resolveDesignArtifactLocation` and pass `location.root`. A blank
 * root, or one that holds no files, yields `[]`.
 */
export function listSessionDesignFilesAtRoot(root: string | null | undefined): DesignFileEntry[] {
  if (!root || typeof root !== 'string') return [];
  return listFilesUnder(path.resolve(root));
}
