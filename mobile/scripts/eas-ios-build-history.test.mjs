import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const historyScript = fileURLToPath(new URL('./eas-ios-build-history.sh', import.meta.url));
const versionScript = fileURLToPath(new URL('./next-app-version.mjs', import.meta.url));

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'eas-history-'));
  dirs.push(dir);
  return dir;
}

// A stand-in `eas` that serves `build:list` pages from <dir>/served/<offset>.json,
// returns [] past the end, and logs every offset it was asked for.
// `failAt` makes one offset exit non-zero.
function fakeEas(pagesByOffset, { failAt } = {}) {
  const dir = tempDir();
  const served = join(dir, 'served');
  mkdirSync(served);
  for (const [offset, builds] of Object.entries(pagesByOffset)) {
    writeFileSync(
      join(served, `${offset}.json`),
      typeof builds === 'string' ? builds : JSON.stringify(builds),
    );
  }
  const bin = join(dir, 'eas');
  writeFileSync(
    bin,
    `#!/usr/bin/env bash
set -eu
offset=0
while [ $# -gt 0 ]; do
  if [ "$1" = "--offset" ]; then offset="$2"; shift; fi
  shift
done
echo "$offset" >> "${dir}/calls"
${failAt === undefined ? '' : `if [ "$offset" = "${failAt}" ]; then echo boom >&2; exit 3; fi`}
if [ -f "${served}/$offset.json" ]; then cat "${served}/$offset.json"; else echo '[]'; fi
`,
  );
  chmodSync(bin, 0o755);
  return { bin, calls: () => readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n') };
}

function builds(count, appVersion) {
  return Array.from({ length: count }, () => ({ appVersion }));
}

function runHistory(bin) {
  const out = tempDir();
  const res = spawnSync('bash', [historyScript, bin, out], { encoding: 'utf8' });
  return { res, out };
}

function nextVersion(out, floor = '1.0.0') {
  const appJson = join(tempDir(), 'app.json');
  writeFileSync(appJson, JSON.stringify({ expo: { version: floor } }));
  const pages = readdirSync(out)
    .filter((f) => f.startsWith('page-'))
    .map((f) => join(out, f));
  const res = spawnSync('node', [versionScript, '--app-json', appJson, ...pages], {
    encoding: 'utf8',
  });
  expect(res.status, res.stderr).toBe(0);
  expect(JSON.parse(readFileSync(appJson, 'utf8')).expo.version).toBe(res.stdout.trim());
  return res.stdout.trim();
}

describe('eas-ios-build-history.sh', () => {
  it('finds a maximum that sits beyond the first page', () => {
    // 50 newer development builds at 1.0.0 hide an older 2.0.0 on page two.
    const eas = fakeEas({ 0: builds(50, '1.0.0'), 50: [{ appVersion: '2.0.0' }] });
    const { res, out } = runHistory(eas.bin);
    expect(res.status, res.stderr).toBe(0);
    expect(eas.calls()).toEqual(['0', '50']);
    expect(nextVersion(out)).toBe('2.0.1');
  });

  it('asks for the next page when a page is exactly full', () => {
    const eas = fakeEas({ 0: builds(50, '1.0.3'), 50: builds(50, '1.0.2') });
    const { res, out } = runHistory(eas.bin);
    expect(res.status, res.stderr).toBe(0);
    expect(eas.calls()).toEqual(['0', '50', '100']);
    expect(nextVersion(out)).toBe('1.0.4');
  });

  it('reads a single short page once', () => {
    const eas = fakeEas({ 0: [{ appVersion: '1.0.7' }] });
    const { res, out } = runHistory(eas.bin);
    expect(res.status, res.stderr).toBe(0);
    expect(eas.calls()).toEqual(['0']);
    expect(nextVersion(out)).toBe('1.0.8');
  });

  it('fails when a later page cannot be fetched', () => {
    const eas = fakeEas({ 0: builds(50, '1.0.0') }, { failAt: 50 });
    const { res } = runHistory(eas.bin);
    expect(res.status).not.toBe(0);
    expect(eas.calls()).toEqual(['0', '50']);
  });

  it('fails when a page is not a build list', () => {
    const eas = fakeEas({ 0: builds(50, '1.0.0'), 50: '{"error":"nope"}' });
    const { res } = runHistory(eas.bin);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/not an eas build:list --json array/);
  });
});
