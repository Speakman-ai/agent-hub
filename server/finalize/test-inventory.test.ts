import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  truncateSync,
  writeFileSync,
  existsSync,
} from 'fs';
import os from 'os';
import path from 'path';
import {
  cleanupJunitDir,
  collectJunitFiles,
  inventoriedJobs,
  JUNIT_MAX_FILES,
  JUNIT_PATH_ROOT_SUFFIX,
  parsePathRoot,
  ensureTestInventorySchema,
  JUNIT_COLLECT_SCRIPT,
  JUNIT_COLLECT_STEP_INDEX,
  junitDirForInstance,
  lookupTestInventory,
  parseJunitCollectorOutput,
  parseJunitTestFiles,
  readTestInventory,
  recordTestInventoryFromRun,
  shouldWriteTestInventory,
  testFilesFromJunit,
  writeTestInventory,
  type IsAncestorFn,
} from './test-inventory.js';
import { defaultSpawnStep, type SpawnedStep, type SpawnStepFn } from './step-runner.js';
import { withJunitDirPrepare } from './runner-exec-args.js';
import { FINALIZE_RUNNER_WORKSPACE } from './runner-images.js';

// ── XML shapes ──────────────────────────────────────────────────────────────

const VITEST = `<?xml version="1.0" encoding="UTF-8" ?>
<testsuites name="vitest tests" tests="3" failures="0" errors="0" time="0.5">
  <testsuite name="src/utils/a.test.ts" timestamp="2026-10-20T10:00:00" hostname="h" tests="2">
    <testcase classname="src/utils/a.test.ts" name="adds &gt; one" time="0.01"></testcase>
    <testcase classname="src/utils/a.test.ts" name="adds &gt; two" time="0.01">
      <failure message="boom"><![CDATA[<testcase classname="not/real.test.ts"/>]]></failure>
    </testcase>
  </testsuite>
  <testsuite name="src/b.test.tsx" tests="1">
    <testcase classname="src/b.test.tsx" name="renders" time="0.02"/>
  </testsuite>
  <testsuite name="src/all-skipped.test.ts" tests="0"></testsuite>
</testsuites>`;

const JEST_JUNIT_FILE_ATTR = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="jest tests" tests="2">
  <testsuite name="Login form" tests="2" file="/home/ci/repo/web/src/Login.test.jsx">
    <testcase classname="Login form renders" name="Login form renders" file="/home/ci/repo/web/src/Login.test.jsx"/>
    <testcase classname="Login form submits" name="Login form submits" file="/home/ci/repo/web/src/Login.test.jsx"/>
  </testsuite>
</testsuites>`;

const JEST_JUNIT_DEFAULT = `<testsuites name="jest tests">
  <testsuite name="Login form" tests="1">
    <testcase classname="Login form renders" name="Login form renders"/>
  </testsuite>
</testsuites>`;

const PYTEST_XUNIT2 = `<?xml version="1.0" encoding="utf-8"?>
<testsuites><testsuite name="pytest" errors="0" failures="0" skipped="0" tests="3">
  <testcase classname="tests.unit.test_api.TestLogin" name="test_ok" time="0.001"/>
  <testcase classname="tests.unit.test_api" name="test_bare" time="0.001"/>
  <testcase classname="tests.test_models" name="test_x" time="0.001"><skipped/></testcase>
</testsuite></testsuites>`;

const PYTEST_XUNIT2_ROOT = `<testsuites><testsuite name="pytest" tests="3">
  <testcase classname="test_api" name="test_ok"/>
  <testcase classname="db_test.TestConn" name="test_open"/>
  <testcase classname="TestOnlyClass" name="test_x"/>
  <testcase classname="tests" name="test_y"/>
</testsuite></testsuites>`;

const PYTEST_XUNIT1 = `<testsuites><testsuite name="pytest" tests="1">
  <testcase classname="tests.test_cli.TestRun" name="test_go" file="tests/test_cli.py" line="10"/>
</testsuite></testsuites>`;

const GO_JUNIT_REPORT = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites tests="2">
  <testsuite name="github.com/acme/app/internal/store" tests="2" time="0.1">
    <properties><property name="go.version" value="go1.23"></property></properties>
    <testcase name="TestGet" classname="github.com/acme/app/internal/store" time="0.0"></testcase>
    <testcase name="TestPut" classname="github.com/acme/app/internal/store" time="0.0"></testcase>
  </testsuite>
</testsuites>`;

const RSPEC = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="rspec" tests="2" skipped="0" failures="0" errors="0">
  <properties><property name="seed" value="1234"/></properties>
  <testcase classname="spec.models.user_spec" name="User is valid" file="./spec/models/user_spec.rb" time="0.01"/>
  <testcase classname="spec.requests.api_spec" name="API returns 200" file="./spec/requests/api_spec.rb" time="0.02"/>
</testsuite>`;

const PLAYWRIGHT = `<testsuites id="" name="" tests="2" failures="0" skipped="0" errors="0" time="3.2">
<testsuite name="auth/login.spec.ts" timestamp="2026-10-20T10:00:00.000Z" hostname="chromium" tests="2">
<testcase name="login › works" classname="auth/login.spec.ts" time="1.1"></testcase>
<testcase name="login › rejects" classname="auth/login.spec.ts" time="1.0"><system-out>log</system-out></testcase>
</testsuite>
</testsuites>`;

const CYPRESS_MOCHA = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="Mocha Tests" time="2.1" tests="1" failures="0">
  <testsuite name="Root Suite" timestamp="2026-10-20T10:00:00" tests="0" file="cypress/e2e/checkout.cy.ts" time="0.0" failures="0"></testsuite>
  <testsuite name="Checkout" timestamp="2026-10-20T10:00:00" tests="1" time="2.1" failures="0">
    <testcase name="Checkout pays" time="2.1" classname="pays"></testcase>
  </testsuite>
</testsuites>`;

describe('parseJunitTestFiles', () => {
  it('vitest: suite/classname are the file path; CDATA bodies are ignored', () => {
    expect(parseJunitTestFiles(VITEST)).toEqual([
      'src/all-skipped.test.ts',
      'src/b.test.tsx',
      'src/utils/a.test.ts',
    ]);
  });

  it('jest-junit with addFileAttribute: absolute file attr made workspace-relative', () => {
    expect(
      parseJunitTestFiles(JEST_JUNIT_FILE_ATTR, { workspaceRoots: ['/home/ci/repo'] }),
    ).toEqual(['web/src/Login.test.jsx']);
  });

  it('jest-junit default config: describe titles are not paths, so no files', () => {
    expect(parseJunitTestFiles(JEST_JUNIT_DEFAULT)).toEqual([]);
  });

  it('pytest xunit2: dotted classname maps to the module file, dropping test classes', () => {
    expect(parseJunitTestFiles(PYTEST_XUNIT2)).toEqual([
      'tests/test_models.py',
      'tests/unit/test_api.py',
    ]);
  });

  it('pytest xunit2: root-level test modules map to their file', () => {
    expect(parseJunitTestFiles(PYTEST_XUNIT2_ROOT)).toEqual(['db_test.py', 'test_api.py']);
  });

  it('pytest xunit1: file attribute wins over the classname', () => {
    expect(parseJunitTestFiles(PYTEST_XUNIT1)).toEqual(['tests/test_cli.py']);
  });

  it('go-junit-report: records the package import path', () => {
    expect(parseJunitTestFiles(GO_JUNIT_REPORT)).toEqual(['github.com/acme/app/internal/store']);
  });

  it('rspec_junit_formatter: root testsuite, ./-prefixed file attributes', () => {
    expect(parseJunitTestFiles(RSPEC)).toEqual([
      'spec/models/user_spec.rb',
      'spec/requests/api_spec.rb',
    ]);
  });

  it('playwright: classname is the spec path', () => {
    expect(parseJunitTestFiles(PLAYWRIGHT)).toEqual(['auth/login.spec.ts']);
  });

  it('cypress (mocha-junit-reporter): the Root Suite file applies to every case', () => {
    expect(parseJunitTestFiles(CYPRESS_MOCHA)).toEqual(['cypress/e2e/checkout.cy.ts']);
  });

  it('sibling suites each keep their own explicit or path-like attribution', () => {
    const xml = `<testsuites>
  <testsuite name="A" file="a.test.ts"><testcase classname="A works" name="works"/></testsuite>
  <testsuite name="b.test.ts"><testcase classname="b.test.ts" name="runs"/></testsuite>
</testsuites>`;
    expect(testFilesFromJunit([{ name: 'm.xml', xml }])).toEqual({
      files: ['a.test.ts', 'b.test.ts'],
      status: 'reported',
    });
  });

  it.each([
    [
      'a sibling suite with an unattributed testcase',
      `<testsuites>
  <testsuite name="A" file="a.test.ts"><testcase classname="A works" name="works"/></testsuite>
  <testsuite name="B"><testcase classname="B runs" name="runs"/></testsuite>
</testsuites>`,
    ],
    [
      'a sibling testcase whose explicit file is rejected',
      `<testsuites>
  <testsuite name="A" file="a.test.ts"><testcase classname="A works" name="works"/></testsuite>
  <testsuite name="B"><testcase classname="B runs" name="runs" file="../outside.test.ts"/></testsuite>
</testsuites>`,
    ],
    [
      'a rejected explicit file even when the classname is a path',
      `<testsuite name="s"><testcase classname="ok.test.ts" name="x" file="/etc/outside.test.ts/../x"/></testsuite>`,
    ],
    [
      'an absolute file outside the workspace',
      `<testsuite name="s"><testcase classname="x" name="x" file="/etc/elsewhere/a.test.ts"/></testsuite>`,
    ],
    [
      'a suite whose explicit file is rejected',
      `<testsuites><testsuite name="s.test.ts" file="../s.test.ts"><testcase classname="s.test.ts" name="x"/></testsuite></testsuites>`,
    ],
    [
      'two mocha Root Suites in one document',
      `<testsuites>
  <testsuite name="Root Suite" file="a.cy.ts" tests="0"></testsuite>
  <testsuite name="Root Suite" file="b.cy.ts" tests="0"></testsuite>
  <testsuite name="Checkout"><testcase classname="pays" name="pays"/></testsuite>
</testsuites>`,
    ],
    [
      'a Root Suite that has its own testcases',
      `<testsuites>
  <testsuite name="Root Suite" file="a.cy.ts"><testcase classname="x" name="x"/></testsuite>
  <testsuite name="Checkout"><testcase classname="pays" name="pays"/></testsuite>
</testsuites>`,
    ],
    [
      'a slash name outside a go-junit-report suite',
      `<testsuites><testsuite name="api"><testcase classname="api/users" name="lists"/></testsuite></testsuites>`,
    ],
    [
      'a dotted classname outside a pytest suite',
      `<testsuites><testsuite name="unit"><testcase classname="tests.test_api" name="x"/></testsuite></testsuites>`,
    ],
  ])('is incomplete for %s', (_label, xml) => {
    const res = testFilesFromJunit([{ name: 'r.xml', xml }]);
    expect(res.status).toBe('incomplete');
    expect(res.files).toEqual([]);
    expect(res.reason).toMatch(/testcase\(s\) name no file/);
  });

  it('accepts declarations, comments, CDATA and entities in a well-formed report', () => {
    const xml = `<?xml version="1.0"?>\n<!DOCTYPE testsuites>\n<!-- run 1 -->\n<testsuites><testsuite name="x"><testcase name="a &amp; b" file="a.test.ts"><system-out><![CDATA[<not a tag>]]></system-out></testcase></testsuite></testsuites>\n`;
    expect(testFilesFromJunit([{ name: 'x.xml', xml }])).toEqual({
      files: ['a.test.ts'],
      status: 'reported',
    });
  });

  it('strips the runner workspace prefix and rejects path traversal', () => {
    const xml = `<testsuite name="x"><testcase name="a" file="${FINALIZE_RUNNER_WORKSPACE}/pkg/a.test.ts"/><testcase name="b" file="../outside.test.ts"/></testsuite>`;
    expect(parseJunitTestFiles(xml)).toEqual(['pkg/a.test.ts']);
  });

  it('unions files across complete reports', () => {
    expect(
      testFilesFromJunit([
        { name: 'a.xml', xml: VITEST },
        { name: 'c.xml', xml: PLAYWRIGHT },
      ]),
    ).toEqual({
      files: [
        'auth/login.spec.ts',
        'src/all-skipped.test.ts',
        'src/b.test.tsx',
        'src/utils/a.test.ts',
      ],
      status: 'reported',
    });
    expect(testFilesFromJunit([])).toEqual({ files: [], status: 'no_reports' });
  });

  it.each([
    ['a report that is not XML', 'not xml at all', /malformed XML/],
    [
      'a truncated report',
      '<testsuites><testsuite><testcase file="a.test.ts"/><testcase file="b.test.ts"',
      /malformed XML/,
    ],
    [
      'a report cut off after a complete testcase',
      '<testsuites><testsuite name="s"><testcase file="a.test.ts"/>',
      /unclosed <testsuite>/,
    ],
    [
      'mismatched closing tags',
      '<testsuites><testsuite><testcase file="a.test.ts"></testsuite></testcase></testsuites>',
      /does not close/,
    ],
    ['a well-formed document that is not JUnit', '<html><body/></html>', /root element is <html>/],
    ['jest-junit without the file attribute', JEST_JUNIT_DEFAULT, /1 of 1 testcase/],
    [
      'a testcase whose only path is rejected',
      `<testsuite name="x"><testcase name="a" file="ok.test.ts"/><testcase name="b" file="../out.test.ts"/></testsuite>`,
      /1 of 2 testcase/,
    ],
  ])('is incomplete and empty for %s, even next to good reports', (_label, xml, reason) => {
    const res = testFilesFromJunit([
      { name: 'good.xml', xml: VITEST },
      { name: 'bad.xml', xml },
    ]);
    expect(res.status).toBe('incomplete');
    expect(res.files).toEqual([]);
    expect(res.reason).toMatch(reason);
  });
});

// ── Collection ──────────────────────────────────────────────────────────────

function fakeChild(stdout: string, code = 0, opts: { hang?: boolean } = {}): SpawnedStep {
  const listeners: Record<string, Array<(arg: unknown) => void>> = {};
  const dataListeners: Array<(c: string) => void> = [];
  const child: SpawnedStep = {
    stdout: {
      on: (event: string, l: (c: string) => void) => {
        if (event === 'data') dataListeners.push(l);
        return child.stdout;
      },
    } as unknown as NodeJS.ReadableStream,
    stderr: null,
    on(event: string, listener: (arg: never) => void) {
      (listeners[event] ??= []).push(listener as (arg: unknown) => void);
      return child;
    },
    kill: vi.fn(() => true),
  };
  setTimeout(() => {
    for (const l of dataListeners) l(stdout);
    if (!opts.hang) for (const l of listeners.close ?? []) l(code);
  }, 0);
  return child;
}

describe('path-root sidecars', () => {
  const PW_E2E = `<testsuites id="" name="" tests="1" failures="0" skipped="0" errors="0" time="1">
<testsuite name="x.spec.ts" timestamp="2026-10-20T10:00:00.000Z" hostname="chromium" tests="1">
<testcase name="x › works" classname="x.spec.ts" time="1"></testcase>
</testsuite>
</testsuites>`;
  const root = (report: string, dir: string) => ({
    name: `${report}${JUNIT_PATH_ROOT_SUFFIX}`,
    xml: `${dir}\n`,
  });

  it('a Playwright report for e2e/tests/x.spec.ts inventories as e2e/tests/x.spec.ts', () => {
    expect(
      testFilesFromJunit([{ name: 'e2e.xml', xml: PW_E2E }, root('e2e.xml', 'e2e/tests')]),
    ).toEqual({ files: ['e2e/tests/x.spec.ts'], status: 'reported' });
    // Without the sidecar the testDir-relative name is all there is.
    expect(testFilesFromJunit([{ name: 'e2e.xml', xml: PW_E2E }]).files).toEqual(['x.spec.ts']);
  });

  it('prefixes vitest cases and empty suites alike, per report', () => {
    expect(
      testFilesFromJunit([
        { name: 'server-1.xml', xml: VITEST },
        root('server-1.xml', './server/'),
        { name: 'nested/pw.xml', xml: PLAYWRIGHT },
        root('nested/pw.xml', 'e2e/tests'),
      ]),
    ).toEqual({
      files: [
        'e2e/tests/auth/login.spec.ts',
        'server/src/all-skipped.test.ts',
        'server/src/b.test.tsx',
        'server/src/utils/a.test.ts',
      ],
      status: 'reported',
    });
  });

  it('leaves absolute file attributes to the workspace roots', () => {
    expect(
      testFilesFromJunit([{ name: 'j.xml', xml: JEST_JUNIT_FILE_ATTR }, root('j.xml', 'web')], {
        workspaceRoots: ['/home/ci/repo'],
      }).files,
    ).toEqual(['web/src/Login.test.jsx']);
  });

  it('an invalid root voids the instance; a sidecar alone is no evidence', () => {
    for (const bad of ['/abs', '../up', 'a/../../b', 'two\nlines']) {
      const res = testFilesFromJunit([{ name: 'e2e.xml', xml: PW_E2E }, root('e2e.xml', bad)]);
      expect(res.status, bad).toBe('incomplete');
      expect(res.files).toEqual([]);
    }
    expect(testFilesFromJunit([root('e2e.xml', 'e2e/tests')])).toEqual({
      files: [],
      status: 'no_reports',
    });
  });

  it('parsePathRoot normalizes to a repo-relative directory', () => {
    expect(parsePathRoot('e2e/tests\n')).toBe('e2e/tests');
    expect(parsePathRoot('./server//')).toBe('server');
    expect(parsePathRoot('.')).toBe('');
    expect(parsePathRoot('')).toBe('');
    expect(parsePathRoot('C:/repo')).toBeNull();
  });

  it('the real collector script returns sidecars with their reports', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'junit-collect-root-'));
    writeFileSync(path.join(dir, 'e2e.xml'), PW_E2E);
    writeFileSync(path.join(dir, `e2e.xml${JUNIT_PATH_ROOT_SUFFIX}`), 'e2e/tests\n');
    writeFileSync(path.join(dir, 'stray.path-root'), 'ignored');
    try {
      const res = await collectJunitFiles({
        spawnStep: defaultSpawnStep,
        cwd: os.tmpdir(),
        env: { ...process.env, FINALIZE_JUNIT_DIR: dir },
      });
      expect(res.complete).toBe(true);
      expect(res.files.map((f) => f.name).sort()).toEqual(['e2e.xml', 'e2e.xml.path-root']);
      expect(testFilesFromJunit(res.files).files).toEqual(['e2e/tests/x.spec.ts']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('collector', () => {
  const block = (name: string, xml: string) =>
    `@@FINALIZE_JUNIT_FILE ${name}\n${Buffer.from(xml).toString('base64')}\n@@FINALIZE_JUNIT_END\n`;

  it('round-trips files and is complete only with a matching DONE count', () => {
    const out = `noise\n${block('sub/report.xml', VITEST)}\n@@FINALIZE_JUNIT_DONE 1\n`;
    expect(parseJunitCollectorOutput(out)).toEqual({
      files: [{ name: 'sub/report.xml', xml: VITEST }],
      complete: true,
    });
  });

  it.each([
    ['no DONE marker (output cut off)', (b: string) => b, /before DONE/],
    [
      'DONE count larger than the files returned',
      (b: string) => `${b}@@FINALIZE_JUNIT_DONE 2\n`,
      /found 2/,
    ],
    [
      'a malformed block',
      (b: string) => `${b}@@FINALIZE_JUNIT_FILE broken.xml\nabc\n\n@@FINALIZE_JUNIT_DONE 2\n`,
      /malformed/,
    ],
    [
      'an INCOMPLETE marker',
      () => '\n@@FINALIZE_JUNIT_INCOMPLETE 501 report(s), 0 over 16MB (limit 500)\n',
      /501 report/,
    ],
  ])('discards every file on %s', (_label, make, reason) => {
    const res = parseJunitCollectorOutput(make(block('a.xml', VITEST)));
    expect(res.complete).toBe(false);
    expect(res.files).toEqual([]);
    expect(res.reason).toMatch(reason);
  });

  it('collectJunitFiles runs the collector at its own step index with the instance env', async () => {
    const spawnStep = vi.fn<SpawnStepFn>(() =>
      fakeChild(`${block('rspec.xml', RSPEC)}\n@@FINALIZE_JUNIT_DONE 1\n`),
    );
    const res = await collectJunitFiles({
      spawnStep,
      cwd: '/wt',
      env: { FINALIZE_JUNIT_DIR: '/tmp/x' },
    });
    expect(res).toEqual({ files: [{ name: 'rspec.xml', xml: RSPEC }], complete: true });
    const call = spawnStep.mock.calls[0][0];
    expect(call.index).toBe(JUNIT_COLLECT_STEP_INDEX);
    expect(call.step.run).toBe(JUNIT_COLLECT_SCRIPT);
    expect(call.env?.FINALIZE_JUNIT_DIR).toBe('/tmp/x');
  });

  it('is incomplete when the runner throws, the collector exits non-zero, or output overflows', async () => {
    const throws: SpawnStepFn = () => {
      throw new Error('runner gone');
    };
    expect(await collectJunitFiles({ spawnStep: throws, cwd: '/wt', env: {} })).toMatchObject({
      complete: false,
      files: [],
      reason: expect.stringMatching(/runner gone/),
    });
    const full = `${block('a.xml', VITEST)}\n@@FINALIZE_JUNIT_DONE 1\n`;
    const nonZero = await collectJunitFiles({
      spawnStep: () => fakeChild(full, 137),
      cwd: '/wt',
      env: {},
    });
    expect(nonZero).toMatchObject({ complete: false, reason: 'collector exited 137' });
    const overflow = await collectJunitFiles({
      spawnStep: () => fakeChild(full),
      cwd: '/wt',
      env: {},
      maxCaptureChars: 64,
    });
    expect(overflow).toMatchObject({ complete: false, files: [] });
    expect(overflow.reason).toMatch(/exceeded 64/);
  });

  it('is incomplete and kills the collector when it times out', async () => {
    const child = fakeChild(`${block('a.xml', VITEST)}`, 0, { hang: true });
    const res = await collectJunitFiles({
      spawnStep: () => child,
      cwd: '/wt',
      env: {},
      timeoutMs: 20,
    });
    expect(res).toMatchObject({ complete: false, files: [] });
    expect(res.reason).toMatch(/timed out/);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('the real collector script reads nested xml, ignores other files and removes the dir', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'junit-collect-'));
    mkdirSync(path.join(dir, 'nested'));
    writeFileSync(path.join(dir, 'vitest.xml'), VITEST);
    writeFileSync(path.join(dir, 'nested', 'pw.xml'), PLAYWRIGHT);
    writeFileSync(path.join(dir, 'notes.txt'), 'ignored');
    try {
      const res = await collectJunitFiles({
        spawnStep: defaultSpawnStep,
        cwd: os.tmpdir(),
        env: { ...process.env, FINALIZE_JUNIT_DIR: dir },
      });
      expect(res.complete).toBe(true);
      expect(res.files.map((f) => f.name).sort()).toEqual(['nested/pw.xml', 'vitest.xml']);
      expect(res.files.find((f) => f.name === 'vitest.xml')?.xml).toBe(VITEST);
      expect(existsSync(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the real collector script is complete and empty when the job wrote nothing', async () => {
    const res = await collectJunitFiles({
      spawnStep: defaultSpawnStep,
      cwd: os.tmpdir(),
      env: { ...process.env, FINALIZE_JUNIT_DIR: path.join(os.tmpdir(), 'junit-never-made-xyz') },
    });
    expect(res).toEqual({ files: [], complete: true });
  });

  it('the real collector script refuses more reports than the file limit', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'junit-many-'));
    for (let i = 0; i <= JUNIT_MAX_FILES; i++) writeFileSync(path.join(dir, `r${i}.xml`), VITEST);
    try {
      const res = await collectJunitFiles({
        spawnStep: defaultSpawnStep,
        cwd: os.tmpdir(),
        env: { ...process.env, FINALIZE_JUNIT_DIR: dir },
      });
      expect(res).toMatchObject({ complete: false, files: [] });
      expect(res.reason).toMatch(new RegExp(`more than ${JUNIT_MAX_FILES} report`));
      expect(existsSync(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the real collector script refuses when one report is over the size limit', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'junit-big-'));
    writeFileSync(path.join(dir, 'ok.xml'), VITEST);
    const big = path.join(dir, 'big.xml');
    writeFileSync(big, '');
    truncateSync(big, 16 * 1024 * 1024); // sparse; find -size reads st_size
    try {
      const res = await collectJunitFiles({
        spawnStep: defaultSpawnStep,
        cwd: os.tmpdir(),
        env: { ...process.env, FINALIZE_JUNIT_DIR: dir },
      });
      expect(res).toMatchObject({ complete: false, files: [] });
      expect(res.reason).toMatch(/big\.xml is 16MB or more/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the real collector script output over the capture cap is incomplete', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'junit-cap-'));
    writeFileSync(path.join(dir, 'a.xml'), VITEST);
    writeFileSync(path.join(dir, 'b.xml'), VITEST);
    try {
      const res = await collectJunitFiles({
        spawnStep: defaultSpawnStep,
        cwd: os.tmpdir(),
        env: { ...process.env, FINALIZE_JUNIT_DIR: dir },
        maxCaptureChars: VITEST.length,
      });
      expect(res).toMatchObject({ complete: false, files: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the real collector script is incomplete when a subdirectory cannot be traversed', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'junit-unreadable-dir-'));
    writeFileSync(path.join(dir, 'ok.xml'), VITEST);
    const locked = path.join(dir, 'locked');
    mkdirSync(locked);
    writeFileSync(path.join(locked, 'hidden.xml'), PLAYWRIGHT);
    chmodSync(locked, 0o000);
    try {
      const res = await collectJunitFiles({
        spawnStep: defaultSpawnStep,
        cwd: os.tmpdir(),
        env: { ...process.env, FINALIZE_JUNIT_DIR: dir },
      });
      expect(res).toMatchObject({ complete: false, files: [] });
      expect(res.reason).toMatch(/could not read every directory/);
    } finally {
      if (existsSync(locked)) chmodSync(locked, 0o755);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the real collector script is incomplete when a report cannot be read', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'junit-unreadable-file-'));
    writeFileSync(path.join(dir, 'ok.xml'), VITEST);
    const locked = path.join(dir, 'locked.xml');
    writeFileSync(locked, PLAYWRIGHT);
    chmodSync(locked, 0o000);
    try {
      const res = await collectJunitFiles({
        spawnStep: defaultSpawnStep,
        cwd: os.tmpdir(),
        env: { ...process.env, FINALIZE_JUNIT_DIR: dir },
      });
      expect(res).toMatchObject({ complete: false, files: [] });
      expect(res.reason).toMatch(/cannot read locked\.xml/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the cleanup script removes the dir and tolerates a missing one', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'junit-clean-'));
    writeFileSync(path.join(dir, 'a.xml'), VITEST);
    await cleanupJunitDir({
      spawnStep: defaultSpawnStep,
      cwd: os.tmpdir(),
      env: { ...process.env, FINALIZE_JUNIT_DIR: dir },
    });
    expect(existsSync(dir)).toBe(false);
    await cleanupJunitDir({
      spawnStep: defaultSpawnStep,
      cwd: os.tmpdir(),
      env: { ...process.env, FINALIZE_JUNIT_DIR: dir },
    });
  });

  it('every step creates FINALIZE_JUNIT_DIR before its own command runs', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'junit-prep-'));
    const dir = path.join(root, 'a', 'b');
    try {
      const child = defaultSpawnStep({
        step: { name: 'go', run: 'echo "<testsuite/>" > "$FINALIZE_JUNIT_DIR/go.xml"' },
        index: 0,
        cwd: root,
        env: { ...process.env, FINALIZE_JUNIT_DIR: dir },
      });
      const code = await new Promise<number | null>((r) => child.on('close', r));
      expect(code).toBe(0);
      expect(existsSync(path.join(dir, 'go.xml'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('withJunitDirPrepare leaves the command alone when the env has no junit dir', () => {
    expect(withJunitDirPrepare('echo hi', {})).toBe('echo hi');
    expect(withJunitDirPrepare('echo hi', { FINALIZE_JUNIT_DIR: '/tmp/j' })).toMatch(
      /^mkdir -p "\$FINALIZE_JUNIT_DIR" .*\necho hi$/,
    );
  });

  it('junit dirs are unique per instance and live outside the workspace', () => {
    const a = junitDirForInstance('run-1', 'unit', 'shard=1');
    const b = junitDirForInstance('run-1', 'unit', 'shard=2');
    expect(a).not.toBe(b);
    expect(a.startsWith('/tmp/finalize-junit/')).toBe(true);
    expect(a).not.toMatch(/=/);
  });

  it('junit dirs stay distinct when sanitizing or truncating would collide', () => {
    expect(junitDirForInstance('r', 'unit', 'target=a/b')).not.toBe(
      junitDirForInstance('r', 'unit', 'target=a-b'),
    );
    const long = 'x'.repeat(200);
    expect(junitDirForInstance('r', 'unit', `${long}1`)).not.toBe(
      junitDirForInstance('r', 'unit', `${long}2`),
    );
    expect(junitDirForInstance('r', 'a-b', 'c')).not.toBe(junitDirForInstance('r', 'a', 'b-c'));
    expect(junitDirForInstance('r', 'unit', 'k')).toBe(junitDirForInstance('r', 'unit', 'k'));
  });
});

// ── Write gating ────────────────────────────────────────────────────────────

function memDb(): Database.Database {
  const db = new Database(':memory:');
  ensureTestInventorySchema(db);
  return db;
}

const FULL_DEFAULT = {
  trigger: 'git_push',
  branch: 'main',
  defaultBranch: 'main',
  fullRun: true,
  status: 'success' as const,
};

describe('shouldWriteTestInventory', () => {
  it('allows only full default-branch push CI runs with real results', () => {
    expect(shouldWriteTestInventory(FULL_DEFAULT)).toBe(true);
    expect(shouldWriteTestInventory({ ...FULL_DEFAULT, status: 'failure' })).toBe(true);
    expect(shouldWriteTestInventory({ ...FULL_DEFAULT, status: 'timeout' })).toBe(true);
  });

  it.each([
    ['session Finalize run', { trigger: 'finalize' }],
    ['manual Finalize run', { trigger: null }],
    ['PR CI', { trigger: 'pr_push' }],
    ['selected / per-job run', { fullRun: false }],
    ['non-default branch', { branch: 'feature/x' }],
    ['unknown default branch', { defaultBranch: '' }],
    ['infra error', { status: 'infra_error' as const }],
    ['cancelled', { status: 'cancelled' as const }],
  ])('refuses a %s', (_label, patch) => {
    expect(shouldWriteTestInventory({ ...FULL_DEFAULT, ...patch })).toBe(false);
  });
});

describe('recordTestInventoryFromRun', () => {
  const base = {
    ...FULL_DEFAULT,
    projectId: 'p1',
    runId: 'r1',
    repoDir: '/repo',
    headSha: 'aaaa1111',
    reports: [
      {
        jobId: 'unit',
        matrixKey: 'shard=1',
        testFiles: ['a.test.ts', 'b.test.ts'],
        status: 'reported' as const,
      },
      {
        jobId: 'unit',
        matrixKey: 'shard=2',
        testFiles: ['c.test.ts'],
        status: 'reported' as const,
      },
      { jobId: 'lint', matrixKey: '', testFiles: [], status: 'reported' as const },
    ],
  };

  it('writes (project, job, matrix, file, sha) for a full default-branch run', async () => {
    const db = memDb();
    expect(await recordTestInventoryFromRun(db, base)).toBe(true);
    const inv = readTestInventory(db, 'p1');
    expect(inv?.state).toMatchObject({ sha: 'aaaa1111', branch: 'main', runId: 'r1' });
    expect(inv?.entries).toEqual([
      { jobId: 'unit', matrixKey: 'shard=1', testFile: 'a.test.ts' },
      { jobId: 'unit', matrixKey: 'shard=1', testFile: 'b.test.ts' },
      { jobId: 'unit', matrixKey: 'shard=2', testFile: 'c.test.ts' },
    ]);
    const rows = db.prepare('SELECT DISTINCT sha FROM finalize_test_inventory').all();
    expect(rows).toEqual([{ sha: 'aaaa1111' }]);
  });

  it('never writes for session, PR or selected runs', async () => {
    const db = memDb();
    expect(await recordTestInventoryFromRun(db, { ...base, trigger: 'finalize' })).toBe(false);
    expect(await recordTestInventoryFromRun(db, { ...base, trigger: 'pr_push' })).toBe(false);
    expect(await recordTestInventoryFromRun(db, { ...base, fullRun: false })).toBe(false);
    expect(readTestInventory(db, 'p1')).toBeNull();
  });

  it('replaces the whole snapshot: a job that stopped writing JUnit has no inventory', async () => {
    const db = memDb();
    await recordTestInventoryFromRun(db, base);
    const isAncestor: IsAncestorFn = async () => false;
    await recordTestInventoryFromRun(db, {
      ...base,
      headSha: 'bbbb2222',
      runId: 'r2',
      isAncestor,
      reports: [
        {
          jobId: 'unit',
          matrixKey: 'shard=1',
          testFiles: ['a.test.ts'],
          status: 'reported' as const,
        },
      ],
    });
    const inv = readTestInventory(db, 'p1');
    expect(inv?.state.sha).toBe('bbbb2222');
    expect(inv?.entries).toEqual([{ jobId: 'unit', matrixKey: 'shard=1', testFile: 'a.test.ts' }]);
  });

  it('drops a whole job when any of its instances is incomplete', async () => {
    const db = memDb();
    const reports = [
      {
        jobId: 'unit',
        matrixKey: 'shard=1',
        testFiles: ['a.test.ts'],
        status: 'reported' as const,
      },
      {
        jobId: 'unit',
        matrixKey: 'shard=2',
        testFiles: [],
        status: 'incomplete' as const,
        reason: 'timed out',
      },
      { jobId: 'e2e', matrixKey: '', testFiles: ['x.spec.ts'], status: 'reported' as const },
    ];
    expect([...inventoriedJobs(reports)]).toEqual(['e2e']);
    await recordTestInventoryFromRun(db, { ...base, reports });
    expect(readTestInventory(db, 'p1')?.entries).toEqual([
      { jobId: 'e2e', matrixKey: '', testFile: 'x.spec.ts' },
    ]);
  });

  it('drops a matrix job when one shard passed but wrote no JUnit', async () => {
    const db = memDb();
    const reports = [
      {
        jobId: 'unit',
        matrixKey: 'shard=1',
        testFiles: ['a.test.ts'],
        status: 'reported' as const,
      },
      { jobId: 'unit', matrixKey: 'shard=2', testFiles: [], status: 'no_reports' as const },
      { jobId: 'zero', matrixKey: '', testFiles: [], status: 'reported' as const },
    ];
    // shard 2 may have run tests with its reporter off: no evidence, so the
    // whole job goes. An explicit zero-test report is evidence and stays.
    expect([...inventoriedJobs(reports)]).toEqual(['zero']);
    await recordTestInventoryFromRun(db, { ...base, reports });
    expect(readTestInventory(db, 'p1')?.entries).toEqual([]);
  });

  it('keeps the snapshot when git cannot tell whether the run is older', async () => {
    const db = memDb();
    await recordTestInventoryFromRun(db, { ...base, headSha: 'recorded' });
    expect(
      await recordTestInventoryFromRun(db, {
        ...base,
        headSha: 'unknown',
        isAncestor: async () => null,
      }),
    ).toBe(false);
    expect(readTestInventory(db, 'p1')?.state.sha).toBe('recorded');
  });

  it('an older run whose ancestry check finishes last does not overwrite a newer one', async () => {
    const db = memDb();
    await recordTestInventoryFromRun(db, { ...base, headSha: 'S' });
    // History: S <- A <- B. Both runs read snapshot S, then their checks
    // against S resolve out of order: B first, A second.
    const pending = new Map<string, (v: boolean) => void>();
    const isAncestor: IsAncestorFn = (_repo, ancestor, descendant) => {
      if (ancestor === 'A' && descendant === 'B') return Promise.resolve(true);
      return new Promise((resolve) => pending.set(`${ancestor}->${descendant}`, resolve));
    };
    const runA = recordTestInventoryFromRun(db, { ...base, headSha: 'A', runId: 'rA', isAncestor });
    const runB = recordTestInventoryFromRun(db, { ...base, headSha: 'B', runId: 'rB', isAncestor });
    await vi.waitFor(() => expect(pending.size).toBe(2));
    pending.get('B->S')!(false);
    expect(await runB).toBe(true);
    pending.get('A->S')!(false);
    expect(await runA).toBe(false);
    expect(readTestInventory(db, 'p1')?.state).toMatchObject({ sha: 'B', runId: 'rB' });
  });

  it('writeTestInventory refuses a stale compare-and-swap', () => {
    const db = memDb();
    writeTestInventory(db, { projectId: 'p1', branch: 'main', sha: 'X', runId: 'r', reports: [] });
    expect(
      writeTestInventory(db, {
        projectId: 'p1',
        branch: 'main',
        sha: 'Y',
        runId: 'r2',
        reports: [],
        expectedSha: 'W',
      }),
    ).toBe(false);
    expect(readTestInventory(db, 'p1')?.state.sha).toBe('X');
  });

  it('a re-run of an older commit does not roll the inventory back', async () => {
    const db = memDb();
    await recordTestInventoryFromRun(db, { ...base, headSha: 'newer' });
    const isAncestor = vi.fn<IsAncestorFn>(async () => true);
    expect(
      await recordTestInventoryFromRun(db, { ...base, headSha: 'older', runId: 'r0', isAncestor }),
    ).toBe(false);
    expect(isAncestor).toHaveBeenCalledWith('/repo', 'older', 'newer');
    expect(readTestInventory(db, 'p1')?.state.sha).toBe('newer');
  });

  it('keeps projects apart', async () => {
    const db = memDb();
    await recordTestInventoryFromRun(db, base);
    writeTestInventory(db, { projectId: 'p2', branch: 'main', sha: 'c', runId: 'x', reports: [] });
    expect(readTestInventory(db, 'p1')?.entries).toHaveLength(3);
    expect(readTestInventory(db, 'p2')?.entries).toEqual([]);
  });
});

// ── Lookup / staleness ──────────────────────────────────────────────────────

describe('lookupTestInventory', () => {
  function seeded(): Database.Database {
    const db = memDb();
    writeTestInventory(db, {
      projectId: 'p1',
      branch: 'main',
      sha: 'inv-sha',
      runId: 'r1',
      reports: [
        { jobId: 'unit', matrixKey: '', testFiles: ['a.test.ts'], status: 'reported' as const },
      ],
      now: 1000,
    });
    return db;
  }

  it('returns missing when no full run has recorded one', async () => {
    expect(
      await lookupTestInventory(memDb(), { projectId: 'p1', baseSha: 'base', repoDir: '/r' }),
    ).toEqual({ status: 'missing' });
  });

  it('returns the entries when the inventory sha is an ancestor of the base', async () => {
    const isAncestor = vi.fn<IsAncestorFn>(async () => true);
    const res = await lookupTestInventory(seeded(), {
      projectId: 'p1',
      baseSha: 'base',
      repoDir: '/r',
      isAncestor,
    });
    expect(isAncestor).toHaveBeenCalledWith('/r', 'inv-sha', 'base', undefined);
    expect(res).toEqual({
      status: 'ok',
      sha: 'inv-sha',
      branch: 'main',
      recordedAt: 1000,
      entries: [{ jobId: 'unit', matrixKey: '', testFile: 'a.test.ts' }],
    });
  });

  it('is stale when the inventory sha is not an ancestor of the base', async () => {
    const res = await lookupTestInventory(seeded(), {
      projectId: 'p1',
      baseSha: 'base',
      repoDir: '/r',
      isAncestor: async () => false,
    });
    expect(res).toMatchObject({ status: 'stale', sha: 'inv-sha' });
    expect(res.status === 'stale' && res.reason).toMatch(/not an ancestor/);
  });

  it('is stale when ancestry cannot be determined', async () => {
    for (const isAncestor of [
      (async () => null) as IsAncestorFn,
      (async () => {
        throw new Error('git missing');
      }) as IsAncestorFn,
    ]) {
      const res = await lookupTestInventory(seeded(), {
        projectId: 'p1',
        baseSha: 'base',
        repoDir: '/r',
        isAncestor,
      });
      expect(res.status).toBe('stale');
    }
  });
});
