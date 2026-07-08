// rumSessionFilters.ts — pure filter-state helpers for the mobile Replays
// dashboard. Ported from client/src/components/RumSessionsExplorer.tsx so the
// mobile Sessions tab builds byte-identical server query params and applies the
// same "did the effective filter set change?" short-circuit. Framework-free so
// the filter-state logic is unit-testable without rendering React Native.

export type FilterDraft = Record<string, string>;

// Started-at time-range presets → lookback window in ms (null = all time).
export const TIME_RANGES: { id: string; label: string; ms: number | null }[] = [
  { id: '15m', label: 'Last 15 min', ms: 15 * 60_000 },
  { id: '1h', label: 'Last hour', ms: 60 * 60_000 },
  { id: '4h', label: 'Last 4 hours', ms: 4 * 60 * 60_000 },
  { id: '1d', label: 'Last 24 hours', ms: 24 * 60 * 60_000 },
  { id: '7d', label: 'Last 7 days', ms: 7 * 24 * 60 * 60_000 },
  { id: '30d', label: 'Last 30 days', ms: 30 * 24 * 60 * 60_000 },
  { id: 'all', label: 'All time', ms: null },
];

export const DEFAULT_RANGE_ID = '1d';

/** Resolve a range preset id to its lookback window in ms (null = all time). */
export function rangeMsFor(rangeId: string): number | null {
  return TIME_RANGES.find((r) => r.id === rangeId)?.ms ?? null;
}

// Free-text facet fields (exact-match on the server).
export const TEXT_FACETS: { key: string; label: string; placeholder: string }[] = [
  { key: 'usrEmail', label: 'User email', placeholder: 'user@example.com' },
  { key: 'usrName', label: 'User name', placeholder: 'Ada Lovelace' },
  { key: 'usrId', label: 'User id', placeholder: 'usr_123' },
  { key: 'deviceType', label: 'Device', placeholder: 'Desktop' },
  { key: 'browser', label: 'Browser', placeholder: 'Chrome' },
  { key: 'os', label: 'OS', placeholder: 'macOS' },
  { key: 'geoCountry', label: 'Country', placeholder: 'US' },
];

// Numeric lower-bound facets (>= on the server).
export const COUNT_FACETS: { key: string; label: string }[] = [
  { key: 'viewCountMin', label: 'Min views' },
  { key: 'actionCountMin', label: 'Min actions' },
  { key: 'errorCountMin', label: 'Min errors' },
  { key: 'frustrationCountMin', label: 'Min frustrations' },
];

export const SESSIONS_PAGE_SIZE = 50;

/** Build the server filter payload from the applied draft + time range. Blank
 *  strings are dropped; duration seconds inputs are converted to the ms the
 *  server expects; the range preset becomes an inclusive `from` bound. */
export function buildRumSessionParams(
  applied: FilterDraft,
  rangeMs: number | null,
  nowMs: number,
  limit: number,
  offset: number,
): Record<string, string | number> {
  const params: Record<string, string | number> = { limit, offset };
  for (const { key } of TEXT_FACETS) {
    if (applied[key]?.trim()) params[key] = applied[key].trim();
  }
  for (const { key } of COUNT_FACETS) {
    const n = Number(applied[key]);
    if (applied[key]?.trim() && Number.isFinite(n)) params[key] = Math.max(0, Math.floor(n));
  }
  const minS = Number(applied.durationMinS);
  if (applied.durationMinS?.trim() && Number.isFinite(minS)) {
    params.durationMinMs = Math.max(0, Math.floor(minS * 1000));
  }
  const maxS = Number(applied.durationMaxS);
  if (applied.durationMaxS?.trim() && Number.isFinite(maxS)) {
    params.durationMaxMs = Math.max(0, Math.floor(maxS * 1000));
  }
  if (rangeMs != null) params.from = nowMs - rangeMs;
  return params;
}

/** Compare two filter drafts by their effective (trimmed, non-blank) entries,
 *  so blank inputs and missing keys are equal — used to skip a redundant reload
 *  when Apply is tapped with no real change. */
export function sameFilters(a: FilterDraft, b: FilterDraft): boolean {
  const norm = (o: FilterDraft): FilterDraft =>
    Object.fromEntries(
      Object.entries(o)
        .filter(([, v]) => v?.trim())
        .map(([k, v]) => [k, v.trim()]),
    );
  const na = norm(a);
  const nb = norm(b);
  const keys = Object.keys(na);
  return keys.length === Object.keys(nb).length && keys.every((k) => na[k] === nb[k]);
}

/** True when the applied draft carries at least one effective (non-blank)
 *  filter — drives the Clear button visibility and the empty-state copy. */
export function hasActiveFilters(applied: FilterDraft): boolean {
  return Object.values(applied).some((v) => v?.trim());
}

// ── Capture-grain (Replays tab) filters ─────────────────────────────
// Ticket-link filter, mirrors ReplayCaptureTable FILTERS. `orphans` is only
// shown to privileged callers (canViewOrphans from the list response).
export const REPLAY_LINK_FILTERS: { id: string; label: string; orphanOnly?: boolean }[] = [
  { id: 'all', label: 'All' },
  { id: 'linked', label: 'Linked' },
  { id: 'unlinked', label: 'Unlinked' },
  { id: 'orphans', label: 'Orphaned', orphanOnly: true },
];

// Capture-kind facet, orthogonal to the ticket-link filter above.
export const REPLAY_KIND_FILTERS: { id: string; label: string }[] = [
  { id: 'all', label: 'All kinds' },
  { id: 'continuous', label: 'Continuous' },
  { id: 'on-error', label: 'On-error' },
];

export const REPLAYS_PAGE_SIZE = 50;

/** The ticket-link filters visible for a given privilege level — orphan-only
 *  filters drop out unless the caller can view orphans. Mirrors
 *  ReplayCaptureTable's `visibleFilters`. */
export function visibleReplayLinkFilters(canViewOrphans: boolean) {
  return REPLAY_LINK_FILTERS.filter((f) => !f.orphanOnly || canViewOrphans);
}
