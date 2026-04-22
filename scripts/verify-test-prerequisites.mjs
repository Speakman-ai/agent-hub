/**
 * Fail fast before `npm test` when workspace packages were never installed.
 * (Common after clone or when only client/server deps were installed.)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const checks = [
  {
    marker: path.join(root, 'client', 'node_modules', 'vite', 'package.json'),
    hint: 'cd client && npm ci --include=dev',
  },
  {
    marker: path.join(root, 'server', 'node_modules', 'typescript', 'package.json'),
    hint: 'cd server && npm ci --include=dev',
  },
  {
    marker: path.join(root, 'mobile', 'node_modules', 'react', 'package.json'),
    hint: 'cd mobile && npm ci --include=dev',
  },
];

const missing = checks.filter((c) => !fs.existsSync(c.marker));

if (missing.length > 0) {
  console.error('Test prerequisites: missing node_modules under one or more workspaces.');
  console.error('From the repo root run:  npm run install:all');
  console.error('Or install individually:');
  for (const m of missing) {
    console.error(`  - ${m.hint}`);
  }
  process.exit(1);
}
