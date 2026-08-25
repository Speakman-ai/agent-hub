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
import { extensionForContentType } from './mime-extensions.js';
import { validateUploadContent } from './upload-validation.js';
import { BRAND_LOGO_CID } from './email-branding.js';
import type { EmailAttachment } from './email-sender.js';
import type { ProjectEmailLogo } from './types.js';

/**
 * Per-project override for the branded release/deployment email logo.
 *
 * The global logo lives in `server/email-branding.ts` as a single asset. This
 * module lets each project store its own raster image on disk (under the
 * project data dir) and resolves it into the same inline `cid:` attachment the
 * email shell already references, so a project's notification emails brand with
 * their own logo while keeping the exact email layout.
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

function brandingDir(projectDataDir: string): string {
  return path.join(projectDataDir, 'branding');
}

/** Absolute path to a stored project logo. */
export function projectEmailLogoPath(projectDataDir: string, logo: ProjectEmailLogo): string {
  return path.join(brandingDir(projectDataDir), logo.filename);
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
  projectDataDir: string,
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

  const dir = brandingDir(projectDataDir);
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
  projectDataDir: string,
  logo: ProjectEmailLogo | null | undefined,
): void {
  if (!logo) return;
  try {
    rmSync(projectEmailLogoPath(projectDataDir, logo), { force: true });
  } catch {
    /* best-effort cleanup */
  }
}

/**
 * Remove ALL stored logo files (and stale staging temps) for a project. Used
 * for full teardown (e.g. project deletion). Routine upload/remove uses
 * `deleteProjectEmailLogoFile` on the specific prior file instead.
 */
export function deleteProjectEmailLogoFiles(projectDataDir: string): void {
  const dir = brandingDir(projectDataDir);
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

/** Read a stored project logo's bytes, or `null` if it can't be read. */
export function readProjectEmailLogo(
  projectDataDir: string,
  logo: ProjectEmailLogo,
): Buffer | null {
  try {
    return readFileSync(projectEmailLogoPath(projectDataDir, logo));
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
  projectDataDir: string,
): EmailAttachment | null {
  if (!logo) return null;
  const content = readProjectEmailLogo(projectDataDir, logo);
  if (!content) return null;
  return {
    filename: logo.filename,
    content,
    cid: BRAND_LOGO_CID,
    contentType: logo.contentType,
  };
}
