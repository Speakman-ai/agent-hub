/**
 * Fail fast when Node is outside the repo's supported range (.nvmrc / package.json engines).
 * Prevents cryptic better-sqlite3 ERR_DLOPEN_FAILED on unsupported Node versions.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nvmrcPath = path.join(root, '.nvmrc');

const major = Number(process.versions.node.split('.')[0]);
const minor = Number(process.versions.node.split('.')[1] ?? 0);
const current = process.versions.node;

// Keep in sync with package.json "engines": ">=22.14.0 <23.0.0"
const MIN_MAJOR = 22;
const MIN_MINOR = 14;
const MAX_MAJOR_EXCLUSIVE = 23;

const inRange =
  (major > MIN_MAJOR || (major === MIN_MAJOR && minor >= MIN_MINOR)) && major < MAX_MAJOR_EXCLUSIVE;

if (inRange) process.exit(0);

const expected = fs.existsSync(nvmrcPath)
  ? fs.readFileSync(nvmrcPath, 'utf8').trim()
  : `${MIN_MAJOR}.${MIN_MINOR}.x`;

console.error('');
console.error(`Agent Hub requires Node ${MIN_MAJOR}.${MIN_MINOR}.x (see .nvmrc).`);
console.error(`Current: v${current}`);
console.error('');
console.error('Fix:');
console.error(`  nvm use ${expected}`);
console.error('  node -v          # should print v22.x');
console.error('  npm run dev');
console.error('');
console.error('If you switched Node versions recently, also run:');
console.error('  npm run rebuild:native');
console.error('');
process.exit(1);
