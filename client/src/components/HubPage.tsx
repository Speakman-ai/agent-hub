import { useCallback, useState, type ReactNode } from 'react';
import { Bot, PanelRightClose, PanelRightOpen } from 'lucide-react';
import { DEFAULT_HUB_PANE, parseHubPane, type HubWorkspacePane } from '@shared/utils/hub';

export interface HubPageProps {
  pane?: HubWorkspacePane | null;
  onPaneChange: (pane: HubWorkspacePane) => void;
  /** Compact assistant column (desktop) / Assistant tab body (mobile). */
  assistant: ReactNode;
  today: ReactNode;
  org: ReactNode;
  todos: ReactNode;
  reminders: ReactNode;
  calendar: ReactNode;
  mail: ReactNode;
  chat: ReactNode;
  support: ReactNode;
  /** When true, show the Assistant tab in the pane strip (narrow viewports). */
  mobileAssistantTab?: boolean;
  mobileTab?: 'assistant' | HubWorkspacePane;
  onMobileTabChange?: (tab: 'assistant' | HubWorkspacePane) => void;
  /** Clear (and similar) controls on the assistant column header. */
  assistantActions?: ReactNode;
  /** Unread counts shown on pane tabs (e.g. Google Chat). Zero hides the badge. */
  paneBadges?: Partial<Record<HubWorkspacePane, number>>;
  /**
   * The assistant is open as the pinned DM in the Chat pane, so the column
   * steps aside on desktop (the transcript can only be mounted once).
   */
  assistantInWorkspace?: boolean;
}

export const HUB_ASSISTANT_COLLAPSED_KEY = 'agentHub.hubAssistantCollapsed';

function readAssistantCollapsed(): boolean {
  try {
    return window.localStorage.getItem(HUB_ASSISTANT_COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

function writeAssistantCollapsed(collapsed: boolean): void {
  try {
    if (collapsed) window.localStorage.setItem(HUB_ASSISTANT_COLLAPSED_KEY, '1');
    else window.localStorage.removeItem(HUB_ASSISTANT_COLLAPSED_KEY);
  } catch {
    // Storage unavailable (private mode): the toggle still works for this page view.
  }
}

function workspaceBody(
  active: HubWorkspacePane,
  panes: Pick<
    HubPageProps,
    'today' | 'org' | 'todos' | 'reminders' | 'calendar' | 'mail' | 'chat' | 'support'
  >,
): ReactNode {
  switch (active) {
    case 'today':
      return panes.today;
    case 'org':
      return panes.org;
    case 'todos':
      return panes.todos;
    case 'reminders':
      return panes.reminders;
    case 'calendar':
      return panes.calendar;
    case 'mail':
      return panes.mail;
    case 'chat':
      return panes.chat;
    case 'support':
      return panes.support;
    default: {
      const _never: never = active;
      return _never;
    }
  }
}

/**
 * Hub — the org/user home. Workspace panes sit beside the Hub assistant.
 */
export default function HubPage({
  pane,
  onPaneChange: _onPaneChange,
  assistant,
  today,
  org,
  todos,
  reminders,
  calendar,
  mail,
  chat,
  support,
  assistantActions,
  assistantInWorkspace = false,
}: HubPageProps) {
  const [assistantCollapsed, setAssistantCollapsedState] = useState(readAssistantCollapsed);
  const setAssistantCollapsed = useCallback((collapsed: boolean) => {
    setAssistantCollapsedState(collapsed);
    writeAssistantCollapsed(collapsed);
  }, []);
  const workspace = workspaceBody(parseHubPane(pane), {
    today,
    org,
    todos,
    reminders,
    calendar,
    mail,
    chat,
    support,
  });

  return (
    <div className="flex-1 flex min-h-0 min-w-0 overflow-hidden bg-gray-950" data-testid="hub-page">
      <div className="flex-1 flex flex-col min-h-0 min-w-0">
        {assistantCollapsed && !assistantInWorkspace && (
          <div className="hidden lg:flex shrink-0 justify-end border-b border-gray-800 px-3 py-2">
            <button
              type="button"
              data-testid="hub-assistant-open"
              onClick={() => setAssistantCollapsed(false)}
              title="Show assistant"
              aria-label="Show assistant"
              className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-gray-400 hover:text-gray-200 hover:bg-gray-800/60 transition-colors"
            >
              <PanelRightOpen size={13} />
              Assistant
            </button>
          </div>
        )}
        {/* Flex column so pane roots using `flex-1` (org/todos/calendar/mail) get a
            bounded height and can scroll; `h-full` panes (today) still resolve
            against this bounded box. Without `flex`, `flex-1` is inert and pane content
            overflows this `overflow-hidden` wrapper with no scrollbar. */}
        <div className="flex-1 min-h-0 overflow-hidden flex flex-col">{workspace}</div>
      </div>

      <aside
        className={`hidden border-gray-800 bg-gray-950 min-h-0 min-w-0 flex-col ${
          assistantCollapsed || assistantInWorkspace
            ? 'lg:hidden'
            : 'lg:flex lg:w-[min(28rem,40vw)] lg:border-l'
        }`}
        data-testid="hub-assistant-pane"
      >
        <div className="hidden lg:flex shrink-0 items-center gap-2 border-b border-gray-800 px-3 py-2">
          <Bot size={14} className="text-cyan-400" />
          <span className="text-xs font-semibold text-white flex-1">Assistant</span>
          {assistantActions}
          <button
            type="button"
            data-testid="hub-assistant-close"
            onClick={() => setAssistantCollapsed(true)}
            title="Hide assistant"
            aria-label="Hide assistant"
            className="shrink-0 rounded p-1 text-gray-400 hover:text-gray-200 hover:bg-gray-800/60 transition-colors"
          >
            <PanelRightClose size={14} />
          </button>
        </div>
        <div className="flex-1 min-h-0 flex flex-col overflow-hidden">{assistant}</div>
      </aside>
    </div>
  );
}

export { DEFAULT_HUB_PANE };
