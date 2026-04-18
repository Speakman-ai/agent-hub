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
import { readFileSync } from 'fs';
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

function run(cmd, args) {
  console.log(`\n$ ${cmd} ${args.join(' ')}`);
  const result = spawnSync(cmd, args, { stdio: 'inherit', cwd: ROOT });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
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

  // 2. Build both DMGs in one electron-builder invocation
  run('npx', ['electron-builder', '--mac', 'dmg', '--arm64', '--x64']);

  // 3. Upload each DMG to S3
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
