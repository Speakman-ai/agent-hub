import { MessageSquare, Palette } from 'lucide-react';

/**
 * SessionModePicker — the `session_mode` segmented control (Chat | Design) that
 * sits alongside the model / Finalize controls in the chat header. Selecting
 * `Design` puts the session into design mode (the server loads the design skill
 * and the client renders the in-session canvas pane); `Chat` is normal build.
 *
 * Design mode requires an isolated worktree — the server rejects `PUT /mode`
 * with `design_mode_requires_worktree` for a worktree-less session. We mirror
 * that here by disabling the Design button (with an explanatory tooltip) when
 * `canDesign` is false, so the control never offers a mode the session can't run.
 *
 * Purely presentational / controlled: the parent owns the value and persists
 * the change (api.setSessionMode) in `onChange`.
 *
 * Props:
 *   - mode:      current session mode ('chat' | 'design').
 *   - canDesign: whether design mode is selectable (session has a worktree).
 *   - disabled:  disable the whole control (e.g. while a switch is in flight).
 *   - onChange(nextMode): called with the chosen mode when it actually changes.
 */
export default function SessionModePicker({
  mode = 'chat',
  canDesign = false,
  disabled = false,
  onChange,
}) {
  const current = mode === 'design' ? 'design' : 'chat';

  const select = (next) => {
    if (disabled) return;
    if (next === current) return;
    if (next === 'design' && !canDesign) return;
    onChange?.(next);
  };

  const baseBtn =
    'flex items-center gap-1 px-2 py-1 text-[11px] rounded-md transition-colors border';
  const activeBtn = 'bg-gray-800 text-white border-gray-600';
  const idleBtn = 'bg-transparent text-gray-400 border-transparent hover:text-gray-100';

  return (
    <div
      className="hidden sm:inline-flex items-center gap-0.5 rounded-lg border border-gray-800 bg-gray-900/60 p-0.5"
      role="group"
      aria-label="Session mode"
      data-testid="session-mode-picker"
    >
      <button
        type="button"
        onClick={() => select('chat')}
        disabled={disabled}
        aria-pressed={current === 'chat'}
        className={`${baseBtn} ${current === 'chat' ? activeBtn : idleBtn} ${
          disabled ? 'opacity-50 cursor-not-allowed' : ''
        }`}
        title="Chat / build mode"
        data-testid="session-mode-chat"
      >
        <MessageSquare size={12} />
        <span>Chat</span>
      </button>
      <button
        type="button"
        onClick={() => select('design')}
        disabled={disabled || !canDesign}
        aria-pressed={current === 'design'}
        className={`${baseBtn} ${current === 'design' ? activeBtn : idleBtn} ${
          disabled || !canDesign ? 'opacity-50 cursor-not-allowed' : ''
        }`}
        title={
          canDesign
            ? 'Design mode — iterate on a live canvas, artifacts carry over to build'
            : 'Design mode needs a session with an isolated worktree'
        }
        data-testid="session-mode-design"
      >
        <Palette size={12} />
        <span>Design</span>
      </button>
    </div>
  );
}
