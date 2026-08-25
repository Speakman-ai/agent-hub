import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { randomUUID } from 'crypto';
import path from 'path';
import config from './config.js';
import { extensionForContentType } from './mime-extensions.js';
import { validateUploadContent } from './upload-validation.js';
import { BRAND_LOGO_CID } from './email-branding.js';
import type { EmailAttachment } from './email-sender.js';
import type { ProjectEmailLogo } from './types.js';

/**
 * Per-project override for the branded release/deployment email logo.
 *
 * The global logo lives in `server/email-branding.ts` as a single asset. This
 * module lets each project store its own raster image on disk and resolves it
 * into the same inline `cid:` attachment the email shell already references, so
 * a project's notification emails brand with their own logo while keeping the
 * exact email layout.
 *
 * Storage lives under the **durable** data dir (`<dataDir>/project-branding/
 * <projectId>/`), NOT the project workspace dir (`config.projectsDir/<id>`).
 * The workspace tree is separately bind-mounted and hosted restart/redeploy
 * flows recreate it — storing branding there wiped every project's logo bytes
 * on restart while the `projects.json` metadata (durable) kept dangling at the
 * missing files, so emails silently fell back to the global logo. This mirrors
 * the same fix already applied to project skills (see project-skill-paths.ts).
 *
 * Each upload is stored under a **unique** filename (`email-logo-<uuid>.<ext>`)
 * and written via a temp file + atomic rename. Nothing here deletes a prior
 * logo: the route writes the new file, persists metadata, and only then removes
 * the old file — so a persistence failure can roll back with the previous
 * override (file + metadata) fully intact.
 *
 * SVG is intentionally excluded: most mail clients block inline SVG, and
 * serving attacker-supplied SVG from our own origin for the settings preview
 * would be an XSS vector. Only raster formats are accepted.
 */

// The active org's durable data dir. Tracks `reloadProjects(dataDir)` the same
// way `setProjectSkillsDataDir` does, so an org switch repoints branding
// storage without leaking one org's logos into another.
let activeDataDir: string = config.dataDir;

/** Point branding storage at a specific durable data dir (per-org). */
export function setProjectBrandingDataDir(dataDir: string): void {
  activeDataDir = dataDir;
}

/** Durable directory holding a project's branding files. */
export function resolveProjectBrandingDir(projectId: string): string {
  return path.join(activeDataDir, 'project-branding', projectId);
}

/** Raster image types accepted for a project email logo. */
export const PROJECT_EMAIL_LOGO_ALLOWED_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
] as const;

/** Max stored logo size in bytes. */
export const PROJECT_EMAIL_LOGO_MAX_BYTES = 2 * 1024 * 1024; // 2 MB

/** Shared filename prefix for stored logos (incl. staging temp files). */
const LOGO_PREFIX = 'email-logo';

function normalizeType(contentType: string): string {
  return (contentType || '').split(';')[0]?.trim().toLowerCase() || '';
}

export function isAllowedEmailLogoType(contentType: string): boolean {
  return (PROJECT_EMAIL_LOGO_ALLOWED_TYPES as readonly string[]).includes(
    normalizeType(contentType),
  );
}

function brandingDir(projectId: string): string {
  return resolveProjectBrandingDir(projectId);
}

/** Absolute path to a stored project logo. */
export function projectEmailLogoPath(projectId: string, logo: ProjectEmailLogo): string {
  return path.join(brandingDir(projectId), logo.filename);
}

/** Parsed `data:` URL for an inline image upload. */
export interface ParsedImageUpload {
  contentType: string;
  buffer: Buffer;
}

/**
 * Parse a base64 `data:` URL into a content type + buffer. Returns `null` for
 * anything that isn't a base64 data URL (the only shape the upload UI sends).
 */
export function parseImageDataUrl(dataUrl: string): ParsedImageUpload | null {
  const match = /^data:([^;]+);base64,(.+)$/s.exec(dataUrl ?? '');
  if (!match) return null;
  return { contentType: normalizeType(match[1]), buffer: Buffer.from(match[2], 'base64') };
}

/** Error thrown when an uploaded logo fails validation. `.status` maps to HTTP. */
export class ProjectEmailLogoError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'ProjectEmailLogoError';
    this.status = status;
  }
}

/**
 * Validate + write an uploaded project email logo to a NEW unique file, without
 * touching any existing logo. Throws `ProjectEmailLogoError` on invalid
 * type/size/content. The bytes land via a temp file + atomic rename so a
 * partial write is never observable. Returns the metadata to persist; the
 * caller removes the prior file only after persistence succeeds.
 */
export function writeProjectEmailLogo(
  projectId: string,
  buffer: Buffer,
  contentType: string,
): ProjectEmailLogo {
  const type = normalizeType(contentType);
  if (!isAllowedEmailLogoType(type)) {
    throw new ProjectEmailLogoError(
      `Unsupported image type. Allowed: ${PROJECT_EMAIL_LOGO_ALLOWED_TYPES.join(', ')}.`,
    );
  }
  if (!buffer || buffer.length === 0) {
    throw new ProjectEmailLogoError('Empty image body.');
  }
  if (buffer.length > PROJECT_EMAIL_LOGO_MAX_BYTES) {
    throw new ProjectEmailLogoError(
      `Image too large. Max size: ${Math.round(PROJECT_EMAIL_LOGO_MAX_BYTES / 1024 / 1024)}MB.`,
    );
  }
  const rejectReason = validateUploadContent(type, buffer);
  if (rejectReason) {
    throw new ProjectEmailLogoError(rejectReason);
  }

  const dir = brandingDir(projectId);
  mkdirSync(dir, { recursive: true });

  const ext = extensionForContentType(type);
  // Unique per upload so a new logo never overwrites (destroys) the prior one.
  const filename = `${LOGO_PREFIX}-${randomUUID()}.${ext}`;
  const finalPath = path.join(dir, filename);
  const tmpPath = path.join(dir, `${LOGO_PREFIX}.tmp-${randomUUID()}`);
  try {
    writeFileSync(tmpPath, buffer);
    renameSync(tmpPath, finalPath);
  } catch (err) {
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      /* best-effort cleanup of the staging file */
    }
    throw err;
  }

  return {
    filename,
    contentType: type,
    size: buffer.length,
    updatedAt: new Date().toISOString(),
  };
}

/** Best-effort removal of a single stored logo's file. */
export function deleteProjectEmailLogoFile(
  projectId: string,
  logo: ProjectEmailLogo | null | undefined,
): void {
  if (!logo) return;
  try {
    rmSync(projectEmailLogoPath(projectId, logo), { force: true });
  } catch {
    /* best-effort cleanup */
  }
}

/**
 * Remove a project's entire branding directory. Used for full teardown (e.g.
 * project deletion). Routine upload/remove uses `deleteProjectEmailLogoFile` on
 * the specific prior file instead.
 */
export function deleteProjectEmailLogoFiles(projectId: string): void {
  const dir = brandingDir(projectId);
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    if (entry === LOGO_PREFIX || entry.startsWith(LOGO_PREFIX)) {
      try {
        rmSync(path.join(dir, entry), { force: true });
      } catch {
        /* best-effort cleanup */
      }
    }
  }
}

/** Remove a project's entire durable branding directory (project teardown). */
export function deleteProjectBrandingDir(projectId: string): void {
  try {
    rmSync(brandingDir(projectId), { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
}

/** Read a stored project logo's bytes, or `null` if it can't be read. */
export function readProjectEmailLogo(projectId: string, logo: ProjectEmailLogo): Buffer | null {
  try {
    return readFileSync(projectEmailLogoPath(projectId, logo));
  } catch {
    return null;
  }
}

/**
 * Resolve a project's logo into the inline `cid:` email attachment used by the
 * branded release email. Returns `null` when the project has no override or the
 * file can't be read (the caller then falls back to the global logo).
 */
export function resolveProjectEmailLogoAttachment(
  logo: ProjectEmailLogo | null | undefined,
  projectId: string,
): EmailAttachment | null {
  if (!logo) return null;
  const content = readProjectEmailLogo(projectId, logo);
  if (!content) return null;
  return {
    filename: logo.filename,
    content,
    cid: BRAND_LOGO_CID,
    contentType: logo.contentType,
  };
}
