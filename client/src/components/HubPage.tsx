import type { ReactNode } from 'react';
import { DEFAULT_HUB_PANE, parseHubPane, type HubWorkspacePane } from '@shared/utils/hub';

export interface HubPageProps {
  pane?: HubWorkspacePane | null;
  onPaneChange: (pane: HubWorkspacePane) => void;
  today: ReactNode;
  org: ReactNode;
  todos: ReactNode;
  reminders: ReactNode;
  calendar: ReactNode;
  mail: ReactNode;
  chat: ReactNode;
  support: ReactNode;
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
 * Hub — the org/user home. One workspace pane fills the page. The Hub
 * assistant lives in Chat.
 */
export default function HubPage({
  pane,
  onPaneChange: _onPaneChange,
  today,
  org,
  todos,
  reminders,
  calendar,
  mail,
  chat,
  support,
}: HubPageProps) {
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
        {/* Flex column so pane roots using `flex-1` (org/todos/calendar/mail) get a
            bounded height and can scroll; `h-full` panes (today) still resolve
            against this bounded box. Without `flex`, `flex-1` is inert and pane content
            overflows this `overflow-hidden` wrapper with no scrollbar. */}
        <div className="flex-1 min-h-0 overflow-hidden flex flex-col">{workspace}</div>
      </div>
    </div>
  );
}

export { DEFAULT_HUB_PANE };
