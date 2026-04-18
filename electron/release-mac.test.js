import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  readVersion,
  dmgFilenames,
  s3Key,
  s3Uri,
  resolveAwsProfile,
  awsCpArgs,
  electronBuilderArgs,
  BUCKET,
  REGION,
  AWS_PROFILE,
  PRODUCT_NAME,
} from './release-mac.mjs';

describe('release-mac helpers', () => {
  describe('constants', () => {
    it('points at the agent-hub-prod-releases bucket in us-east-2', () => {
      expect(BUCKET).toBe('agent-hub-prod-releases');
      expect(REGION).toBe('us-east-2');
    });

    it('uses the default AWS profile', () => {
      expect(AWS_PROFILE).toBe('default');
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
      expect(s3Key('1.3.1', 'Agent Hub-1.3.1.dmg')).toBe(
        'v1.3.1/Agent Hub-1.3.1.dmg'
      );
    });
  });

  describe('s3Uri', () => {
    it('builds an s3:// URI from bucket + key', () => {
      expect(s3Uri('agent-hub-prod-releases', 'v1.3.1/foo.dmg')).toBe(
        's3://agent-hub-prod-releases/v1.3.1/foo.dmg'
      );
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
      expect(resolveAwsProfile({ AWS_PROFILE: 'release-bot' })).toBe(
        'release-bot'
      );
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
        })
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
        })
      ).toBeNull();
    });

    it('prefers explicit AWS_PROFILE over ambient creds', () => {
      // If a human set AWS_PROFILE locally while ambient creds also leaked in,
      // honor the explicit intent.
      expect(
        resolveAwsProfile({
          AWS_PROFILE: 'staging',
          AWS_ACCESS_KEY_ID: 'ASIA...',
        })
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
      expect(awsCpArgs('a.dmg', 's3://b/c.dmg', '')).toEqual([
        's3',
        'cp',
        'a.dmg',
        's3://b/c.dmg',
      ]);
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
  });

  describe('round-trip — filename → upload destination', () => {
    it('produces a full s3:// URI for the arm64 DMG at v1.3.1', () => {
      const { arm64 } = dmgFilenames(PRODUCT_NAME, '1.3.1');
      expect(s3Uri(BUCKET, s3Key('1.3.1', arm64))).toBe(
        's3://agent-hub-prod-releases/v1.3.1/Agent Hub-1.3.1-arm64.dmg'
      );
    });

    it('produces a full s3:// URI for the x64 DMG at v1.3.1', () => {
      const { x64 } = dmgFilenames(PRODUCT_NAME, '1.3.1');
      expect(s3Uri(BUCKET, s3Key('1.3.1', x64))).toBe(
        's3://agent-hub-prod-releases/v1.3.1/Agent Hub-1.3.1.dmg'
      );
    });
  });
});
