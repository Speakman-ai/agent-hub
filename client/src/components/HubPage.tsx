import { useCallback, useState, type ReactNode } from 'react';
import {
  BarChart3,
  Bot,
  Briefcase,
  CalendarDays,
  LifeBuoy,
  ListTodo,
  Mail,
  MessagesSquare,
  PanelRightClose,
  PanelRightOpen,
  ScrollText,
} from 'lucide-react';
import BrandLogo from './BrandLogo';
import { formatUnreadCount } from '../utils/googleChatPush';
import {
  DEFAULT_HUB_PANE,
  HUB_WORKSPACE_PANES,
  parseHubPane,
  type HubWorkspacePane,
} from '@shared/utils/hub';

const PANE_META: Record<
  HubWorkspacePane,
  { label: string; icon: typeof Briefcase; testId: string }
> = {
  today: { label: 'Dashboard', icon: Briefcase, testId: 'hub-pane-today' },
  summary: { label: 'Daily Summary', icon: ScrollText, testId: 'hub-pane-summary' },
  org: { label: 'Org', icon: BarChart3, testId: 'hub-pane-org' },
  todos: { label: 'Todos', icon: ListTodo, testId: 'hub-pane-todos' },
  calendar: { label: 'Calendar', icon: CalendarDays, testId: 'hub-pane-calendar' },
  mail: { label: 'Mail', icon: Mail, testId: 'hub-pane-mail' },
  chat: { label: 'Chat', icon: MessagesSquare, testId: 'hub-pane-chat' },
  support: { label: 'Support', icon: LifeBuoy, testId: 'hub-pane-support' },
};

export interface HubPageProps {
  pane?: HubWorkspacePane | null;
  onPaneChange: (pane: HubWorkspacePane) => void;
  /** Compact assistant column (desktop) / Assistant tab body (mobile). */
  assistant: ReactNode;
  today: ReactNode;
  summary: ReactNode;
  org: ReactNode;
  todos: ReactNode;
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
    'today' | 'summary' | 'org' | 'todos' | 'calendar' | 'mail' | 'chat' | 'support'
  >,
): ReactNode {
  switch (active) {
    case 'today':
      return panes.today;
    case 'summary':
      return panes.summary;
    case 'org':
      return panes.org;
    case 'todos':
      return panes.todos;
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
  onPaneChange,
  assistant,
  today,
  summary,
  org,
  todos,
  calendar,
  mail,
  chat,
  support,
  mobileAssistantTab = false,
  mobileTab = 'today',
  onMobileTabChange,
  assistantActions,
  paneBadges,
}: HubPageProps) {
  const active = parseHubPane(pane);
  // Desktop-only: narrow viewports reach the assistant through its own tab.
  const [assistantCollapsed, setAssistantCollapsedState] = useState(readAssistantCollapsed);
  const setAssistantCollapsed = useCallback((collapsed: boolean) => {
    setAssistantCollapsedState(collapsed);
    writeAssistantCollapsed(collapsed);
  }, []);
  const workspace = workspaceBody(active, {
    today,
    summary,
    org,
    todos,
    calendar,
    mail,
    chat,
    support,
  });

  return (
    <div className="flex-1 flex min-h-0 min-w-0 overflow-hidden bg-gray-950" data-testid="hub-page">
      <div
        className={`flex-1 flex flex-col min-h-0 min-w-0 ${
          mobileAssistantTab && mobileTab === 'assistant' ? 'hidden lg:flex' : 'flex'
        }`}
      >
        <header className="shrink-0 border-b border-gray-800 px-3 py-2 flex items-center gap-2">
          <h1 className="m-0 leading-none shrink-0">
            <BrandLogo size="sm" />
          </h1>
          <nav
            className="flex-1 flex items-center gap-1 overflow-x-auto ml-2"
            aria-label="Hub sections"
          >
            {mobileAssistantTab && (
              <button
                type="button"
                data-testid="hub-pane-assistant"
                onClick={() => onMobileTabChange?.('assistant')}
                className={`lg:hidden inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors ${
                  mobileTab === 'assistant'
                    ? 'bg-gray-800 text-white'
                    : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800/60'
                }`}
              >
                <Bot size={13} />
                Assistant
              </button>
            )}
            {HUB_WORKSPACE_PANES.map((id) => {
              const meta = PANE_META[id];
              const Icon = meta.icon;
              const selected = active === id && (!mobileAssistantTab || mobileTab !== 'assistant');
              return (
                <button
                  key={id}
                  type="button"
                  data-testid={meta.testId}
                  onClick={() => {
                    onPaneChange(id);
                    onMobileTabChange?.(id);
                  }}
                  className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors ${
                    selected
                      ? 'bg-gray-800 text-white'
                      : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800/60'
                  }`}
                >
                  <Icon size={13} />
                  {meta.label}
                  {!!paneBadges?.[id] && (
                    <span
                      data-testid={`${meta.testId}-badge`}
                      aria-label={`${paneBadges[id]} unread`}
                      className="ml-0.5 min-w-[1.1rem] rounded-full bg-blue-600 px-1 text-center text-[10px] font-semibold leading-4 text-white"
                    >
                      {formatUnreadCount(paneBadges[id] as number)}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>
          {assistantCollapsed && (
            <button
              type="button"
              data-testid="hub-assistant-open"
              onClick={() => setAssistantCollapsed(false)}
              title="Show assistant"
              aria-label="Show assistant"
              className="hidden lg:inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-gray-400 hover:text-gray-200 hover:bg-gray-800/60 transition-colors"
            >
              <PanelRightOpen size={13} />
              Assistant
            </button>
          )}
        </header>
        {/* Flex column so pane roots using `flex-1` (org/todos/calendar/mail) get a
            bounded height and can scroll; `h-full` panes (today/summary) still resolve
            against this bounded box. Without `flex`, `flex-1` is inert and pane content
            overflows this `overflow-hidden` wrapper with no scrollbar. */}
        <div className="flex-1 min-h-0 overflow-hidden flex flex-col">{workspace}</div>
      </div>

      <aside
        className={`border-gray-800 bg-gray-950 min-h-0 min-w-0 flex-col ${
          mobileAssistantTab && mobileTab === 'assistant' ? 'flex' : 'hidden'
        } ${assistantCollapsed ? 'lg:hidden' : 'lg:flex lg:w-[min(28rem,40vw)] lg:border-l'}`}
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
