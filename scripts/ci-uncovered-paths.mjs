/**
 * Emits `uncovered=true` when `git diff` lists files outside `ci-path-scope.mjs`.
 * Used by `.github/workflows/ci.yml` so PRs touching e.g. root `README.md`,
 * `docs/**`, or `Dockerfile` still run lint/build/tests (cannot rely on every
 * skip being "safe" when no `dorny/paths-filter` group matched).
 */

import { execFileSync } from 'node:child_process';
import process from 'node:process';

import { filterUncoveredPaths } from './ci-path-scope.mjs';

function listChangedFiles(baseSha, headSha) {
  const out = execFileSync('git', ['diff', '--name-only', `${baseSha}...${headSha}`], {
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
  });
  return out.split('\n').filter(Boolean);
}

function main() {
  const base = process.env.BASE_SHA;
  const head = process.env.HEAD_SHA;
  if (!base || !head) {
    process.stdout.write('uncovered=false\n');
    process.stderr.write(
      'ci-uncovered-paths: BASE_SHA/HEAD_SHA not set; assuming no uncovered paths (local)\n',
    );
    return;
  }

  const files = listChangedFiles(base, head);
  const uncovered = filterUncoveredPaths(files);
  if (uncovered.length > 0) {
    const lines = uncovered.slice(0, 80);
    process.stderr.write(
      `ci-uncovered-paths: ${uncovered.length} path(s) outside dorny filter scope (full CI legs). First files:\n${lines.join('\n')}\n`,
    );
  }
  process.stdout.write(`uncovered=${uncovered.length > 0}\n`);
}

main();
