import path from 'path';

/**
 * Resolve tsx's programmatic ESM register API (`tsx/esm/api`, i.e.
 * `dist/esm/api/index.mjs` in tsx v4). The entry shim imports `register` from
 * this module and calls it to install tsx's ESM hooks before importing the
 * TypeScript main process.
 *
 * IMPORTANT — do NOT register the bare loader (`dist/esm/index.mjs`) via
 * `node:module`'s `register()`. Since tsx 4.19 the loader's `initialize` hook
 * throws `tsx must be loaded with --import instead of --loader` unless it
 * receives an init-data payload. Hand-registering the loader file passes no
 * `data`, so tsx treats it as the deprecated `--loader` path and hard-throws at
 * launch. tsx's own `register()` (this api entry) calls `module.register()`
 * with the required payload internally, so we go through it instead.
 *
 * In a packaged build, `server/**` is unpacked to `app.asar.unpacked` (see the
 * `asarUnpack` list in package.json), so the api module lives outside the asar
 * archive. main.ts applies the same `app.asar` -> `app.asar.unpacked` rewrite
 * when spawning the server; the shim must do it too, otherwise the app crashes
 * at launch with ERR_MODULE_NOT_FOUND before main.ts is ever loaded. The api
 * module resolves its sibling loader relative to its own `import.meta.url`, so
 * loading it from the unpacked tree keeps that internal resolution correct.
 *
 * In dev (running unpacked, no `app.asar` segment) the replace is a no-op.
 *
 * @param {string} electronDir Directory of the entry shim (its `__dirname`).
 * @returns {string} Absolute path to tsx's ESM register API, rewritten to the unpacked tree.
 */
export function resolveTsxApiPath(electronDir) {
  return path
    .join(electronDir, '..', 'server', 'node_modules', 'tsx', 'dist', 'esm', 'api', 'index.mjs')
    .replace('app.asar', 'app.asar.unpacked');
}
