import { describe, expect, it } from 'vitest';
import {
  comparePep440Versions,
  isValidPep440Version,
  parsePep440Version,
} from './pep440-version.js';

describe('parsePep440Version / isValidPep440Version', () => {
  it('accepts the PyPI version forms we persist from lockfiles', () => {
    expect(isValidPep440Version('6.13.3')).toBe(true);
    expect(isValidPep440Version('2!1.0')).toBe(true);
    expect(isValidPep440Version('1.0rc1')).toBe(true);
    expect(isValidPep440Version('1.0-rc1')).toBe(true);
    expect(isValidPep440Version('1.0_rc1')).toBe(true);
    expect(isValidPep440Version('1.0.post1')).toBe(true);
    expect(isValidPep440Version('1.0-1')).toBe(true);
    expect(isValidPep440Version('1.0a2.dev1')).toBe(true);
    expect(isValidPep440Version('1.0-dev1')).toBe(true);
    expect(isValidPep440Version('1.0+local.1')).toBe(true);
    expect(isValidPep440Version('not-a-version')).toBe(false);
    expect(parsePep440Version('1.0')).toMatchObject({
      epoch: 0,
      release: [1, 0],
      pre: null,
      post: null,
      dev: null,
      local: [],
    });
  });
});

describe('comparePep440Versions', () => {
  it('orders releases numerically with epoch precedence', () => {
    expect(comparePep440Versions('1.10', '1.2')).toBe(1);
    expect(comparePep440Versions('2!1.0', '1!9.9')).toBe(1);
    expect(comparePep440Versions('1.0', '1.0.0')).toBe(0);
  });

  it('orders prereleases, final releases, and post releases', () => {
    expect(comparePep440Versions('1.0a1', '1.0b1')).toBe(-1);
    expect(comparePep440Versions('1.0b1', '1.0rc1')).toBe(-1);
    expect(comparePep440Versions('1.0rc1', '1.0')).toBe(-1);
    expect(comparePep440Versions('1.0', '1.0.post1')).toBe(-1);
  });

  it('normalizes accepted separator variants for pre/dev/post releases', () => {
    expect(comparePep440Versions('1.0-rc1', '1.0rc1')).toBe(0);
    expect(comparePep440Versions('1.0_rc1', '1.0rc1')).toBe(0);
    expect(comparePep440Versions('1.0-dev1', '1.0.dev1')).toBe(0);
    expect(comparePep440Versions('1.0-1', '1.0.post1')).toBe(0);
  });

  it('keeps dev releases inside their pre/post release context', () => {
    expect(comparePep440Versions('1.0.dev1', '1.0a1')).toBe(-1);
    expect(comparePep440Versions('1.0a2.dev1', '1.0a1')).toBe(1);
    expect(comparePep440Versions('1.0a2.dev1', '1.0a2')).toBe(-1);
    expect(comparePep440Versions('1.0.post1.dev1', '1.0.post1')).toBe(-1);
  });

  it('orders local suffixes after their public version', () => {
    expect(comparePep440Versions('1.0+local.1', '1.0')).toBe(1);
    expect(comparePep440Versions('1.0', '1.0+local.1')).toBe(-1);
  });

  it('orders local suffix segments like PEP 440', () => {
    expect(comparePep440Versions('1.0+abc', '1.0+1')).toBe(-1);
    expect(comparePep440Versions('1.0+abc.2', '1.0+abc.10')).toBe(-1);
    expect(comparePep440Versions('1.0+abc.2', '1.0+abc.2.extra')).toBe(-1);
  });

  it('sorts unparseable versions last', () => {
    expect(comparePep440Versions('garbage', '1.0')).toBe(1);
    expect(comparePep440Versions('1.0', 'garbage')).toBe(-1);
  });
});
