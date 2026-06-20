import { describe, it, expect, vi } from 'vitest';
import { OsvAdvisorySource, osvVulnToAdvisory, pickFixedVersion } from './osv.js';
import type { ResolvedDependency } from './types.js';

const dep = (name: string, version: string): ResolvedDependency => ({
  ecosystem: 'npm',
  name,
  version,
  manifestPath: 'package-lock.json',
});

/** Build a fetch stub that answers querybatch + vulns/{id} from fixtures. */
function fakeFetch(opts: {
  batch: Record<string, { vulns: { id: string }[] }>;
  vulns: Record<string, unknown>;
}): { fetchFn: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push(u);
    if (u.endsWith('/v1/querybatch')) {
      const body = JSON.parse(String(init?.body)) as {
        queries: { package: { name: string }; version: string }[];
      };
      const results = body.queries.map(
        (q) => opts.batch[`${q.package.name}@${q.version}`] ?? { vulns: [] },
      );
      return new Response(JSON.stringify({ results }), { status: 200 });
    }
    const m = u.match(/\/v1\/vulns\/(.+)$/);
    if (m) {
      const id = decodeURIComponent(m[1]);
      const vuln = opts.vulns[id];
      if (!vuln) return new Response('not found', { status: 404 });
      return new Response(JSON.stringify(vuln), { status: 200 });
    }
    return new Response('unexpected', { status: 500 });
  });
  return { fetchFn: fetchFn as unknown as typeof fetch, calls };
}

describe('pickFixedVersion', () => {
  const vuln = {
    id: 'GHSA-x',
    affected: [
      {
        package: { ecosystem: 'npm', name: 'lodash' },
        ranges: [
          {
            type: 'SEMVER',
            events: [{ introduced: '0' }, { fixed: '4.17.12' }],
          },
          {
            type: 'SEMVER',
            events: [{ introduced: '4.17.13' }, { fixed: '4.17.21' }],
          },
        ],
      },
    ],
  };

  it('picks the smallest fixed version >= the installed version', () => {
    expect(pickFixedVersion(vuln, 'lodash', 'npm', '4.17.15')).toBe('4.17.21');
  });

  it('picks the lowest published fix when installed is below all fixes', () => {
    expect(pickFixedVersion(vuln, 'lodash', 'npm', '4.0.0')).toBe('4.17.12');
  });

  it('returns null when the package has no fixed event', () => {
    expect(pickFixedVersion({ id: 'x', affected: [] }, 'lodash', 'npm', '1.0.0')).toBeNull();
  });

  it('returns null (no downgrade) when installed is above all fixed candidates', () => {
    // Disjoint ranges: fixes 4.17.12 / 4.17.21 belong to older ranges. An install
    // at 5.0.0 is vulnerable in a later, unfixed range — suggesting 4.17.12 would
    // be a downgrade that does NOT resolve it, so we suggest nothing.
    expect(pickFixedVersion(vuln, 'lodash', 'npm', '5.0.0')).toBeNull();
  });

  it('still suggests a fix for an unparseable installed version (best-effort lowest)', () => {
    expect(pickFixedVersion(vuln, 'lodash', 'npm', 'not-a-version')).toBe('4.17.12');
  });

  it('matches the ecosystem, not just the package name (no cross-ecosystem leak)', () => {
    // Same package NAME ("colors") in two ecosystems, with different fixes. The
    // npm query must pick the npm fix, never the PyPI one.
    const crossEco = {
      id: 'GHSA-cross',
      affected: [
        {
          package: { ecosystem: 'PyPI', name: 'colors' },
          ranges: [{ type: 'SEMVER', events: [{ fixed: '1.0.0' }] }],
        },
        {
          package: { ecosystem: 'npm', name: 'colors' },
          ranges: [{ type: 'SEMVER', events: [{ fixed: '1.4.1' }] }],
        },
      ],
    };
    expect(pickFixedVersion(crossEco, 'colors', 'npm', '1.4.0')).toBe('1.4.1');
    expect(pickFixedVersion(crossEco, 'colors', 'PyPI', '0.9.0')).toBe('1.0.0');
    // An affected entry with no ecosystem is never borrowed.
    const noEco = {
      id: 'x',
      affected: [
        { package: { name: 'colors' }, ranges: [{ type: 'SEMVER', events: [{ fixed: '2.0.0' }] }] },
      ],
    };
    expect(pickFixedVersion(noEco, 'colors', 'npm', '1.0.0')).toBeNull();
  });
});

describe('osvVulnToAdvisory', () => {
  it('maps severity from database_specific label, fix, and url', () => {
    const adv = osvVulnToAdvisory(
      {
        id: 'GHSA-jf85-cpcp-j695',
        summary: 'Prototype Pollution in lodash\nsecond line',
        aliases: ['CVE-2019-10744'],
        database_specific: { severity: 'CRITICAL' },
        affected: [
          {
            package: { ecosystem: 'npm', name: 'lodash' },
            ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '4.17.12' }] }],
          },
        ],
        references: [
          { type: 'WEB', url: 'https://example.com/web' },
          { type: 'ADVISORY', url: 'https://github.com/advisories/GHSA-jf85-cpcp-j695' },
        ],
      },
      dep('lodash', '4.17.11'),
    );
    expect(adv).toMatchObject({
      id: 'GHSA-jf85-cpcp-j695',
      summary: 'Prototype Pollution in lodash',
      severity: 'critical',
      aliases: ['CVE-2019-10744'],
      fixedVersion: '4.17.12',
      url: 'https://github.com/advisories/GHSA-jf85-cpcp-j695',
    });
  });

  it('falls back to the CVSS vector when no label is present', () => {
    const adv = osvVulnToAdvisory(
      {
        id: 'OSV-1',
        summary: 's',
        severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' }],
      },
      dep('x', '1.0.0'),
    );
    expect(adv.severity).toBe('critical');
  });

  it('takes severity AND fix from the affected entry matching the dependency ecosystem', () => {
    // The same name in PyPI carries a different severity + fix; the npm dep must
    // resolve to the npm affected entry, not the PyPI one.
    const adv = osvVulnToAdvisory(
      {
        id: 'GHSA-cross',
        summary: 'colors vuln',
        affected: [
          {
            package: { ecosystem: 'PyPI', name: 'colors' },
            ranges: [{ type: 'SEMVER', events: [{ fixed: '9.9.9' }] }],
            database_specific: { severity: 'LOW' },
          },
          {
            package: { ecosystem: 'npm', name: 'colors' },
            ranges: [{ type: 'SEMVER', events: [{ fixed: '1.4.1' }] }],
            database_specific: { severity: 'CRITICAL' },
          },
        ],
      },
      dep('colors', '1.4.0'),
    );
    expect(adv.severity).toBe('critical');
    expect(adv.fixedVersion).toBe('1.4.1');
  });
});

describe('OsvAdvisorySource.query', () => {
  it('maps batch ids to hydrated advisories, deduping hydrate calls', async () => {
    const { fetchFn, calls } = fakeFetch({
      batch: {
        'lodash@4.17.11': { vulns: [{ id: 'GHSA-a' }] },
        'minimist@1.2.0': { vulns: [{ id: 'GHSA-a' }, { id: 'GHSA-b' }] },
      },
      vulns: {
        'GHSA-a': {
          id: 'GHSA-a',
          summary: 'vuln a',
          database_specific: { severity: 'HIGH' },
          affected: [
            {
              package: { ecosystem: 'npm', name: 'lodash' },
              ranges: [{ type: 'SEMVER', events: [{ fixed: '4.17.21' }] }],
            },
          ],
        },
        'GHSA-b': { id: 'GHSA-b', summary: 'vuln b', database_specific: { severity: 'LOW' } },
      },
    });
    const source = new OsvAdvisorySource({ fetchFn });
    const findings = await source.query([dep('lodash', '4.17.11'), dep('minimist', '1.2.0')]);

    expect(findings).toHaveLength(3);
    expect(findings.map((f) => `${f.dependency.name}:${f.advisory.id}`)).toEqual([
      'lodash:GHSA-a',
      'minimist:GHSA-a',
      'minimist:GHSA-b',
    ]);
    // GHSA-a hydrated once despite hitting two packages.
    const hydrateCalls = calls.filter((c) => c.includes('/v1/vulns/'));
    expect(hydrateCalls.filter((c) => c.endsWith('GHSA-a'))).toHaveLength(1);
  });

  // The follow-up request carries the DOCUMENTED snake_case `page_token`; the
  // fake here ONLY honors that field (reads `page_token`, ignores any other
  // spelling) so the test fails if we send the wrong key. Responses are read
  // under both casings, so the fixture varies the RESPONSE token spelling to
  // pin both the live camelCase and the docs snake_case shapes.
  const paginationFetch = (responseTokenKey: 'nextPageToken' | 'next_page_token') => {
    const calls: Array<{ pageToken?: string }> = [];
    const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/v1/querybatch')) {
        const body = JSON.parse(String(init?.body)) as {
          queries: { page_token?: string }[];
        };
        // Honor ONLY the documented `page_token` request field.
        const pageToken = body.queries[0]?.page_token;
        calls.push({ pageToken });
        if (!pageToken) {
          return new Response(
            JSON.stringify({
              results: [{ vulns: [{ id: 'GHSA-1' }], [responseTokenKey]: 'tok1' }],
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ results: [{ vulns: [{ id: 'GHSA-2' }] }] }), {
          status: 200,
        });
      }
      const m = u.match(/\/v1\/vulns\/(.+)$/);
      if (m) {
        const id = decodeURIComponent(m[1]);
        return new Response(
          JSON.stringify({ id, summary: id, database_specific: { severity: 'HIGH' } }),
          { status: 200 },
        );
      }
      return new Response('unexpected', { status: 500 });
    });
    return { fetchFn: fetchFn as unknown as typeof fetch, calls };
  };

  it('drains a camelCase nextPageToken response by sending the documented page_token', async () => {
    const { fetchFn, calls } = paginationFetch('nextPageToken');
    const source = new OsvAdvisorySource({ fetchFn });
    const findings = await source.query([dep('lodash', '4.17.11')]);
    expect(findings.map((f) => f.advisory.id).sort()).toEqual(['GHSA-1', 'GHSA-2']);
    // Exactly two calls: if we'd sent the wrong request field, the fake would
    // never see the token and loop until the cap (far more than 2 calls).
    expect(calls).toHaveLength(2);
    expect(calls[1].pageToken).toBe('tok1'); // follow-up carried page_token
  });

  it('also drains a snake_case next_page_token response (docs shape)', async () => {
    const { fetchFn, calls } = paginationFetch('next_page_token');
    const source = new OsvAdvisorySource({ fetchFn });
    const findings = await source.query([dep('lodash', '4.17.11')]);
    expect(findings.map((f) => f.advisory.id).sort()).toEqual(['GHSA-1', 'GHSA-2']);
    expect(calls).toHaveLength(2);
    expect(calls[1].pageToken).toBe('tok1');
  });

  it('THROWS when querybatch keeps returning a page token past the cap (no partial set)', async () => {
    // A token that never clears must abort the scan, not silently stop with a
    // partial advisory set (which would later look clean → mark vulns fixed).
    const fetchFn = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith('/v1/querybatch')) {
        // Always return one id + a fresh token (camelCase) → unbounded pagination.
        return new Response(
          JSON.stringify({ results: [{ vulns: [{ id: 'GHSA-loop' }], nextPageToken: 'tok' }] }),
          { status: 200 },
        );
      }
      return new Response('unexpected', { status: 500 });
    });
    const source = new OsvAdvisorySource({ fetchFn: fetchFn as unknown as typeof fetch });
    await expect(source.query([dep('lodash', '4.17.11')])).rejects.toThrow(
      /pagination .*exceeded/i,
    );
  });

  it('returns [] for an empty dependency set without any fetch', async () => {
    const fetchFn = vi.fn();
    const source = new OsvAdvisorySource({ fetchFn: fetchFn as unknown as typeof fetch });
    expect(await source.query([])).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('THROWS when an advisory id from querybatch cannot be hydrated', async () => {
    // querybatch said x@1.0.0 is vulnerable, but /v1/vulns/MISSING 404s.
    // Silently dropping it would make a known vuln vanish and the store would
    // then mark a still-open finding as fixed — so the scan must abort.
    const { fetchFn } = fakeFetch({
      batch: { 'x@1.0.0': { vulns: [{ id: 'MISSING' }] } },
      vulns: {},
    });
    const source = new OsvAdvisorySource({ fetchFn });
    await expect(source.query([dep('x', '1.0.0')])).rejects.toThrow(/hydrate failed/i);
  });

  it('THROWS when only one of several ids fails to hydrate (no partial result)', async () => {
    const { fetchFn } = fakeFetch({
      batch: { 'x@1.0.0': { vulns: [{ id: 'GHSA-ok' }, { id: 'GHSA-bad' }] } },
      vulns: {
        'GHSA-ok': { id: 'GHSA-ok', summary: 'ok', database_specific: { severity: 'LOW' } },
      },
    });
    const source = new OsvAdvisorySource({ fetchFn });
    await expect(source.query([dep('x', '1.0.0')])).rejects.toThrow(/GHSA-bad/);
  });
});
