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

function rowIds() {
  return screen
    .getAllByTestId(/^simple-agent-row-/)
    .map((row) => row.getAttribute('data-testid')?.replace('simple-agent-row-', '') ?? '');
}
