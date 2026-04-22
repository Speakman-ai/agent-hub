import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

describe('scripts/run-eslint.mjs', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

  it('npm lint script ends with `.` so `npm run lint -- <flags>` still lints the repo root (matches eslint . + tail)', () => {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    expect(pkg.scripts.lint).toBe('node scripts/run-eslint.mjs .');
  });

  it('guards missing eslint and runs the package bin via node (portable PATH)', () => {
    const src = readFileSync(path.join(root, 'scripts', 'run-eslint.mjs'), 'utf8');
    expect(src).toContain('node_modules/eslint');
    expect(src).toContain('spawnSync(process.execPath');
    expect(src).toContain('ESLint is not installed');
    expect(src.split(/from ['"]fs['"]/).length - 1).toBe(1);
  });
});
