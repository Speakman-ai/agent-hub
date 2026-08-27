/**
 * Electron entry shim — loads the TypeScript main process via tsx.
 * package.json "main" must remain JavaScript for Electron.
 */
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'path';
import { fileURLToPath } from 'url';
import { resolveTsxEsmPath } from './resolve-tsx-esm.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tsxEsm = resolveTsxEsmPath(__dirname);
register(pathToFileURL(tsxEsm).href);
await import('./main.ts');
