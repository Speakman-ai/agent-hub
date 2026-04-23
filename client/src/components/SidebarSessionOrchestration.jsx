import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Gauge, Loader2, Save } from 'lucide-react';
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
 * Active chat session: optional outer PAV controls (left sidebar).
 */
export default function SidebarSessionOrchestration({ session, onOrchestrationSave, showToast }) {
  const prevSessionIdRef = useRef(session?.id);
  const [orchOpen, setOrchOpen] = useState(false);
  const [orchPhase, setOrchPhase] = useState('');
  const [orchMeta, setOrchMeta] = useState('');
  const [orchDirty, setOrchDirty] = useState(false);
  const [orchSaving, setOrchSaving] = useState(false);

  useEffect(() => {
    const id = session?.id;
    const idChanged = id !== prevSessionIdRef.current;
    if (idChanged) prevSessionIdRef.current = id;

    if (idChanged || !orchDirty) {
      setOrchPhase(session?.orchestration_phase || '');
      setOrchMeta(orchestrationMetaTextFromSession(session));
      if (idChanged) setOrchDirty(false);
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

  const toggleOrch = useCallback(() => setOrchOpen((o) => !o), []);

  if (!session?.id || !onOrchestrationSave) return null;

  return (
    <div className="mt-4 border-t border-gray-800/80 pt-3 px-2 pb-2">
      <button
        type="button"
        onClick={toggleOrch}
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
  );
}
