/**
 * This repo's ci.yaml test jobs must write JUnit to FINALIZE_JUNIT_DIR, named
 * by repo-relative file, or the test inventory has nothing to learn from and
 * every job always runs in full (dynamic test selection).
 */

import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { afterEach, describe, expect, it } from 'vitest';
import { finalizeJunitReporter } from '../../e2e/finalize-junit.js';
import { loadCiConfigFromFile } from './ci-config.js';
import { parseJunitTestFiles } from './test-inventory.js';

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

describe('agent-hub ci.yaml: JUnit for the test inventory', () => {
  it('junit() emits the vitest JUnit flags into FINALIZE_JUNIT_DIR', async () => {
    const fn = junitFunction(await testRunScript());
    expect(shell(`${fn}\njunit server-3`, { FINALIZE_JUNIT_DIR: '/tmp/finalize-junit/x' })).toBe(
      '--reporter=default --reporter=junit --outputFile.junit=/tmp/finalize-junit/x/server-3.xml',
    );
  });

  it('junit() emits nothing when the Hub does not inject FINALIZE_JUNIT_DIR', async () => {
    const fn = junitFunction(await testRunScript());
    expect(shell(`${fn}\necho "[$(junit server-3)]"`, {})).toBe('[]');
  });

  it('every test instance runs its suite with a JUnit report of its own', async () => {
    const result = await loadCiConfigFromFile(CI_YAML_PATH);
    if (!result.ok) throw new Error(result.error.message);
    const run = await testRunScript();
    const instances = result.config.jobs.test.matrixInclude;
    const reports = new Set<string>();
    for (const inst of instances) {
      const { suite, shard } = inst;
      const branch = suiteBranch(run, suite);
      const arg = branch.match(/\$\(junit "?([^)"]+)"?\)/)?.[1];
      expect(arg, `suite ${suite} passes no JUnit flags`).toBeDefined();
      reports.add(arg!.replace('$FINALIZE_MATRIX_SHARD', shard ?? ''));
    }
    // A shared file name would let one shard's report overwrite another's.
    expect(reports.size).toBe(instances.length);
  });
});

describe('vitest configs: repo-relative JUnit classnames', () => {
  const saved = process.env.FINALIZE_JUNIT_DIR;
  afterEach(() => {
    if (saved === undefined) delete process.env.FINALIZE_JUNIT_DIR;
    else process.env.FINALIZE_JUNIT_DIR = saved;
  });

  type Reporters = Array<string | [string, { classnameTemplate?: unknown }]> | undefined;

  async function loadTestConfig(config: string, bust: string): Promise<{ reporters?: Reporters }> {
    const url = `${pathToFileURL(path.join(REPO_ROOT, config)).href}?${bust}`;
    const mod = (await import(url)) as { default: { test?: { reporters?: Reporters } } };
    return mod.default.test ?? {};
  }

  async function loadReporters(config: string, bust: string): Promise<Reporters> {
    const url = `${pathToFileURL(path.join(REPO_ROOT, config)).href}?${bust}`;
    const mod = (await import(url)) as { default: { test?: { reporters?: Reporters } } };
    return mod.default.test?.reporters;
  }

  const configs = [
    { config: 'server/vitest.config.ts', file: 'server/finalize/a.test.ts' },
    { config: 'shared/vitest.config.ts', file: 'shared/utils/a.test.ts' },
    { config: 'mobile/vitest.config.js', file: 'mobile/src/utils/a.test.ts' },
    { config: 'electron/vitest.config.ts', file: 'electron/a.test.ts' },
    {
      config: 'client/vitest.config.ts',
      file: 'client/src/utils/a.test.ts',
      // The client config loads @vitejs/plugin-react, which only the client
      // install provides; the server shards don't install it.
      needs: 'client/node_modules/@vitejs/plugin-react',
    },
  ];

  for (const { config, file, needs } of configs) {
    it.skipIf(needs !== undefined && !existsSync(path.join(REPO_ROOT, needs)))(
      `${config} names testcases by repo-relative file under Finalize`,
      async () => {
        process.env.FINALIZE_JUNIT_DIR = '/tmp/finalize-junit/x';
        const reporters = await loadReporters(config, 'junit-on');
        const junit = reporters?.find(
          (r): r is [string, { classnameTemplate?: unknown }] =>
            Array.isArray(r) && r[0] === 'junit',
        );
        expect(reporters).toContain('default');
        const template = junit?.[1].classnameTemplate as (v: {
          filename: string;
          filepath: string;
        }) => string;
        const classname = template({ filename: 'a.test.ts', filepath: path.join(REPO_ROOT, file) });
        expect(classname).toBe(file);
        // The inventory parser accepts it as-is.
        const xml = `<testsuites><testsuite name="a.test.ts"><testcase classname="${classname}" name="t"/></testsuite></testsuites>`;
        expect(parseJunitTestFiles(xml)).toEqual([file]);

        delete process.env.FINALIZE_JUNIT_DIR;
        // Absent, not `reporters: undefined`, which crashes vitest startup.
        expect('reporters' in (await loadTestConfig(config, 'junit-off'))).toBe(false);
      },
    );
  }
});

describe('e2e: Playwright JUnit reporter', () => {
  it('adds a junit reporter only under Finalize', () => {
    expect(finalizeJunitReporter('e2e', {})).toEqual([]);
    expect(finalizeJunitReporter('e2e', { FINALIZE_JUNIT_DIR: '/tmp/finalize-junit/x' })).toEqual([
      ['junit', { outputFile: '/tmp/finalize-junit/x/e2e.xml' }],
    ]);
  });

  it('both Playwright configs include it', async () => {
    for (const config of ['playwright.config.ts', 'playwright.organizations.config.ts']) {
      const raw = await readFile(path.join(REPO_ROOT, 'e2e', config), 'utf8');
      expect(raw, config).toMatch(/\.\.\.finalizeJunitReporter\('e2e[\w-]*'\)/);
    }
  });
});
