/**
 * The collection allowlist editor (decisions INFRA-SCOPE and INFRA-COST).
 *
 * Collection is opt-in: an empty list polls nothing. Every row an operator adds
 * here multiplies into billed `GetMetricData` requests forever, so the one
 * thing this screen must do is show the price **while the list is still being
 * edited**. The number that changes behaviour is the one on screen at decision
 * time, not the one on next month's bill — so the projection is recomputed on
 * every edit against the server's pricing endpoint (pure arithmetic, no AWS
 * calls, nothing persisted) rather than only after Save.
 *
 * `resources` is an editable estimate rather than a read-only inventory figure.
 * Inventory sync runs hourly and has described nothing when a scope is first
 * added, so a read-only column would render $0.00 next to every new row —
 * precisely the row whose cost the operator needs to see before committing.
 * The estimate is a pricing input only and is never saved; a stored scope
 * pre-fills it from real inventory.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Loader2, Plus, Trash2 } from 'lucide-react';
// One money formatter for the whole product. The rule that a sub-cent charge
// must never print as "$0.00" was written here first and then retyped on
// mobile; it lives in shared/ so the two cannot drift on what a bill says.
import { formatUsd } from '@shared/utils/infraSpend';
import { api } from '../../utils/api';

export interface ScopeDraftRow {
  /** Local identity. Survives edits to the triple, unlike the server id. */
  key: string;
  id?: string;
  profileName: string;
  region: string;
  service: string;
  enabled: boolean;
  /** Pricing input only — never sent on save. */
  resourceCount: number;
  tagClauses: Array<{ key: string; values: string }>;
}

interface ProjectionState {
  estimatedMonthlyCostUsd: number;
  metricsRequestedPerMonth: number;
  perScope: Array<Record<string, any>>;
}

const EMPTY_PROJECTION: ProjectionState = {
  estimatedMonthlyCostUsd: 0,
  metricsRequestedPerMonth: 0,
  perScope: [],
};

/**
 * Fallback for the server's `maxScopes`. Only used before the first successful
 * load, and re-applied on every project switch so a permissive limit from one
 * project cannot govern the Add-scope button of another.
 */
const DEFAULT_MAX_SCOPES = 200;

/** Debounce for the pricing call. Long enough to coalesce a typed region. */
const PRICE_DEBOUNCE_MS = 250;

let rowSeq = 0;
function nextRowKey(): string {
  rowSeq += 1;
  return `scope-${rowSeq}`;
}

export function blankRow(): ScopeDraftRow {
  return {
    key: nextRowKey(),
    profileName: '',
    region: '',
    service: '',
    enabled: true,
    resourceCount: 0,
    tagClauses: [],
  };
}

/** Server scope -> draft row. Tag values join with `, ` for a single input. */
export function toDraftRow(scope: Record<string, any>): ScopeDraftRow {
  const tagFilter = (scope.tagFilter ?? null) as Record<string, string[]> | null;
  return {
    key: nextRowKey(),
    id: scope.id,
    profileName: scope.profileName ?? '',
    region: scope.region ?? '',
    service: scope.service ?? '',
    enabled: scope.enabled !== false,
    resourceCount: Number(scope.resourceCount) || 0,
    tagClauses: tagFilter
      ? Object.entries(tagFilter).map(([key, values]) => ({
          key,
          values: (Array.isArray(values) ? values : [values]).join(', '),
        }))
      : [],
  };
}

/**
 * Draft clauses -> the wire tag filter.
 *
 * A clause with no key, or with no non-empty values, is dropped rather than
 * sent: a half-typed row would fail the server's parser, and the parser
 * deliberately fails a scope rather than degrading it to "no filter", so the
 * operator would get a rejected save for a row they had not finished.
 */
export function toTagFilter(
  clauses: ReadonlyArray<{ key: string; values: string }>,
): Record<string, string[]> | null {
  const filter: Record<string, string[]> = {};
  for (const clause of clauses) {
    const key = clause.key.trim();
    if (key === '') continue;
    const values = clause.values
      .split(',')
      .map((v) => v.trim())
      .filter((v) => v !== '');
    if (values.length === 0) continue;
    // Union rather than overwrite. Two clauses on the same key are two halves of
    // one OR — the UI states that values within a tag are ORed — so assigning
    // would silently discard the earlier clause and save a filter narrower than
    // the one on screen. Deduped so a value typed twice does not reach the
    // collector twice.
    const merged = filter[key] ?? [];
    for (const value of values) {
      if (!merged.includes(value)) merged.push(value);
    }
    filter[key] = merged;
  }
  return Object.keys(filter).length === 0 ? null : filter;
}

function isComplete(row: ScopeDraftRow): boolean {
  return row.profileName.trim() !== '' && row.region.trim() !== '' && row.service.trim() !== '';
}

/** Rows that are complete enough to price or save. */
export function completeRows(rows: readonly ScopeDraftRow[]): ScopeDraftRow[] {
  return rows.filter(isComplete);
}

/**
 * Rows missing part of the triple.
 *
 * These block the save rather than being quietly dropped from it. The save is a
 * whole-list replace, so a row omitted from the payload is a row *deleted* on
 * the server — clearing the profile field of a working scope and hitting Save
 * would silently stop collecting it, and an operator who added a blank row and
 * saved would wipe the allowlist. Neither is something the operator asked for,
 * so the editor refuses instead of guessing which they meant.
 */
export function incompleteRows(rows: readonly ScopeDraftRow[]): ScopeDraftRow[] {
  return rows.filter((r) => !isComplete(r));
}

/** The pricing payload: enabled, complete rows only — a paused scope costs nothing. */
export function toProjectionScopes(rows: readonly ScopeDraftRow[]): Array<Record<string, unknown>> {
  return completeRows(rows)
    .filter((r) => r.enabled)
    .map((r) => ({
      id: r.id,
      service: r.service.trim().toLowerCase(),
      region: r.region.trim(),
      profileName: r.profileName.trim(),
      resourceCount: Math.max(0, Math.floor(r.resourceCount) || 0),
    }));
}

/** The save payload. `resourceCount` is a pricing input and is deliberately absent. */
export function toSavePayload(rows: readonly ScopeDraftRow[]): Array<Record<string, unknown>> {
  return completeRows(rows).map((r) => ({
    profileName: r.profileName.trim(),
    region: r.region.trim(),
    service: r.service.trim().toLowerCase(),
    enabled: r.enabled,
    tagFilter: toTagFilter(r.tagClauses),
  }));
}

export interface InfraScopeEditorProps {
  projectId?: string | null;
  showToast?: (message: string, type?: string) => void;
  /**
   * Notified whenever the editor adopts a server response — initial load and
   * every save. The page's "no scope configured" empty states key off this, so
   * they must clear on load rather than only after the first save.
   */
  onScopesChange?: (response: Record<string, any>) => void;
}

export default function InfraScopeEditor({
  projectId,
  showToast,
  onScopesChange,
}: InfraScopeEditorProps): React.ReactElement {
  const [rows, setRows] = useState<ScopeDraftRow[]>([]);
  const [ceiling, setCeiling] = useState<string>('');
  const [services, setServices] = useState<string[]>([]);
  const [maxScopes, setMaxScopes] = useState<number>(DEFAULT_MAX_SCOPES);
  const [degradation, setDegradation] = useState<string>('normal');
  const [projection, setProjection] = useState<ProjectionState>(EMPTY_PROJECTION);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  /**
   * The last pricing request failed, so `projection` describes an older draft
   * than the one on screen. Kept separate from `error`, which is about the
   * scopes themselves — a project can be perfectly loadable and saveable while
   * its cost is momentarily unknown.
   */
  const [pricingFailed, setPricingFailed] = useState(false);
  /**
   * The draft identity `projection` was computed for.
   *
   * A boolean "is a request in flight" is not enough: the gap between an edit
   * and its price also spans the debounce, before any request exists. Comparing
   * identities covers both, and answers the only question that matters at Save
   * time — does the number on screen describe *these* rows? While it does not,
   * the figure is the previous draft's and must not be approvable.
   */
  const [pricedKey, setPricedKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * Tracked apart from `error` because the two mean different things about the
   * rows on screen. A failed *save* leaves the draft intact and trustworthy; a
   * failed *load* leaves it empty and meaningless, and an empty draft is the one
   * value this editor must never act on — the save is a whole-list replace, so
   * committing it would delete every scope the project has.
   */
  const [loadFailed, setLoadFailed] = useState(false);
  const [dirty, setDirty] = useState(false);

  // Guards every async settle against a project switch: a slow response for the
  // previous project must never repaint the new project's allowlist.
  const generation = useRef(0);

  const applyResponse = useCallback(
    (response: Record<string, any>) => {
      const scopes = Array.isArray(response.scopes) ? response.scopes : [];
      const draftRows = scopes.map(toDraftRow);
      setRows(draftRows);
      // The server priced exactly these scopes, so the projection it returned
      // already describes the draft we are adopting. Marking it priced here
      // avoids an immediate redundant reprice on every load and save.
      setPricedKey(JSON.stringify(toProjectionScopes(draftRows)));
      setPricingFailed(false);
      setServices(Array.isArray(response.collectableServices) ? response.collectableServices : []);
      setMaxScopes(Number(response.maxScopes) || DEFAULT_MAX_SCOPES);
      setDegradation(String(response.degradation ?? 'normal'));
      setCeiling(
        response.monthlyCeilingUsd === null || response.monthlyCeilingUsd === undefined
          ? ''
          : String(response.monthlyCeilingUsd),
      );
      setProjection({ ...EMPTY_PROJECTION, ...(response.projection ?? {}) });
      setDirty(false);
      setLoadFailed(false);
      onScopesChange?.(response);
    },
    [onScopesChange],
  );

  useEffect(() => {
    const gen = ++generation.current;
    // Everything below is project-derived, so all of it is cleared here rather
    // than only the fields the happy path happens to overwrite. When the load
    // fails there is no `applyResponse` to reset the rest, and the leftovers are
    // not harmless decoration: a ceiling and a degradation notice belonging to
    // the previous project read as statements about this one, and the ceiling in
    // particular is an editable field that a save would then write across.
    setRows([]);
    setProjection(EMPTY_PROJECTION);
    setPricedKey(null);
    setPricingFailed(false);
    setCeiling('');
    setDegradation('normal');
    setServices([]);
    setMaxScopes(DEFAULT_MAX_SCOPES);
    setError(null);
    setLoadFailed(false);
    setDirty(false);
    // A save belonging to the previous project must not hold this one's editor
    // shut. Bumping the generation above already orphaned that request, so its
    // response can no longer touch these rows and the freeze protects nothing —
    // but a slow or hung request would otherwise keep the new project read-only
    // indefinitely, with no way for the operator to recover.
    setSaving(false);
    if (!projectId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    api
      .getInfraScopes(projectId)
      .then((response: any) => {
        if (generation.current === gen) applyResponse(response);
      })
      .catch((err: any) => {
        if (generation.current === gen) {
          setError(err?.message || 'The collection scope could not be loaded.');
          setLoadFailed(true);
        }
      })
      .finally(() => {
        if (generation.current === gen) setLoading(false);
      });
  }, [projectId, applyResponse]);

  // Recompute the price on every edit. The endpoint writes nothing and calls no
  // AWS API, so the only cost of doing this live is a debounced local request.
  const projectionScopes = useMemo(() => toProjectionScopes(rows), [rows]);
  const projectionKey = useMemo(() => JSON.stringify(projectionScopes), [projectionScopes]);

  useEffect(() => {
    if (!projectId || loading) return;
    if (projectionScopes.length === 0) {
      // A genuine zero: nothing enabled is nothing billed. Distinct from a
      // pricing failure, so the failure flag clears here too.
      setProjection(EMPTY_PROJECTION);
      setPricingFailed(false);
      setPricedKey(projectionKey);
      return;
    }
    const gen = generation.current;
    const key = projectionKey;
    let cancelled = false;
    const timer = setTimeout(() => {
      api
        .projectInfraCost(projectId, {
          scopes: projectionScopes,
          ...(degradation === 'widened' ? { degradation: 'widened' } : {}),
        })
        .then((response: any) => {
          if (!cancelled && generation.current === gen) {
            setProjection({ ...EMPTY_PROJECTION, ...response });
            setPricingFailed(false);
            setPricedKey(key);
          }
        })
        .catch(() => {
          // Zeroing the projection here would render "$0.00 /month" for a scope
          // whose cost is simply unknown, which is the single most dangerous
          // thing this screen can display: it invites an operator to approve an
          // expensive allowlist as if it were free. Keep the last figure in
          // state and let the panel refuse to present it as current.
          //
          // Editing stays unblocked on purpose. A pricing outage must not trap
          // an operator out of *removing* scopes, which is the very action they
          // would want if they suspected a cost problem.
          //
          // The key is settled even on failure, so this draft reads as "priced,
          // outcome unknown" rather than "still pricing". The two need different
          // treatment at Save: a pending price will arrive if you wait, a failed
          // one will not, and blocking on the latter would trap the operator.
          if (!cancelled && generation.current === gen) {
            setPricingFailed(true);
            setPricedKey(key);
          }
        });
    }, PRICE_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // projectionKey is the value identity of projectionScopes; depending on the
    // array itself would refire on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, projectionKey, degradation, loading]);

  /**
   * Edits are frozen while a save is in flight.
   *
   * The request captured `rows` and `ceilingValue` at call time, and its
   * response is adopted wholesale on settle. An edit made in between would be
   * silently overwritten by the server's echo of the *older* draft — the
   * operator watches their change disappear with a success toast on top of it.
   * Freezing is honest about that; the alternative, reconciling two drafts of a
   * whole-list replace, has no correct answer when the same row was touched in
   * both.
   */
  const frozen = saving;

  const mutate = (key: string, patch: Partial<ScopeDraftRow>) => {
    if (frozen) return;
    setDirty(true);
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  };

  const addRow = () => {
    if (frozen) return;
    setDirty(true);
    setRows((prev) => [...prev, blankRow()]);
  };

  const removeRow = (key: string) => {
    if (frozen) return;
    setDirty(true);
    setRows((prev) => prev.filter((r) => r.key !== key));
  };

  const addClause = (key: string) => {
    if (frozen) return;
    setDirty(true);
    setRows((prev) =>
      prev.map((r) =>
        r.key === key ? { ...r, tagClauses: [...r.tagClauses, { key: '', values: '' }] } : r,
      ),
    );
  };

  const mutateClause = (
    rowKey: string,
    index: number,
    patch: Partial<{ key: string; values: string }>,
  ) => {
    if (frozen) return;
    setDirty(true);
    setRows((prev) =>
      prev.map((r) =>
        r.key === rowKey
          ? {
              ...r,
              tagClauses: r.tagClauses.map((c, i) => (i === index ? { ...c, ...patch } : c)),
            }
          : r,
      ),
    );
  };

  const removeClause = (rowKey: string, index: number) => {
    if (frozen) return;
    setDirty(true);
    setRows((prev) =>
      prev.map((r) =>
        r.key === rowKey ? { ...r, tagClauses: r.tagClauses.filter((_, i) => i !== index) } : r,
      ),
    );
  };

  const duplicateTriples = useMemo(() => {
    const seen = new Set<string>();
    const dupes = new Set<string>();
    for (const row of completeRows(rows)) {
      const key = `${row.profileName.trim()} ${row.region.trim()} ${row.service.trim().toLowerCase()}`;
      if (seen.has(key)) dupes.add(key);
      seen.add(key);
    }
    return dupes;
  }, [rows]);

  const uncollectable = useMemo(() => {
    if (services.length === 0) return new Set<string>();
    const known = new Set(services);
    return new Set(
      completeRows(rows)
        .map((r) => r.service.trim().toLowerCase())
        .filter((s) => !known.has(s)),
    );
  }, [rows, services]);

  const ceilingValue = ceiling.trim() === '' ? null : Number(ceiling);
  const ceilingInvalid =
    ceilingValue !== null && (!Number.isFinite(ceilingValue) || ceilingValue < 0);
  /** The projection on screen was computed for an older draft than the rows. */
  const projectionStale = pricedKey !== projectionKey;

  // Suppressed whenever the figure does not describe the current rows: the
  // comparison would be drawn against a different draft, so both its presence
  // and its absence would be claims the editor cannot support.
  const overCeiling =
    ceilingValue !== null &&
    !ceilingInvalid &&
    !pricingFailed &&
    !projectionStale &&
    projection.estimatedMonthlyCostUsd > ceilingValue;

  const incomplete = useMemo(() => incompleteRows(rows), [rows]);

  const canSave =
    !!projectId &&
    !saving &&
    !loading &&
    // A whole-list replace built on top of a failed load would submit an empty
    // list and delete every stored scope.
    !loadFailed &&
    // INFRA-COST requires the price to be visible at the moment of the decision.
    // Approving while the figure still describes the previous draft is exactly
    // the failure that requirement exists to prevent — the operator would be
    // shown a cheaper allowlist than the one they are committing.
    !projectionStale &&
    incomplete.length === 0 &&
    duplicateTriples.size === 0 &&
    !ceilingInvalid;

  const save = async () => {
    if (!projectId || !canSave) return;
    // Pinned before the await, checked after, exactly as the load and pricing
    // paths do. A save that settles after the operator has switched projects
    // would otherwise paint project A's scopes into project B's editor and
    // report them upward through onScopesChange — and because the save is a
    // whole-list replace, the next Save in that editor would write A's
    // allowlist over B's.
    const gen = generation.current;
    setSaving(true);
    setError(null);
    try {
      const response: any = await api.updateInfraScopes(projectId, {
        scopes: toSavePayload(rows),
        monthlyCeilingUsd: ceilingValue,
      });
      if (generation.current !== gen) return;
      applyResponse(response);
      showToast?.('Collection scope saved', 'success');
    } catch (err: any) {
      if (generation.current !== gen) return;
      const message = err?.message || 'The collection scope could not be saved.';
      setError(message);
      showToast?.(message, 'error');
    } finally {
      // Generation-guarded like the rest. This was previously unconditional to
      // keep a stale settle from wedging the new project's Save button, but the
      // project-switch reset now owns that. Left unconditional it would be a
      // hazard in the other direction: project A's late settle would clear the
      // freeze in the middle of project B's *own* save, reopening the inputs
      // whose edits B's in-flight response is about to overwrite.
      if (generation.current === gen) setSaving(false);
    }
  };

  if (loading) {
    return (
      <div
        className="flex items-center gap-2 rounded-xl border border-gray-800 bg-gray-900/40 p-5 text-sm text-gray-400"
        data-testid="infra-scope-editor-loading"
      >
        <Loader2 size={14} className="animate-spin" />
        Loading collection scope…
      </div>
    );
  }

  return (
    <section
      className="rounded-xl border border-gray-800 bg-gray-900/40 p-4"
      data-testid="infra-scope-editor"
    >
      <header className="mb-3">
        <h3 className="text-sm font-medium text-gray-200">Collection scope</h3>
        <p className="mt-1 text-xs leading-5 text-gray-500">
          Agent Hub polls only what is listed here. An empty list collects nothing — there is no
          automatic discovery, because scanning a whole account would bill you for every resource in
          it.
        </p>
      </header>

      {error && (
        <div
          className="mb-3 rounded-lg border border-red-900/60 bg-red-950/30 px-3 py-2 text-xs text-red-300"
          data-testid="infra-scope-error"
          role="alert"
        >
          {error}
        </div>
      )}

      <div className="space-y-2">
        {rows.length === 0 && loadFailed && (
          <p
            className="rounded-lg border border-dashed border-gray-800 px-3 py-4 text-center text-xs text-gray-500"
            data-testid="infra-scope-unknown"
          >
            The current scope could not be loaded, so what is being collected is unknown. Reload
            before editing — saving now would replace the stored allowlist with an empty one.
          </p>
        )}

        {rows.length === 0 && !loadFailed && (
          <p className="rounded-lg border border-dashed border-gray-800 px-3 py-4 text-center text-xs text-gray-500">
            No scopes yet. Nothing is being collected.
          </p>
        )}

        {rows.map((row) => {
          const service = row.service.trim().toLowerCase();
          const triple = `${row.profileName.trim()} ${row.region.trim()} ${service}`;
          return (
            <div
              key={row.key}
              className="rounded-lg border border-gray-800 bg-gray-950/40 p-3"
              data-testid="infra-scope-row"
            >
              <div className="flex flex-wrap items-end gap-2">
                <label className="flex-1 min-w-[8rem] text-[11px] text-gray-500">
                  Profile
                  <input
                    className="mt-1 w-full rounded border border-gray-700 bg-gray-900 px-2 py-1 text-xs text-gray-100"
                    value={row.profileName}
                    aria-label="Profile"
                    disabled={frozen}
                    onChange={(e) => mutate(row.key, { profileName: e.target.value })}
                  />
                </label>
                <label className="flex-1 min-w-[8rem] text-[11px] text-gray-500">
                  Region
                  <input
                    className="mt-1 w-full rounded border border-gray-700 bg-gray-900 px-2 py-1 text-xs text-gray-100"
                    value={row.region}
                    aria-label="Region"
                    disabled={frozen}
                    placeholder="us-east-2"
                    onChange={(e) => mutate(row.key, { region: e.target.value })}
                  />
                </label>
                <label className="flex-1 min-w-[8rem] text-[11px] text-gray-500">
                  Service
                  <input
                    className="mt-1 w-full rounded border border-gray-700 bg-gray-900 px-2 py-1 text-xs text-gray-100"
                    value={row.service}
                    aria-label="Service"
                    disabled={frozen}
                    list="infra-collectable-services"
                    onChange={(e) => mutate(row.key, { service: e.target.value })}
                  />
                </label>
                <label className="w-24 text-[11px] text-gray-500">
                  Resources
                  <input
                    type="number"
                    min={0}
                    className="mt-1 w-full rounded border border-gray-700 bg-gray-900 px-2 py-1 text-xs text-gray-100"
                    value={row.resourceCount}
                    aria-label="Resources"
                    disabled={frozen}
                    onChange={(e) =>
                      mutate(row.key, { resourceCount: Math.max(0, Number(e.target.value) || 0) })
                    }
                  />
                </label>
                <button
                  type="button"
                  aria-label="Enabled"
                  disabled={frozen}
                  aria-pressed={row.enabled}
                  onClick={() => mutate(row.key, { enabled: !row.enabled })}
                  className={`rounded border px-2 py-1 text-xs ${
                    row.enabled
                      ? 'border-emerald-800 bg-emerald-950/40 text-emerald-300'
                      : 'border-gray-700 bg-gray-900 text-gray-500'
                  }`}
                >
                  {row.enabled ? 'Enabled' : 'Paused'}
                </button>
                <button
                  type="button"
                  aria-label="Remove scope"
                  disabled={frozen}
                  onClick={() => removeRow(row.key)}
                  className="rounded border border-gray-700 bg-gray-900 p-1.5 text-gray-400 hover:text-red-300"
                >
                  <Trash2 size={13} />
                </button>
              </div>

              {!isComplete(row) && (
                <p
                  className="mt-2 text-[11px] text-amber-400"
                  role="alert"
                  data-testid="infra-scope-incomplete"
                >
                  Profile, region and service are all required. Finish this row or remove it —
                  saving replaces the whole list, so an unfinished row would be dropped.
                </p>
              )}
              {duplicateTriples.has(triple) && (
                <p className="mt-2 text-[11px] text-amber-400" role="alert">
                  Duplicate scope. Each profile, region and service combination may appear once.
                </p>
              )}
              {uncollectable.has(service) && (
                <p className="mt-2 text-[11px] text-amber-400">
                  No metric pack collects <code>{service}</code>. This scope will be saved but
                  nothing will be polled for it.
                </p>
              )}

              <div className="mt-2 border-t border-gray-800/70 pt-2">
                {row.tagClauses.map((clause, index) => (
                  <div key={index} className="mb-1.5 flex items-center gap-2">
                    <input
                      className="w-32 rounded border border-gray-700 bg-gray-900 px-2 py-1 text-[11px] text-gray-100"
                      value={clause.key}
                      aria-label="Tag key"
                      disabled={frozen}
                      placeholder="Environment"
                      onChange={(e) => mutateClause(row.key, index, { key: e.target.value })}
                    />
                    <input
                      className="flex-1 rounded border border-gray-700 bg-gray-900 px-2 py-1 text-[11px] text-gray-100"
                      value={clause.values}
                      aria-label="Tag values"
                      disabled={frozen}
                      placeholder="prod, staging"
                      onChange={(e) => mutateClause(row.key, index, { values: e.target.value })}
                    />
                    <button
                      type="button"
                      aria-label="Remove tag filter"
                      disabled={frozen}
                      onClick={() => removeClause(row.key, index)}
                      className="rounded border border-gray-700 bg-gray-900 p-1 text-gray-400 hover:text-red-300"
                    >
                      <Trash2 size={11} />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() => addClause(row.key)}
                  disabled={frozen}
                  className="text-[11px] text-sky-400 hover:text-sky-300 disabled:opacity-40"
                >
                  + tag filter
                </button>
                {row.tagClauses.length > 0 && (
                  <p className="mt-1 text-[11px] text-gray-600">
                    Values within a tag are ORed, tags are ANDed. <code>*</code> and <code>?</code>{' '}
                    are wildcards.
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <datalist id="infra-collectable-services">
        {services.map((service) => (
          <option key={service} value={service} />
        ))}
      </datalist>

      <button
        type="button"
        onClick={addRow}
        disabled={frozen || rows.length >= maxScopes}
        className="mt-2 inline-flex items-center gap-1.5 rounded border border-gray-700 bg-gray-900 px-2.5 py-1.5 text-xs text-gray-200 hover:border-gray-600 disabled:opacity-40"
      >
        <Plus size={13} />
        Add scope
      </button>

      <div
        className="mt-4 rounded-lg border border-gray-800 bg-gray-950/50 p-3"
        data-testid="infra-scope-projection"
      >
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-xs text-gray-400">Projected AWS API cost</span>
          <span
            className={`text-lg font-semibold ${
              pricingFailed || projectionStale ? 'text-amber-400' : 'text-gray-100'
            }`}
            data-testid="infra-projected-cost"
          >
            {pricingFailed ? (
              'unavailable'
            ) : projectionStale ? (
              // The old number is deliberately not rendered. Showing it beside a
              // "pricing…" note is what let a cheaper figure be approved for a
              // more expensive list; a figure the operator cannot read is a
              // figure they cannot act on.
              'pricing…'
            ) : (
              <>
                {formatUsd(projection.estimatedMonthlyCostUsd)}
                <span className="ml-1 text-xs font-normal text-gray-500">/month</span>
              </>
            )}
          </span>
        </div>
        {pricingFailed ? (
          <p
            className="mt-1 text-[11px] leading-5 text-amber-400"
            data-testid="infra-pricing-unavailable"
            role="alert"
          >
            This scope could not be priced, so its monthly cost is unknown — not zero. Retry before
            saving if the cost matters to your decision.
          </p>
        ) : projectionStale ? (
          <p
            className="mt-1 text-[11px] leading-5 text-amber-400"
            data-testid="infra-pricing-stale"
            role="status"
          >
            Pricing the edited scope. Saving is held until the cost shown matches what you are about
            to save.
          </p>
        ) : (
          <p className="mt-1 text-[11px] text-gray-500">
            {projection.metricsRequestedPerMonth.toLocaleString()} metrics requested per month.
            <code className="ml-1">GetMetricData</code> is billed from the first call and is never
            in the free tier.
          </p>
        )}
        {completeRows(rows).some((r) => r.enabled && r.resourceCount === 0) && (
          <p className="mt-1 text-[11px] text-gray-600">
            Scopes with zero resources are priced at zero. Inventory sync runs hourly — enter an
            expected resource count to price a scope before it has been discovered.
          </p>
        )}
      </div>

      <div className="mt-3 rounded-lg border border-gray-800 bg-gray-950/50 p-3">
        <label className="text-xs text-gray-400">
          Monthly cost ceiling (USD)
          <input
            className="mt-1 block w-40 rounded border border-gray-700 bg-gray-900 px-2 py-1 text-xs text-gray-100"
            value={ceiling}
            aria-label="Monthly cost ceiling (USD)"
            disabled={frozen}
            placeholder="uncapped"
            inputMode="decimal"
            onChange={(e) => {
              if (frozen) return;
              setDirty(true);
              setCeiling(e.target.value);
            }}
          />
        </label>
        <p className="mt-2 text-[11px] leading-5 text-gray-500">
          Leave blank for no cap. At the ceiling the collector widens every poll interval fourfold;
          at twice the ceiling it stops issuing billed requests entirely and raises a notice. It
          never keeps spending silently. <code>0</code> means collect nothing and pauses
          immediately.
        </p>
        {ceilingInvalid && (
          <p className="mt-1 text-[11px] text-red-400" role="alert">
            Enter a number of zero or more, or leave it blank.
          </p>
        )}
        {overCeiling && (
          <p
            className="mt-1 flex items-center gap-1 text-[11px] text-amber-400"
            data-testid="infra-scope-over-ceiling"
          >
            <AlertTriangle size={12} />
            This scope is projected to exceed the ceiling, so the collector will degrade partway
            through the month.
          </p>
        )}
        {degradation !== 'normal' && (
          <p className="mt-1 text-[11px] text-amber-400">
            The collector is currently {degradation === 'paused' ? 'paused' : 'running widened'}{' '}
            because month-to-date spend reached the ceiling.
          </p>
        )}
      </div>

      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={save}
          disabled={!canSave}
          className="inline-flex items-center gap-1.5 rounded bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-40"
        >
          {saving && <Loader2 size={13} className="animate-spin" />}
          Save scope
        </button>
        {incomplete.length > 0 && (
          <span className="text-[11px] text-amber-400" data-testid="infra-scope-save-blocked">
            {incomplete.length === 1 ? '1 row is' : `${incomplete.length} rows are`} incomplete.
          </span>
        )}
        {dirty && incomplete.length === 0 && (
          <span className="text-[11px] text-gray-500">Unsaved changes</span>
        )}
      </div>
    </section>
  );
}
