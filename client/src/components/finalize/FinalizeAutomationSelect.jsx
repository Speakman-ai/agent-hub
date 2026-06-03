import { useCallback, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { api } from '../../utils/api.js';
import {
  FINALIZE_AUTOMATION_OPTIONS,
  finalizeAutomationFromSession,
  parseFinalizeAutomation,
} from '../../utils/finalizeAutomation.js';

export default function FinalizeAutomationSelect({
  sessionId,
  session,
  disabled = false,
  onError,
  variant = 'default',
}) {
  const level = finalizeAutomationFromSession(session);
  const [pending, setPending] = useState(false);
  const [open, setOpen] = useState(false);

  const handleSelect = useCallback(
    async (nextValue) => {
      if (!sessionId || pending || nextValue === level) {
        setOpen(false);
        return;
      }
      setPending(true);
      try {
        await api.updateSession(sessionId, { finalize_automation: nextValue });
      } catch (err) {
        onError?.(err?.message || 'Failed to update runner automation');
      } finally {
        setPending(false);
        setOpen(false);
      }
    },
    [sessionId, pending, level, onError],
  );

  if (!sessionId) return null;

  const compact = variant === 'compact';
  const selected =
    FINALIZE_AUTOMATION_OPTIONS.find((o) => o.value === level) ?? FINALIZE_AUTOMATION_OPTIONS[0];

  return (
    <div className="relative inline-flex">
      <button
        type="button"
        disabled={disabled || pending}
        aria-haspopup="listbox"
        aria-expanded={open}
        data-testid="finalize-automation-select"
        title={selected.description}
        onClick={() => setOpen((v) => !v)}
        className={
          compact
            ? 'inline-flex items-center gap-1 text-[11px] font-medium px-2 py-1 rounded-md border border-slate-700/70 bg-slate-900/50 text-slate-200 hover:bg-slate-800/70 disabled:opacity-60'
            : 'inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-lg border border-slate-700/70 bg-slate-900/50 text-slate-200 hover:bg-slate-800/70 disabled:opacity-60'
        }
      >
        <span>{selected.label}</span>
        <ChevronDown size={compact ? 12 : 14} className="opacity-70 shrink-0" />
      </button>

      {open ? (
        <>
          <button
            type="button"
            aria-label="Close runner automation menu"
            className="fixed inset-0 z-40 cursor-default"
            onClick={() => setOpen(false)}
          />
          <ul
            role="listbox"
            aria-label="Runner automation"
            className="absolute left-0 bottom-full mb-1 z-50 min-w-[220px] rounded-lg border border-slate-700/80 bg-slate-950 shadow-xl py-1"
          >
            {FINALIZE_AUTOMATION_OPTIONS.map((option) => {
              const active = option.value === parseFinalizeAutomation(level);
              return (
                <li key={option.value}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={active}
                    data-testid={`finalize-automation-option-${option.value}`}
                    onClick={() => handleSelect(option.value)}
                    className={`w-full text-left px-3 py-2 text-xs hover:bg-slate-800/80 ${
                      active ? 'text-indigo-200 bg-indigo-950/40' : 'text-slate-200'
                    }`}
                  >
                    <div className="font-medium">{option.label}</div>
                    <div className="text-[11px] text-slate-500 mt-0.5">{option.description}</div>
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
    </div>
  );
}
