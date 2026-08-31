/**
 * Electron entry shim — loads the TypeScript main process via tsx.
 * package.json "main" must remain JavaScript for Electron.
 */
import path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';
import { resolveTsxApiPath } from './resolve-tsx-esm.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Install tsx's ESM hooks through its programmatic API. Do NOT hand-register
// the loader via node:module's register() — since tsx 4.19 that path throws
// "tsx must be loaded with --import instead of --loader" at launch. See
// resolve-tsx-esm.mjs for the full rationale.
const tsxApi = resolveTsxApiPath(__dirname);
const { register } = await import(pathToFileURL(tsxApi).href);
register();

await import('./main.ts');
