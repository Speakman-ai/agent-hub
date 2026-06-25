import { describe, it, expect } from 'vitest';
import {
  normalizePypiName,
  parseRequirementsTxt,
  parsePoetryLock,
  parsePipfileLock,
  pipLockfileParsers,
} from './pip-lockfile.js';

describe('normalizePypiName (PEP 503)', () => {
  it('lowercases and collapses runs of -_. to a single dash', () => {
    expect(normalizePypiName('Flask')).toBe('flask');
    expect(normalizePypiName('zope.interface')).toBe('zope-interface');
    expect(normalizePypiName('Zope_Interface')).toBe('zope-interface');
    expect(normalizePypiName('zope-interface')).toBe('zope-interface');
    expect(normalizePypiName('foo__bar..baz')).toBe('foo-bar-baz');
  });
});

describe('parseRequirementsTxt', () => {
  const path = 'requirements.txt';

  it('captures exact == pins as pip dependencies', () => {
    const out = parseRequirementsTxt('Django==3.2.0\nrequests==2.25.1\n', path);
    expect(out).toEqual([
      { ecosystem: 'pip', name: 'django', version: '3.2.0', manifestPath: path },
      { ecosystem: 'pip', name: 'requests', version: '2.25.1', manifestPath: path },
    ]);
  });

  it('skips unpinned and range requirements (no single installed version)', () => {
    const out = parseRequirementsTxt(
      ['flask', 'urllib3>=1.26', 'numpy~=1.21', 'pytest<7', 'pandas==1.3.*'].join('\n'),
      path,
    );
    expect(out).toEqual([]);
  });

  it('strips comments, blank lines, extras, markers and --hash fragments', () => {
    const content = [
      '# top comment',
      '',
      'requests[security]==2.25.1  # inline comment',
      'cryptography==3.4.7 ; python_version < "3.8"',
      'certifi==2021.5.30 --hash=sha256:abc123',
      '   ',
    ].join('\n');
    const out = parseRequirementsTxt(content, path);
    expect(out).toEqual([
      { ecosystem: 'pip', name: 'requests', version: '2.25.1', manifestPath: path },
      { ecosystem: 'pip', name: 'cryptography', version: '3.4.7', manifestPath: path },
      { ecosystem: 'pip', name: 'certifi', version: '2021.5.30', manifestPath: path },
    ]);
  });

  it('ignores pip option / include lines (-r, -e, -c, --index-url)', () => {
    const content = [
      '-r base.txt',
      '-c constraints.txt',
      '-e .',
      '--index-url https://example.test/simple',
      'lodash==1.0.0', // a real pin still captured
    ].join('\n');
    const out = parseRequirementsTxt(content, path);
    expect(out).toEqual([
      { ecosystem: 'pip', name: 'lodash', version: '1.0.0', manifestPath: path },
    ]);
  });

  it('joins backslash line continuations', () => {
    const out = parseRequirementsTxt('requests==\\\n2.25.1\n', path);
    expect(out).toEqual([
      { ecosystem: 'pip', name: 'requests', version: '2.25.1', manifestPath: path },
    ]);
  });

  it('normalizes the dependency name to PEP 503 form', () => {
    expect(parseRequirementsTxt('Zope_Interface==5.4.0\n', path)).toEqual([
      { ecosystem: 'pip', name: 'zope-interface', version: '5.4.0', manifestPath: path },
    ]);
  });

  it('dedupes identical name@version pins', () => {
    const out = parseRequirementsTxt('django==3.2.0\nDjango==3.2.0\n', path);
    expect(out).toHaveLength(1);
  });

  it('captures PEP 440 epoch versions (N!) as exact pins', () => {
    // `1!2.0.0` is a valid exact installed version (epoch), not a range — the
    // `!` here is the epoch separator, not the `!=` operator.
    const out = parseRequirementsTxt('somepkg==1!2.0.0\n', path);
    expect(out).toEqual([
      { ecosystem: 'pip', name: 'somepkg', version: '1!2.0.0', manifestPath: path },
    ]);
  });

  it('still rejects the != range operator (not an exact pin)', () => {
    // `!=` never matches the `==` capture, so it is dropped entirely.
    expect(parseRequirementsTxt('somepkg!=2.0.0\n', path)).toEqual([]);
  });
});

describe('parsePoetryLock', () => {
  const path = 'poetry.lock';

  it('reads name/version from each [[package]] block', () => {
    const content = `
[[package]]
name = "django"
version = "3.2.0"
description = "A high-level Python Web framework."
optional = false

[[package]]
name = "requests"
version = "2.25.1"
optional = false
`;
    const out = parsePoetryLock(content, path);
    expect(out).toEqual([
      { ecosystem: 'pip', name: 'django', version: '3.2.0', manifestPath: path },
      { ecosystem: 'pip', name: 'requests', version: '2.25.1', manifestPath: path },
    ]);
  });

  it('does not read a version from a nested [package.source]/[package.dependencies] table', () => {
    // The `reference`/`version` under sub-tables must NOT override the package
    // version, and a sub-table key named `version` must be ignored.
    const content = `
[[package]]
name = "somepkg"
version = "1.4.2"

[package.source]
type = "git"
reference = "deadbeef"
version = "9.9.9"

[package.dependencies]
urllib3 = ">=1.26"
`;
    const out = parsePoetryLock(content, path);
    expect(out).toEqual([
      { ecosystem: 'pip', name: 'somepkg', version: '1.4.2', manifestPath: path },
    ]);
  });

  it('normalizes names and stops scalars at the [metadata] table', () => {
    const content = `
[[package]]
name = "Jinja2"
version = "2.11.3"

[metadata]
lock-version = "1.1"
`;
    const out = parsePoetryLock(content, path);
    expect(out).toEqual([
      { ecosystem: 'pip', name: 'jinja2', version: '2.11.3', manifestPath: path },
    ]);
  });

  it('captures a PEP 440 epoch (N!) version from a package block', () => {
    const content = '[[package]]\nname = "somepkg"\nversion = "1!2.0.0"\n';
    expect(parsePoetryLock(content, path)).toEqual([
      { ecosystem: 'pip', name: 'somepkg', version: '1!2.0.0', manifestPath: path },
    ]);
  });

  it('returns null when there are no [[package]] blocks (corrupt/non-poetry)', () => {
    expect(parsePoetryLock('# just a comment\n', path)).toBeNull();
    expect(parsePoetryLock('', path)).toBeNull();
  });

  it('returns [] for a poetry.lock whose only package block is incomplete', () => {
    const out = parsePoetryLock('[[package]]\nname = "x"\n', path);
    expect(out).toEqual([]);
  });
});

describe('parsePipfileLock', () => {
  const path = 'Pipfile.lock';

  it('reads default and develop pinned versions, stripping ==', () => {
    const content = JSON.stringify({
      default: { django: { version: '==3.2.0' }, requests: { version: '==2.25.1' } },
      develop: { pytest: { version: '==6.2.4' } },
    });
    const out = parsePipfileLock(content, path);
    expect(out).toEqual([
      { ecosystem: 'pip', name: 'django', version: '3.2.0', manifestPath: path },
      { ecosystem: 'pip', name: 'requests', version: '2.25.1', manifestPath: path },
      { ecosystem: 'pip', name: 'pytest', version: '6.2.4', manifestPath: path },
    ]);
  });

  it('reads plain-string entries ("name": "==x.y.z"), not just object entries', () => {
    const content = JSON.stringify({
      default: { requests: '==2.25.1', flask: { version: '==2.0.1' } },
    });
    const out = parsePipfileLock(content, path);
    expect(out).toEqual([
      { ecosystem: 'pip', name: 'requests', version: '2.25.1', manifestPath: path },
      { ecosystem: 'pip', name: 'flask', version: '2.0.1', manifestPath: path },
    ]);
  });

  it('skips a bare "*" string entry (no exact version)', () => {
    const content = JSON.stringify({ default: { anything: '*' } });
    expect(parsePipfileLock(content, path)).toEqual([]);
  });

  it('captures epoch (N!) versions from either entry shape', () => {
    const content = JSON.stringify({
      default: { a: '==1!2.0.0', b: { version: '==2!3.4.5' } },
    });
    const out = parsePipfileLock(content, path);
    expect(out).toEqual([
      { ecosystem: 'pip', name: 'a', version: '1!2.0.0', manifestPath: path },
      { ecosystem: 'pip', name: 'b', version: '2!3.4.5', manifestPath: path },
    ]);
  });

  it('skips entries without a pinned == version (vcs/editable)', () => {
    const content = JSON.stringify({
      default: {
        somepkg: { git: 'https://example.test/x.git', ref: 'abc' },
        flask: { version: '==2.0.1' },
      },
    });
    const out = parsePipfileLock(content, path);
    expect(out).toEqual([
      { ecosystem: 'pip', name: 'flask', version: '2.0.1', manifestPath: path },
    ]);
  });

  it('normalizes names to PEP 503 form', () => {
    const content = JSON.stringify({ default: { 'Zope.Interface': { version: '==5.4.0' } } });
    expect(parsePipfileLock(content, path)).toEqual([
      { ecosystem: 'pip', name: 'zope-interface', version: '5.4.0', manifestPath: path },
    ]);
  });

  it('returns null on corrupt JSON', () => {
    expect(parsePipfileLock('{not json', path)).toBeNull();
  });

  it('returns null on non-object JSON', () => {
    expect(parsePipfileLock('[]', path)).toBeNull();
    expect(parsePipfileLock('"x"', path)).toBeNull();
  });

  it('returns [] for valid JSON with no default/develop sections', () => {
    expect(parsePipfileLock(JSON.stringify({ _meta: {} }), path)).toEqual([]);
  });
});

describe('pipLockfileParsers registration', () => {
  it('registers Python lockfiles under the pip ecosystem', () => {
    const byFile = new Map<string, string>();
    for (const p of pipLockfileParsers) for (const f of p.filenames) byFile.set(f, p.ecosystem);
    expect(byFile.get('requirements.txt')).toBe('pip');
    expect(byFile.get('poetry.lock')).toBe('pip');
    // basenames are matched case-insensitively (lowercased) by the scanner.
    expect(byFile.get('pipfile.lock')).toBe('pip');
  });

  it('matches common requirements filename variants', () => {
    const requirementsParser = pipLockfileParsers.find((p) =>
      p.filenames.includes('requirements.txt'),
    );
    expect(requirementsParser?.matchesFilename?.('requirements.txt')).toBe(true);
    expect(requirementsParser?.matchesFilename?.('requirements-base.txt')).toBe(true);
    expect(requirementsParser?.matchesFilename?.('requirements_docker.txt')).toBe(true);
    expect(requirementsParser?.matchesFilename?.('requirements.local.txt')).toBe(true);
    expect(requirementsParser?.matchesFilename?.('dev-requirements.txt')).toBe(false);
    expect(requirementsParser?.matchesFilename?.('requirements.in')).toBe(false);
  });
});
