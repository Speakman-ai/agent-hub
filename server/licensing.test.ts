import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { describe, it, expect } from 'vitest';

/**
 * Guards the PolyForm Noncommercial source-available licensing metadata.
 *
 * These tests assert that the official license text, the required notice, and
 * every workspace's SPDX metadata stay aligned. This prevents a future edit
 * from silently restoring commercial-use permission in one package or
 * dropping the attribution required for redistribution.
 */

const repoRoot = join(__dirname, '..');

describe('LICENSE (PolyForm-Noncommercial-1.0.0)', () => {
  const license = readFileSync(join(repoRoot, 'LICENSE'), 'utf8');

  it('exists at repo root and is non-trivial', () => {
    expect(license.length).toBeGreaterThan(1000);
  });

  it('contains the identifying terms from the official license', () => {
    expect(license).toContain('# PolyForm Noncommercial License 1.0.0');
    expect(license).toContain('https://polyformproject.org/licenses/noncommercial/1.0.0');
    expect(license).toContain('Any noncommercial purpose is a permitted purpose.');
    expect(license).toContain('without any anticipated commercial application');
    expect(license).toContain('## Noncommercial Organizations');
  });

  it('includes the project required notice', () => {
    expect(license).toMatch(
      /^Required Notice: Copyright 2026 The Agent Hub Authors \(https:\/\/github\.com\/Speakman-ai\/agent-hub\)$/m,
    );
  });

  it('discloses mixed-license terms at the top of LICENSE', () => {
    expect(license).toContain('This repository is mixed-license');
    expect(license).toContain('Ryan Speakman');
    expect(license).toContain('LICENSES/Apache-2.0.txt');
    expect(license).toContain('does not relicense Apache-2.0 remainder');
  });
});

describe('NOTICE', () => {
  it('exists and attributes the project', () => {
    const notice = readFileSync(join(repoRoot, 'NOTICE'), 'utf8');
    expect(notice).toContain('Agent Hub');
    expect(notice).toContain('Required Notice: Copyright 2026 The Agent Hub Authors');
    expect(notice).toContain('PolyForm Noncommercial License 1.0.0');
  });

  it('retains Apache-era attribution and points at the preserved Apache-2.0 text', () => {
    const notice = readFileSync(join(repoRoot, 'NOTICE'), 'utf8');
    expect(notice).toContain('This product includes software developed by the Agent Hub project');
    expect(notice).toContain('Apache License 2.0');
    expect(notice).toContain('That grant is not revoked');
    expect(notice).toContain('LICENSES/Apache-2.0.txt');
    expect(notice).toContain('not a chain of title');
    expect(notice).toContain('whose copyright holder is not Ryan Speakman remains');
    expect(notice).toContain('SEE LICENSE IN LICENSE');
  });
});

describe('historical Apache-2.0 text', () => {
  it('keeps the previously published Apache-2.0 license body', () => {
    const apache = readFileSync(join(repoRoot, 'LICENSES', 'Apache-2.0.txt'), 'utf8');
    expect(apache).toContain('Apache License');
    expect(apache).toContain('Version 2.0, January 2004');
    expect(apache).toContain('http://www.apache.org/licenses/');
    expect(apache).toContain('APPENDIX: How to apply the Apache License to your work.');
  });
});

describe('PolyForm text in LICENSES/', () => {
  it('keeps a canonical PolyForm Noncommercial 1.0.0 copy', () => {
    const polyform = readFileSync(
      join(repoRoot, 'LICENSES', 'PolyForm-Noncommercial-1.0.0.txt'),
      'utf8',
    );
    expect(polyform).toContain('# PolyForm Noncommercial License 1.0.0');
    expect(polyform).toContain('https://polyformproject.org/licenses/noncommercial/1.0.0');
    expect(polyform).toContain('Any noncommercial purpose is a permitted purpose.');
    expect(polyform).not.toContain('This repository is mixed-license');
  });
});

describe('relicensing authority', () => {
  it('documents chain of title and leaves unverified contributions under Apache-2.0', () => {
    const licensing = readFileSync(join(repoRoot, 'docs', 'licensing.md'), 'utf8');
    expect(licensing).toContain('speakmanra');
    expect(licensing).toContain('Ryan Speakman');
    expect(licensing).toContain('not a copyright assignment');
    expect(licensing).toContain('do not prove copyright ownership');
    expect(licensing).toContain('Accepting an agent-authored commit');
    expect(licensing).toContain('mixed-license');
    expect(licensing).toContain('Unverified contributions stay under Apache-2.0');
    expect(licensing).toContain('Authoritative license mapping');
    expect(licensing).toContain('SEE LICENSE IN LICENSE');
    expect(licensing).toContain('LICENSES/Apache-2.0.txt');
    expect(licensing).toContain('LICENSES/PolyForm-Noncommercial-1.0.0.txt');
    expect(licensing).toContain(
      'Commercial use of works covered by PolyForm Noncommercial requires a separate',
    );
    expect(licensing).not.toMatch(/^Any commercial use requires a separate commercial license/m);
  });

  it('README describes mixed-license terms and does not blanket-restrict commercial use', () => {
    const readme = readFileSync(join(repoRoot, 'README.md'), 'utf8');
    const licenseSection = (readme.split('## License')[1] ?? '').split('\n## ')[0];
    const lower = licenseSection.toLowerCase();
    expect(lower).toContain('mixed-license');
    expect(lower).toContain('polyform-covered works');
    expect(lower).toContain('apache license 2.0');
    expect(lower).not.toContain('any commercial use');
  });

  it('requires a CLA or copyright assignment before accepting inbound code', () => {
    const licensing = readFileSync(join(repoRoot, 'docs', 'licensing.md'), 'utf8');
    const flat = licensing.replace(/\s+/g, ' ');
    expect(flat).toContain('CLA.md');
    expect(flat).toContain('not an inbound contributor agreement');
    expect(flat).toContain('commercial relicensing rights');
    expect(flat).toMatch(/must not merge/i);
    expect(flat).not.toContain(
      'accepted only under the current CONTRIBUTING terms (PolyForm Noncommercial 1.0.0)',
    );
  });
});

describe('inbound contributor agreement', () => {
  const contributing = readFileSync(join(repoRoot, 'CONTRIBUTING.md'), 'utf8');
  const cla = readFileSync(join(repoRoot, 'CLA.md'), 'utf8');

  it('ships CLA.md with a commercial sublicense grant while contributors retain copyright', () => {
    expect(cla.length).toBeGreaterThan(1000);
    expect(cla).toContain('You retain copyright in Your Contributions.');
    expect(cla).toContain('sublicensable copyright license');
    expect(cla).toContain(
      'any commercial, proprietary, or other license terms the Licensor offers',
    );
    expect(cla).toContain('PolyForm is only an outbound noncommercial');
    expect(cla).toMatch(/must not accept a code contribution/i);
  });

  it('identifies Ryan Speakman as the Licensor counterparty', () => {
    expect(cla).toContain('Ryan Speakman ("Licensor")');
    expect(cla).toContain('speakmanra');
    expect(cla).toContain(
      '**"Licensor"** means Ryan Speakman, the natural person who controls GitHub',
    );
    expect(cla).not.toContain('the Licensor identified in');
  });

  it('allows opening a PR before CLA completion and blocks merge until the statement is recorded', () => {
    const flat = cla.replace(/\s+/g, ' ');
    expect(flat).toContain('You may open a pull request');
    expect(flat).toMatch(/must not merge that pull request/i);
    expect(flat).toContain('Checking a box is not a substitute');
    expect(flat).toContain('Legal name: <name>');
    expect(flat).not.toContain(
      'Do not open a pull request that adds or changes copyrightable material until',
    );
  });

  it('CONTRIBUTING.md makes the CLA or assignment a hard merge gate', () => {
    const flat = contributing.replace(/\s+/g, ' ');
    expect(flat).toContain('CLA.md');
    expect(flat).toContain('copyright assignment');
    expect(flat).toMatch(/Maintainers must not merge/i);
    expect(flat).toContain('You may open a pull request before the CLA is completed');
    expect(flat).toContain('A checkbox is not a substitute');
    expect(flat).toContain('PolyForm terms alone are not a contributor agreement');
    expect(flat).not.toContain('whether a separate contributor agreement is needed');
    expect(flat).not.toContain('your contributions will be licensed under the same terms');
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
    it(`${rel} declares mixed licensing via "SEE LICENSE IN LICENSE"`, () => {
      const full = join(repoRoot, rel);
      expect(existsSync(full)).toBe(true);
      const pkg = JSON.parse(readFileSync(full, 'utf8'));
      expect(pkg.license).toBe('SEE LICENSE IN LICENSE');
      expect(existsSync(join(full, '..', 'LICENSE'))).toBe(true);
    });
  }
});

describe('generated OpenAPI license metadata', () => {
  it('identifies mixed licensing and points at the mapping', () => {
    const openapi = readFileSync(join(repoRoot, 'docs/api/openapi.yaml'), 'utf8');
    expect(openapi).toContain('name: Mixed (PolyForm Noncommercial 1.0.0 and Apache-2.0)');
    expect(openapi).toContain(
      'url: https://github.com/Speakman-ai/agent-hub/blob/main/docs/licensing.md',
    );
  });
});
