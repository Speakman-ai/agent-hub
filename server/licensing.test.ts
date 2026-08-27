import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { describe, it, expect } from 'vitest';

/**
 * Guards the single-license PolyForm Noncommercial licensing metadata.
 *
 * Agent Hub ships under one license: PolyForm Noncommercial 1.0.0, with a
 * separate CLA that enables future commercial licensing. These tests assert
 * that the license text, the required notice, the docs, and every workspace's
 * SPDX metadata stay aligned — and that a future edit does not silently
 * reintroduce the retired Apache-2.0 dual-license / "mixed-license" framing or
 * restore blanket commercial-use permission.
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

  it('states the commercial boundary at the top of LICENSE', () => {
    expect(license).toContain('PolyForm Noncommercial License 1.0.0');
    expect(license).toContain('Ryan Speakman');
    expect(license).toContain('Commercial use requires a separate commercial license');
    expect(license).toContain('Third-party dependencies and vendored code keep their own licenses');
  });

  it('does not reintroduce the retired Apache-2.0 dual-license framing', () => {
    expect(license).not.toContain('mixed-license');
    expect(license).not.toContain('Apache');
  });
});

describe('NOTICE', () => {
  const notice = readFileSync(join(repoRoot, 'NOTICE'), 'utf8');

  it('exists and attributes the project under PolyForm', () => {
    expect(notice).toContain('Agent Hub');
    expect(notice).toContain('Required Notice: Copyright 2026 The Agent Hub Authors');
    expect(notice).toContain('PolyForm Noncommercial License 1.0.0');
    expect(notice).toContain('This product includes software developed by the Agent Hub project');
  });

  it('points at the CLA and third-party licenses without Apache framing', () => {
    expect(notice).toContain('Contributor License Agreement (CLA.md)');
    expect(notice).toContain('Third-party dependencies and vendored code keep their own licenses');
    expect(notice).not.toContain('Apache');
    expect(notice).not.toContain('mixed-license');
  });
});

describe('retired Apache-2.0 text', () => {
  it('no longer ships an Apache-2.0 license file', () => {
    expect(existsSync(join(repoRoot, 'LICENSES', 'Apache-2.0.txt'))).toBe(false);
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

describe('licensing docs', () => {
  const licensing = readFileSync(join(repoRoot, 'docs', 'licensing.md'), 'utf8');

  it('documents PolyForm as the single outbound license and the licensor', () => {
    expect(licensing).toContain('speakmanra');
    expect(licensing).toContain('Ryan Speakman');
    expect(licensing).toContain('PolyForm Noncommercial License');
    expect(licensing).toContain(
      'Commercial use of Agent Hub requires a separate commercial license',
    );
  });

  it('does not carry the retired Apache-2.0 / mixed-license machinery', () => {
    expect(licensing).not.toContain('Apache');
    expect(licensing).not.toContain('mixed-license');
    expect(licensing).not.toContain('Unverified contributions');
    expect(licensing).not.toContain('SEE LICENSE IN LICENSE');
  });

  it('README describes PolyForm terms and does not blanket-restrict commercial use', () => {
    const readme = readFileSync(join(repoRoot, 'README.md'), 'utf8');
    const licenseSection = (readme.split('## License')[1] ?? '').split('\n## ')[0];
    const lower = licenseSection.toLowerCase();
    expect(lower).toContain('polyform noncommercial license 1.0.0');
    expect(lower).toContain('separate commercial license');
    expect(lower).not.toContain('mixed-license');
    expect(lower).not.toContain('apache');
    expect(lower).not.toContain('any commercial use');
  });

  it('requires a CLA or copyright assignment before accepting inbound code', () => {
    const flat = licensing.replace(/\s+/g, ' ');
    expect(flat).toContain('CLA.md');
    expect(flat).toContain('not an inbound contributor agreement');
    expect(flat).toContain('commercial relicensing rights');
    expect(flat).toMatch(/must not merge/i);
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
    expect(flat).not.toContain('remain under Apache License 2.0');
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
    it(`${rel} declares the PolyForm-Noncommercial-1.0.0 SPDX identifier`, () => {
      const full = join(repoRoot, rel);
      expect(existsSync(full)).toBe(true);
      const pkg = JSON.parse(readFileSync(full, 'utf8'));
      expect(pkg.license).toBe('PolyForm-Noncommercial-1.0.0');
      expect(existsSync(join(full, '..', 'LICENSE'))).toBe(true);
    });
  }
});

describe('generated OpenAPI license metadata', () => {
  it('identifies the single PolyForm license and points at the mapping', () => {
    const openapi = readFileSync(join(repoRoot, 'docs/api/openapi.yaml'), 'utf8');
    expect(openapi).toContain('name: PolyForm Noncommercial License 1.0.0');
    expect(openapi).toContain(
      'url: https://github.com/Speakman-ai/agent-hub/blob/main/docs/licensing.md',
    );
    expect(openapi).not.toContain('Apache-2.0');
  });
});
