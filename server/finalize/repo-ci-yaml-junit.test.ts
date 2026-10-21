/**
 * This repo's ci.yaml test jobs must write JUnit to FINALIZE_JUNIT_DIR, with a
 * path-root sidecar that turns the reporter's names into repo-relative files,
 * or the test inventory has nothing to learn from and every job always runs
 * in full (dynamic test selection).
 */

import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { readFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  finalizeJunitReporter,
  JUNIT_PATH_ROOT_SUFFIX as E2E_PATH_ROOT_SUFFIX,
} from '../../e2e/finalize-junit.js';
import { loadCiConfigFromFile } from './ci-config.js';
import { JUNIT_PATH_ROOT_SUFFIX, testFilesFromJunit } from './test-inventory.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CI_YAML_PATH = path.join(REPO_ROOT, '.agent-hub', 'ci.yaml');

async function testRunScript(): Promise<string> {
  const result = await loadCiConfigFromFile(CI_YAML_PATH);
  if (!result.ok) throw new Error(result.error.message);
  const run = result.config.jobs.test?.steps[0]?.run;
  if (!run) throw new Error('test job has no run script');
  return run;
}

function junitFunction(run: string): string {
  const m = run.match(/^\s*junit\(\) \{[\s\S]*?^\s*\}$/m);
  if (!m) throw new Error('junit() helper missing from the test run script');
  return m[0];
}

function suiteBranch(run: string, suite: string): string {
  const after = run.slice(run.indexOf(`"$FINALIZE_MATRIX_SUITE" = "${suite}"`));
  const end = after.search(/elif \[|^\s*fi\b/m);
  return end > -1 ? after.slice(0, end) : after;
}

function shell(script: string, env: Record<string, string>): string {
  return execFileSync('sh', ['-c', script], { env: { PATH: process.env.PATH ?? '', ...env } })
    .toString()
    .trim();
}

function tmpJunitDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'repo-ci-junit-'));
}

describe('agent-hub ci.yaml: JUnit for the test inventory', () => {
  it('junit() emits the vitest JUnit flags and writes the package path root', async () => {
    const fn = junitFunction(await testRunScript());
    const dir = tmpJunitDir();
    try {
      expect(shell(`${fn}\njunit server-3 server`, { FINALIZE_JUNIT_DIR: dir })).toBe(
        `--reporter=default --reporter=junit --outputFile.junit=${dir}/server-3.xml`,
      );
      expect(readFileSync(path.join(dir, `server-3.xml${JUNIT_PATH_ROOT_SUFFIX}`), 'utf8')).toBe(
        'server\n',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('junit() emits nothing when the Hub does not inject FINALIZE_JUNIT_DIR', async () => {
    const fn = junitFunction(await testRunScript());
    expect(shell(`${fn}\necho "[$(junit server-3 server)]"`, {})).toBe('[]');
  });

  it('every test instance writes its own report rooted at the package vitest runs in', async () => {
    const result = await loadCiConfigFromFile(CI_YAML_PATH);
    if (!result.ok) throw new Error(result.error.message);
    const run = await testRunScript();
    const instances = result.config.jobs.test.matrixInclude;
    const reports = new Set<string>();
    for (const inst of instances) {
      const { suite, shard } = inst;
      const branch = suiteBranch(run, suite);
      const m = branch.match(/\$\(junit "?([^)"\s]+)"? ([\w-]+)\)/);
      expect(m, `suite ${suite} passes no JUnit flags with a path root`).not.toBeNull();
      reports.add(m![1].replace('$FINALIZE_MATRIX_SHARD', shard ?? ''));
      // vitest names files relative to its root, the package it runs in.
      expect(m![2]).toBe(suite);
    }
    // A shared file name would let one shard's report overwrite another's.
    expect(reports.size).toBe(instances.length);
  });
});

describe('vitest configs: package-relative JUnit names', () => {
  const saved = process.env.FINALIZE_JUNIT_DIR;
  afterEach(() => {
    if (saved === undefined) delete process.env.FINALIZE_JUNIT_DIR;
    else process.env.FINALIZE_JUNIT_DIR = saved;
  });

  const configs = [
    { config: 'server/vitest.config.ts' },
    { config: 'mobile/vitest.config.js' },
    { config: 'electron/vitest.config.ts' },
    {
      config: 'client/vitest.config.ts',
      // The client config loads @vitejs/plugin-react, which only the client
      // install provides; the server shards don't install it.
      needs: 'client/node_modules/@vitejs/plugin-react',
    },
  ];

  for (const { config, needs } of configs) {
    it.skipIf(needs !== undefined && !existsSync(path.join(REPO_ROOT, needs)))(
      `${config} leaves JUnit names to vitest under Finalize`,
      async () => {
        // A repo-relative classnameTemplate on top of the path root would
        // prefix the package twice. An explicit `reporters: undefined`
        // crashes vitest startup, so the key must be absent, not unset.
        process.env.FINALIZE_JUNIT_DIR = '/tmp/finalize-junit/x';
        const url = `${pathToFileURL(path.join(REPO_ROOT, config)).href}?junit-on`;
        const mod = (await import(url)) as { default: { test?: Record<string, unknown> } };
        expect('reporters' in (mod.default.test ?? {})).toBe(false);
      },
    );
  }

  it('a package-relative vitest report inventories under its package', () => {
    const xml = `<testsuites name="vitest tests"><testsuite name="finalize/a.test.ts" tests="1"><testcase classname="finalize/a.test.ts" name="t"/></testsuite><testsuite name="finalize/empty.test.ts" tests="0"></testsuite></testsuites>`;
    expect(
      testFilesFromJunit([
        { name: 'server-1.xml', xml },
        { name: `server-1.xml${JUNIT_PATH_ROOT_SUFFIX}`, xml: 'server\n' },
      ]).files,
    ).toEqual(['server/finalize/a.test.ts', 'server/finalize/empty.test.ts']);
  });
});

describe('e2e: Playwright JUnit reporter', () => {
  it('uses the inventory sidecar suffix', () => {
    expect(E2E_PATH_ROOT_SUFFIX).toBe(JUNIT_PATH_ROOT_SUFFIX);
  });

  it('adds nothing outside Finalize', () => {
    expect(finalizeJunitReporter('e2e', './tests', {})).toEqual([]);
  });

  it('a Playwright report for e2e/tests/x.spec.ts inventories as e2e/tests/x.spec.ts', () => {
    const dir = tmpJunitDir();
    try {
      const outputFile = path.join(dir, 'e2e.xml');
      expect(finalizeJunitReporter('e2e', './tests', { FINALIZE_JUNIT_DIR: dir })).toEqual([
        ['junit', { outputFile }],
      ]);
      // Playwright names the spec relative to testDir.
      const xml = `<testsuites id="" name="" tests="1"><testsuite name="x.spec.ts" hostname="chromium" tests="1"><testcase name="x › works" classname="x.spec.ts" time="1"></testcase></testsuite></testsuites>`;
      const sidecar = `e2e.xml${JUNIT_PATH_ROOT_SUFFIX}`;
      const files = [
        { name: 'e2e.xml', xml },
        { name: sidecar, xml: readFileSync(path.join(dir, sidecar), 'utf8') },
      ];
      expect(testFilesFromJunit(files)).toEqual({
        files: ['e2e/tests/x.spec.ts'],
        status: 'reported',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('both Playwright configs pass their testDir', async () => {
    for (const config of ['playwright.config.ts', 'playwright.organizations.config.ts']) {
      const raw = await readFile(path.join(REPO_ROOT, 'e2e', config), 'utf8');
      expect(raw, config).toMatch(/\.\.\.finalizeJunitReporter\('e2e[\w-]*', TEST_DIR\)/);
      expect(raw, config).toMatch(/testDir: TEST_DIR,/);
    }
  });
});
