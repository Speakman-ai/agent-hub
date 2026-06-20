import { describe, it, expect } from 'vitest';
import { parseNpmLockfile } from './npm-lockfile.js';

describe('parseNpmLockfile', () => {
  it('parses lockfileVersion 3 packages map and skips the root', () => {
    const lock = JSON.stringify({
      name: 'app',
      lockfileVersion: 3,
      packages: {
        '': { name: 'app', version: '1.0.0' },
        'node_modules/lodash': { version: '4.17.20' },
        'node_modules/express': { version: '4.18.2' },
      },
    });
    const deps = parseNpmLockfile(lock, 'package-lock.json');
    expect(deps).toEqual([
      { ecosystem: 'npm', name: 'lodash', version: '4.17.20', manifestPath: 'package-lock.json' },
      { ecosystem: 'npm', name: 'express', version: '4.18.2', manifestPath: 'package-lock.json' },
    ]);
  });

  it('resolves scoped names and nested node_modules paths', () => {
    const lock = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        'node_modules/@scope/pkg': { version: '2.0.0' },
        'node_modules/a/node_modules/@s/b': { version: '3.1.0' },
      },
    });
    const deps = parseNpmLockfile(lock, 'package-lock.json');
    expect(deps!.map((d) => `${d.name}@${d.version}`)).toEqual(['@scope/pkg@2.0.0', '@s/b@3.1.0']);
  });

  it('dedupes the same name@version appearing at multiple install paths', () => {
    const lock = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        'node_modules/lodash': { version: '4.17.20' },
        'node_modules/a/node_modules/lodash': { version: '4.17.20' },
        'node_modules/b/node_modules/lodash': { version: '4.17.21' },
      },
    });
    const deps = parseNpmLockfile(lock, 'package-lock.json');
    expect(deps!.map((d) => `${d.name}@${d.version}`)).toEqual([
      'lodash@4.17.20',
      'lodash@4.17.21',
    ]);
  });

  it('skips linked workspace packages (no registry version)', () => {
    const lock = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        'node_modules/pkg': { resolved: '../pkg', link: true },
        'node_modules/real': { version: '1.2.3' },
      },
    });
    const deps = parseNpmLockfile(lock, 'package-lock.json');
    expect(deps).toEqual([
      { ecosystem: 'npm', name: 'real', version: '1.2.3', manifestPath: 'package-lock.json' },
    ]);
  });

  it('audits an aliased install under its real registry name, not the alias', () => {
    // `npm i safe-name@npm:lodash@4.17.11` → the install path is the alias but
    // `name` carries the real package; auditing the alias would miss the vuln.
    const lock = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        'node_modules/safe-name': { name: 'lodash', version: '4.17.11' },
        'node_modules/plain': { version: '2.0.0' }, // no `name` → derive from path
      },
    });
    const deps = parseNpmLockfile(lock, 'package-lock.json');
    expect(deps).toEqual([
      { ecosystem: 'npm', name: 'lodash', version: '4.17.11', manifestPath: 'package-lock.json' },
      { ecosystem: 'npm', name: 'plain', version: '2.0.0', manifestPath: 'package-lock.json' },
    ]);
  });

  it('ignores a non-string `name` field and derives from the path', () => {
    const lock = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        'node_modules/pkg': { name: 123, version: '1.0.0' },
      },
    });
    const deps = parseNpmLockfile(lock, 'package-lock.json');
    expect(deps).toEqual([
      { ecosystem: 'npm', name: 'pkg', version: '1.0.0', manifestPath: 'package-lock.json' },
    ]);
  });

  it('falls back to the recursive dependencies tree for lockfileVersion 1', () => {
    const lock = JSON.stringify({
      name: 'app',
      lockfileVersion: 1,
      dependencies: {
        lodash: { version: '4.17.11' },
        chalk: {
          version: '2.4.2',
          dependencies: {
            'ansi-styles': { version: '3.2.1' },
          },
        },
      },
    });
    const deps = parseNpmLockfile(lock, 'package-lock.json');
    expect(deps!.map((d) => `${d.name}@${d.version}`).sort()).toEqual([
      'ansi-styles@3.2.1',
      'chalk@2.4.2',
      'lodash@4.17.11',
    ]);
  });

  it('returns null (parse failure) for corrupt/non-object content, without throwing', () => {
    // null signals "could not parse" so the scanner excludes the manifest from
    // the fixed sweep — a corrupt lockfile must never clear real findings.
    expect(parseNpmLockfile('{not json', 'package-lock.json')).toBeNull();
    expect(parseNpmLockfile('null', 'package-lock.json')).toBeNull();
    expect(parseNpmLockfile('[]', 'package-lock.json')).toBeNull();
    expect(parseNpmLockfile('"a string"', 'package-lock.json')).toBeNull();
    expect(parseNpmLockfile('', 'package-lock.json')).toBeNull();
  });

  it('returns [] (parsed, empty) for a valid JSON object with no dependencies', () => {
    // Distinct from a parse failure: this manifest WAS scanned, just has nothing
    // to audit — so it stays in the sweep scope.
    expect(parseNpmLockfile('{}', 'package-lock.json')).toEqual([]);
    expect(
      parseNpmLockfile(JSON.stringify({ lockfileVersion: 3, packages: {} }), 'package-lock.json'),
    ).toEqual([]);
  });

  it('threads the manifestPath onto every result', () => {
    const lock = JSON.stringify({
      lockfileVersion: 3,
      packages: { 'node_modules/x': { version: '1.0.0' } },
    });
    const deps = parseNpmLockfile(lock, 'packages/api/package-lock.json');
    expect(deps![0].manifestPath).toBe('packages/api/package-lock.json');
  });
});
