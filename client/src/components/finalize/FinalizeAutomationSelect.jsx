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
  askMode = false,
  onAskModeChange,
  onError,
  variant = 'default',
}) {
  const level = finalizeAutomationFromSession(session);
  const [pending, setPending] = useState(false);
  const [open, setOpen] = useState(false);
  const options = [
    {
      value: 'ask',
      label: 'Ask',
      description: 'Read-only planning mode, using the selected CLI engine ask mode',
    },
    ...FINALIZE_AUTOMATION_OPTIONS,
  ];

  const handleSelect = useCallback(
    async (nextValue) => {
      const selectingAsk = nextValue === 'ask';
      const selectedValue = askMode ? 'ask' : level;
      if (!sessionId || pending || nextValue === selectedValue) {
        setOpen(false);
        return;
      }
      setPending(true);
      try {
        const setAskMode = async (enabled) => {
          if (onAskModeChange) {
            await onAskModeChange(enabled);
          } else {
            await api.setSessionAskMode(sessionId, enabled);
          }
        };
        if (selectingAsk) {
          await setAskMode(true);
        } else {
          if (askMode) {
            await setAskMode(false);
          }
          if (nextValue !== level) {
            await api.updateSession(sessionId, { finalize_automation: nextValue });
          }
        }
      } catch (err) {
        onError?.(err?.message || 'Failed to update session mode');
      } finally {
        setPending(false);
        setOpen(false);
      }
    },
    [sessionId, pending, askMode, level, onAskModeChange, onError],
  );

  if (!sessionId) return null;

  const compact = variant === 'compact';
  const selected =
    (askMode ? options[0] : FINALIZE_AUTOMATION_OPTIONS.find((o) => o.value === level)) ??
    FINALIZE_AUTOMATION_OPTIONS[0];

  return (
    <div className="relative flex w-[150px] min-w-[150px] shrink-0 sm:inline-flex sm:w-auto sm:min-w-0">
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
            ? 'flex w-full justify-center items-center gap-1 text-[11px] font-medium px-2 py-1 rounded-md border border-slate-700/70 bg-slate-900/50 text-slate-200 hover:bg-slate-800/70 disabled:opacity-60 sm:w-auto sm:inline-flex'
            : 'flex w-full justify-center items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-lg border border-slate-700/70 bg-slate-900/50 text-slate-200 hover:bg-slate-800/70 disabled:opacity-60 sm:w-auto sm:inline-flex'
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
            {options.map((option) => {
              const active = askMode
                ? option.value === 'ask'
                : option.value === parseFinalizeAutomation(level);
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
