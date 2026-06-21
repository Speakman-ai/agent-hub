import { useCallback, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { api } from '../../utils/api.js';
import {
  SESSION_CONTROL_OPTIONS,
  finalizeAutomationFromSession,
  sessionControlValue,
  sessionControlPatch,
} from '../../utils/finalizeAutomation.js';

/**
 * FinalizeAutomationSelect — the single "what is this session doing" dropdown.
 *
 * It folds three orthogonal session axes into one mutually-exclusive control:
 *   - session_mode === 'design'  → Design (no ship at all; live canvas)
 *   - ask_mode === true          → Ask (read-only planning)
 *   - finalize_automation level  → Build / Build and Review / Build and Push / Auto Merge
 *
 * Design sits at the top as the no-ship end of the gradient. It is mutually
 * exclusive with the ship levels by construction: picking Design clears any
 * ship intent, and picking a ship level (or Ask) drops the session out of
 * design mode first.
 */
export default function FinalizeAutomationSelect({
  sessionId,
  session,
  disabled = false,
  askMode = false,
  onControlChange,
  onError,
  variant = 'default',
}) {
  const level = finalizeAutomationFromSession(session);
  const sessionMode = session?.session_mode === 'design' ? 'design' : 'chat';
  const canDesign = !!session?.can_design_mode;
  const [pending, setPending] = useState(false);
  const [open, setOpen] = useState(false);

  const handleSelect = useCallback(
    async (nextValue) => {
      if (nextValue === 'design' && !canDesign) {
        setOpen(false);
        return;
      }
      // Collapse the (possibly multi-axis) change into ONE patch so it is applied
      // atomically server-side. This is what prevents a partial commit — e.g.
      // entering Design from `merge` clears ship intent AND switches the mode in
      // a single transaction, so a failed worktree check can't drop the merge
      // intent while leaving the user in chat.
      const patch = sessionControlPatch({ sessionMode, askMode, automation: level }, nextValue);
      if (!sessionId || pending || patch === null) {
        setOpen(false);
        return;
      }
      setPending(true);
      try {
        if (onControlChange) await onControlChange(patch);
        else await api.updateSession(sessionId, patch);
      } catch (err) {
        onError?.(err?.message || 'Failed to update session mode');
      } finally {
        setPending(false);
        setOpen(false);
      }
    },
    [sessionId, pending, sessionMode, canDesign, askMode, level, onControlChange, onError],
  );

  if (!sessionId) return null;

  const compact = variant === 'compact';
  const selectedValue = sessionControlValue({ sessionMode, askMode, automation: level });
  const selected =
    SESSION_CONTROL_OPTIONS.find((o) => o.value === selectedValue) ?? SESSION_CONTROL_OPTIONS[2];

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
            {SESSION_CONTROL_OPTIONS.map((option) => {
              const active = option.value === selectedValue;
              const optionDisabled = option.value === 'design' && !canDesign;
              return (
                <li key={option.value}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={active}
                    disabled={optionDisabled}
                    title={
                      optionDisabled
                        ? 'Design mode needs a session with an isolated worktree'
                        : option.description
                    }
                    data-testid={`finalize-automation-option-${option.value}`}
                    onClick={() => handleSelect(option.value)}
                    className={`w-full text-left px-3 py-2 text-xs hover:bg-slate-800/80 ${
                      optionDisabled ? 'opacity-40 cursor-not-allowed hover:bg-transparent' : ''
                    } ${active ? 'text-indigo-200 bg-indigo-950/40' : 'text-slate-200'}`}
                  >
                    <div className="font-medium">{option.label}</div>
                    <div className="text-[11px] text-slate-500 mt-0.5">
                      {optionDisabled
                        ? 'Needs a session with an isolated worktree'
                        : option.description}
                    </div>
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
