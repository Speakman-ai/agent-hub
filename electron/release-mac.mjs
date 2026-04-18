/**
 * release-mac — Build macOS DMGs for both arm64 and x64, upload to S3.
 *
 * Invoked via `npm run release:mac` from the repo root.
 *
 * Requires:
 *   - macOS host (electron-builder needs hdiutil + Apple toolchain for DMGs)
 *   - AWS CLI authenticated on the `default` profile with write access to the bucket
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
  for (const filename of [arm64, x64]) {
    const src = resolve(ROOT, 'release', filename);
    const dst = s3Uri(BUCKET, s3Key(version, filename));
    run('aws', ['s3', 'cp', src, dst, '--profile', AWS_PROFILE]);
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
