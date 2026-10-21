import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { ReporterDescription } from '@playwright/test';

const E2E_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(E2E_DIR, '..');

/** Must match JUNIT_PATH_ROOT_SUFFIX in server/finalize/test-inventory.ts. */
export const JUNIT_PATH_ROOT_SUFFIX = '.path-root';

/**
 * JUnit for the Finalize test inventory (dynamic test selection). The runner
 * injects FINALIZE_JUNIT_DIR per job instance; outside Finalize this is a no-op.
 *
 * Playwright names each spec relative to testDir (`auth.spec.ts`) and has no
 * option to change that, so this also writes the `<report>.xml.path-root`
 * sidecar the inventory prefixes those names with (`e2e/tests`). `testDir` is
 * the config's own value, relative to e2e/.
 */
export function finalizeJunitReporter(
  report: string,
  testDir: string,
  env: Record<string, string | undefined> = process.env,
): ReporterDescription[] {
  const dir = env.FINALIZE_JUNIT_DIR;
  if (!dir) return [];
  const outputFile = path.join(dir, `${report}.xml`);
  const root = path.relative(REPO_ROOT, path.resolve(E2E_DIR, testDir)).split(path.sep).join('/');
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${outputFile}${JUNIT_PATH_ROOT_SUFFIX}`, `${root}\n`);
  return [['junit', { outputFile }]];
}
