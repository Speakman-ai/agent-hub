import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, ClipboardList, Gauge, Loader2, Save } from 'lucide-react';
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

/**
 * Active chat session: read-only agent-maintained task plan + optional outer PAV controls.
 * Shown in the left sidebar (not above the transcript).
 */
export default function SidebarSessionTaskPlan({ session, onOrchestrationSave, showToast }) {
  const prevSessionIdRef = useRef(session?.id);
  const [taskOpen, setTaskOpen] = useState(true);
  const [orchOpen, setOrchOpen] = useState(false);
  const [orchPhase, setOrchPhase] = useState('');
  const [orchMeta, setOrchMeta] = useState('');
  const [orchDirty, setOrchDirty] = useState(false);
  const [orchSaving, setOrchSaving] = useState(false);

  const parsed = parseTaskStateFromSession(session);
  const hasTask = taskStateFormHasContent(parsed);

  useEffect(() => {
    const id = session?.id;
    const idChanged = id !== prevSessionIdRef.current;
    if (idChanged) prevSessionIdRef.current = id;

    if (idChanged || !orchDirty) {
      setOrchPhase(session?.orchestration_phase || '');
      setOrchMeta(orchestrationMetaTextFromSession(session));
      if (idChanged) setOrchDirty(false);
    }

    const next = parseTaskStateFromSession(session);
    const has = taskStateFormHasContent(next);
    if (idChanged) {
      setTaskOpen(has);
    } else if (has) {
      setTaskOpen(true);
    }
  }, [session, orchDirty]);

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

  const toggleTask = useCallback(() => setTaskOpen((o) => !o), []);

  if (!session?.id) return null;

  return (
    <div className="mt-4 border-t border-gray-800/80 pt-3">
      <button
        type="button"
        onClick={toggleTask}
        className="w-full flex items-center gap-2 text-left text-xs font-semibold text-gray-300 hover:text-white px-2 py-1.5 rounded-md hover:bg-gray-800/40"
      >
        {taskOpen ? (
          <ChevronDown className="w-3.5 h-3.5 shrink-0 text-gray-500" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 shrink-0 text-gray-500" />
        )}
        <ClipboardList className="w-3.5 h-3.5 text-sky-400 shrink-0" />
        <span>Task plan</span>
        <span className="text-gray-600 font-normal text-[10px] ml-auto">agent</span>
      </button>
      {taskOpen && (
        <div className="mt-1.5 px-2 pb-2 space-y-2">
          {!hasTask ? (
            <p className="text-[11px] text-gray-500 leading-relaxed">
              The model maintains this automatically. It will appear here after the first
              <code className="text-gray-500 mx-0.5">&lt;agenthub:task-state&gt;</code> update.
            </p>
          ) : (
            <>
              {parsed.goal ? (
                <div>
                  <div className="text-[10px] font-medium text-gray-500 uppercase tracking-wide mb-0.5">
                    Goal
                  </div>
                  <p className="text-xs text-gray-200 whitespace-pre-wrap break-words">
                    {parsed.goal}
                  </p>
                </div>
              ) : null}
              {parsed.checklist?.length > 0 ? (
                <div>
                  <div className="text-[10px] font-medium text-gray-500 uppercase tracking-wide mb-1">
                    Checklist
                  </div>
                  <ul className="space-y-1">
                    {parsed.checklist.map((item, i) => (
                      <li
                        key={`chk-${i}-${item.done ? '1' : '0'}-${item.text.slice(0, 96)}`}
                        className="flex gap-2 text-xs text-gray-300"
                      >
                        <span
                          className={
                            item.done
                              ? 'text-emerald-500 shrink-0 line-through opacity-70'
                              : 'text-gray-600 shrink-0'
                          }
                          aria-hidden
                        >
                          {item.done ? '✓' : '○'}
                        </span>
                        <span className={item.done ? 'line-through text-gray-500' : ''}>
                          {item.text}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {parsed.lastFailure ? (
                <div>
                  <div className="text-[10px] font-medium text-amber-600/90 uppercase tracking-wide mb-0.5">
                    Blocker
                  </div>
                  <p className="text-xs text-amber-100/90 whitespace-pre-wrap break-words">
                    {parsed.lastFailure}
                  </p>
                </div>
              ) : null}
            </>
          )}
        </div>
      )}

      {onOrchestrationSave ? (
        <div className="px-2 pb-2">
          <button
            type="button"
            onClick={() => setOrchOpen((o) => !o)}
            className="w-full flex items-center gap-2 text-left text-[11px] font-medium text-gray-500 hover:text-gray-300 py-1"
          >
            {orchOpen ? (
              <ChevronDown className="w-3 h-3 shrink-0" />
            ) : (
              <ChevronRight className="w-3 h-3 shrink-0" />
            )}
            <Gauge className="w-3 h-3 text-amber-500/80 shrink-0" />
            <span>Outer orchestration</span>
          </button>
          {orchOpen && (
            <div className="mt-2 rounded-md border border-gray-700/60 bg-gray-900/40 p-2 space-y-2">
              <p className="text-[10px] text-gray-500 leading-relaxed">
                Macro phase + JSON metadata (optional). Same as{' '}
                <code className="text-gray-500">PUT /sessions/…/orchestration</code>.
              </p>
              <label className="block text-[10px] font-medium text-gray-500">
                Phase
                <select
                  value={orchPhase}
                  onChange={(e) => {
                    setOrchDirty(true);
                    setOrchPhase(e.target.value);
                  }}
                  className="mt-0.5 w-full text-xs bg-gray-900 border border-gray-700 rounded px-2 py-1 text-gray-200 focus:outline-none focus:ring-1 focus:ring-amber-500/40"
                >
                  {ORCH_PHASES.map((o) => (
                    <option key={o.value || 'unset'} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-[10px] font-medium text-gray-500">
                Metadata (JSON)
                <textarea
                  value={orchMeta}
                  onChange={(e) => {
                    setOrchDirty(true);
                    setOrchMeta(e.target.value);
                  }}
                  rows={3}
                  spellCheck={false}
                  className="mt-0.5 w-full text-[10px] font-mono bg-gray-900 border border-gray-700 rounded px-2 py-1 text-gray-200 placeholder:text-gray-600 focus:outline-none focus:ring-1 focus:ring-amber-500/40"
                  placeholder="{}"
                />
              </label>
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={() => void handleSaveOrchestration()}
                  disabled={orchSaving}
                  className="inline-flex items-center gap-1 text-[10px] px-2 py-1 rounded bg-amber-700/90 hover:bg-amber-600 text-white disabled:opacity-50"
                >
                  {orchSaving ? (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  ) : (
                    <Save className="w-3 h-3" />
                  )}
                  Save
                </button>
              </div>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
