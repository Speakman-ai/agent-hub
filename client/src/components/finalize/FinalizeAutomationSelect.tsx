import { useCallback, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { api } from '../../utils/api';
import {
  SESSION_CONTROL_OPTIONS,
  finalizeAutomationFromSession,
  sessionControlPatch,
  sessionControlOptionsForProject,
  sessionControlValueForProject,
} from '../../utils/finalizeAutomation';
import { sessionControlIcon } from '../../utils/sessionControlIcons';
import {
  sessionActionControlClass,
  sessionActionSubmenuClass,
} from '../../utils/sessionActionMenu';

function SessionControlIcon({
  value,
  size = 14,
  className = '',
}: {
  value: string;
  size?: number;
  className?: string;
}) {
  const Icon = sessionControlIcon(value);
  if (!Icon) return null;
  return <Icon size={size} className={`shrink-0 ${className}`} aria-hidden />;
}

/**
 * FinalizeAutomationSelect — the single "what is this session doing" dropdown.
 *
 * It folds session mode and finalize automation into one mutually-exclusive control:
 *   - session_mode === 'design'  → Design (no ship at all; live canvas)
 *   - session_mode === 'consult' → Consult (Hub-only; no code ship or Finalize)
 *   - finalize_automation level  → Build / Build and Review / Build and Push / Auto Merge
 *
 * Design and Consult sit at the no-ship end of the gradient. They are mutually
 * exclusive with the ship levels by construction: picking Design or Consult clears
 * any ship intent, and picking a ship level drops the session out of those modes first.
 */
export default function FinalizeAutomationSelect({
  sessionId,
  session,
  agent,
  project = null,
  disabled = false,
  legacyAskMode = false,
  onControlChange,
  onError,
  variant = 'default',
}: any) {
  const level = finalizeAutomationFromSession(session);
  const sessionMode =
    session?.session_mode === 'design'
      ? 'design'
      : session?.session_mode === 'scoping'
        ? 'scoping'
        : session?.session_mode === 'skill-builder'
          ? 'skill-builder'
          : session?.session_mode === 'consult'
            ? 'consult'
            : session?.session_mode === 'isolated'
              ? 'isolated'
              : 'chat';
  // Design mode runs when the session has an isolated worktree (dev projects) OR
  // the project is workflow/no-code (artifacts go to the Hub data-dir store). The
  // server's `can_design_mode` covers the worktree arm; we OR in the workflow arm
  // here since the picker already has `project` and broadcast-sourced rows can
  // carry a stale (worktree-only) capability. The server mode routes still enforce.
  const canDesign = !!session?.can_design_mode || project?.mode === 'workflow';
  const [pending, setPending] = useState(false);
  const [open, setOpen] = useState(false);

  const handleSelect = useCallback(
    async (nextValue: any) => {
      if (nextValue === 'design' && !canDesign) {
        setOpen(false);
        return;
      }
      // Collapse the (possibly multi-axis) change into ONE patch so it is applied
      // atomically server-side. This is what prevents a partial commit — e.g.
      // entering Design from `merge` clears ship intent AND switches the mode in
      // a single transaction, so a failed worktree check can't drop the merge
      // intent while leaving the user in chat.
      const patch = sessionControlPatch(
        { sessionMode, askMode: legacyAskMode, automation: level },
        nextValue,
        { project },
      );
      if (!sessionId || pending || patch === null) {
        setOpen(false);
        return;
      }
      setPending(true);
      try {
        if (onControlChange) await onControlChange(patch);
        else await api.updateSession(sessionId, patch);
      } catch (err: any) {
        onError?.(err?.message || 'Failed to update session mode');
      } finally {
        setPending(false);
        setOpen(false);
      }
    },
    [
      sessionId,
      pending,
      sessionMode,
      canDesign,
      legacyAskMode,
      level,
      project,
      onControlChange,
      onError,
    ],
  );

  if (!sessionId) return null;

  const compact = variant === 'compact';
  const isMenu = variant === 'menu';
  const selectedValue = sessionControlValueForProject(project, {
    sessionMode,
    askMode: legacyAskMode,
    automation: level,
  });
  // The currently-active label is resolved against the FULL list so a session
  // already in skill-builder mode still renders correctly even on an ineligible
  // agent; the dropdown itself only OFFERS the options the agent/project allow.
  const optionList = sessionControlOptionsForProject(project, agent, {
    canUseVm: session?.can_isolated_mode === true,
  });
  const selected =
    SESSION_CONTROL_OPTIONS.find((o: any) => o.value === selectedValue) ??
    optionList[0] ??
    SESSION_CONTROL_OPTIONS[2];

  return (
    <div
      className={
        isMenu
          ? 'relative w-full'
          : 'relative flex w-[150px] min-w-[150px] shrink-0 sm:inline-flex sm:w-auto sm:min-w-0'
      }
    >
      <button
        type="button"
        disabled={disabled || pending}
        aria-haspopup="listbox"
        aria-expanded={open}
        data-testid="finalize-automation-select"
        title={selected.description}
        onClick={() => setOpen((v: any) => !v)}
        className={
          isMenu
            ? sessionActionControlClass('menu')
            : compact
              ? 'flex w-full justify-center items-center gap-1 text-[11px] font-medium px-2 py-1 rounded-md border border-slate-700/70 bg-slate-900/50 text-slate-200 hover:bg-slate-800/70 disabled:opacity-60 sm:w-auto sm:inline-flex'
              : 'flex w-full justify-center items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-lg border border-slate-700/70 bg-slate-900/50 text-slate-200 hover:bg-slate-800/70 disabled:opacity-60 sm:w-auto sm:inline-flex'
        }
      >
        <SessionControlIcon value={selectedValue} size={compact ? 12 : 14} className="opacity-80" />
        <span>{selected.label}</span>
        <ChevronDown size={compact ? 12 : 14} className="opacity-70 shrink-0" />
      </button>

      {open ? (
        <>
          {!isMenu ? (
            <button
              type="button"
              aria-label="Close runner automation menu"
              className="fixed inset-0 z-40 cursor-default"
              onClick={() => setOpen(false)}
            />
          ) : null}
          <ul
            role="listbox"
            aria-label="Runner automation"
            className={sessionActionSubmenuClass(
              isMenu ? 'menu' : 'toolbar',
              'absolute left-0 bottom-full mb-1 z-50 min-w-[220px] max-h-[min(70vh,20rem)] overflow-y-auto overscroll-contain rounded-lg border border-slate-700/80 bg-slate-950 shadow-xl py-1',
            )}
          >
            {optionList.map((option: any) => {
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
                    <div className="flex items-start gap-2">
                      <SessionControlIcon
                        value={option.value}
                        size={14}
                        className={`mt-0.5 ${active ? 'text-indigo-300' : 'text-slate-400'}`}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="font-medium">{option.label}</div>
                        <div className="text-[11px] text-slate-500 mt-0.5">
                          {optionDisabled
                            ? 'Needs a session with an isolated worktree'
                            : option.description}
                        </div>
                      </div>
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
