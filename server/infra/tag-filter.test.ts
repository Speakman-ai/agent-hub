/**
 * Scope tag filter — the shared format behind inventory sync's server-side
 * `DescribeInstances` filter and the metric collector's client-side re-check.
 *
 * The point of these tests is that the two agree. EC2's semantics are the
 * contract, and the one that is easy to get wrong is `?`: AWS documents it as
 * matching *zero or one* character, where the intuitive translation is exactly
 * one. A mismatch there means the collector disagrees with the describe call
 * that populated inventory in the first place.
 */
import { describe, it, expect } from 'vitest';
import {
  parseInfraTagFilter,
  compileInfraTagFilter,
  compileTagFilterValue,
  matchesInfraTagFilter,
  isEmptyInfraTagFilter,
} from './tag-filter.js';

/** `infra_resources.tags_json` shape: the raw AWS tag array. */
function tags(pairs: Record<string, string>): string {
  return JSON.stringify(Object.entries(pairs).map(([Key, Value]) => ({ Key, Value })));
}

describe('parseInfraTagFilter', () => {
  it('returns no clauses for a null or blank filter', () => {
    expect(parseInfraTagFilter(null)).toEqual([]);
    expect(parseInfraTagFilter('   ')).toEqual([]);
  });

  it('accepts a bare string as a single accepted value', () => {
    expect(parseInfraTagFilter('{"Team":"platform"}')).toEqual([
      { key: 'Team', values: ['platform'] },
    ]);
  });

  it('accepts a value list', () => {
    expect(parseInfraTagFilter('{"Env":["prod","staging"]}')).toEqual([
      { key: 'Env', values: ['prod', 'staging'] },
    ]);
  });

  it('rejects malformed input rather than degrading to no filter', () => {
    // Degrading would silently widen the allowlist to the whole region.
    expect(() => parseInfraTagFilter('not json')).toThrow(/not valid JSON/);
    expect(() => parseInfraTagFilter('[1,2]')).toThrow(/must be a JSON object/);
    expect(() => parseInfraTagFilter('"scalar"')).toThrow(/must be a JSON object/);
    expect(() => parseInfraTagFilter('{"":["v"]}')).toThrow(/empty tag key/);
    expect(() => parseInfraTagFilter('{"Env":[]}')).toThrow(/has no values/);
    expect(() => parseInfraTagFilter('{"Env":[1]}')).toThrow(/non-string value/);
  });
});

describe('compileTagFilterValue', () => {
  it('matches a literal exactly and case-sensitively', () => {
    const p = compileTagFilterValue('prod');
    expect(p.test('prod')).toBe(true);
    expect(p.test('Prod')).toBe(false);
    expect(p.test('prods')).toBe(false);
    expect(p.test('xprod')).toBe(false);
  });

  it('treats * as zero or more characters', () => {
    const p = compileTagFilterValue('prod*');
    // AWS's own example set.
    expect(['prod', 'prods', 'production'].every((v) => p.test(v))).toBe(true);
    expect(p.test('pro')).toBe(false);
  });

  it('treats ? as ZERO OR ONE character, not exactly one', () => {
    // The documented behaviour, and the one a naive `.` translation gets wrong:
    // over prod/prods/production, `prod?` matches prod and prods only.
    const p = compileTagFilterValue('prod?');
    expect(p.test('prod')).toBe(true);
    expect(p.test('prods')).toBe(true);
    expect(p.test('production')).toBe(false);
  });

  it('honours backslash escapes for literal wildcards', () => {
    const star = compileTagFilterValue('a\\*b');
    expect(star.test('a*b')).toBe(true);
    expect(star.test('axxb')).toBe(false);

    const question = compileTagFilterValue('a\\?b');
    expect(question.test('a?b')).toBe(true);
    expect(question.test('ab')).toBe(false);
  });

  it('treats a trailing lone backslash as a literal backslash', () => {
    expect(compileTagFilterValue('a\\').test('a\\')).toBe(true);
  });

  it('does not let regex metacharacters in a tag value become a pattern', () => {
    const p = compileTagFilterValue('a.b+c(d)');
    expect(p.test('a.b+c(d)')).toBe(true);
    expect(p.test('axbbbcd')).toBe(false);
  });

  it('lets * span a newline', () => {
    expect(compileTagFilterValue('a*b').test('a\nb')).toBe(true);
  });
});

describe('matchesInfraTagFilter', () => {
  it('matches everything when the filter is empty', () => {
    const filter = compileInfraTagFilter(null);
    expect(isEmptyInfraTagFilter(filter)).toBe(true);
    expect(matchesInfraTagFilter(null, filter)).toBe(true);
    expect(matchesInfraTagFilter(tags({ Env: 'prod' }), filter)).toBe(true);
  });

  it('ORs values within one key', () => {
    const filter = compileInfraTagFilter('{"Env":["prod","staging"]}');
    expect(matchesInfraTagFilter(tags({ Env: 'prod' }), filter)).toBe(true);
    expect(matchesInfraTagFilter(tags({ Env: 'staging' }), filter)).toBe(true);
    expect(matchesInfraTagFilter(tags({ Env: 'dev' }), filter)).toBe(false);
  });

  it('ANDs across keys', () => {
    const filter = compileInfraTagFilter('{"Env":"prod","Team":"platform"}');
    expect(matchesInfraTagFilter(tags({ Env: 'prod', Team: 'platform' }), filter)).toBe(true);
    expect(matchesInfraTagFilter(tags({ Env: 'prod', Team: 'billing' }), filter)).toBe(false);
    expect(matchesInfraTagFilter(tags({ Env: 'prod' }), filter)).toBe(false);
  });

  it('matches tag keys case-sensitively, as EC2 does', () => {
    const filter = compileInfraTagFilter('{"Env":"prod"}');
    expect(matchesInfraTagFilter(tags({ env: 'prod' }), filter)).toBe(false);
    expect(matchesInfraTagFilter(tags({ Env: 'prod' }), filter)).toBe(true);
  });

  it('excludes an untagged resource from a tag-scoped allowlist', () => {
    const filter = compileInfraTagFilter('{"Env":"prod"}');
    expect(matchesInfraTagFilter(null, filter)).toBe(false);
    expect(matchesInfraTagFilter('[]', filter)).toBe(false);
  });

  it('fails closed on tags_json it cannot read', () => {
    // Our own column, so this should not happen — but a row we cannot prove is
    // in scope must not be billed for.
    const filter = compileInfraTagFilter('{"Env":"prod"}');
    expect(matchesInfraTagFilter('{not json', filter)).toBe(false);
    expect(matchesInfraTagFilter('{"Env":"prod"}', filter)).toBe(false);
  });

  it('applies wildcards from the filter to the stored value', () => {
    const filter = compileInfraTagFilter('{"Name":"web-*"}');
    expect(matchesInfraTagFilter(tags({ Name: 'web-01' }), filter)).toBe(true);
    expect(matchesInfraTagFilter(tags({ Name: 'db-01' }), filter)).toBe(false);
  });

  it('ignores a tag entry with no Value', () => {
    const filter = compileInfraTagFilter('{"Env":"prod"}');
    expect(matchesInfraTagFilter(JSON.stringify([{ Key: 'Env' }]), filter)).toBe(false);
  });
});
