/**
 * Design-mode artifact location resolver.
 *
 * Design mode (`session_mode = 'design'`) produces HTML/CSS/JS artifacts that
 * the live canvas renders. WHERE those artifacts live depends on the project:
 *
 *   - **Dev projects** — the session has an isolated git worktree, so artifacts
 *     live in `<worktree>/design/`. Flipping the session back to `chat`/Build
 *     hands them over for free (same checkout). This is the original model.
 *   - **Workflow (no-code) projects** — these intentionally have NO per-session
 *     worktree (they share one checkout and never Build/ship), so there is no
 *     worktree to write into and the Design→Build handoff does not apply. For
 *     them, artifacts live in a Hub-managed, per-session directory under the
 *     data dir: `<dataDir>/design-sessions/<sessionId>/`. This keeps the shared
 *     project checkout clean while still giving the canvas something to render.
 *
 * This module is the single source of truth for that decision so the spawn path
 * (chat.ts), the static file mount (session-files-mount.ts), and the artifact
 * listing (session-design-files.ts) all agree on the same root — otherwise the
 * agent could write to one place and the canvas read from another.
 *
 * Pure (path math only, no I/O) so it unit-tests without a DB or filesystem.
 */
import path from 'path';
import type { Project } from './types.js';
import { isDesignModeActive } from './session-mode.js';
import { getProjectMode } from './project-mode.js';
import { DESIGN_MODE_SUBDIR } from './design-mode-prompt.js';

/** Sub-directory of the data dir that holds workflow-project design artifacts. */
export const DESIGN_DATA_DIR_SUBDIR = 'design-sessions';

export interface DesignArtifactLocation {
  /** Which store backs this location — dev worktree vs. workflow data dir. */
  kind: 'worktree' | 'data-dir';
  /**
   * Absolute directory holding the design artifacts. This is the directory the
   * canvas serves at `/session-files/<id>/design/*` and the agent writes into.
   */
  root: string;
  /**
   * Deepest platform-managed ancestor of `root` that is safe to `realpath` in
   * the static file mount. The mount resolves symlinks only down to this anchor
   * (a dir the agent does not own) and then walks the remaining, agent-owned
   * components no-follow — so a malicious symlink in the artifact dir can never
   * be followed. See session-files-mount.ts for the full threat model.
   */
  safeAnchorParent: string;
}

/**
 * The worktree design location: `<worktree>/design`, anchored at the worktree's
 * PARENT (the platform-managed workspaces dir). The worktree dir itself and the
 * `design/` dir under it are agent-owned and walked no-follow by the mount.
 */
export function worktreeDesignLocation(worktreePath: string): DesignArtifactLocation {
  const abs = path.resolve(worktreePath);
  return {
    kind: 'worktree',
    root: path.join(abs, DESIGN_MODE_SUBDIR),
    safeAnchorParent: path.dirname(abs),
  };
}

/**
 * The workflow data-dir design location:
 * `<dataDir>/design-sessions/<sessionId>`, anchored at
 * `<dataDir>/design-sessions` (a platform-managed dir). The per-session dir is
 * treated as agent-owned and walked no-follow by the mount.
 */
export function dataDirDesignLocation(dataDir: string, sessionId: string): DesignArtifactLocation {
  const anchor = path.join(path.resolve(dataDir), DESIGN_DATA_DIR_SUBDIR);
  return {
    kind: 'data-dir',
    root: path.join(anchor, sessionId),
    safeAnchorParent: anchor,
  };
}

/**
 * Resolve where a DESIGN-MODE session's artifacts live, given its project and
 * the Hub data dir. Returns `null` when design mode cannot run for the session:
 *
 *   - the session is not in design mode, or
 *   - it is a dev-project session with no worktree (design mode requires one;
 *     writing into the shared checkout would pollute it).
 *
 * A worktree wins over the data-dir store when present (a dev session always
 * uses its worktree). A worktree-less session on a workflow project uses the
 * data-dir store.
 */
export function resolveDesignArtifactLocation(args: {
  session: { session_mode?: string | null; worktree_path?: string | null };
  sessionId: string;
  project: Project | null | undefined;
  dataDir: string;
}): DesignArtifactLocation | null {
  const { session, sessionId, project, dataDir } = args;
  if (!isDesignModeActive(session)) return null;
  const worktree = (session.worktree_path ?? '').trim();
  if (worktree) return worktreeDesignLocation(worktree);
  if (getProjectMode(project) === 'workflow') return dataDirDesignLocation(dataDir, sessionId);
  return null;
}

/**
 * Resolve the design location for the STATIC FILE MOUNT, which has no project
 * context (it authenticates via the opaque session id alone). Prefers the
 * worktree when the session has one; otherwise falls back to the data-dir store
 * keyed by session id. Never returns null — a non-design / dev-worktree-less
 * session simply has no files under the resolved root, so the mount 404s
 * naturally when the walk finds nothing.
 */
export function resolveDesignLocationForServe(args: {
  session: { worktree_path?: string | null };
  sessionId: string;
  dataDir: string;
}): DesignArtifactLocation {
  const { session, sessionId, dataDir } = args;
  const worktree = (session.worktree_path ?? '').trim();
  if (worktree) return worktreeDesignLocation(worktree);
  return dataDirDesignLocation(dataDir, sessionId);
}
