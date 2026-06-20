/**
 * osv.ts — {@link AdvisorySource} backed by OSV.dev (https://osv.dev).
 *
 * OSV aggregates the GitHub Advisory DB (GHSA-*), the npm advisory feed,
 * CVEs, and others, so a single source covers the "GitHub Advisory DB /
 * OSV" acceptance criterion.
 *
 * Two-step protocol (https://google.github.io/osv.dev/api/):
 *   1. `POST /v1/querybatch` with one `{package, version}` query per
 *      dependency. OSV does version-applicability server-side and returns,
 *      per query, the *ids* of the vulns affecting that exact version.
 *   2. `GET /v1/vulns/{id}` to hydrate each unique id into a full record
 *      (summary, severity, fixed versions). Ids are deduped across the
 *      batch so a vuln hitting many packages is fetched once.
 *
 * `fetchFn` is injectable so tests drive the whole mapping with canned
 * responses and never touch the network.
 */

import type { Advisory, AdvisorySource, DependencyFinding, ResolvedDependency } from './types.js';
import { resolveSeverity } from './severity.js';
import { compareVersions, isValidVersion } from './version-compare.js';

const DEFAULT_BASE_URL = 'https://api.osv.dev';
/** OSV batch limit is generous; we chunk to stay well under any cap. */
const MAX_BATCH = 200;
/** Safety cap on per-dependency querybatch pages (a package with this many
 * pages of advisories is pathological; the cap prevents an unbounded loop on a
 * misbehaving `next_page_token`). */
const MAX_OSV_PAGES = 50;
const REQUEST_TIMEOUT_MS = 30_000;

type FetchFn = typeof fetch;

export interface OsvSourceOptions {
  fetchFn?: FetchFn;
  baseUrl?: string;
  /** Per-request timeout; also bounds the whole hydrate fan-out per call. */
  timeoutMs?: number;
}

interface OsvBatchVulnRef {
  id: string;
}
interface OsvBatchResult {
  vulns?: OsvBatchVulnRef[];
  /**
   * Present when this result has more vuln ids than one page returned. OSV is
   * proto-backed and its live JSON emits camelCase `nextPageToken`; the docs
   * page shows snake_case `next_page_token`. We read BOTH so we drain
   * pagination regardless of which the deployment serves — missing it would
   * silently omit advisories, which later look fixed.
   */
  nextPageToken?: string;
  next_page_token?: string;
}
interface OsvBatchResponse {
  results?: OsvBatchResult[];
}

interface OsvBatchQuery {
  package: { ecosystem: string; name: string };
  version: string;
  /**
   * The DOCUMENTED OSV request field is snake_case `page_token`. Per the proto3
   * JSON spec a parser must also accept the original field name, so this is
   * accepted by any compliant OSV deployment (camelCase deployments included).
   * Responses are read under both spellings (see {@link OsvBatchResult}).
   */
  page_token?: string;
}

/** Read the next-page token from a result under either field spelling. */
function nextPageToken(result: OsvBatchResult | undefined): string | undefined {
  return result?.nextPageToken ?? result?.next_page_token;
}

interface OsvSeverityEntry {
  type?: string;
  score?: string;
}
interface OsvRangeEvent {
  introduced?: string;
  fixed?: string;
  last_affected?: string;
}
interface OsvRange {
  type?: string;
  events?: OsvRangeEvent[];
}
interface OsvAffected {
  package?: { ecosystem?: string; name?: string };
  ranges?: OsvRange[];
  database_specific?: { severity?: string };
}
interface OsvVuln {
  id: string;
  summary?: string;
  details?: string;
  aliases?: string[];
  severity?: OsvSeverityEntry[];
  affected?: OsvAffected[];
  references?: { type?: string; url?: string }[];
  database_specific?: { severity?: string };
}

/** OSV ecosystem string for one of our ecosystems. */
function osvEcosystem(ecosystem: ResolvedDependency['ecosystem']): string {
  switch (ecosystem) {
    case 'npm':
      return 'npm';
    default:
      return ecosystem;
  }
}

/** Pick the CVSS v3 vector from an OSV severity array, if present. */
function cvssVectorFromOsv(vuln: OsvVuln): string | null {
  const entry = vuln.severity?.find((s) => (s.type ?? '').toUpperCase().startsWith('CVSS_V3'));
  return entry?.score ?? null;
}

/** Best advisory URL: prefer an ADVISORY reference, else the first one. */
function advisoryUrl(vuln: OsvVuln): string {
  const refs = vuln.references ?? [];
  const advisory = refs.find((r) => (r.type ?? '').toUpperCase() === 'ADVISORY');
  return advisory?.url ?? refs[0]?.url ?? '';
}

/**
 * Match an OSV `affected[].package.ecosystem` against the ecosystem we queried.
 * Exact match, or our base ecosystem against an OSV `Ecosystem:Release` value
 * (e.g. `Debian:11`, `Alpine:v3.18`). npm carries no suffix. A missing affected
 * ecosystem does NOT match — we never want to borrow a fix/severity from an
 * entry that didn't declare the same ecosystem.
 */
function ecosystemMatches(affectedEcosystem: string | undefined, ourEcosystem: string): boolean {
  if (!affectedEcosystem) return false;
  return affectedEcosystem === ourEcosystem || affectedEcosystem.split(':')[0] === ourEcosystem;
}

/** True when an OSV affected entry is for the given (ecosystem, package). */
function affectedMatches(aff: OsvAffected, pkgName: string, ecosystem: string): boolean {
  return aff.package?.name === pkgName && ecosystemMatches(aff.package?.ecosystem, ecosystem);
}

/**
 * Smallest published fixed version that resolves `vuln` for the given
 * (ecosystem, package) at `currentVersion`. Walks every SEMVER range's `fixed`
 * events, keeps those >= the installed version, and returns the lowest — the
 * minimal safe bump. `null` when no fix is published.
 *
 * Matching is by BOTH name and ecosystem: a hydrated advisory can carry
 * `affected` entries for several ecosystems, and a same-named package in
 * another ecosystem must not surface the wrong fixed version.
 */
export function pickFixedVersion(
  vuln: OsvVuln,
  pkgName: string,
  ecosystem: string,
  currentVersion: string,
): string | null {
  const candidates: string[] = [];
  for (const aff of vuln.affected ?? []) {
    if (!affectedMatches(aff, pkgName, ecosystem)) continue;
    for (const range of aff.ranges ?? []) {
      if ((range.type ?? '').toUpperCase() !== 'SEMVER') continue;
      for (const ev of range.events ?? []) {
        if (typeof ev.fixed === 'string' && isValidVersion(ev.fixed)) {
          candidates.push(ev.fixed);
        }
      }
    }
  }
  if (candidates.length === 0) return null;
  const sorted = [...candidates].sort(compareVersions);
  if (isValidVersion(currentVersion)) {
    // Only a fix >= the installed version actually resolves it. A lower `fixed`
    // event belongs to an older, disjoint affected range; for a package
    // vulnerable in a later/unfixed range, suggesting that lower version would
    // be a DOWNGRADE that doesn't fix the installed version. When nothing
    // qualifies, make no suggestion (null) rather than a misleading downgrade.
    return sorted.find((v) => compareVersions(v, currentVersion) >= 0) ?? null;
  }
  // Installed version unparseable → best-effort lowest published fix.
  return sorted[0] ?? null;
}

/**
 * Severity label from the affected-entry override (matched by name AND
 * ecosystem), falling back to the top-level advisory severity.
 */
function severityLabel(vuln: OsvVuln, pkgName: string, ecosystem: string): string | null {
  const aff = vuln.affected?.find((a) => affectedMatches(a, pkgName, ecosystem));
  return aff?.database_specific?.severity ?? vuln.database_specific?.severity ?? null;
}

/** Map a hydrated OSV vuln + the dependency it hit into our Advisory shape. */
export function osvVulnToAdvisory(vuln: OsvVuln, dep: ResolvedDependency): Advisory {
  const eco = osvEcosystem(dep.ecosystem);
  return {
    id: vuln.id,
    summary: (vuln.summary ?? vuln.details ?? vuln.id).split('\n')[0].slice(0, 300),
    severity: resolveSeverity({
      label: severityLabel(vuln, dep.name, eco),
      cvssVector: cvssVectorFromOsv(vuln),
    }),
    aliases: Array.isArray(vuln.aliases) ? vuln.aliases.filter((a) => typeof a === 'string') : [],
    fixedVersion: pickFixedVersion(vuln, dep.name, eco, dep.version),
    url: advisoryUrl(vuln),
  };
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export class OsvAdvisorySource implements AdvisorySource {
  private readonly fetchFn: FetchFn;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(opts: OsvSourceOptions = {}) {
    this.fetchFn = opts.fetchFn ?? fetch;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  private async postJson<T>(path: string, body: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchFn(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`OSV ${path} returned ${res.status}`);
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  private async getJson<T>(path: string): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchFn(`${this.baseUrl}${path}`, { signal: controller.signal });
      if (!res.ok) throw new Error(`OSV ${path} returned ${res.status}`);
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  async query(deps: ResolvedDependency[]): Promise<DependencyFinding[]> {
    if (deps.length === 0) return [];

    // Step 1: batched id lookup, preserving input order per OSV's contract.
    //
    // querybatch can PAGINATE per result: a result may carry a `next_page_token`
    // meaning it has more vuln ids than this page returned. We must follow those
    // tokens to exhaustion — otherwise a dependency with many advisories yields a
    // partial set, and a missing advisory later looks like a clean result that
    // would mark a still-vulnerable finding `fixed`.
    const idSets: Set<string>[] = deps.map(() => new Set<string>());
    const pageTokens: (string | undefined)[] = new Array<string | undefined>(deps.length).fill(
      undefined,
    );

    let offset = 0;
    for (const batch of chunk(deps, MAX_BATCH)) {
      const queries: OsvBatchQuery[] = batch.map((d) => ({
        package: { ecosystem: osvEcosystem(d.ecosystem), name: d.name },
        version: d.version,
      }));
      const resp = await this.postJson<OsvBatchResponse>('/v1/querybatch', { queries });
      const results = resp.results ?? [];
      for (let i = 0; i < batch.length; i++) {
        for (const v of results[i]?.vulns ?? []) if (v.id) idSets[offset + i].add(v.id);
        pageTokens[offset + i] = nextPageToken(results[i]);
      }
      offset += batch.length;
    }

    // Drain remaining pages per dependency (one single-query batch per page).
    for (let i = 0; i < deps.length; i++) {
      let token = pageTokens[i];
      let guard = 0;
      while (token) {
        // Hitting the cap with a token still outstanding means we have NOT
        // collected every advisory id for this package. Proceeding would persist
        // a partial set, and a missing advisory later looks like a clean result
        // that marks a still-vulnerable finding `fixed`. So abort the scan rather
        // than silently stop — same philosophy as the hydrate-failure guard.
        if (guard >= MAX_OSV_PAGES) {
          throw new Error(
            `OSV querybatch pagination for ${deps[i].name}@${deps[i].version} exceeded ` +
              `${MAX_OSV_PAGES} pages; aborting scan rather than persisting a partial ` +
              `(falsely-clean) advisory set.`,
          );
        }
        guard += 1;
        const query: OsvBatchQuery = {
          package: { ecosystem: osvEcosystem(deps[i].ecosystem), name: deps[i].name },
          version: deps[i].version,
          page_token: token,
        };
        const resp = await this.postJson<OsvBatchResponse>('/v1/querybatch', { queries: [query] });
        const r = resp.results?.[0];
        for (const v of r?.vulns ?? []) if (v.id) idSets[i].add(v.id);
        token = nextPageToken(r);
      }
    }

    const idsByDep: string[][] = idSets.map((s) => [...s]);

    // Step 2: hydrate each unique id once.
    //
    // A hydrate failure must NOT be swallowed: querybatch already told us the
    // installed version is vulnerable, so dropping the id would make a KNOWN
    // vulnerability silently vanish from the result set — and the store would
    // then mark a still-open finding as `fixed`. A transient timeout/404 on
    // `/v1/vulns/{id}` would therefore clear real findings. So we collect every
    // un-hydratable id and throw, aborting the scan with a partial result
    // rather than persisting a falsely-clean one.
    const uniqueIds = [...new Set(idsByDep.flat())];
    const vulnById = new Map<string, OsvVuln>();
    const hydrateFailures: string[] = [];
    await Promise.all(
      uniqueIds.map(async (id) => {
        try {
          const vuln = await this.getJson<OsvVuln>(`/v1/vulns/${encodeURIComponent(id)}`);
          if (vuln && typeof vuln.id === 'string') vulnById.set(id, vuln);
          else hydrateFailures.push(id);
        } catch {
          hydrateFailures.push(id);
        }
      }),
    );
    if (hydrateFailures.length > 0) {
      const shown = hydrateFailures.slice(0, 5).join(', ');
      const more = hydrateFailures.length > 5 ? `, …(+${hydrateFailures.length - 5})` : '';
      throw new Error(
        `OSV hydrate failed for ${hydrateFailures.length} advisory id(s): ${shown}${more}. ` +
          `Aborting scan rather than reporting a partial (falsely-clean) result.`,
      );
    }

    const findings: DependencyFinding[] = [];
    for (let i = 0; i < deps.length; i++) {
      for (const id of idsByDep[i]) {
        const vuln = vulnById.get(id);
        if (!vuln) continue;
        findings.push({ dependency: deps[i], advisory: osvVulnToAdvisory(vuln, deps[i]) });
      }
    }
    return findings;
  }
}
