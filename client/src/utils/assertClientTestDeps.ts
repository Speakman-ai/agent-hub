import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Dev-only packages required to load vitest.config.js and run tests. */
const REQUIRED = ['@vitejs/plugin-react', 'vitest'];

/**
 * Ensures client test toolchain packages are installed (see npm devDependencies).
 * When NODE_ENV=production, plain `npm ci` omits devDependencies — use `npm ci --include=dev`.
 *
 * @param {string} [clientPackageRoot] - Absolute path to `client/` (directory with package.json)
 */
export function assertClientTestDepsInstalled(clientPackageRoot?: any) {
  const root = clientPackageRoot ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const require = createRequire(join(root, 'package.json'));
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
}
