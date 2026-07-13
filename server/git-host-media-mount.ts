/**
 * Git-host README media mount.
 *
 * Serves image blobs referenced by relative paths inside a Hub-hosted repo's
 * README at `/git-host-media/<projectId>?path=<repoPath>&branch=<branch>&token=<token>`.
 * The RepositoryPage README renders markdown whose `![alt](docs/media/x.png)`
 * refs are repo-relative; a browser resolves those against the SPA URL and
 * 404s, so the README image slots render blank. The client rewrites each
 * relative image src to this endpoint (see client/src/utils/resolveRepoMediaUrl.ts).
 *
 * Security model:
 *   - Mounted where `authMiddleware` (which only gates `/api/*`) does NOT
 *     require a bearer token, because an `<img>` tag cannot attach the SPA's
 *     JWT. Instead, the authenticated README route mints an opaque media token
 *     after the same project visibility gate that guards the README itself has
 *     already passed. The token is scoped to project + branch and expires
 *     quickly, so a guessable project slug and image path are not enough to
 *     read blobs from another project or org.
 *   - Only raster image content types are servable — SVG and non-image
 *     extensions 404 — so this mount can't be turned into a general repo-file
 *     exfiltration channel or an active-content surface controlled by repo
 *     contents.
 *   - Blobs come from `git show <ref>:<path>` in the bare repo, and
 *     `readRepoBlob` rejects `..` / absolute / null-byte paths, so there is no
 *     filesystem path-traversal surface (unlike the worktree-sourced mounts).
 *   - A blob that hit the size cap (`truncated`) is refused rather than served
 *     as corrupt bytes.
 */
import { randomBytes } from 'crypto';
import { type Request, type Response } from 'express';

const MEDIA_TOKEN_TTL_MS = 10 * 60 * 1000;
const MAX_MEDIA_TOKENS = 1000;

const mediaTokens = new Map<
  string,
  {
    projectId: string;
    branch: string;
    expiresAt: number;
  }
>();

function cleanupExpiredMediaTokens(now: number): void {
  for (const [token, record] of mediaTokens) {
    if (record.expiresAt <= now || mediaTokens.size > MAX_MEDIA_TOKENS) {
      mediaTokens.delete(token);
    }
  }
}

export function issueGitHostMediaToken(
  projectId: string,
  branch: string,
  now = Date.now(),
): string {
  cleanupExpiredMediaTokens(now);
  const token = randomBytes(24).toString('base64url');
  mediaTokens.set(token, {
    projectId,
    branch,
    expiresAt: now + MEDIA_TOKEN_TTL_MS,
  });
  return token;
}

export function validateGitHostMediaToken(
  projectId: string,
  branch: string,
  token: unknown,
  now = Date.now(),
): boolean {
  if (typeof token !== 'string' || !token) return false;
  const record = mediaTokens.get(token);
  if (!record) return false;
  if (record.expiresAt <= now) {
    mediaTokens.delete(token);
    return false;
  }
  return record.projectId === projectId && record.branch === branch;
}

/** Raster image extensions a README can reference, mapped to their content type. */
const IMAGE_MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.apng': 'image/apng',
};

/** Content type for a repo path by extension, or null when not an image. */
export function imageMimeForPath(filePath: string): string | null {
  const dot = filePath.lastIndexOf('.');
  if (dot < 0) return null;
  const ext = filePath.slice(dot).toLowerCase();
  return IMAGE_MIME_BY_EXT[ext] ?? null;
}

export interface GitHostMediaProject {
  id: string;
  gitHost?: string | null;
}

export interface GitHostMediaDeps {
  /** Resolve a project by id, or null when unknown. */
  findProject: (projectId: string) => GitHostMediaProject | null;
  /** Validate the short-lived media token minted by the README route. */
  validateToken: (projectId: string, branch: string, token: unknown) => boolean;
  /** Read a repo blob as raw bytes, or null when absent/unsafe. */
  readBlob: (
    projectId: string,
    filePath: string,
    branch?: string,
  ) => Promise<{ buffer: Buffer; truncated?: boolean } | null>;
}

/** Project ids are slugs — refuse anything that could be a crafted segment. */
const PROJECT_ID_RE = /^[A-Za-z0-9._-]+$/;

export function createGitHostMediaHandler(deps: GitHostMediaDeps) {
  return async (req: Request, res: Response): Promise<void> => {
    const projectId = req.params.projectId as string;
    if (!projectId || !PROJECT_ID_RE.test(projectId)) {
      res.status(400).json({ error: 'Invalid project id' });
      return;
    }
    const filePath = typeof req.query.path === 'string' ? req.query.path : '';
    const branch = typeof req.query.branch === 'string' ? req.query.branch : '';
    if (!filePath) {
      res.status(400).json({ error: 'Missing path' });
      return;
    }
    const mime = imageMimeForPath(filePath);
    if (!mime) {
      // Only image blobs are servable through this mount.
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const project = deps.findProject(projectId);
    if (!project || project.gitHost !== 'agenthub') {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    // The token was minted only after the authenticated README route passed
    // the project visibility gate. Mask token failures as 404 to avoid making
    // this mount an oracle for project or path existence.
    if (!deps.validateToken(projectId, branch, req.query.token)) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    let blob: { buffer: Buffer; truncated?: boolean } | null = null;
    try {
      blob = await deps.readBlob(projectId, filePath, branch || undefined);
    } catch {
      blob = null;
    }
    if (!blob) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    if (blob.truncated) {
      // Hit the size cap — serving the partial buffer would render as a broken
      // image, so refuse it outright.
      res.status(404).json({ error: 'Not found' });
      return;
    }
    res.setHeader('Content-Type', mime);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Defense-in-depth for SVG: an <img>-loaded blob must not execute script
    // or fetch subresources even if a crafted SVG is somehow rendered inline.
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    );
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.status(200).end(blob.buffer);
  };
}
