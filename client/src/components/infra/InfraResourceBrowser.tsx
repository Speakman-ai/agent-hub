/**
 * The inventory browser (decision INFRA-UI, Resources tab).
 *
 * Reads `infra_resources`, which the hourly describe sweep owns and nothing
 * here writes. Two properties of that table shape the whole screen:
 *
 *   - **Rows are never deleted** (decision INFRA-SCOPE), so a terminated
 *     instance is still a row. The list therefore leads with `lastSeen` and
 *     defaults to the collector's staleness window; "show everything ever
 *     described" is an explicit toggle, not the default view.
 *   - **Tag and name text is untrusted** — operator- and third-party-controlled
 *     strings from an AWS account. It is rendered as text and nothing else.
 *
 * Transport is REST polling. Inventory changes hourly at most, so a socket
 * would be machinery with no payoff (the deliberate divergence from the logs
 * module recorded in INFRA-UI).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, RefreshCw, Search } from 'lucide-react';
import { api } from '../../utils/api';

export interface InfraResourceWire {
  resourceKey: string;
  accountId: string;
  region: string;
  service: string;
  resourceId: string;
  name: string | null;
  environment: string | null;
  state: string | null;
  tags: Record<string, string>;
  /** CloudWatch dimension map the resource's series are keyed on. */
  metricDimensions?: Record<string, unknown> | null;
  /** Paid provider features detected as on for this resource. */
  features?: Record<string, unknown> | null;
  firstSeen: number;
  lastSeen: number;
}

export interface InfraResourceFacetsWire {
  services: string[];
  regions: string[];
  accounts: string[];
  environments: string[];
  states: string[];
  tagKeys: string[];
  total: number;
}

/** Sentinel the server understands for "carries no environment label". */
export const NO_ENVIRONMENT = 'none';

const EMPTY_FACETS: InfraResourceFacetsWire = {
  services: [],
  regions: [],
  accounts: [],
  environments: [],
  states: [],
  tagKeys: [],
  total: 0,
};

/** Poll interval. Inventory sync runs hourly; this is only to catch a sweep. */
const POLL_MS = 60_000;

export interface ResourceFilterState {
  service: string;
  region: string;
  environment: string;
  state: string;
  tagKey: string;
  tagValue: string;
  search: string;
  includeStale: boolean;
}

export const EMPTY_FILTERS: ResourceFilterState = {
  service: '',
  region: '',
  environment: '',
  state: '',
  tagKey: '',
  tagValue: '',
  search: '',
  includeStale: false,
};

/**
 * Filters -> query params.
 *
 * `seenSince: 0` is sent explicitly for the stale view rather than omitting the
 * key, because omitting it means "use the collector's staleness default" on the
 * server — the opposite of what the toggle asks for. A tag value without a key
 * is dropped: the server ignores it, and sending it would make the URL claim a
 * filter that is not being applied.
 */
export function toResourceQuery(filters: ResourceFilterState): Record<string, unknown> {
  return {
    service: filters.service,
    region: filters.region,
    environment: filters.environment,
    state: filters.state,
    tagKey: filters.tagKey,
    tagValue: filters.tagKey ? filters.tagValue : '',
    search: filters.search.trim(),
    seenSince: filters.includeStale ? 0 : undefined,
  };
}

/** True when every filter is at its default — used for the empty-state copy. */
export function hasActiveFilters(filters: ResourceFilterState): boolean {
  return (
    filters.service !== '' ||
    filters.region !== '' ||
    filters.environment !== '' ||
    filters.state !== '' ||
    filters.tagKey !== '' ||
    filters.search.trim() !== ''
  );
}

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Compact relative age. Never "in the future": clock skew reads as "just now". */
export function formatAge(tsMs: number, nowMs: number): string {
  const delta = nowMs - tsMs;
  if (!Number.isFinite(delta) || delta < MINUTE) return 'just now';
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)}m ago`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)}h ago`;
  return `${Math.floor(delta / DAY)}d ago`;
}

/**
 * Whether a row has gone quiet for longer than the collector will keep polling
 * it. A stale row is dimmed rather than hidden — it is the record of something
 * that existed, and hiding it is what makes a chart end mid-air.
 */
export function isStaleResource(
  resource: Pick<InfraResourceWire, 'lastSeen'>,
  staleAfterMs: number,
  nowMs: number,
): boolean {
  return nowMs - resource.lastSeen > staleAfterMs;
}

function StateBadge({ state }: { state: string | null }): React.ReactElement {
  const tone =
    state === 'running' || state === 'available'
      ? 'border-emerald-900/60 bg-emerald-950/30 text-emerald-300'
      : state === 'terminated' || state === 'stopped' || state === 'deleted'
        ? 'border-red-900/60 bg-red-950/30 text-red-300'
        : 'border-gray-800 bg-gray-900/50 text-gray-400';
  return (
    <span className={`rounded border px-1.5 py-0.5 text-[11px] ${tone}`}>{state ?? 'unknown'}</span>
  );
}

export interface InfraResourceBrowserProps {
  projectId: string;
  /** Notified when a row is chosen, so the page can open its charts. */
  onSelectResource?: (resource: InfraResourceWire) => void;
  selectedResourceKey?: string | null;
}

export default function InfraResourceBrowser({
  projectId,
  onSelectResource,
  selectedResourceKey,
}: InfraResourceBrowserProps): React.ReactElement {
  const [filters, setFilters] = useState<ResourceFilterState>(EMPTY_FILTERS);
  const [resources, setResources] = useState<InfraResourceWire[]>([]);
  const [facets, setFacets] = useState<InfraResourceFacetsWire>(EMPTY_FACETS);
  const [staleAfterMs, setStaleAfterMs] = useState(24 * HOUR);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  /**
   * When the rows on screen were last confirmed against the server. Null before
   * the first success. Read only to date the stale banner — a "not current"
   * warning that cannot say *how* not-current is not much of a warning.
   */
  const [lastLoadedAt, setLastLoadedAt] = useState<number | null>(null);

  // Guards every async settle against a project switch or a newer filter set:
  // a slow response must never repaint a list it no longer describes.
  const generation = useRef(0);

  const query = useMemo(() => toResourceQuery(filters), [filters]);
  const queryKey = useMemo(() => JSON.stringify(query), [query]);

  /**
   * Refresh the current filter set.
   *
   * The rows are deliberately **not** cleared here, unlike the filter/project
   * effect below, and the two cases are different rather than inconsistent:
   *
   *   - A filter or project change makes the rows on screen answer a question
   *     nobody asked any more. They are *wrong*, so they go.
   *   - A refresh — manual or the 60s poll — asks the same question again. The
   *     rows are still the best answer anyone has; they are merely *old*.
   *     Blanking the table on every poll tick would make the list flash empty
   *     once a minute on a perfectly healthy Hub, which trains an operator to
   *     ignore an empty table — the one state that has to stay meaningful.
   *
   * What must not happen is old rows reading as current, so a failed refresh
   * marks them stale instead of silently leaving them next to an error
   * (see `showingStale` in the render path). `error` is therefore cleared on
   * *success* rather than at the start of the request: clearing up front would
   * drop the stale marking for the duration of every retry, so a Hub failing
   * every poll would show an unmarked list most of the time.
   */
  const load = useCallback(() => {
    const gen = ++generation.current;
    setLoading(true);
    api
      .listInfraResources(projectId, JSON.parse(queryKey))
      .then((response: any) => {
        if (generation.current !== gen) return;
        setResources(Array.isArray(response?.resources) ? response.resources : []);
        setFacets({ ...EMPTY_FACETS, ...(response?.facets ?? {}) });
        setNextCursor(response?.nextCursor ?? null);
        if (Number.isFinite(response?.staleAfterMs)) setStaleAfterMs(response.staleAfterMs);
        setNowMs(Date.now());
        setLastLoadedAt(Date.now());
        setError(null);
      })
      .catch((err: any) => {
        if (generation.current !== gen) return;
        setError(err?.message || 'The resource inventory could not be loaded.');
      })
      .finally(() => {
        if (generation.current === gen) setLoading(false);
      });
  }, [projectId, queryKey]);

  useEffect(() => {
    // Everything below is project- and filter-derived, so it is cleared before
    // the request rather than only overwritten on success: a failed load would
    // otherwise leave the previous project's inventory on screen.
    setResources([]);
    setFacets(EMPTY_FACETS);
    setNextCursor(null);
    // `error` is project- and filter-derived too, and this is the one path that
    // must clear it. It describes the *previous* question — a different project,
    // or a different filter set — so leaving it up renders an empty table under
    // a failure that has nothing to do with the request now in flight, and the
    // pending load reads as already broken.
    //
    // This is exactly the case the refresh path must *not* do (see `load`):
    // there, clearing up front would drop the stale marking on every retry.
    // Same state, opposite treatment, because a refresh re-asks the same
    // question and a filter change asks a new one.
    setError(null);
    load();
  }, [load]);

  useEffect(() => {
    if (!projectId) return;
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [projectId, load]);

  // Filters are project-scoped; carrying one project's service selection into
  // another silently shows an empty list for a project that has resources.
  useEffect(() => {
    setFilters(EMPTY_FILTERS);
  }, [projectId]);

  const loadMore = useCallback(() => {
    if (!nextCursor) return;
    const gen = generation.current;
    setLoadingMore(true);
    api
      .listInfraResources(projectId, { ...JSON.parse(queryKey), cursor: nextCursor })
      .then((response: any) => {
        if (generation.current !== gen) return;
        setResources((prev) => [
          ...prev,
          ...(Array.isArray(response?.resources) ? response.resources : []),
        ]);
        setNextCursor(response?.nextCursor ?? null);
      })
      .catch((err: any) => {
        if (generation.current === gen) setError(err?.message || 'Could not load more resources.');
      })
      .finally(() => {
        if (generation.current === gen) setLoadingMore(false);
      });
  }, [projectId, queryKey, nextCursor]);

  const setFilter = useCallback(
    <K extends keyof ResourceFilterState>(key: K, value: ResourceFilterState[K]) => {
      setFilters((prev) => ({ ...prev, [key]: value }));
    },
    [],
  );

  const selectClass =
    'rounded border border-gray-800 bg-gray-900 px-2 py-1 text-xs text-gray-200 focus:border-sky-600 focus:outline-none';

  /**
   * Rows are on screen but the last refresh failed, so they describe an older
   * snapshot than the operator is looking at.
   *
   * This is the state the reviewer flagged: without marking it, a failed poll
   * leaves a normal-looking inventory table sitting beside an error banner, and
   * "these instances exist" is exactly the kind of claim that must not be made
   * out of data we could not confirm. Marked rather than cleared, because
   * clearing on every refresh would blank a healthy list once a minute.
   */
  const showingStale = error !== null && resources.length > 0;

  return (
    <div className="space-y-3" data-testid="infra-resource-browser">
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative">
          <Search size={13} className="absolute left-2 top-1.5 text-gray-500" />
          <input
            type="search"
            aria-label="Search resources"
            placeholder="id or name"
            value={filters.search}
            onChange={(e) => setFilter('search', e.target.value)}
            className={`${selectClass} w-44 pl-6`}
          />
        </label>

        <select
          aria-label="Service"
          value={filters.service}
          onChange={(e) => setFilter('service', e.target.value)}
          className={selectClass}
        >
          <option value="">All services</option>
          {facets.services.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>

        <select
          aria-label="Region"
          value={filters.region}
          onChange={(e) => setFilter('region', e.target.value)}
          className={selectClass}
        >
          <option value="">All regions</option>
          {facets.regions.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>

        <select
          aria-label="Environment"
          value={filters.environment}
          onChange={(e) => setFilter('environment', e.target.value)}
          className={selectClass}
        >
          <option value="">All environments</option>
          {facets.environments.map((e) => (
            <option key={e} value={e}>
              {e}
            </option>
          ))}
          <option value={NO_ENVIRONMENT}>(unlabelled)</option>
        </select>

        <select
          aria-label="State"
          value={filters.state}
          onChange={(e) => setFilter('state', e.target.value)}
          className={selectClass}
        >
          <option value="">Any state</option>
          {facets.states.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>

        <select
          aria-label="Tag key"
          value={filters.tagKey}
          onChange={(e) => setFilter('tagKey', e.target.value)}
          className={selectClass}
        >
          <option value="">Any tag</option>
          {facets.tagKeys.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>

        {filters.tagKey && (
          <input
            aria-label="Tag value"
            placeholder="tag value"
            value={filters.tagValue}
            onChange={(e) => setFilter('tagValue', e.target.value)}
            className={`${selectClass} w-32`}
          />
        )}

        <label className="flex items-center gap-1.5 text-xs text-gray-400">
          <input
            type="checkbox"
            checked={filters.includeStale}
            onChange={(e) => setFilter('includeStale', e.target.checked)}
          />
          Include resources no longer described
        </label>

        <button
          type="button"
          onClick={load}
          className="ml-auto inline-flex items-center gap-1 rounded border border-gray-800 px-2 py-1 text-xs text-gray-300 hover:bg-gray-800"
        >
          {loading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
          Refresh
        </button>
      </div>

      {error && (
        <div
          className="rounded border border-red-900/60 bg-red-950/20 p-3 text-xs text-red-300"
          data-testid="infra-resources-error"
          role="alert"
        >
          {error}
          {showingStale && (
            <span className="ml-1 text-red-200">
              Showing the last successful load
              {lastLoadedAt ? ` from ${formatAge(lastLoadedAt, nowMs)}` : ''} — this list is not
              current.
            </span>
          )}
        </div>
      )}

      {!error && resources.length === 0 && !loading ? (
        <div
          className="rounded-xl border border-gray-800 bg-gray-900/40 p-5 text-sm text-gray-400"
          data-testid="infra-resources-empty"
        >
          {hasActiveFilters(filters)
            ? 'No resources match these filters.'
            : 'No resources discovered yet. Inventory sync runs hourly against the scopes you allowed.'}
        </div>
      ) : (
        <div
          className={`overflow-x-auto rounded-xl border ${
            showingStale ? 'border-red-900/50 opacity-50' : 'border-gray-800'
          }`}
          data-testid={showingStale ? 'infra-resources-stale' : 'infra-resources-table'}
          aria-busy={showingStale}
        >
          <table className="w-full text-left text-xs">
            <thead className="bg-gray-900/70 text-gray-400">
              <tr>
                <th className="px-3 py-2 font-medium">Resource</th>
                <th className="px-3 py-2 font-medium">Service</th>
                <th className="px-3 py-2 font-medium">Region</th>
                <th className="px-3 py-2 font-medium">Environment</th>
                <th className="px-3 py-2 font-medium">State</th>
                <th className="px-3 py-2 font-medium">Last seen</th>
              </tr>
            </thead>
            <tbody>
              {resources.map((resource) => {
                const stale = isStaleResource(resource, staleAfterMs, nowMs);
                return (
                  <tr
                    key={resource.resourceKey}
                    onClick={() => onSelectResource?.(resource)}
                    className={`cursor-pointer border-t border-gray-800/70 hover:bg-gray-800/40 ${
                      selectedResourceKey === resource.resourceKey ? 'bg-sky-950/30' : ''
                    } ${stale ? 'opacity-60' : ''}`}
                    data-testid="infra-resource-row"
                  >
                    <td className="px-3 py-2">
                      <div className="font-mono text-gray-200">{resource.resourceId}</div>
                      {resource.name && <div className="text-gray-500">{resource.name}</div>}
                    </td>
                    <td className="px-3 py-2 text-gray-300">{resource.service}</td>
                    <td className="px-3 py-2 text-gray-300">{resource.region}</td>
                    <td className="px-3 py-2 text-gray-300">{resource.environment || '—'}</td>
                    <td className="px-3 py-2">
                      <StateBadge state={resource.state} />
                    </td>
                    <td className="px-3 py-2 text-gray-400">
                      {formatAge(resource.lastSeen, nowMs)}
                      {stale && <span className="ml-1 text-amber-400">(not polled)</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex items-center gap-3 text-[11px] text-gray-500">
        <span>
          Showing {resources.length} of {facets.total}
          {showingStale ? ' (not current)' : ''}
        </span>
        {/*
          Paging is withheld while the list is stale. A next page fetched now
          would be appended to rows from an older snapshot, and a half-fresh
          list is harder to reason about than either an old one or a failure.
        */}
        {nextCursor && !showingStale && (
          <button
            type="button"
            onClick={loadMore}
            disabled={loadingMore}
            className="rounded border border-gray-800 px-2 py-0.5 text-gray-300 hover:bg-gray-800 disabled:opacity-50"
          >
            {loadingMore ? 'Loading…' : 'Load more'}
          </button>
        )}
      </div>
    </div>
  );
}
