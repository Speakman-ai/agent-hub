/**
 * Root `npm run test:mobile` entry — mirrors CI (mobile deps installed) while
 * tolerating local clones where only server/client were installed.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const mobileDir = join(rootDir, 'mobile');
const marker = join(mobileDir, 'node_modules', 'react', 'package.json');

function runNpm(args, cwd) {
  const r = spawnSync('npm', args, { cwd, stdio: 'inherit', env: process.env });
  return r.status ?? 1;
}

if (!existsSync(marker)) {
  console.warn(
    '[test:mobile] mobile/node_modules is missing or incomplete — running `npm ci --include=dev` in mobile/',
  );
  const code = runNpm(['ci', '--include=dev'], mobileDir);
  if (code !== 0) {
    console.error(
      '[test:mobile] `npm ci` in mobile/ failed. From repo root try: npm run install:all',
    );
    process.exit(code);
  }
}

process.exit(runNpm(['test'], mobileDir));
