/**
 * release-mac — Build macOS DMGs for both arm64 and x64, upload to S3.
 *
 * Invoked via `npm run release:mac` from the repo root or from the
 * `build-mac` job in `.github/workflows/release-prod.yml`.
 *
 * Requires:
 *   - macOS host (electron-builder needs hdiutil + Apple toolchain for DMGs)
 *   - AWS credentials with write access to the bucket, via either:
 *       • the `default` CLI profile (local dev), OR
 *       • ambient env-var credentials populated by aws-actions/configure-aws-credentials (CI)
 *
 * Uploads to: s3://agent-hub-prod-releases/v<version>/
 *   - Agent Hub-<version>-arm64.dmg
 *   - Agent Hub-<version>.dmg   (Intel x64)
 */
import { readFileSync, existsSync } from 'fs';
import { spawnSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

export const BUCKET = 'agent-hub-prod-releases';
export const REGION = 'us-east-2';
export const AWS_PROFILE = 'default';
export const PRODUCT_NAME = 'Agent Hub';

/**
 * Read the version string from a package.json file.
 * @param {string} pkgPath absolute path to a package.json
 * @returns {string} version
 */
export function readVersion(pkgPath = resolve(ROOT, 'package.json')) {
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  if (!pkg.version) {
    throw new Error(`package.json at ${pkgPath} is missing "version"`);
  }
  return pkg.version;
}

/**
 * Compute the default electron-builder DMG filenames for a given version.
 * These match electron-builder's default artifact naming when targets are
 * `--mac dmg --arm64 --x64` with no custom `artifactName`.
 */
export function dmgFilenames(productName, version) {
  return {
    arm64: `${productName}-${version}-arm64.dmg`,
    x64: `${productName}-${version}.dmg`,
  };
}

/** Build the S3 object key for a release artifact. */
export function s3Key(version, filename) {
  return `v${version}/${filename}`;
}

/** Build a full s3:// URI. */
export function s3Uri(bucket, key) {
  return `s3://${bucket}/${key}`;
}

/**
 * Decide which AWS CLI profile (if any) to pass to `aws s3 cp`.
 *
 * Priority:
 *   1. If `AWS_PROFILE` is set in env, use that value (including if empty —
 *      an explicit empty string means "no profile flag").
 *   2. Else if ambient static creds are present (`AWS_ACCESS_KEY_ID`), CI is
 *      using OIDC-assumed credentials. Return `null` so no `--profile` flag
 *      is passed, letting the CLI pick up env credentials.
 *   3. Else fall back to the local-dev default (`'default'`).
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {string | null} profile name, or null to omit --profile
 */
export function resolveAwsProfile(env = process.env) {
  if (typeof env.AWS_PROFILE === 'string') {
    return env.AWS_PROFILE === '' ? null : env.AWS_PROFILE;
  }
  if (env.AWS_ACCESS_KEY_ID) {
    return null;
  }
  return AWS_PROFILE;
}

/**
 * Build the `aws s3 cp` arg list, optionally appending `--profile <profile>`.
 * @param {string} src
 * @param {string} dst
 * @param {string | null} profile
 * @returns {string[]}
 */
export function awsCpArgs(src, dst, profile) {
  const args = ['s3', 'cp', src, dst];
  if (profile) {
    args.push('--profile', profile);
  }
  return args;
}

/**
 * Build the electron-builder arg list for our macOS DMG release.
 *
 * `--publish never` is required: when running under CI (e.g. GitHub Actions),
 * electron-builder auto-detects the environment and triggers an *implicit*
 * publish to GitHub Releases, which fails because the `build-mac` job
 * intentionally does not expose `GH_TOKEN` (releases are created upstream by
 * the `release` job using `RELEASE_PAT`, and DMG distribution is handled by
 * the subsequent `aws s3 cp` step in this script — not by electron-builder).
 *
 * Passing `--publish never` is also forward-compatible with electron-builder
 * v27, which removes the implicit-publish-on-CI behavior entirely.
 *
 * @returns {string[]}
 */
export function electronBuilderArgs() {
  return [
    'electron-builder',
    '--mac',
    'dmg',
    '--arm64',
    '--x64',
    '--publish',
    'never',
  ];
}

function requireMac() {
  if (process.platform !== 'darwin') {
    console.error(
      `✗ release:mac must be run on macOS (current platform: ${process.platform})`
    );
    console.error(
      '  electron-builder requires hdiutil + Apple toolchain to produce DMGs.'
    );
    process.exit(1);
  }
}

function run(cmd, args, opts = {}) {
  console.log(`\n$ ${cmd} ${args.join(' ')}`);
  const result = spawnSync(cmd, args, { stdio: 'inherit', cwd: opts.cwd || ROOT });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

/**
 * Read `version` from `server/node_modules/@esbuild/<dirName>/package.json`.
 * @returns {string | null} semver string, or null if missing / invalid shape
 */
export function readDarwinEsbuildDirVersion(serverDir, dirName) {
  if (!dirName) {
    return null;
  }
  const pkgPath = resolve(serverDir, 'node_modules/@esbuild', dirName, 'package.json');
  if (!existsSync(pkgPath)) {
    return null;
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(pkgPath, 'utf8'));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`✗ Could not parse ${pkgPath}: ${msg}`);
    process.exit(1);
  }
  const v = raw && typeof raw.version === 'string' ? raw.version : null;
  return v;
}

/**
 * Version of the installed native darwin @esbuild binary under server/node_modules.
 * Used to pin the cross-arch binary to the same release as tsx/esbuild.
 */
export function readNativeDarwinEsbuildVersion(serverDir) {
  const nativeDir =
    process.arch === 'arm64'
      ? 'darwin-arm64'
      : process.arch === 'x64'
        ? 'darwin-x64'
        : null;
  return readDarwinEsbuildDirVersion(serverDir, nativeDir);
}

/**
 * npm package spec for the non-native macOS esbuild binary (for universal DMG packaging).
 */
export function crossDarwinEsbuildPackageSpec(arch = process.arch, nativeVersion) {
  if (!nativeVersion) {
    return null;
  }
  const other =
    arch === 'arm64' ? 'darwin-x64' : arch === 'x64' ? 'darwin-arm64' : null;
  if (!other) {
    return null;
  }
  return `@esbuild/${other}@${nativeVersion}`;
}

function installCrossPlatformEsbuildForServer() {
  const serverDir = resolve(ROOT, 'server');
  const otherDir =
    process.arch === 'arm64' ? 'darwin-x64' : process.arch === 'x64' ? 'darwin-arm64' : null;
  if (!otherDir) {
    console.warn(
      `\nSkipping cross-arch esbuild install: unexpected process.arch=${process.arch}`
    );
    return;
  }
  const v = readNativeDarwinEsbuildVersion(serverDir);
  if (!v) {
    console.error(
      '✗ Could not read native @esbuild/darwin-* version under server/node_modules. Run npm ci (or npm install) in server/ first.'
    );
    process.exit(1);
  }
  const crossV = readDarwinEsbuildDirVersion(serverDir, otherDir);
  if (crossV === v) {
    console.log(
      `\nCross-arch esbuild already satisfies native version (@esbuild/${otherDir}@${crossV}), skipping install.`
    );
    return;
  }
  if (crossV) {
    console.log(
      `\nCross-arch @esbuild/${otherDir}@${crossV} differs from native @${v}; reinstalling to match.`
    );
  }
  const spec = crossDarwinEsbuildPackageSpec(process.arch, v);
  console.log(
    '\nInstalling cross-platform esbuild binary for server (other macOS arch for DMG packaging)...'
  );
  // npm refuses wrong-CPU optional packages without --force; safe here (official scoped binary only).
  run('npm', ['install', '--no-save', '--force', spec], { cwd: serverDir });
}

export async function main() {
  requireMac();
  const version = readVersion();
  const { arm64, x64 } = dmgFilenames(PRODUCT_NAME, version);

  console.log(
    `Releasing ${PRODUCT_NAME} v${version} → s3://${BUCKET}/v${version}/`
  );

  // 1. Build the React client
  run('npm', ['run', 'build']);

  // 2. Ensure both platform esbuild binaries are present in server/node_modules.
  //    The build machine only gets its native @esbuild/darwin-* from npm ci.
  //    The other macOS arch is needed so tsx works inside that arch's DMG.
  installCrossPlatformEsbuildForServer();

  // 3. Build both DMGs in one electron-builder invocation
  run('npx', electronBuilderArgs());

  // 4. Upload each DMG to S3
  const profile = resolveAwsProfile();
  if (profile) {
    console.log(`  (using AWS profile: ${profile})`);
  } else {
    console.log('  (using ambient AWS env credentials — no --profile flag)');
  }
  for (const filename of [arm64, x64]) {
    const src = resolve(ROOT, 'release', filename);
    const dst = s3Uri(BUCKET, s3Key(version, filename));
    run('aws', awsCpArgs(src, dst, profile));
  }

  console.log(
    `\n✓ Uploaded v${version} artifacts to s3://${BUCKET}/v${version}/`
  );
}

// Run when invoked directly (not imported in tests)
const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
