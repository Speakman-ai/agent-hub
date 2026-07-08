/**
 * Read `import.meta.env` defensively.
 *
 * Some non-Vite test/runtime contexts evaluate a module without an
 * `import.meta.env` object (or throw on touching `import.meta`). This returns
 * the env bag when present and `undefined` otherwise — it never throws — so
 * build-time env resolvers can share one safe accessor instead of copy-pasting
 * the try/catch guard.
 */
export function importMetaEnv(): any {
  try {
    return typeof import.meta !== 'undefined' && import.meta.env ? import.meta.env : undefined;
  } catch {
    return undefined;
  }
}
