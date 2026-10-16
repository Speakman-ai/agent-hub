// Picks the user-facing app version (`expo.version`, CFBundleShortVersionString)
// for the next store build and writes it into app.json.
//
// EAS `autoIncrement` with `appVersionSource: remote` only bumps the build
// number; `version` stays whatever app.json says. To make every build carry a
// higher version, the deploy step feeds this script every page of the
// project's iOS EAS build history (see eas-ios-build-history.sh). The next version is one patch above the
// highest of app.json and every version EAS has already built. app.json acts as
// a floor, so a manual minor/major bump there still wins.
//
// EAS uploads the working tree (uncommitted changes included), so the rewritten
// app.json reaches the remote build without a commit.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION_RE = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/;

/** @returns {[number, number, number] | null} */
export function parseVersion(value) {
  if (typeof value !== 'string') return null;
  const m = VERSION_RE.exec(value.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}

function compare(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/**
 * @param {string} current version from app.json
 * @param {unknown[]} builds entries from `eas build:list --json`
 * @returns {string}
 */
export function nextAppVersion(current, builds) {
  const floor = parseVersion(current);
  if (!floor)
    throw new Error(`app.json expo.version "${current}" is not a MAJOR.MINOR.PATCH version`);
  let highest = floor;
  for (const build of Array.isArray(builds) ? builds : []) {
    const parsed = parseVersion(build && typeof build === 'object' ? build.appVersion : null);
    if (parsed && compare(parsed, highest) > 0) highest = parsed;
  }
  return `${highest[0]}.${highest[1]}.${highest[2] + 1}`;
}

export function readBuildPage(path) {
  let builds;
  try {
    builds = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`${path} is not readable eas build:list --json output: ${err.message}`);
  }
  if (!Array.isArray(builds)) throw new Error(`${path} is not an eas build:list --json array`);
  return builds;
}

// Usage:
//   next-app-version.mjs --count <page.json>
//     prints the number of builds in one page (the history script uses it to
//     decide whether another page exists)
//   next-app-version.mjs [--app-json <path>] <page.json>...
//     writes the next version into app.json and prints it
function main(args) {
  if (args[0] === '--count') {
    if (!args[1]) throw new Error('usage: next-app-version.mjs --count <page.json>');
    process.stdout.write(`${readBuildPage(args[1]).length}\n`);
    return;
  }
  let appJsonPath = resolve(dirname(fileURLToPath(import.meta.url)), '../app.json');
  if (args[0] === '--app-json') {
    appJsonPath = resolve(args[1]);
    args = args.slice(2);
  }
  if (args.length === 0) {
    throw new Error('usage: next-app-version.mjs [--app-json <path>] <page.json>...');
  }
  const builds = args.flatMap(readBuildPage);
  const appJson = JSON.parse(readFileSync(appJsonPath, 'utf8'));
  const version = nextAppVersion(appJson.expo.version, builds);
  appJson.expo.version = version;
  writeFileSync(appJsonPath, `${JSON.stringify(appJson, null, 2)}\n`);
  process.stdout.write(`${version}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
