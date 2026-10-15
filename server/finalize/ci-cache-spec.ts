/**
 * Parse-time model for ci.yaml `cache:` entries. Dependency-free so the config
 * parser can import it without pulling in runner modules. Runtime behavior
 * lives in ci-cache.ts.
 */
export interface CiCacheEntry {
  /** Key template: `${VAR}` placeholders and `${{ hashFiles('glob', ...) }}`. */
  key: string;
  /** Files/dirs relative to /finalize-cache. Simple `*`/`?`/`[...]` globs allowed. */
  paths: string[];
  /** Ordered key-prefix fallbacks used when the exact key is missing. */
  restoreKeys: string[];
}

export interface CiStepCacheAction {
  action: 'restore' | 'save';
  entry: CiCacheEntry;
}

export const CACHE_MAX_KEY_LENGTH = 512;
export const CACHE_MAX_PATHS = 32;
export const CACHE_MAX_RESTORE_KEYS = 8;
export const CACHE_MAX_ENTRIES_PER_JOB = 8;

export const HASH_FILES_RE = /\$\{\{\s*hashFiles\(([^)]*)\)\s*\}\}/g;
// Paths are spliced unquoted into the save script so bash can expand globs.
// The charset admits glob metacharacters and nothing a shell would interpret
// any other way.
const CACHE_PATH_RE = /^[A-Za-z0-9._@+=,*?[\]-][A-Za-z0-9._@+=,*?[\]/-]*$/;

/** Validate one `path` entry. Returns an error message or null. */
export function validateCachePath(p: string): string | null {
  if (p.startsWith('/')) return 'must be relative to /finalize-cache';
  if (!CACHE_PATH_RE.test(p)) {
    return 'may only contain letters, digits, ._@+=,-/ and the glob characters *?[]';
  }
  if (p.split('/').some((seg) => seg === '..')) return "must not contain '..'";
  if (p.startsWith('-')) return "must not start with '-'";
  return null;
}

/**
 * Parse the quoted argument list of a `hashFiles(...)` call. Returns null when
 * the list is malformed or empty.
 */
export function parseHashFilesArgs(argList: string): string[] | null {
  const globs: string[] = [];
  const re = /\s*(['"])((?:(?!\1).)*)\1\s*(,|$)/y;
  let pos = 0;
  while (pos < argList.length) {
    re.lastIndex = pos;
    const m = re.exec(argList);
    if (!m) return null;
    const glob = m[2].trim();
    if (!glob || glob.startsWith('/') || glob.split('/').includes('..')) return null;
    globs.push(glob);
    pos = re.lastIndex;
    if (m[3] === '') break;
  }
  if (pos < argList.length && argList.slice(pos).trim() !== '') return null;
  return globs.length > 0 ? globs : null;
}

/** Validate every `hashFiles(...)` call in a key template. */
export function validateKeyTemplate(template: string): string | null {
  for (const m of template.matchAll(HASH_FILES_RE)) {
    if (!parseHashFilesArgs(m[1])) {
      return `has a malformed hashFiles(...) call: '${m[0]}'. Use hashFiles('glob', ...).`;
    }
  }
  return null;
}
