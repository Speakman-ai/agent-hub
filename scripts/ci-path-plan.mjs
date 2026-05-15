/**
 * CI path scope for `.github/workflows/ci.yml`, kept in JS so Vitest can lock
 * the decision table to the filters in the workflow.
 *
 * Env contract (set by the `changes` job): FILTER_GLOBAL, FILTER_SERVER, etc.
 */

import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export function truthy(v) {
  return v === true || v === 'true';
}

/**
 * @param {Record<string, string | boolean | undefined>} f paths-filter outputs
 */
export function computeCiPlan(f) {
  const T = (key) => truthy(f[key]);
  const any = (...keys) => keys.some((k) => T(k));

  const run_lint = any('global', 'server', 'client', 'electron', 'shared', 'scripts', 'e2e');
  const run_terraform = T('terraform');
  const run_build = any('global', 'client', 'shared');
  const run_server = any('global', 'server', 'scripts');
  const run_client = any('global', 'client', 'shared');
  const run_electron = any('global', 'electron');
  const run_mobile = any('global', 'mobile');
  const run_tests = run_server || run_client || run_electron || run_mobile;

  /** @type {Array<Record<string, string | number>>} */
  const rows = [];
  if (run_server) {
    rows.push({ suite: 'server', shard: 1, shards: 3, label: 'server 1/3' });
    rows.push({ suite: 'server', shard: 2, shards: 3, label: 'server 2/3' });
    rows.push({ suite: 'server', shard: 3, shards: 3, label: 'server 3/3' });
  }
  if (run_client) {
    rows.push({ suite: 'client', label: 'client' });
  }
  if (run_electron) {
    rows.push({ suite: 'electron', label: 'electron' });
  }
  if (run_mobile) {
    rows.push({ suite: 'mobile', label: 'mobile' });
  }

  return {
    run_lint,
    run_terraform,
    run_build,
    run_tests,
    test_matrix: { include: rows },
  };
}

export function formatGithubOutput(plan) {
  const matrixJson = JSON.stringify(plan.test_matrix);
  const lines = [
    `run_lint=${plan.run_lint}`,
    `run_terraform=${plan.run_terraform}`,
    `run_build=${plan.run_build}`,
    `run_tests=${plan.run_tests}`,
    'test_matrix<<MATRIX_EOF',
    matrixJson,
    'MATRIX_EOF',
  ];
  return `${lines.join('\n')}\n`;
}

function main() {
  const plan = computeCiPlan({
    global: process.env.FILTER_GLOBAL,
    server: process.env.FILTER_SERVER,
    client: process.env.FILTER_CLIENT,
    electron: process.env.FILTER_ELECTRON,
    mobile: process.env.FILTER_MOBILE,
    shared: process.env.FILTER_SHARED,
    terraform: process.env.FILTER_TERRAFORM,
    scripts: process.env.FILTER_SCRIPTS,
    e2e: process.env.FILTER_E2E,
  });
  process.stdout.write(formatGithubOutput(plan));
}

const invokedDirectly =
  process.argv[1] != null && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  main();
}
