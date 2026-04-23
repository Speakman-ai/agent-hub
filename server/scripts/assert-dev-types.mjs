/**
 * Fails fast when devDependencies were omitted (e.g. NODE_ENV=production during
 * npm install). Without @types/*, tsc floods with TS2307/TS7016 noise.
 */
import { access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const marker = join(serverRoot, 'node_modules', '@types', 'express');

try {
  await access(marker);
} catch {
  console.error(
    [
      '[agent-hub-server] TypeScript devDependencies are missing (e.g. @types/express).',
      '  Fix:  cd server && npm ci --include=dev',
      '        npm install --include=dev',
      '  Note: npm omits devDependencies when NODE_ENV=production unless you pass --include=dev.',
    ].join('\n'),
  );
  process.exit(1);
}
