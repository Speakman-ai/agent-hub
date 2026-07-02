import { describe, expect, it } from 'vitest';
import {
  environmentStatus,
  environmentStatusLabel,
  hasRuntimeConfig,
  sortEnvironmentsForDisplay,
} from './environments';

describe('environmentStatus', () => {
  it('is deployable when declared and enabled', () => {
    expect(environmentStatus({ active: true, enabled: true })).toBe('deployable');
  });

  it('is paused when declared but disabled', () => {
    expect(environmentStatus({ active: true, enabled: false })).toBe('paused');
  });

  it('is orphaned when not declared, regardless of enabled', () => {
    expect(environmentStatus({ active: false, enabled: true })).toBe('orphaned');
    expect(environmentStatus({ active: false, enabled: false })).toBe('orphaned');
  });
});

describe('environmentStatusLabel', () => {
  it('maps each status to a human label', () => {
    expect(environmentStatusLabel('deployable')).toBe('deployable');
    expect(environmentStatusLabel('paused')).toBe('paused');
    expect(environmentStatusLabel('orphaned')).toBe('orphaned');
  });
});

describe('hasRuntimeConfig', () => {
  it('is true only when a config row is present', () => {
    expect(hasRuntimeConfig({ config: { id: 'c1' } })).toBe(true);
    expect(hasRuntimeConfig({ config: null })).toBe(false);
  });
});

describe('sortEnvironmentsForDisplay', () => {
  it('puts declared environments first, then orphaned, each alphabetical', () => {
    const input = [
      { name: 'zeta', active: true },
      { name: 'legacy', active: false },
      { name: 'alpha', active: true },
      { name: 'ancient', active: false },
    ];
    expect(sortEnvironmentsForDisplay(input).map((e) => e.name)).toEqual([
      'alpha',
      'zeta',
      'ancient',
      'legacy',
    ]);
  });

  it('does not mutate the input array', () => {
    const input = [
      { name: 'b', active: true },
      { name: 'a', active: true },
    ];
    const copy = [...input];
    sortEnvironmentsForDisplay(input);
    expect(input).toEqual(copy);
  });
});
