import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { describe, it, expect } from 'vitest';

/**
 * Guards the Apache-2.0 open-source licensing metadata.
 *
 * Acceptance for the licensing card is "repo has a valid Apache-2.0 license
 * recognized by GitHub's license detector". GitHub uses the `licensee` gem,
 * which matches on the license body text in a root LICENSE file. These tests
 * assert the identifying phrases are present and that every workspace
 * package.json declares the SPDX identifier, so a future edit that guts the
 * LICENSE or flips a package back to proprietary fails loudly.
 */

const repoRoot = join(__dirname, '..');

describe('LICENSE (Apache-2.0)', () => {
  const license = readFileSync(join(repoRoot, 'LICENSE'), 'utf8');

  it('exists at repo root and is non-trivial', () => {
    expect(license.length).toBeGreaterThan(1000);
  });

  it('contains the phrases GitHub licensee keys on for Apache-2.0', () => {
    expect(license).toContain('Apache License');
    expect(license).toContain('Version 2.0, January 2004');
    expect(license).toContain('http://www.apache.org/licenses/');
    expect(license).toContain('WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND');
  });
});

describe('NOTICE', () => {
  it('exists and attributes the project', () => {
    const notice = readFileSync(join(repoRoot, 'NOTICE'), 'utf8');
    expect(notice).toContain('Agent Hub');
    expect(notice).toMatch(/Apache License, Version 2\.0/);
  });
});

describe('package.json license metadata', () => {
  const pkgPaths = [
    'package.json',
    'server/package.json',
    'client/package.json',
    'mobile/package.json',
    'shared/package.json',
  ];

  for (const rel of pkgPaths) {
    it(`${rel} declares "license": "Apache-2.0"`, () => {
      const full = join(repoRoot, rel);
      expect(existsSync(full)).toBe(true);
      const pkg = JSON.parse(readFileSync(full, 'utf8'));
      expect(pkg.license).toBe('Apache-2.0');
    });
  }
});
