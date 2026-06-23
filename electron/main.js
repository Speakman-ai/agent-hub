/**
 * Electron entry shim — loads the TypeScript main process via tsx.
 * package.json "main" must remain JavaScript for Electron.
 */
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tsxEsm = path.join(__dirname, '..', 'server', 'node_modules', 'tsx', 'dist', 'esm.mjs');
register(pathToFileURL(tsxEsm).href);
await import('./main.ts');
