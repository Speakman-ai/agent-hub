/**
 * Resource-inventory helpers for the mobile Infrastructure screen.
 *
 * Duplicated from `client/src/components/infra/InfraResourceBrowser.tsx` rather
 * than hoisted to `shared/`: these describe a filter *form*, and the two forms
 * genuinely differ. Web renders six dropdowns at once; a phone shows a service
 * chip row and a search box, because six pickers stacked vertically is the whole
 * screen. Sharing the state shape would freeze mobile's form to web's layout.
 *
 * The query mapping below is the part that must not drift, so it is a faithful
 * port with the same two traps handled:
 *
 *   - `seenSince: 0` is sent explicitly for the "include stale" view rather than
 *     omitted, because omitting it means "use the collector's staleness default"
 *     server-side — the opposite of what the toggle asks for.
 *   - A tag value without a tag key is dropped. The server ignores it, and
 *     sending it would make the request claim a filter that is not applied.
 */

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
  firstSeen: number;
  lastSeen: number;
}

/** Sentinel the server understands for "carries no environment label". */
export const NO_ENVIRONMENT = 'none';

export interface ResourceFilterState {
  service: string;
  region: string;
  environment: string;
  state: string;
  search: string;
  includeStale: boolean;
}

export const EMPTY_FILTERS: ResourceFilterState = {
  service: '',
  region: '',
  environment: '',
  state: '',
  search: '',
  includeStale: false,
};

/** Filters -> query params for `GET /projects/:id/infra/resources`. */
export function toResourceQuery(filters: ResourceFilterState): Record<string, unknown> {
  return {
    service: filters.service,
    region: filters.region,
    environment: filters.environment,
    state: filters.state,
    search: filters.search.trim(),
    seenSince: filters.includeStale ? 0 : undefined,
  };
}

/** True when any filter is off its default — used to pick the empty-state copy. */
export function hasActiveFilters(filters: ResourceFilterState): boolean {
  return (
    filters.service !== '' ||
    filters.region !== '' ||
    filters.environment !== '' ||
    filters.state !== '' ||
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

export type ResourceTone = 'good' | 'bad' | 'neutral';

/**
 * Tone for a resource's lifecycle state.
 *
 * The web browser inlines this as a JSX ternary; on mobile it has to be a value
 * because React Native styles are objects, not class strings. Same three
 * buckets, so the two surfaces agree on which states read as healthy.
 */
export function resourceStateTone(state: string | null | undefined): ResourceTone {
  if (state === 'running' || state === 'available') return 'good';
  if (state === 'terminated' || state === 'stopped' || state === 'deleted') return 'bad';
  return 'neutral';
}

/** One-line summary under a resource row: name, service and region. */
export function resourceSubtitle(resource: InfraResourceWire): string {
  const parts = [resource.name, resource.service, resource.region].filter(
    (part): part is string => typeof part === 'string' && part.length > 0,
  );
  return parts.join(' · ');
}
