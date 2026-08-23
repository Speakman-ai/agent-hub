import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'fs';
import path from 'path';

export type LegacyUploadsMigrationStatus =
  | 'disabled'
  | 'already-migrated'
  | 'source-missing'
  | 'same-directory'
  | 'migrated';

export interface LegacyUploadsMigrationResult {
  status: LegacyUploadsMigrationStatus;
  importedEntries: number;
}

interface LegacyUploadsMigrationOptions {
  legacyUploadsDir: string | null;
  uploadsDir: string;
  markerPath: string;
  log?: (message: string) => void;
}

/**
 * Import the pre-2.31 Docker named volume into the configured upload store.
 *
 * The legacy volume is mounted read-only. Existing destination entries win so
 * a repeated or partially completed import never overwrites newer uploads. The
 * marker is written only after every source entry copies successfully; a
 * failed import therefore retries on the next startup instead of silently
 * stranding database references.
 */
export function migrateLegacyUploads(
  options: LegacyUploadsMigrationOptions,
): LegacyUploadsMigrationResult {
  const { legacyUploadsDir, uploadsDir, markerPath, log = console.log } = options;
  if (!legacyUploadsDir) return { status: 'disabled', importedEntries: 0 };
  if (path.resolve(legacyUploadsDir) === path.resolve(uploadsDir)) {
    return { status: 'same-directory', importedEntries: 0 };
  }
  if (existsSync(markerPath)) return { status: 'already-migrated', importedEntries: 0 };
  if (!existsSync(legacyUploadsDir)) return { status: 'source-missing', importedEntries: 0 };

  mkdirSync(uploadsDir, { recursive: true });
  const entries = readdirSync(legacyUploadsDir);
  for (const name of entries) {
    cpSync(path.join(legacyUploadsDir, name), path.join(uploadsDir, name), {
      recursive: true,
      force: false,
      errorOnExist: false,
      dereference: false,
    });
  }

  mkdirSync(path.dirname(markerPath), { recursive: true });
  writeFileSync(markerPath, `${new Date().toISOString()}\n`, { flag: 'wx' });
  if (entries.length > 0) {
    log(
      `[uploads] Imported ${entries.length} legacy upload entr${entries.length === 1 ? 'y' : 'ies'} from ${legacyUploadsDir}`,
    );
  }
  return { status: 'migrated', importedEntries: entries.length };
}
