import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  readVersion,
  dmgFilenames,
  s3Key,
  s3Uri,
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
