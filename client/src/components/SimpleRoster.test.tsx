import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SimpleRoster from './SimpleRoster';

const agents = [
  { id: 'ada', name: 'Ada', projectName: 'Hub', color: '#8B5CF6', active: true },
  { id: 'bea', name: 'Bea', projectName: 'Docs', color: '#10B981', active: true, role: 'reviewer' },
];

function dataTransfer() {
  const store: Record<string, string> = {};
  return {
    effectAllowed: '',
    dropEffect: '',
    setData: (type: string, value: string) => {
      store[type] = value;
    },
    getData: (type: string) => store[type] ?? '',
    setDragImage: () => undefined,
  };
}

describe('SimpleRoster', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('lists chat agents, opens one, and can return to the full Hub', () => {
    const onOpenAgent = vi.fn();
    const onOpenFullHub = vi.fn();
    const onEnsureSessions = vi.fn();
    const onOpenServerAgent = vi.fn();

    render(
      <SimpleRoster
        agents={agents}
        serverAgent={{
          id: 'server',
          name: 'Server Agent',
          preview: 'Ask about the Hub',
          status: 'idle',
          selected: false,
        }}
        onOpenServerAgent={onOpenServerAgent}
        sessionsByAgentId={{
          ada: [
            {
              id: 's1',
              name: 'Fix the roster',
              session_mode: 'consult',
              updated_at: '2026-04-01T00:00:00Z',
            },
          ],
        }}
        activeAgentId="ada"
        onOpenAgent={onOpenAgent}
        onOpenFullHub={onOpenFullHub}
        onEnsureSessions={onEnsureSessions}
        organizations={null}
      />,
    );

    expect(screen.getByTestId('simple-server-agent')).toBeTruthy();
    expect(
      screen.getByTestId('simple-server-agent').querySelector('[data-testid="brand-logo-mark"]'),
    ).toBeTruthy();
    expect(screen.getByTestId('simple-agent-ada')).toBeTruthy();
    fireEvent.click(screen.getByTestId('simple-server-agent'));
    expect(onOpenServerAgent).toHaveBeenCalledOnce();
    expect(screen.queryByTestId('simple-agent-bea')).toBeNull();
    expect(screen.getByText('Hub · Fix the roster')).toBeTruthy();
    expect(onEnsureSessions).toHaveBeenCalledWith('ada');

    fireEvent.click(screen.getByTestId('simple-agent-ada'));
    expect(onOpenAgent).toHaveBeenCalledWith('ada');

    fireEvent.click(screen.getByTestId('simple-open-full-hub'));
    expect(onOpenFullHub).toHaveBeenCalledOnce();

    expect(screen.queryByTestId('simple-home-today')).toBeNull();
    expect(screen.getByTestId('simple-home-chat')).toHaveAttribute('aria-label', 'Chat');
    expect(screen.queryByTestId('simple-home-google-chat')).toBeNull();
    expect(screen.getByTestId('simple-home-org')).toHaveAttribute('aria-label', 'Server');
    expect(screen.getByTestId('simple-home-nav').textContent).toBe('');

    fireEvent.change(screen.getByTestId('simple-search'), { target: { value: 'missing' } });
    expect(screen.getByTestId('simple-empty').textContent).toBe('No matching agents');
  });

  it('keeps a dragged order, with the server agent pinned first', () => {
    const agents = [
      { id: 'ada', name: 'Ada', projectName: 'Hub', color: '#8B5CF6', active: true },
      { id: 'cam', name: 'Cam', projectName: 'Hub', color: '#F59E0B', active: true },
    ];
    const props = {
      agents,
      serverAgent: {
        id: 'server',
        name: 'Server Agent',
        preview: 'Ask about the Hub',
        status: 'idle' as const,
        selected: true,
      },
      onOpenAgent: vi.fn(),
      onOpenFullHub: vi.fn(),
      organizations: null,
    };

    const { unmount } = render(<SimpleRoster {...props} />);
    expect(screen.queryByTestId('simple-agent-drag-server')).toBeNull();
    expect(rowIds()).toEqual(['ada', 'cam']);

    const dt = dataTransfer();
    fireEvent.dragStart(screen.getByTestId('simple-agent-drag-cam'), { dataTransfer: dt });
    fireEvent.dragOver(screen.getByTestId('simple-agent-row-ada'), { dataTransfer: dt });
    fireEvent.drop(screen.getByTestId('simple-agent-row-ada'), { dataTransfer: dt });

    expect(rowIds()).toEqual(['cam', 'ada']);
    const server = screen.getByTestId('simple-server-agent');
    const first = screen.getByTestId('simple-agent-row-cam');
    expect(server.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    unmount();
    render(<SimpleRoster {...props} />);
    expect(rowIds()).toEqual(['cam', 'ada']);
  });
});

it('opens a Hub page from its icon and shows Google Chat only when it is connected', () => {
  const onOpenPane = vi.fn();
  const { rerender } = render(
    <SimpleRoster
      agents={agents}
      activePane="mail"
      onOpenAgent={vi.fn()}
      onOpenFullHub={vi.fn()}
      onOpenPane={onOpenPane}
      organizations={null}
    />,
  );
  expect(screen.getByTestId('simple-home-mail')).toHaveAttribute('aria-current', 'page');
  fireEvent.click(screen.getByTestId('simple-home-todos'));
  expect(onOpenPane).toHaveBeenCalledWith('todos');

  rerender(
    <SimpleRoster
      agents={agents}
      googleChatAvailable
      onOpenAgent={vi.fn()}
      onOpenFullHub={vi.fn()}
      onOpenPane={onOpenPane}
      organizations={null}
    />,
  );
  expect(screen.getByTestId('simple-home-google-chat')).toHaveAttribute(
    'aria-label',
    'Google Chat',
  );
  fireEvent.click(screen.getByTestId('simple-home-google-chat'));
  expect(onOpenPane).toHaveBeenLastCalledWith('google-chat');
});

it('reorders projects inside an organization and organizations against each other', () => {
  const agents = [
    {
      id: 'ada',
      name: 'Ada',
      projectId: 'app',
      projectName: 'App',
      color: '#8B5CF6',
      active: true,
    },
    {
      id: 'cam',
      name: 'Cam',
      projectId: 'site',
      projectName: 'Site',
      color: '#F59E0B',
      active: true,
    },
    {
      id: 'dee',
      name: 'Dee',
      projectId: 'notes',
      projectName: 'Notes',
      color: '#10B981',
      active: true,
    },
  ];
  render(
    <SimpleRoster
      agents={agents}
      organizations={[
        { id: 'acme', name: 'Acme' },
        { id: 'beta', name: 'Beta' },
      ]}
      projectMembership={{ acme: ['site', 'app'], beta: ['notes'] }}
      onOpenAgent={vi.fn()}
      onOpenFullHub={vi.fn()}
    />,
  );

  expect(screen.getByTestId('simple-org-acme').textContent).toContain('Acme');
  expect(screen.getByTestId('simple-org-beta').textContent).toContain('Beta');
  const app = screen.getByTestId('simple-project-app');
  const site = screen.getByTestId('simple-project-site');
  expect(app.compareDocumentPosition(site) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

  const projectDrag = dataTransfer();
  fireEvent.dragStart(screen.getByTestId('simple-project-drag-app'), { dataTransfer: projectDrag });
  fireEvent.dragOver(screen.getByTestId('simple-project-site'), { dataTransfer: projectDrag });
  fireEvent.drop(screen.getByTestId('simple-project-site'), { dataTransfer: projectDrag });
  const appAfter = screen.getByTestId('simple-project-app');
  const siteAfter = screen.getByTestId('simple-project-site');
  expect(
    siteAfter.compareDocumentPosition(appAfter) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();

  const orgDrag = dataTransfer();
  fireEvent.dragStart(screen.getByTestId('simple-org-drag-beta'), { dataTransfer: orgDrag });
  fireEvent.drop(screen.getByTestId('simple-org-acme'), { dataTransfer: orgDrag });
  const acme = screen.getByTestId('simple-org-acme');
  const beta = screen.getByTestId('simple-org-beta');
  expect(beta.compareDocumentPosition(acme) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

function rowIds() {
  return screen
    .getAllByTestId(/^simple-agent-row-/)
    .map((row) => row.getAttribute('data-testid')?.replace('simple-agent-row-', '') ?? '');
}
