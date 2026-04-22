import { accessSync, constants as fsConstants } from 'fs';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const eslintJs = path.join(root, 'node_modules', 'eslint', 'bin', 'eslint.js');

try {
  accessSync(eslintJs, fsConstants.F_OK);
} catch {
  console.error(
    'ESLint is not installed (missing node_modules/eslint).',
    '\n  From the repository root run: npm install',
    '\n  If npm is configured to omit devDependencies, use: npm install --include=dev',
    '\n  This repo sets include=dev in .npmrc so tooling stays available. See husky pre-commit.',
  );
  process.exit(127);
}

const argv = process.argv.slice(2);
const eslintArgs = argv.length > 0 ? argv : ['.'];
const result = spawnSync(process.execPath, [eslintJs, ...eslintArgs], {
  stdio: 'inherit',
  cwd: root,
  windowsHide: true,
  env: process.env,
});

if (result.error) {
  console.error(result.error);
  process.exit(1);
}
process.exit(result.status === null ? 1 : result.status);
