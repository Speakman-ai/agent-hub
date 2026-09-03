import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, 'install-chromedriver.sh');

const CFT_BASE = 'https://cft.test/public';
const CFT_ENDPOINTS = 'https://cft.test/endpoints';

interface Fake {
  /** Exact-version zips that exist (HEAD → 200). */
  exact: string[];
  /** latest-patch-versions-per-build payload. */
  builds: Record<string, string>;
  /** Version string the fake chromedriver binary reports. */
  driverVersion?: string;
}

let sandbox: string;

// A `curl` stand-in on PATH: the script only ever issues a HEAD probe for the
// exact zip, a GET for the per-build JSON, and a GET for the zip itself.
function installFakeCurl(fake: Fake): void {
  const bin = path.join(sandbox, 'bin');
  mkdirSync(bin, { recursive: true });
  const buildsJson = JSON.stringify({
    builds: Object.fromEntries(
      Object.entries(fake.builds).map(([build, version]) => [
        build,
        {
          version,
          downloads: {
            chromedriver: [
              {
                platform: 'linux64',
                url: `${CFT_BASE}/${version}/linux64/chromedriver-linux64.zip`,
              },
              { platform: 'win64', url: `${CFT_BASE}/${version}/win64/chromedriver-win64.zip` },
            ],
          },
        },
      ]),
    ),
  });
  writeFileSync(path.join(sandbox, 'builds.json'), buildsJson);
  const exactList = fake.exact.map((v) => `${CFT_BASE}/${v}/linux64/chromedriver-linux64.zip`);
  writeFileSync(path.join(sandbox, 'exact.txt'), exactList.join('\n') + '\n');

  // Zip fixture: chromedriver-linux64/chromedriver is a shell script that
  // mimics `chromedriver --version` output.
  const driverVersion = fake.driverVersion ?? '0.0.0.0';
  const zipDir = path.join(sandbox, 'zip', 'chromedriver-linux64');
  mkdirSync(zipDir, { recursive: true });
  writeFileSync(
    path.join(zipDir, 'chromedriver'),
    `#!/bin/sh\necho "ChromeDriver ${driverVersion} (fake-build-hash)"\n`,
  );
  execFileSync('python3', [
    '-c',
    [
      'import sys, zipfile, os',
      'root, out = sys.argv[1], sys.argv[2]',
      'z = zipfile.ZipFile(out, "w")',
      'z.write(os.path.join(root, "chromedriver-linux64", "chromedriver"), "chromedriver-linux64/chromedriver")',
      'z.close()',
    ].join('\n'),
    path.join(sandbox, 'zip'),
    path.join(sandbox, 'driver.zip'),
  ]);

  writeFileSync(
    path.join(bin, 'curl'),
    `#!/usr/bin/env bash
# fake curl: parse out the URL, whether this is a HEAD probe, and any -o target.
url=""; head=0; out=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) shift; out="$1" ;;
    -*I*) [[ "$1" == -* && "$1" != --* ]] && head=1 ;;
    http*) url="$1" ;;
  esac
  shift
done
echo "$head $url" >> "${sandbox}/curl.log"
if [ "$head" = 1 ]; then
  grep -qxF "$url" "${sandbox}/exact.txt" && exit 0
  echo "curl: (22) The requested URL returned error: 404" >&2; exit 22
fi
case "$url" in
  *latest-patch-versions-per-build-with-downloads.json) cat "${sandbox}/builds.json" ;;
  *chromedriver-linux64.zip) cp "${sandbox}/driver.zip" "$out" ;;
  *) echo "fake curl: unexpected $url" >&2; exit 22 ;;
esac
`,
  );
  chmodSync(path.join(bin, 'curl'), 0o755);
}

function run(args: string[], env: Record<string, string> = {}) {
  const res = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: {
      PATH: `${path.join(sandbox, 'bin')}:${process.env.PATH ?? ''}`,
      HOME: sandbox,
      CFT_BASE,
      CFT_ENDPOINTS,
      INSTALL_CHROMEDRIVER_ARCH: 'x86_64',
      ...env,
    },
  });
  return { code: res.status, out: res.stdout.trim(), err: res.stderr.trim() };
}

beforeEach(() => {
  sandbox = mkdtempSync(path.join(tmpdir(), 'install-chromedriver-'));
});
afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe('install-chromedriver.sh — resolution ladder', () => {
  it('uses the exact-version zip when Chrome for Testing publishes it', () => {
    installFakeCurl({ exact: ['147.0.7727.15'], builds: {} });
    const r = run(['147.0.7727.15', '--print-url']);
    expect(r.code).toBe(0);
    expect(r.out).toBe(`${CFT_BASE}/147.0.7727.15/linux64/chromedriver-linux64.zip`);
  });

  it('falls back to the newest patch of the same major.minor.build', () => {
    installFakeCurl({ exact: [], builds: { '147.0.7727': '147.0.7727.117' } });
    const r = run(['147.0.7727.15', '--print-url']);
    expect(r.code).toBe(0);
    expect(r.out).toBe(`${CFT_BASE}/147.0.7727.117/linux64/chromedriver-linux64.zip`);
    expect(r.err).toMatch(/no chromedriver published for exact 147\.0\.7727\.15/);
  });

  it('refuses to cross majors when neither the version nor its build exists', () => {
    // A newer major IS available — the script must not "helpfully" pick it.
    installFakeCurl({ exact: ['152.0.7977.75'], builds: { '152.0.7977': '152.0.7977.75' } });
    const r = run(['147.0.7727.15', '--print-url']);
    expect(r.code).toBe(1);
    expect(r.out).toBe('');
    expect(r.err).toMatch(/refusing to install a different major/);
  });

  it('is a no-op (exit 0) on non-x86-64 hosts, where CfT ships no Linux driver', () => {
    installFakeCurl({ exact: ['147.0.7727.15'], builds: {} });
    const r = run(['147.0.7727.15', '--print-url'], { INSTALL_CHROMEDRIVER_ARCH: 'aarch64' });
    expect(r.code).toBe(0);
    expect(r.out).toBe('');
    expect(r.err).toMatch(/aarch64.*skipping/);
  });

  it('rejects malformed or missing versions before touching the network', () => {
    installFakeCurl({ exact: [], builds: {} });
    expect(run(['147.0', '--print-url']).code).toBe(2);
    expect(run(['--print-url']).code).toBe(2);
    expect(run(['147.0.7727.15', '--bogus']).code).toBe(2);
  });
});

describe('install-chromedriver.sh — install', () => {
  it('unpacks chromedriver into --dest, executable, and verifies the major', () => {
    installFakeCurl({ exact: ['147.0.7727.15'], builds: {}, driverVersion: '147.0.7727.15' });
    const dest = path.join(sandbox, 'dest');
    mkdirSync(dest);
    const r = run(['147.0.7727.15', '--dest', dest]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/ChromeDriver 147\.0\.7727\.15 .* -> .*\/dest\/chromedriver$/);
    const ver = execFileSync(path.join(dest, 'chromedriver'), ['--version'], { encoding: 'utf8' });
    expect(ver).toContain('147.0.7727.15');
  });

  it('removes the binary and fails when the downloaded driver reports another major', () => {
    installFakeCurl({ exact: ['147.0.7727.15'], builds: {}, driverVersion: '146.0.7000.1' });
    const dest = path.join(sandbox, 'dest');
    mkdirSync(dest);
    const r = run(['147.0.7727.15', '--dest', dest]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/does not match browser major 147/);
    expect(spawnSync('test', ['-e', path.join(dest, 'chromedriver')]).status).toBe(1);
  });
});
