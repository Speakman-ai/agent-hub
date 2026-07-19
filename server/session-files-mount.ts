/**
 * Session design-mode artifact file mount.
 *
 * Serves the static HTML/CSS/JS a `session_mode = 'design'` session produces in
 * its worktree `design/` subdir at `/session-files/<sessionId>/design/*`. This
 * is the worktree-sourced analogue of the standalone `/design-files/<designId>`
 * mount (see server/index.ts) and is what the in-session Design-mode canvas pane
 * renders on the web client (SessionDesignModePane → DesignCanvas).
 *
 * Extracted into a factory so the security guards (id shape, session existence,
 * worktree requirement, path-traversal containment) are unit-testable with a
 * fake `getSession` + a temp worktree, without booting the full server.
 *
 * Security model (mirrors `/design-files`):
 *   - Mounted BEFORE authMiddleware (which only gates `/api/*`) because the
 *     sandboxed iframe fetches without credentials; the opaque sessionId is the
 *     capability token and `getSession` resolves only rows in the active org's
 *     DB, so a session id can't address another org's files.
 *   - The sessionId param is constrained to a uuid-shaped alphabet so a crafted
 *     segment (`..`, slash, null byte) can't be laundered through it.
 *   - The request path must stay inside the per-session `design/` root, and a
 *     session/agent process that can write in or around the worktree must NOT be
 *     able to escape it with a symlink — even by racing the check. express.static
 *     (and a plain realpath-then-open) follow symlinks and re-walk the path,
 *     leaving a time-of-check/time-of-use window; `O_NOFOLLOW` alone only protects
 *     the FINAL component, so a swapped intermediate directory — or the worktree
 *     directory itself — still escapes. We therefore anchor at the filesystem
 *     root `/` (which cannot be a symlink and cannot be swapped) and walk EVERY
 *     component of `<worktree>/design/<segments>` no-follow, descriptor-relative
 *     (openat semantics via `/proc/self/fd`). To avoid false-rejecting a
 *     LEGITIMATE symlink in the deployment's data-dir prefix (e.g. `/tmp` →
 *     `/private/tmp`, a symlinked home), we `realpath` only the worktree's PARENT
 *     — a platform-managed dir the agent doesn't own — once, then walk no-follow
 *     from there down through the worktree dir, the `design/` dir, and the request
 *     path. The agent-controlled components (worktree dir and below) are never
 *     realpath'd, so a malicious symlink there is never followed — it makes that
 *     single open fail. The final descriptor is provably the literal
 *     `<canonical-parent>/<worktree>/design/<segments>` file; we fstat and stream
 *     THAT descriptor. (Linux-only — the mount, like the rest of the platform,
 *     assumes a Linux host; without `/proc/self/fd` the walk fails closed to 404.)
 */
import { type Request, type Response } from 'express';
import path from 'path';
import { openSync, fstatSync, closeSync, createReadStream, realpathSync, constants } from 'fs';
import { resolveDesignLocationForServe } from './design-artifact-store.js';

export interface SessionDesignFilesDeps {
  /** Resolve a session row (active-org DB) by id, or undefined if unknown. */
  getSession: (id: string) => { worktree_path?: string | null } | undefined;
  /**
   * Hub data dir — where workflow (no-code) design sessions store artifacts
   * (`<dataDir>/design-sessions/<sessionId>/`). A worktree-backed session serves
   * from its worktree `design/` dir instead and ignores this.
   */
  dataDir: string;
}

/**
 * Open an ABSOLUTE path (given as its `/`-rooted components) such that NO symlink
 * anywhere in the chain is ever followed — not a parent dir, not the worktree
 * dir, not the `design/` dir, not any intermediate, not the leaf. Anchors at the
 * filesystem root `/` (which cannot be a symlink) and opens each component
 * no-follow relative to its parent's descriptor, emulating
 * `openat(dirfd, name, O_NOFOLLOW)` via Linux `/proc/self/fd`. A component swapped
 * to a symlink (even mid-walk) makes that single open fail with ELOOP rather than
 * escaping. Intermediate components additionally require `O_DIRECTORY`. Returns
 * the descriptor of the final component (which may be a directory — the caller
 * fstats to enforce regular-file). Throws on any missing/looping/swapped
 * component; the caller maps that to 404. The caller owns closing the returned
 * fd; intermediate fds are closed here.
 */
function openAbsPathNoFollow(absSegments: string[]): number {
  let dirFd = openSync('/', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  for (let i = 0; i < absSegments.length; i++) {
    const isLast = i === absSegments.length - 1;
    // `/proc/self/fd/<dirFd>` is a magic symlink to the dir `dirFd` refers to;
    // the kernel dereferences it (an intermediate component, so O_NOFOLLOW does
    // not block it) and then looks up `absSegments[i]` WITHIN that dir.
    // O_NOFOLLOW applies to that final lookup, so a symlink at the component is
    // refused.
    const at = `/proc/self/fd/${dirFd}/${absSegments[i]}`;
    const flags = constants.O_RDONLY | constants.O_NOFOLLOW | (isLast ? 0 : constants.O_DIRECTORY);
    let nextFd: number;
    try {
      nextFd = openSync(at, flags);
    } finally {
      // Release the parent descriptor whether or not the child open succeeded.
      closeSync(dirFd);
    }
    dirFd = nextFd;
  }
  return dirFd;
}

/**
 * Build the express middleware for `/session-files/:sessionId/design`. Returns
 * 400 for a malformed id, 404 for an unknown / worktree-less session, a path
 * that escapes the `design/` root, a non-regular-file, or a missing file,
 * otherwise streams the validated file. A 2-arg handler (no `next`) so express
 * treats it as normal middleware; every outcome ends the response here.
 */
export function createSessionDesignFilesHandler(deps: SessionDesignFilesDeps) {
  return function sessionDesignFiles(req: Request, res: Response) {
    const sessionId = req.params.sessionId as string;
    if (!/^[A-Za-z0-9-]+$/.test(sessionId)) {
      return res.status(400).json({ error: 'Invalid session id' });
    }
    const session = deps.getSession(sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Not found' });
    }
    // Resolve the artifact store for this session: a worktree-backed session
    // serves from `<worktree>/design`; a worktree-less session serves from the
    // workflow data-dir store `<dataDir>/design-sessions/<sessionId>`. Either
    // way we get an absolute artifact `root` and a `safeAnchorParent` — the
    // deepest platform-managed ancestor (worktree's parent, or the
    // `design-sessions` dir) that is safe to realpath. We resolve symlinks only
    // down to that anchor and walk the remaining, agent-owned components
    // no-follow, so a malicious symlink in the artifact dir is never followed.
    // A non-design / worktree-less-dev session simply has no files under the
    // resolved root, so the no-follow walk below 404s naturally.
    const location = resolveDesignLocationForServe({
      session,
      sessionId,
      dataDir: deps.dataDir,
    });
    let anchorCanonical: string;
    try {
      anchorCanonical = realpathSync(location.safeAnchorParent);
    } catch {
      return res.status(404).json({ error: 'Not found' });
    }
    // Agent-owned tail below the safe anchor (e.g. `<worktree-basename>/design`,
    // or `<sessionId>`). Joined onto the canonical anchor; never realpath'd.
    const relTail = path
      .relative(location.safeAnchorParent, location.root)
      .split(path.sep)
      .filter((s) => s.length > 0);
    const root = path.join(anchorCanonical, ...relTail);
    const requested = path.resolve(root, '.' + (req.path || '/'));
    // Cheap lexical containment fast-fail (rejects `../` escapes before we walk).
    if (requested !== root && !requested.startsWith(root + path.sep)) {
      return res.status(404).json({ error: 'Not found' });
    }
    // Open the file via a fully symlink-free walk anchored at `/`
    // (openAbsPathNoFollow). Because EVERY component — including the worktree
    // dir and the design dir — is opened no-follow, the returned descriptor is
    // provably the literal target and cannot escape via a swapped worktree /
    // design / intermediate / leaf symlink, with no re-resolution between check
    // and send (the race express.static would lose).
    const absSegments = requested.split(path.sep).filter((s) => s.length > 0);
    let fd: number;
    try {
      fd = openAbsPathNoFollow(absSegments);
    } catch {
      return res.status(404).json({ error: 'Not found' });
    }
    let st: ReturnType<typeof fstatSync>;
    try {
      st = fstatSync(fd);
    } catch {
      closeSync(fd);
      return res.status(404).json({ error: 'Not found' });
    }
    // Enforce regular-file: a directory request (segments empty, or a real
    // subdir) has no body to serve. The canvas only ever requests explicit files.
    if (!st.isFile()) {
      closeSync(fd);
      return res.status(404).json({ error: 'Not found' });
    }
    // Content-Type from the extension. `res.type(ext)` runs Express' extension
    // lookup, which is only correct for an actual extension — passing a full MIME
    // string down that path can fall back unexpectedly, so set the octet-stream
    // fallback header directly for extensionless files.
    const ext = path.extname(requested);
    if (ext) {
      res.type(ext);
    } else {
      res.setHeader('Content-Type', 'application/octet-stream');
    }
    res.setHeader('Content-Length', String(st.size));
    const stream = createReadStream('', { fd, autoClose: true });
    stream.on('error', () => {
      // fd is auto-closed on stream error; surface a 404 if we haven't started
      // writing the body yet, otherwise just drop the (broken) connection.
      if (!res.headersSent) res.status(404).json({ error: 'Not found' });
      else res.destroy();
    });
    return stream.pipe(res);
  };
}
