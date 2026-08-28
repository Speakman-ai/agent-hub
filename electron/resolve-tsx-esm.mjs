import path from 'path';

/**
 * Resolve the tsx ESM loader the entry shim registers before it can import the
 * TypeScript main process. This is tsx's `./esm` export (`dist/esm/index.mjs`
 * in tsx v4). Earlier tsx versions exposed the loader at `dist/esm.mjs`; that
 * file no longer exists, so hardcoding it crashed the packaged app at launch.
 *
 * In a packaged build, `server/**` is unpacked to `app.asar.unpacked` (see the
 * `asarUnpack` list in package.json), so the loader lives outside the asar
 * archive. main.ts applies the same `app.asar` -> `app.asar.unpacked` rewrite
 * when spawning the server; the shim must do it too, otherwise the app crashes
 * at launch with ERR_MODULE_NOT_FOUND before main.ts is ever loaded.
 *
 * In dev (running unpacked, no `app.asar` segment) the replace is a no-op.
 *
 * @param {string} electronDir Directory of the entry shim (its `__dirname`).
 * @returns {string} Absolute path to tsx's ESM loader, rewritten to the unpacked tree.
 */
export function resolveTsxEsmPath(electronDir) {
  return path
    .join(electronDir, '..', 'server', 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs')
    .replace('app.asar', 'app.asar.unpacked');
}
