#!/usr/bin/env node
/**
 * When `npm test` runs from the repo root, mobile may never have had
 * `npm ci` / `npm install` — mirror CI (`npm ci --include=dev` in mobile/)
 * once if `react` is absent so Vitest can run without a manual step.
 */
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mobileDir = path.join(root, 'mobile');
const marker = path.join(mobileDir, 'node_modules/react/package.json');

if (existsSync(marker)) {
  process.exit(0);
}

console.warn(
  'mobile: dependencies missing; running npm ci --include=dev in mobile/ …',
);

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const lockfile = path.join(mobileDir, 'package-lock.json');
const args = existsSync(lockfile)
  ? ['ci', '--include=dev']
  : ['install', '--include=dev'];

const result = spawnSync(npm, args, {
  cwd: mobileDir,
  stdio: 'inherit',
});

process.exit(result.status ?? 1);
