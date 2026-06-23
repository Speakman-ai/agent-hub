#!/usr/bin/env node
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REQUIRED = ['@vitejs/plugin-react', 'vitest'];
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'package.json'));

try {
  for (const name of REQUIRED) {
    try {
      require.resolve(name);
    } catch {
      throw new Error(
        `Missing devDependency "${name}" for client tests. ` +
          'If NODE_ENV=production, reinstall with: cd client && npm ci --include=dev',
      );
    }
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
