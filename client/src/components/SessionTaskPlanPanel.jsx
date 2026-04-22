import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  ClipboardList,
  Gauge,
  Loader2,
  Save,
  Trash2,
} from 'lucide-react';
import { parseTaskStateFromSession, taskStateFormHasContent } from '../utils/sessionTaskState.js';
import {
  orchestrationMetaTextFromSession,
  parseOrchestrationMetaForSave,
} from '../utils/sessionOrchestration.js';

const ORCH_PHASES = [
  { value: '', label: '(unset)' },
  { value: 'planning', label: 'planning' },
  { value: 'acting', label: 'acting' },
  { value: 'verifying', label: 'verifying' },
  { value: 'done', label: 'done' },
  { value: 'escalated', label: 'escalated' },
];

function newRowKey() {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `row-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function checklistWithKeys(rows) {
  const withText = rows.filter((c) => c.text?.trim()).length > 0;
  const base = withText ? rows : [{ text: '', done: false }];
  return base.map((c) => ({ text: c.text || '', done: !!c.done, rowKey: newRowKey() }));
}

/**
 * Persisted goal / checklist / last failure for long-running sessions (stored in SQLite).
 */
export default function SessionTaskPlanPanel({ session, onSave, onOrchestrationSave, showToast }) {
  const prevSessionIdRef = useRef(session?.id);
  const [dirty, setDirty] = useState(false);
  const [goal, setGoal] = useState('');
  const [lastFailure, setLastFailure] = useState('');
  const [checklist, setChecklist] = useState(() => [
    { text: '', done: false, rowKey: newRowKey() },
  ]);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [orchPhase, setOrchPhase] = useState('');
  const [orchMeta, setOrchMeta] = useState('');
  const [orchDirty, setOrchDirty] = useState(false);
  const [orchSaving, setOrchSaving] = useState(false);

  useEffect(() => {
    const id = session?.id;
    const idChanged = id !== prevSessionIdRef.current;
    if (idChanged) prevSessionIdRef.current = id;

    // Always hydrate when switching sessions. Otherwise only pull server state
    // when the user is not mid-edit (avoids `session-updated` wiping drafts).
    if (idChanged || !dirty) {
      const next = parseTaskStateFromSession(session);
      setGoal(next.goal);
      setLastFailure(next.lastFailure);
      setChecklist(checklistWithKeys(next.checklist));
      if (taskStateFormHasContent(next)) setOpen(true);
      if (idChanged) setDirty(false);
    }
    if (idChanged || !orchDirty) {
      setOrchPhase(session?.orchestration_phase || '');
      setOrchMeta(orchestrationMetaTextFromSession(session));
      if (idChanged) setOrchDirty(false);
    }
  }, [session, dirty, orchDirty]);

  const buildPayload = useCallback(() => {
    const items = checklist
      .map((c) => ({ text: (c.text || '').trim(), done: !!c.done }))
      .filter((c) => c.text);
    const body = {};
    if (goal.trim()) body.goal = goal.trim();
    if (items.length) body.checklist = items;
    if (lastFailure.trim()) body.lastFailure = lastFailure.trim();
    return body;
  }, [goal, lastFailure, checklist]);

  const handleSave = async () => {
    const body = buildPayload();
    setSaving(true);
    try {
      await onSave(Object.keys(body).length ? body : null);
      setDirty(false);
      if (showToast) showToast('Task plan saved', 'success', 3000);
    } catch (e) {
      if (showToast) showToast(e?.message || 'Save failed', 'error', 5000);
    } finally {
      setSaving(false);
    }
  };

  const handleSaveOrchestration = async () => {
    if (!onOrchestrationSave) return;
    const parsedMeta = parseOrchestrationMetaForSave(orchMeta);
    if (!parsedMeta.ok) {
      const msg =
        parsedMeta.reason === 'invalid_json'
          ? 'Orchestration meta must be valid JSON'
          : 'Orchestration meta must be a JSON object';
      if (showToast) showToast(msg, 'error', 5000);
      return;
    }
    const metaPayload = parsedMeta.meta;
    const phasePayload = orchPhase === '' ? null : orchPhase;
    setOrchSaving(true);
    try {
      await onOrchestrationSave({ phase: phasePayload, meta: metaPayload });
      setOrchDirty(false);
      if (showToast) showToast('Orchestration saved', 'success', 3000);
    } catch (e) {
      if (showToast) showToast(e?.message || 'Orchestration save failed', 'error', 5000);
    } finally {
      setOrchSaving(false);
    }
  };

  const handleClear = async () => {
    setSaving(true);
    try {
      await onSave(null);
      setGoal('');
      setLastFailure('');
      setChecklist([{ text: '', done: false, rowKey: newRowKey() }]);
      setDirty(false);
      if (showToast) showToast('Task plan cleared', 'success', 3000);
    } catch (e) {
      if (showToast) showToast(e?.message || 'Clear failed', 'error', 5000);
    } finally {
      setSaving(false);
    }
  };

  const addItem = () =>
    setChecklist((prev) => [...prev, { text: '', done: false, rowKey: newRowKey() }]);
  const removeItem = (rowKey) =>
    setChecklist((prev) => (prev.length <= 1 ? prev : prev.filter((row) => row.rowKey !== rowKey)));

  return (
    <div className="px-3 md:px-0 mb-3 max-w-[95%] sm:max-w-[90%] mx-auto">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2 text-left text-xs font-semibold text-gray-300 hover:text-white border border-gray-700/80 rounded-lg px-3 py-2 bg-gray-900/40"
      >
        {open ? (
          <ChevronDown className="w-4 h-4 shrink-0" />
        ) : (
          <ChevronRight className="w-4 h-4 shrink-0" />
        )}
        <ClipboardList className="w-4 h-4 text-sky-400 shrink-0" />
        <span>Persisted task plan</span>
        <span className="text-gray-500 font-normal ml-auto">survives refresh &amp; handoff</span>
      </button>
      {open && (
        <div className="mt-2 rounded-lg border border-gray-700/80 bg-gray-950/50 p-3 space-y-3">
          <p className="text-[11px] text-gray-500 leading-relaxed">
            Shown in the agent system prompt. The model can also set this with a{' '}
            <code className="text-gray-400">&lt;agenthub:task-state&gt;</code> JSON block.
          </p>
          {onOrchestrationSave ? (
            <div className="rounded-md border border-gray-700/60 bg-gray-900/30 p-3 space-y-2">
              <div className="flex items-center gap-2 text-[11px] font-semibold text-gray-300">
                <Gauge className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                Outer orchestration (PAV)
              </div>
              <p className="text-[11px] text-gray-500 leading-relaxed">
                Host-tracked macro phase + optional JSON metadata — appended to the system prompt.
                Update via <code className="text-gray-400">PUT /sessions/…/orchestration</code>.
              </p>
              <div className="flex flex-col sm:flex-row gap-2">
                <label className="flex-1 block text-[11px] font-medium text-gray-400 mb-1">
                  Phase
                  <select
                    value={orchPhase}
                    onChange={(e) => {
                      setOrchDirty(true);
                      setOrchPhase(e.target.value);
                    }}
                    className="mt-1 w-full text-sm bg-gray-900 border border-gray-700 rounded-md px-2 py-1.5 text-gray-200 focus:outline-none focus:ring-1 focus:ring-amber-500/50"
                  >
                    {ORCH_PHASES.map((o) => (
                      <option key={o.value || 'unset'} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div>
                <label className="block text-[11px] font-medium text-gray-400 mb-1">
                  Metadata (JSON object)
                </label>
                <textarea
                  value={orchMeta}
                  onChange={(e) => {
                    setOrchDirty(true);
                    setOrchMeta(e.target.value);
                  }}
                  rows={3}
                  spellCheck={false}
                  className="w-full text-xs font-mono bg-gray-900 border border-gray-700 rounded-md px-2 py-1.5 text-gray-200 placeholder:text-gray-600 focus:outline-none focus:ring-1 focus:ring-amber-500/50"
                  placeholder={'{}'}
                />
              </div>
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={() => void handleSaveOrchestration()}
                  disabled={orchSaving}
                  className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md bg-amber-700/90 hover:bg-amber-600 text-white disabled:opacity-50"
                >
                  {orchSaving ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Save className="w-3.5 h-3.5" />
                  )}
                  Save orchestration
                </button>
              </div>
            </div>
          ) : null}
          <div>
            <label className="block text-[11px] font-medium text-gray-400 mb-1">Goal</label>
            <textarea
              value={goal}
              onChange={(e) => {
                setDirty(true);
                setGoal(e.target.value);
              }}
              rows={2}
              className="w-full text-sm bg-gray-900 border border-gray-700 rounded-md px-2 py-1.5 text-gray-200 placeholder:text-gray-600 focus:outline-none focus:ring-1 focus:ring-sky-500/50"
              placeholder="Current objective…"
            />
          </div>
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-[11px] font-medium text-gray-400">Checklist</label>
              <button
                type="button"
                onClick={() => {
                  setDirty(true);
                  addItem();
                }}
                className="text-[11px] text-sky-400 hover:text-sky-300"
              >
                + Add item
              </button>
            </div>
            <ul className="space-y-2">
              {checklist.map((item) => (
                <li key={item.rowKey} className="flex gap-2 items-start">
                  <label className="flex items-center pt-2 shrink-0 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={!!item.done}
                      onChange={(e) => {
                        setDirty(true);
                        const v = e.target.checked;
                        setChecklist((prev) =>
                          prev.map((c) => (c.rowKey === item.rowKey ? { ...c, done: v } : c)),
                        );
                      }}
                      className="rounded border-gray-600"
                    />
                  </label>
                  <input
                    value={item.text}
                    onChange={(e) => {
                      setDirty(true);
                      const v = e.target.value;
                      setChecklist((prev) =>
                        prev.map((c) => (c.rowKey === item.rowKey ? { ...c, text: v } : c)),
                      );
                    }}
                    className="flex-1 text-sm bg-gray-900 border border-gray-700 rounded-md px-2 py-1.5 text-gray-200 placeholder:text-gray-600 focus:outline-none focus:ring-1 focus:ring-sky-500/50"
                    placeholder="Step…"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      setDirty(true);
                      removeItem(item.rowKey);
                    }}
                    className="text-gray-500 hover:text-red-400 p-1.5 shrink-0"
                    aria-label="Remove checklist item"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <label className="block text-[11px] font-medium text-gray-400 mb-1">Last failure</label>
            <textarea
              value={lastFailure}
              onChange={(e) => {
                setDirty(true);
                setLastFailure(e.target.value);
              }}
              rows={2}
              className="w-full text-sm bg-gray-900 border border-gray-700 rounded-md px-2 py-1.5 text-gray-200 placeholder:text-gray-600 focus:outline-none focus:ring-1 focus:ring-sky-500/50"
              placeholder="Most recent blocker (optional)…"
            />
          </div>
          <div className="flex flex-wrap gap-2 justify-end">
            <button
              type="button"
              onClick={handleClear}
              disabled={saving}
              className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md border border-gray-600 text-gray-300 hover:bg-gray-800 disabled:opacity-50"
            >
              Clear all
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md bg-sky-600 hover:bg-sky-500 text-white disabled:opacity-50"
            >
              {saving ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Save className="w-3.5 h-3.5" />
              )}
              Save
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
