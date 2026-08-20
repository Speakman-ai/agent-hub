import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Circle,
  Loader2,
  Plus,
  Power,
  PowerOff,
  Rocket,
  Trash2,
  XCircle,
} from 'lucide-react';
import { api } from '../utils/api';
import {
  describeReleaseGate,
  describeReleaseGateProgress,
  sortReleaseGates,
  validateReleaseGateDraft,
  type DeployReleaseGate,
  type ReleaseGateSelectionState,
} from '../utils/deployReleaseGates';

interface PickOption {
  id: string;
  label: string;
}

/**
 * Per-environment release-gates editor. Rendered inline under an environment row
 * in EnvironmentsManagementSection. A release gate is a ONE-SHOT deploy: it
 * fires a single deployment once its selected sessions are all merged AND its
 * selected epics are all done, then is consumed (release-gate epic decision).
 * The operator curates the sessions/epics from the project board.
 */
export default function EnvironmentReleaseGatesPanel({
  projectId,
  environmentName,
  showToast,
}: {
  projectId: string;
  environmentName: string;
  showToast?: (message: string, type?: string) => void;
}) {
  const [gates, setGates] = useState<DeployReleaseGate[]>([]);
  const [sessionOptions, setSessionOptions] = useState<PickOption[]>([]);
  const [epicOptions, setEpicOptions] = useState<PickOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionKey, setActionKey] = useState<string | null>(null);
  const [ref, setRef] = useState('');
  const [selectedSessions, setSelectedSessions] = useState<Record<string, boolean>>({});
  const [selectedEpics, setSelectedEpics] = useState<Record<string, boolean>>({});
  const [adding, setAdding] = useState(false);

  const notify = useCallback(
    (message: string, type: string = 'info') => showToast?.(message, type),
    [showToast],
  );

  const load = useCallback(async () => {
    if (!projectId || !environmentName) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.listDeployReleaseGates(projectId, environmentName);
      setGates(res?.gates || []);
    } catch (e: any) {
      setError(e?.message || 'Failed to load release gates');
    } finally {
      setLoading(false);
    }
  }, [projectId, environmentName]);

  const loadOptions = useCallback(async () => {
    if (!projectId) return;
    try {
      const [board, epicsRes] = await Promise.all([
        api.getBoard(projectId, { limit: 500 }).catch(() => null),
        api.getEpics(projectId).catch(() => null),
      ]);
      // Active sessions = board cards with a linked session that are not yet
      // done/cancelled (those are the "work in flight" you release on). The
      // board endpoint returns a flat top-level `cards` array keyed to columns
      // by `column_id`; columns carry no nested `cards`. Older/other shapes may
      // nest cards under each column, so handle both.
      const columns: any[] = board?.columns || [];
      const isDoneOrCancel = (name: unknown) => {
        const n = String(name || '').toLowerCase();
        return n.includes('done') || n.includes('cancel');
      };
      const columnNameById = new Map<string, string>();
      const doneOrCancelledColumnIds = new Set<string>();
      for (const col of columns) {
        if (col?.id == null) continue;
        columnNameById.set(String(col.id), String(col?.name || ''));
        if (isDoneOrCancel(col?.name)) doneOrCancelledColumnIds.add(String(col.id));
      }
      // The board endpoint returns cards flat: iterate that. Fall back to any
      // nested `col.cards` shape, stamping the column name so done/cancel
      // columns are still excluded when the card lacks a resolvable column_id.
      const flatCards: any[] = Array.isArray(board?.cards)
        ? board.cards
        : columns.flatMap((col: any) =>
            (col?.cards || []).map((c: any) => ({ __columnName: col?.name, ...c })),
          );
      const sessions: PickOption[] = [];
      const seen = new Set<string>();
      for (const card of flatCards) {
        if (!card?.session_id || seen.has(card.session_id)) continue;
        const columnName =
          card.column_id != null ? columnNameById.get(String(card.column_id)) : card.__columnName;
        if (isDoneOrCancel(columnName)) continue;
        seen.add(card.session_id);
        sessions.push({ id: card.session_id, label: card.title || card.session_id });
      }
      setSessionOptions(sessions);

      const epics: any[] = Array.isArray(epicsRes) ? epicsRes : epicsRes?.epics || [];
      setEpicOptions(
        epics
          .filter((e) => e?.id && e?.state !== 'done')
          .map((e) => ({ id: e.id, label: e.name || e.title || e.id })),
      );
    } catch {
      /* options are best-effort; the operator can still see existing gates */
    }
  }, [projectId]);

  useEffect(() => {
    load();
    loadOptions();
  }, [load, loadOptions]);

  const sessionLabels = useMemo(() => {
    const map = new Map<string, string>();
    for (const o of sessionOptions) map.set(o.id, o.label);
    return map;
  }, [sessionOptions]);
  const epicLabels = useMemo(() => {
    const map = new Map<string, string>();
    for (const o of epicOptions) map.set(o.id, o.label);
    return map;
  }, [epicOptions]);

  const draftSessionIds = Object.keys(selectedSessions).filter((k) => selectedSessions[k]);
  const draftEpicIds = Object.keys(selectedEpics).filter((k) => selectedEpics[k]);

  const addGate = async () => {
    const draft = { ref, sessionIds: draftSessionIds, epicIds: draftEpicIds };
    const validationError = validateReleaseGateDraft(draft);
    if (validationError) {
      notify(validationError, 'error');
      return;
    }
    setAdding(true);
    try {
      const res = await api.createDeployReleaseGate(projectId, environmentName, {
        ref: draft.ref.trim() || null,
        sessionIds: draft.sessionIds,
        epicIds: draft.epicIds,
      });
      if (res?.gate) setGates((prev) => [...prev, res.gate]);
      setRef('');
      setSelectedSessions({});
      setSelectedEpics({});
      notify(`Release gate added to ${environmentName}`, 'success');
    } catch (e: any) {
      notify(e?.message || 'Failed to add release gate', 'error');
    } finally {
      setAdding(false);
    }
  };

  const toggleGate = async (gate: DeployReleaseGate) => {
    const key = `toggle:${gate.id}`;
    setActionKey(key);
    try {
      const res = await api.updateDeployReleaseGate(projectId, environmentName, gate.id, {
        enabled: !gate.enabled,
      });
      if (res?.gate) setGates((prev) => prev.map((g) => (g.id === gate.id ? res.gate : g)));
      notify(`Release gate ${!gate.enabled ? 'enabled' : 'disabled'}`, 'success');
    } catch (e: any) {
      notify(e?.message || 'Failed to update release gate', 'error');
    } finally {
      setActionKey(null);
    }
  };

  const deleteGate = async (gate: DeployReleaseGate) => {
    if (
      typeof window !== 'undefined' &&
      !window.confirm(`Delete the release gate "${describeReleaseGate(gate)}"?`)
    ) {
      return;
    }
    const key = `delete:${gate.id}`;
    setActionKey(key);
    try {
      await api.deleteDeployReleaseGate(projectId, environmentName, gate.id);
      setGates((prev) => prev.filter((g) => g.id !== gate.id));
      notify('Release gate deleted', 'success');
    } catch (e: any) {
      notify(e?.message || 'Failed to delete release gate', 'error');
    } finally {
      setActionKey(null);
    }
  };

  const sorted = sortReleaseGates(gates);

  return (
    <div
      className="mt-2 rounded-md border border-gray-800 bg-gray-900/60 p-3"
      data-testid={`env-release-gates-${environmentName}`}
    >
      <div className="mb-2 flex items-center gap-2">
        <Rocket size={13} className="text-fuchsia-300" />
        <span className="text-xs font-semibold text-gray-200">Release gates</span>
      </div>
      <p className="mb-3 text-[11px] leading-relaxed text-gray-500">
        A release gate deploys a ref to <span className="font-mono">{environmentName}</span> once
        every selected session is merged and every selected epic is done — then it is consumed. If a
        selected item is deleted the gate is blocked until you remove it.
      </p>

      {error ? (
        <div className="mb-2 flex items-center gap-2 rounded border border-red-500/40 bg-red-500/10 p-2 text-xs text-red-300">
          <AlertCircle size={13} />
          {error}
        </div>
      ) : null}

      {loading && gates.length === 0 ? (
        <div className="py-3 text-center text-xs text-gray-500">Loading release gates...</div>
      ) : sorted.length === 0 ? (
        <div className="rounded border border-dashed border-gray-800 p-3 text-center text-xs text-gray-500">
          No release gates yet. Add one below.
        </div>
      ) : (
        <div className="space-y-1.5">
          {sorted.map((gate) => (
            <ReleaseGateRow
              key={gate.id}
              gate={gate}
              busyKey={actionKey}
              sessionLabels={sessionLabels}
              epicLabels={epicLabels}
              onToggle={() => toggleGate(gate)}
              onDelete={() => deleteGate(gate)}
            />
          ))}
        </div>
      )}

      <div className="mt-3 space-y-2 border-t border-gray-800 pt-3">
        <input
          type="text"
          value={ref}
          onChange={(e) => setRef(e.target.value)}
          placeholder="ref to deploy (default: main)"
          aria-label="Ref"
          className="w-full rounded border border-gray-700 bg-gray-950 px-2 py-1.5 font-mono text-xs text-gray-200 placeholder:text-gray-600"
        />
        <PickList
          title="Sessions (merge to complete)"
          emptyLabel="No active sessions on the board."
          options={sessionOptions}
          selected={selectedSessions}
          onToggle={(id) => setSelectedSessions((p) => ({ ...p, [id]: !p[id] }))}
          testid="release-gate-session-options"
        />
        <PickList
          title="Epics (all cards done to complete)"
          emptyLabel="No open epics."
          options={epicOptions}
          selected={selectedEpics}
          onToggle={(id) => setSelectedEpics((p) => ({ ...p, [id]: !p[id] }))}
          testid="release-gate-epic-options"
        />
        <button
          type="button"
          onClick={addGate}
          disabled={adding || draftSessionIds.length + draftEpicIds.length === 0}
          className="inline-flex items-center gap-1.5 rounded border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1.5 text-xs text-emerald-200 hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {adding ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
          Add release gate
        </button>
      </div>
    </div>
  );
}

function PickList({
  title,
  emptyLabel,
  options,
  selected,
  onToggle,
  testid,
}: {
  title: string;
  emptyLabel: string;
  options: PickOption[];
  selected: Record<string, boolean>;
  onToggle: (id: string) => void;
  testid: string;
}) {
  return (
    <div>
      <div className="mb-1 text-[11px] font-medium text-gray-400">{title}</div>
      {options.length === 0 ? (
        <div className="rounded border border-dashed border-gray-800 px-2 py-1.5 text-[11px] text-gray-600">
          {emptyLabel}
        </div>
      ) : (
        <div
          data-testid={testid}
          className="max-h-32 space-y-0.5 overflow-y-auto rounded border border-gray-800 bg-gray-950/60 p-1"
        >
          {options.map((o) => (
            <label
              key={o.id}
              className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs text-gray-300 hover:bg-gray-800/70"
            >
              <input
                type="checkbox"
                checked={!!selected[o.id]}
                onChange={() => onToggle(o.id)}
                className="h-3 w-3"
              />
              <span className="truncate">{o.label}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

function SelectionDots({
  items,
  labels,
  kind,
}: {
  items: { id: string; state: ReleaseGateSelectionState }[];
  labels: Map<string, string>;
  kind: string;
}) {
  if (items.length === 0) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {items.map((item) => {
        const label = labels.get(item.id) || item.id;
        const cls =
          item.state === 'complete'
            ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
            : item.state === 'missing'
              ? 'border-red-500/40 bg-red-500/10 text-red-300'
              : 'border-gray-700 bg-gray-900 text-gray-400';
        return (
          <span
            key={`${kind}:${item.id}`}
            title={`${kind}: ${item.state}`}
            className={`inline-flex max-w-[140px] items-center gap-1 truncate rounded border px-1.5 py-0.5 text-[10px] ${cls}`}
          >
            {item.state === 'complete' ? (
              <CheckCircle2 size={9} />
            ) : item.state === 'missing' ? (
              <XCircle size={9} />
            ) : (
              <Circle size={9} />
            )}
            <span className="truncate">{label}</span>
          </span>
        );
      })}
    </div>
  );
}

function ReleaseGateRow({
  gate,
  busyKey,
  sessionLabels,
  epicLabels,
  onToggle,
  onDelete,
}: {
  gate: DeployReleaseGate;
  busyKey: string | null;
  sessionLabels: Map<string, string>;
  epicLabels: Map<string, string>;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const toggleKey = `toggle:${gate.id}`;
  const deleteKey = `delete:${gate.id}`;
  const progressLabel = describeReleaseGateProgress(gate.progress);
  const terminal = gate.status !== 'armed';
  const statusBadge =
    gate.status === 'fired'
      ? { text: 'released', cls: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200' }
      : gate.status === 'failed'
        ? { text: 'failed', cls: 'border-red-500/40 bg-red-500/10 text-red-300' }
        : gate.progress.blocked
          ? { text: 'blocked', cls: 'border-amber-500/40 bg-amber-500/10 text-amber-200' }
          : gate.progress.satisfied
            ? { text: 'ready', cls: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200' }
            : { text: 'waiting', cls: 'border-gray-700 bg-gray-900 text-gray-400' };

  return (
    <div
      data-testid={`release-gate-row-${gate.id}`}
      className={`rounded border p-2 ${
        gate.enabled && !terminal
          ? 'border-gray-800 bg-gray-950/70'
          : 'border-gray-800 bg-gray-950/40 opacity-80'
      }`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center rounded border border-fuchsia-500/30 bg-fuchsia-500/10 px-1.5 py-0.5 font-mono text-[10px] font-medium text-fuchsia-200">
          {gate.ref}
        </span>
        <span
          className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${statusBadge.cls}`}
        >
          {statusBadge.text}
        </span>
        <div className="min-w-0 flex-1 truncate text-[11px] text-gray-400">{progressLabel}</div>
        {!gate.enabled && !terminal ? (
          <span className="text-[10px] uppercase tracking-wide text-gray-500">paused</span>
        ) : null}
        {!terminal ? (
          <button
            type="button"
            onClick={onToggle}
            disabled={busyKey === toggleKey}
            className="inline-flex items-center gap-1 rounded border border-gray-700 px-1.5 py-1 text-[11px] text-gray-300 hover:bg-gray-800 disabled:opacity-50"
            title={gate.enabled ? 'Disable gate' : 'Enable gate'}
            aria-label={`${gate.enabled ? 'Disable' : 'Enable'} ${describeReleaseGate(gate)}`}
          >
            {busyKey === toggleKey ? (
              <Loader2 size={11} className="animate-spin" />
            ) : gate.enabled ? (
              <PowerOff size={11} />
            ) : (
              <Power size={11} />
            )}
            {gate.enabled ? 'Disable' : 'Enable'}
          </button>
        ) : null}
        <button
          type="button"
          onClick={onDelete}
          disabled={busyKey === deleteKey}
          className="inline-flex items-center rounded border border-gray-700 px-1.5 py-1 text-[11px] text-gray-300 hover:bg-gray-800 disabled:opacity-50"
          title="Delete release gate"
          aria-label={`Delete ${describeReleaseGate(gate)}`}
        >
          {busyKey === deleteKey ? (
            <Loader2 size={11} className="animate-spin" />
          ) : (
            <Trash2 size={11} />
          )}
        </button>
      </div>
      <SelectionDots items={gate.progress.sessions} labels={sessionLabels} kind="session" />
      <SelectionDots items={gate.progress.epics} labels={epicLabels} kind="epic" />
      {gate.status === 'failed' && gate.lastError ? (
        <div className="mt-1 truncate text-[10px] text-red-300" title={gate.lastError}>
          {gate.lastError}
        </div>
      ) : null}
      {gate.status === 'fired' && gate.firedDeploymentId ? (
        <div className="mt-1 text-[10px] text-emerald-300/80">
          Released → deployment {gate.firedDeploymentId.slice(0, 8)}
        </div>
      ) : null}
    </div>
  );
}
