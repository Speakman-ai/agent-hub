import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync, mkdirSync, readdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  readVersion,
  readDarwinEsbuildDirVersion,
  readNativeDarwinEsbuildVersion,
  crossDarwinEsbuildPackageSpec,
  dmgFilenames,
  s3Key,
  s3Uri,
  resolveAwsProfile,
  awsCpArgs,
  electronBuilderArgs,
  hasNotarizeCredentials,
  resolveMacSigningMode,
  decodeCscLink,
  keychainSetupCommands,
  parseKeychainList,
  electronBuilderSigningEnv,
  prepareSigningKeychain,
  resolveBucket,
  resolveRegion,
  DEFAULT_BUCKET,
  DEFAULT_REGION,
  BUCKET,
  REGION,
  AWS_PROFILE,
  PRODUCT_NAME,
} from './release-mac.mjs';

describe('release-mac helpers', () => {
  describe('constants', () => {
    it('defaults to the reference release bucket in us-east-2', () => {
      expect(BUCKET).toBe('agent-hub-prod-releases');
      expect(REGION).toBe('us-east-2');
    });

    it('uses the default AWS profile', () => {
      expect(AWS_PROFILE).toBe('default');
    });
  });

  describe('resolveBucket / resolveRegion', () => {
    it('falls back to the reference bucket/region when env is unset', () => {
      expect(resolveBucket({})).toBe(DEFAULT_BUCKET);
      expect(resolveRegion({})).toBe(DEFAULT_REGION);
    });

    it('honours AGENT_HUB_RELEASE_BUCKET / AGENT_HUB_RELEASE_REGION so a fork can self-publish', () => {
      expect(resolveBucket({ AGENT_HUB_RELEASE_BUCKET: '  my-fork-releases  ' })).toBe(
        'my-fork-releases',
      );
      expect(resolveRegion({ AGENT_HUB_RELEASE_REGION: 'eu-west-1' })).toBe('eu-west-1');
    });

    it('treats a blank env value as unset', () => {
      expect(resolveBucket({ AGENT_HUB_RELEASE_BUCKET: '   ' })).toBe(DEFAULT_BUCKET);
      expect(resolveRegion({ AGENT_HUB_RELEASE_REGION: '' })).toBe(DEFAULT_REGION);
    });

    it('targets the Agent Hub product name', () => {
      expect(PRODUCT_NAME).toBe('Agent Hub');
    });
  });

  describe('dmgFilenames', () => {
    it('returns default electron-builder DMG names for both arches', () => {
      expect(dmgFilenames('Agent Hub', '1.3.1')).toEqual({
        arm64: 'Agent Hub-1.3.1-arm64.dmg',
        x64: 'Agent Hub-1.3.1.dmg',
      });
    });

    it('works for pre-release versions', () => {
      expect(dmgFilenames('Agent Hub', '2.0.0-beta.1')).toEqual({
        arm64: 'Agent Hub-2.0.0-beta.1-arm64.dmg',
        x64: 'Agent Hub-2.0.0-beta.1.dmg',
      });
    });
  });

  describe('s3Key', () => {
    it('prefixes with v<version>/', () => {
      expect(s3Key('1.3.1', 'Agent Hub-1.3.1.dmg')).toBe('v1.3.1/Agent Hub-1.3.1.dmg');
    });
  });

  describe('s3Uri', () => {
    it('builds an s3:// URI from bucket + key', () => {
      expect(s3Uri('agent-hub-prod-releases', 'v1.3.1/foo.dmg')).toBe(
        's3://agent-hub-prod-releases/v1.3.1/foo.dmg',
      );
    });
  });

  describe('crossDarwinEsbuildPackageSpec', () => {
    it('targets darwin-x64 when the host is arm64', () => {
      expect(crossDarwinEsbuildPackageSpec('arm64', '0.27.7')).toBe('@esbuild/darwin-x64@0.27.7');
    });

    it('targets darwin-arm64 when the host is x64', () => {
      expect(crossDarwinEsbuildPackageSpec('x64', '0.27.7')).toBe('@esbuild/darwin-arm64@0.27.7');
    });

    it('returns null without a version', () => {
      expect(crossDarwinEsbuildPackageSpec('arm64', null)).toBeNull();
    });

    it('returns null for unsupported arch', () => {
      expect(crossDarwinEsbuildPackageSpec('riscv64', '0.27.7')).toBeNull();
    });
  });

  describe('readDarwinEsbuildDirVersion', () => {
    it('reads version from a given @esbuild/<dir>/package.json', () => {
      const dir = mkdtempSync(join(tmpdir(), 'release-mac-esbuild-dir-'));
      const pkgDir = join(dir, 'node_modules/@esbuild/darwin-x64');
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ version: '1.2.3' }));
      expect(readDarwinEsbuildDirVersion(dir, 'darwin-x64')).toBe('1.2.3');
    });

    it('returns null when the package path is missing', () => {
      const dir = mkdtempSync(join(tmpdir(), 'release-mac-esbuild-missing-'));
      expect(readDarwinEsbuildDirVersion(dir, 'darwin-x64')).toBeNull();
    });
  });

  describe('readNativeDarwinEsbuildVersion', () => {
    it('reads version from the native darwin esbuild folder for this arch', () => {
      const native =
        process.arch === 'arm64' ? 'darwin-arm64' : process.arch === 'x64' ? 'darwin-x64' : null;
      if (!native) {
        return;
      }
      const dir = mkdtempSync(join(tmpdir(), 'release-mac-esbuild-'));
      const pkgDir = join(dir, 'node_modules/@esbuild', native);
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ version: '9.8.7' }));
      expect(readNativeDarwinEsbuildVersion(dir)).toBe('9.8.7');
    });

    it('returns null when the native darwin esbuild package is absent', () => {
      const dir = mkdtempSync(join(tmpdir(), 'release-mac-no-native-esbuild-'));
      expect(readNativeDarwinEsbuildVersion(dir)).toBeNull();
    });
  });

  describe('readVersion', () => {
    it('reads version from a package.json file', () => {
      const dir = mkdtempSync(join(tmpdir(), 'release-mac-'));
      const pkgPath = join(dir, 'package.json');
      writeFileSync(pkgPath, JSON.stringify({ name: 'x', version: '9.9.9' }));
      expect(readVersion(pkgPath)).toBe('9.9.9');
    });

    it('throws when version is missing', () => {
      const dir = mkdtempSync(join(tmpdir(), 'release-mac-'));
      const pkgPath = join(dir, 'package.json');
      writeFileSync(pkgPath, JSON.stringify({ name: 'x' }));
      expect(() => readVersion(pkgPath)).toThrow(/version/);
    });
  });

  describe('resolveAwsProfile', () => {
    it('returns the value of AWS_PROFILE when set', () => {
      expect(resolveAwsProfile({ AWS_PROFILE: 'release-bot' })).toBe('release-bot');
    });

    it('returns null when AWS_PROFILE is explicitly empty', () => {
      expect(resolveAwsProfile({ AWS_PROFILE: '' })).toBeNull();
    });

    it('returns null when ambient creds are present (CI path)', () => {
      expect(
        resolveAwsProfile({
          AWS_ACCESS_KEY_ID: 'ASIA...',
          AWS_SECRET_ACCESS_KEY: 'xxx',
          AWS_SESSION_TOKEN: 'yyy',
        }),
      ).toBeNull();
    });

    it('falls back to "default" for local dev with no AWS env', () => {
      expect(resolveAwsProfile({})).toBe(AWS_PROFILE);
    });

    it('returns null when AWS_PROFILE is empty and ambient creds are present', () => {
      expect(
        resolveAwsProfile({
          AWS_PROFILE: '',
          AWS_ACCESS_KEY_ID: 'ASIA...',
          AWS_SECRET_ACCESS_KEY: 'xxx',
        }),
      ).toBeNull();
    });

    it('prefers explicit AWS_PROFILE over ambient creds', () => {
      // If a human set AWS_PROFILE locally while ambient creds also leaked in,
      // honor the explicit intent.
      expect(
        resolveAwsProfile({
          AWS_PROFILE: 'staging',
          AWS_ACCESS_KEY_ID: 'ASIA...',
        }),
      ).toBe('staging');
    });
  });

  describe('awsCpArgs', () => {
    it('appends --profile when a profile is provided', () => {
      expect(awsCpArgs('a.dmg', 's3://b/c.dmg', 'default')).toEqual([
        's3',
        'cp',
        'a.dmg',
        's3://b/c.dmg',
        '--profile',
        'default',
      ]);
    });

    it('omits --profile when profile is null (CI ambient creds)', () => {
      expect(awsCpArgs('a.dmg', 's3://b/c.dmg', null)).toEqual([
        's3',
        'cp',
        'a.dmg',
        's3://b/c.dmg',
      ]);
    });

    it('omits --profile when profile is an empty string', () => {
      expect(awsCpArgs('a.dmg', 's3://b/c.dmg', '')).toEqual(['s3', 'cp', 'a.dmg', 's3://b/c.dmg']);
    });
  });

  describe('electronBuilderArgs', () => {
    it('targets macOS DMGs for both arm64 and x64', () => {
      const args = electronBuilderArgs();
      expect(args[0]).toBe('electron-builder');
      expect(args).toContain('--mac');
      expect(args).toContain('dmg');
      expect(args).toContain('--arm64');
      expect(args).toContain('--x64');
    });

    it('passes --publish never to suppress implicit GitHub publish under CI', () => {
      // Regression: electron-builder v26 auto-detects CI (e.g. GitHub Actions
      // runs on macos-latest) and triggers an implicit publish that fails when
      // GH_TOKEN is unset — which it intentionally is in the build-mac job.
      // This flag must always be passed so DMG builds don't depend on a token
      // they were never given.
      const args = electronBuilderArgs();
      const publishIdx = args.indexOf('--publish');
      expect(publishIdx).toBeGreaterThanOrEqual(0);
      expect(args[publishIdx + 1]).toBe('never');
    });
    it('ad-hoc signs by default so arm64 DMGs are not reported as "damaged"', () => {
      // Regression: with no identity, electron-builder left Electron's stock
      // linker signature in place. It no longer matched the packed bundle, so
      // Apple Silicon refused to launch the app and showed "damaged".
      const args = electronBuilderArgs();
      expect(args).toContain('-c.mac.identity=-');
      expect(args).toContain('-c.mac.hardenedRuntime=false');
      expect(args).toContain('-c.mac.notarize=false');
      expect(args).not.toContain('-c.forceCodeSigning=true');
    });

    it('leaves identity to the certificate and forces signing in developer-id mode', () => {
      const args = electronBuilderArgs('developer-id');
      expect(args).toContain('-c.forceCodeSigning=true');
      expect(args.some((a) => a.startsWith('-c.mac.identity'))).toBe(false);
      expect(args.some((a) => a.startsWith('-c.mac.hardenedRuntime'))).toBe(false);
      expect(args.some((a) => a.startsWith('-c.mac.notarize'))).toBe(false);
    });
  });

  describe('resolveMacSigningMode', () => {
    const apiKey = {
      APPLE_API_KEY: '/tmp/AuthKey.p8',
      APPLE_API_KEY_ID: 'KEYID',
      APPLE_API_ISSUER: 'issuer-uuid',
    };

    it('is adhoc when no certificate is configured', () => {
      expect(resolveMacSigningMode({})).toBe('adhoc');
      expect(resolveMacSigningMode({ CSC_LINK: '  ' })).toBe('adhoc');
    });

    it('is developer-id with a certificate and an App Store Connect API key', () => {
      expect(resolveMacSigningMode({ CSC_LINK: 'base64p12', ...apiKey })).toBe('developer-id');
    });

    it('accepts CSC_NAME and Apple ID notarization credentials', () => {
      expect(
        resolveMacSigningMode({
          CSC_NAME: 'Developer ID Application: Acme (TEAMID)',
          APPLE_ID: 'a@b.c',
          APPLE_APP_SPECIFIC_PASSWORD: 'pw',
          APPLE_TEAM_ID: 'TEAMID',
        }),
      ).toBe('developer-id');
    });

    it('throws when a certificate is set without notarization credentials', () => {
      expect(() => resolveMacSigningMode({ CSC_LINK: 'base64p12' })).toThrow(/notarization/);
      expect(() =>
        resolveMacSigningMode({ CSC_LINK: 'base64p12', APPLE_API_KEY_ID: 'KEYID' }),
      ).toThrow(/notarization/);
    });

    it('hasNotarizeCredentials requires a complete group', () => {
      expect(hasNotarizeCredentials(apiKey)).toBe(true);
      expect(hasNotarizeCredentials({ ...apiKey, APPLE_API_ISSUER: '' })).toBe(false);
      expect(hasNotarizeCredentials({ APPLE_KEYCHAIN: 'k', APPLE_KEYCHAIN_PROFILE: 'p' })).toBe(
        true,
      );
    });
  });

  describe('signing keychain', () => {
    const base = {
      keychainPath: '/tmp/k/signing.keychain-db',
      keychainPassword: 'KEYCHAIN-PW',
      p12Path: '/tmp/k/cert.p12',
      existingKeychains: ['/Users/runner/Library/Keychains/login.keychain-db'],
    };

    it('unlocks the partition list with the keychain password, not the .p12 password', () => {
      // electron-builder passes the .p12 password to `-k`, which fails with a
      // passwordless .p12 ("SecKeychainUnlock: ... passphrase ... not correct").
      const cmds = keychainSetupCommands({ ...base, p12Password: undefined });
      const partition = cmds.find((c) => c[0] === 'set-key-partition-list');
      expect(partition).toBeDefined();
      expect(partition![partition!.indexOf('-k') + 1]).toBe('KEYCHAIN-PW');
      const imp = cmds.find((c) => c[0] === 'import')!;
      expect(imp[imp.indexOf('-P') + 1]).toBe('');
    });

    it('imports with the .p12 password and creates/unlocks before importing', () => {
      const cmds = keychainSetupCommands({ ...base, p12Password: 'p12pw' });
      const order = cmds.map((c) => c[0]);
      expect(order.indexOf('create-keychain')).toBeLessThan(order.indexOf('import'));
      expect(order.indexOf('unlock-keychain')).toBeLessThan(order.indexOf('import'));
      expect(order.indexOf('import')).toBeLessThan(order.indexOf('set-key-partition-list'));
      const imp = cmds.find((c) => c[0] === 'import')!;
      expect(imp[imp.indexOf('-P') + 1]).toBe('p12pw');
    });

    it('prepends the keychain to the user search list without duplicating it', () => {
      const cmds = keychainSetupCommands({
        ...base,
        existingKeychains: [base.keychainPath, ...base.existingKeychains],
      });
      const list = cmds.find((c) => c[0] === 'list-keychains')!;
      expect(list.slice(4)).toEqual([base.keychainPath, ...base.existingKeychains]);
    });

    it('parses security list-keychains output', () => {
      expect(
        parseKeychainList(
          '    "/Users/runner/Library/Keychains/login.keychain-db"\n    "/Library/Keychains/System.keychain"\n',
        ),
      ).toEqual([
        '/Users/runner/Library/Keychains/login.keychain-db',
        '/Library/Keychains/System.keychain',
      ]);
    });

    it('hands electron-builder the keychain and strips the cert link', () => {
      const env = electronBuilderSigningEnv(
        { CSC_LINK: 'abc', CSC_KEY_PASSWORD: 'pw', APPLE_API_KEY_ID: 'K' },
        '/tmp/k.keychain-db',
      );
      expect(env).toEqual({ APPLE_API_KEY_ID: 'K', CSC_KEYCHAIN: '/tmp/k.keychain-db' });
    });

    it('decodes CSC_LINK from base64, data URLs, or a file path', () => {
      const bytes = Buffer.from([0x30, 0x82, 0x01, 0xff]);
      const b64 = bytes.toString('base64');
      expect(decodeCscLink(`${b64.slice(0, 3)}\n${b64.slice(3)}`, () => false)).toEqual(bytes);
      expect(decodeCscLink(`data:application/x-pkcs12;base64,${b64}`, () => false)).toEqual(bytes);
      const dir = mkdtempSync(join(tmpdir(), 'csc-'));
      const file = join(dir, 'cert.p12');
      writeFileSync(file, bytes);
      expect(decodeCscLink(file)).toEqual(bytes);
    });

    describe('prepareSigningKeychain', () => {
      const env = { CSC_LINK: Buffer.from('fake-p12').toString('base64') };

      it('removes the temp dir (and the .p12) when listing keychains fails', () => {
        const root = mkdtempSync(join(tmpdir(), 'sign-root-'));
        const calls: string[][] = [];
        const runSecurity = (args: string[]) => {
          calls.push(args);
          if (args[0] === 'list-keychains') throw new Error('list-keychains failed');
          return '';
        };
        expect(() => prepareSigningKeychain(env, { runSecurity, tmpRoot: root })).toThrow(
          /list-keychains failed/,
        );
        expect(readdirSync(root)).toEqual([]);
        // Nothing captured, nothing created: no search-list restore, no delete.
        expect(calls).toEqual([['list-keychains', '-d', 'user']]);
      });

      it('removes the temp dir when CSC_LINK cannot be decoded', () => {
        const root = mkdtempSync(join(tmpdir(), 'sign-root-'));
        expect(() =>
          prepareSigningKeychain(
            { CSC_LINK: '/no/such/cert.p12' },
            { runSecurity: () => '', tmpRoot: root },
          ),
        ).toThrow(/neither/);
        expect(readdirSync(root)).toEqual([]);
      });

      it('restores the search list and deletes the keychain when import fails', () => {
        const root = mkdtempSync(join(tmpdir(), 'sign-root-'));
        const calls: string[][] = [];
        const runSecurity = (args: string[], opts?: { capture?: boolean }) => {
          calls.push(args);
          if (opts?.capture) return '    "/Users/me/login.keychain-db"\n';
          if (args[0] === 'import') throw new Error('import failed');
          return '';
        };
        expect(() => prepareSigningKeychain(env, { runSecurity, tmpRoot: root })).toThrow(
          /import failed/,
        );
        expect(readdirSync(root)).toEqual([]);
        expect(calls).toContainEqual([
          'list-keychains',
          '-d',
          'user',
          '-s',
          '/Users/me/login.keychain-db',
        ]);
        expect(calls.some((c) => c[0] === 'delete-keychain')).toBe(true);
      });

      it('drops the .p12 after import but keeps the keychain until cleanup', () => {
        const root = mkdtempSync(join(tmpdir(), 'sign-root-'));
        const runSecurity = () => '';
        const { env: next, cleanup } = prepareSigningKeychain(env, { runSecurity, tmpRoot: root });
        const [dir] = readdirSync(root);
        expect(existsSync(join(root, dir, 'cert.p12'))).toBe(false);
        expect(next.CSC_KEYCHAIN).toBe(join(root, dir, 'signing.keychain-db'));
        cleanup();
        expect(readdirSync(root)).toEqual([]);
      });
    });

    it('rejects empty, URL, and non-base64 CSC_LINK values', () => {
      expect(() => decodeCscLink('  ')).toThrow(/empty/);
      expect(() => decodeCscLink('https://example.com/cert.p12', () => false)).toThrow(/URL/);
      expect(() => decodeCscLink('/no/such/cert.p12', () => false)).toThrow(/neither/);
    });
  });

  describe('round-trip — filename → upload destination', () => {
    it('produces a full s3:// URI for the arm64 DMG at v1.3.1', () => {
      const { arm64 } = dmgFilenames(PRODUCT_NAME, '1.3.1');
      expect(s3Uri(BUCKET, s3Key('1.3.1', arm64))).toBe(
        's3://agent-hub-prod-releases/v1.3.1/Agent Hub-1.3.1-arm64.dmg',
      );
    });

    it('produces a full s3:// URI for the x64 DMG at v1.3.1', () => {
      const { x64 } = dmgFilenames(PRODUCT_NAME, '1.3.1');
      expect(s3Uri(BUCKET, s3Key('1.3.1', x64))).toBe(
        's3://agent-hub-prod-releases/v1.3.1/Agent Hub-1.3.1.dmg',
      );
    });
  });
});
