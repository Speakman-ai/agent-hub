import { describe, expect, it } from 'vitest';
import {
  EMPTY_FILTERS,
  formatAge,
  hasActiveFilters,
  isStaleResource,
  resourceStateTone,
  resourceSubtitle,
  toResourceQuery,
  type InfraResourceWire,
} from './infraResources';

function resource(overrides: Partial<InfraResourceWire> = {}): InfraResourceWire {
  return {
    resourceKey: '111122223333/us-east-1/ec2/i-abc',
    accountId: '111122223333',
    region: 'us-east-1',
    service: 'ec2',
    resourceId: 'i-abc',
    name: 'web-1',
    environment: null,
    state: 'running',
    tags: {},
    firstSeen: 0,
    lastSeen: 0,
    ...overrides,
  };
}

describe('toResourceQuery', () => {
  it('sends seenSince=0 explicitly for the stale view', () => {
    // Omitting the key means "use the collector's staleness default" on the
    // server — the opposite of what the toggle asks for.
    expect(toResourceQuery({ ...EMPTY_FILTERS, includeStale: true }).seenSince).toBe(0);
  });

  it('omits seenSince entirely for the default view', () => {
    expect(toResourceQuery(EMPTY_FILTERS).seenSince).toBeUndefined();
  });

  it('trims the search term so a stray space is not a filter', () => {
    expect(toResourceQuery({ ...EMPTY_FILTERS, search: '  i-abc  ' }).search).toBe('i-abc');
  });

  it('passes the facet selections through unchanged', () => {
    expect(
      toResourceQuery({ ...EMPTY_FILTERS, service: 'ec2', region: 'eu-west-1', state: 'running' }),
    ).toMatchObject({ service: 'ec2', region: 'eu-west-1', state: 'running' });
  });
});

describe('hasActiveFilters', () => {
  it('is false for the default filter set', () => {
    expect(hasActiveFilters(EMPTY_FILTERS)).toBe(false);
  });

  it('does not count a whitespace-only search as a filter', () => {
    expect(hasActiveFilters({ ...EMPTY_FILTERS, search: '   ' })).toBe(false);
  });

  it('ignores the stale toggle, which widens rather than narrows the list', () => {
    // "Include stale" cannot produce an empty list that filters explain, so it
    // must not flip the empty-state copy to "no resources match your filters".
    expect(hasActiveFilters({ ...EMPTY_FILTERS, includeStale: true })).toBe(false);
  });

  it('is true once any narrowing filter is set', () => {
    expect(hasActiveFilters({ ...EMPTY_FILTERS, service: 'ec2' })).toBe(true);
    expect(hasActiveFilters({ ...EMPTY_FILTERS, environment: 'prod' })).toBe(true);
  });
});

describe('formatAge', () => {
  const now = 10 * 24 * 60 * 60 * 1000;

  it('reads a future timestamp as "just now" rather than a negative age', () => {
    expect(formatAge(now + 60_000, now)).toBe('just now');
  });

  it('steps through minutes, hours and days', () => {
    expect(formatAge(now - 5 * 60_000, now)).toBe('5m ago');
    expect(formatAge(now - 3 * 3_600_000, now)).toBe('3h ago');
    expect(formatAge(now - 2 * 86_400_000, now)).toBe('2d ago');
  });

  it('handles a non-finite timestamp without emitting NaN', () => {
    expect(formatAge(Number.NaN, now)).toBe('just now');
  });
});

describe('isStaleResource', () => {
  it('is stale only past the collector window', () => {
    expect(isStaleResource({ lastSeen: 0 }, 1000, 1001)).toBe(true);
    expect(isStaleResource({ lastSeen: 0 }, 1000, 1000)).toBe(false);
  });
});

describe('resourceStateTone', () => {
  it('maps the healthy, dead and unknown states the web browser does', () => {
    expect(resourceStateTone('running')).toBe('good');
    expect(resourceStateTone('available')).toBe('good');
    expect(resourceStateTone('terminated')).toBe('bad');
    expect(resourceStateTone('stopped')).toBe('bad');
    expect(resourceStateTone('deleted')).toBe('bad');
    expect(resourceStateTone('pending')).toBe('neutral');
    expect(resourceStateTone(null)).toBe('neutral');
  });
});

describe('resourceSubtitle', () => {
  it('joins the present parts only', () => {
    expect(resourceSubtitle(resource())).toBe('web-1 · ec2 · us-east-1');
  });

  it('drops a missing name rather than leaving a dangling separator', () => {
    expect(resourceSubtitle(resource({ name: null }))).toBe('ec2 · us-east-1');
  });

  it('drops an empty-string name too', () => {
    expect(resourceSubtitle(resource({ name: '' }))).toBe('ec2 · us-east-1');
  });
});
