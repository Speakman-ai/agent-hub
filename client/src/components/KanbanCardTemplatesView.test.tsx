import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import KanbanCardTemplatesView from './KanbanCardTemplatesView';
import { kanbanCardTemplatesKey } from '../utils/kanbanCardTemplates';

vi.mock('../utils/api.js', () => ({
  api: {
    getCardTemplates: vi.fn(),
    createCardTemplate: vi.fn(),
    updateCardTemplate: vi.fn(),
    deleteCardTemplate: vi.fn(),
    getEpics: vi.fn(),
  },
}));

import { api } from '../utils/api';

describe('KanbanCardTemplatesView', () => {
  beforeEach(() => {
    localStorage.clear();
    (api.getCardTemplates as any).mockReset();
    (api.createCardTemplate as any).mockReset();
    (api.updateCardTemplate as any).mockReset();
    (api.deleteCardTemplate as any).mockReset();
    (api.getEpics as any).mockReset();
    (api.getEpics as any).mockResolvedValue([]);
    (api.getCardTemplates as any).mockResolvedValue([
      {
        id: 't1',
        name: 'Bug report',
        title: 'Fix:',
        description: '',
        priority: 'high',
        labels: 'bug',
        epicId: '',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
  });

  it('lists templates and opens create dialog', async () => {
    render(
      <KanbanCardTemplatesView
        projectId="p1"
        project={{ id: 'p1', name: 'Agent Hub' }}
        onBackToBoard={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.getByTestId('templates-list')).toBeInTheDocument());
    expect(screen.getByText('Bug report')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('templates-new'));
    expect(screen.getByTestId('kanban-card-template-dialog')).toBeInTheDocument();
  });

  it('creates a template via the dialog', async () => {
    (api.createCardTemplate as any).mockResolvedValue({
      id: 't2',
      name: 'Spike',
      title: '',
      description: '',
      priority: 'medium',
      labels: '',
      epicId: '',
      updatedAt: '2026-01-02T00:00:00.000Z',
    });

    render(
      <KanbanCardTemplatesView
        projectId="p1"
        project={{ id: 'p1', name: 'Agent Hub' }}
        onBackToBoard={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.getByTestId('templates-list')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('templates-new'));
    fireEvent.change(screen.getByTestId('template-name'), { target: { value: 'Spike' } });
    fireEvent.click(screen.getByTestId('template-save'));

    await waitFor(() =>
      expect(api.createCardTemplate).toHaveBeenCalledWith(
        'p1',
        expect.objectContaining({ name: 'Spike' }),
      ),
    );
  });

  it('deletes a template', async () => {
    (api.deleteCardTemplate as any).mockResolvedValue({ ok: true });
    (api.getCardTemplates as any)
      .mockResolvedValueOnce([
        {
          id: 't1',
          name: 'Bug report',
          title: 'Fix:',
          description: '',
          priority: 'high',
          labels: 'bug',
          epicId: '',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ])
      .mockResolvedValueOnce([]);

    render(
      <KanbanCardTemplatesView
        projectId="p1"
        project={{ id: 'p1', name: 'Agent Hub' }}
        onBackToBoard={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.getByTestId('template-row-t1')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('template-delete-t1'));
    expect(api.deleteCardTemplate).not.toHaveBeenCalled();
    expect(screen.getByTestId('template-delete-t1')).toHaveTextContent('Confirm');

    fireEvent.click(screen.getByTestId('template-delete-t1'));
    await waitFor(() => expect(api.deleteCardTemplate).toHaveBeenCalledWith('p1', 't1'));
  });

  it('migrates legacy local templates once per project id', async () => {
    localStorage.setItem(
      kanbanCardTemplatesKey('p1'),
      JSON.stringify([
        {
          id: 'legacy-p1',
          name: 'P1 Template',
          title: 'P1 title',
          description: '',
          priority: 'medium',
          labels: '',
          epicId: '',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ]),
    );
    localStorage.setItem(
      kanbanCardTemplatesKey('p2'),
      JSON.stringify([
        {
          id: 'legacy-p2',
          name: 'P2 Template',
          title: 'P2 title',
          description: '',
          priority: 'high',
          labels: 'p2',
          epicId: '',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ]),
    );
    (api.getCardTemplates as any).mockResolvedValue([]);
    (api.createCardTemplate as any).mockResolvedValue({});

    const { rerender } = render(
      <KanbanCardTemplatesView
        projectId="p1"
        project={{ id: 'p1', name: 'Project 1' }}
        onBackToBoard={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(api.createCardTemplate).toHaveBeenCalledWith(
        'p1',
        expect.objectContaining({ name: 'P1 Template' }),
      ),
    );

    rerender(
      <KanbanCardTemplatesView
        projectId="p2"
        project={{ id: 'p2', name: 'Project 2' }}
        onBackToBoard={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(api.createCardTemplate).toHaveBeenCalledWith(
        'p2',
        expect.objectContaining({ name: 'P2 Template' }),
      ),
    );
  });

  it('keeps legacy templates after partial migration failure and retries missing rows', async () => {
    localStorage.setItem(
      kanbanCardTemplatesKey('p1'),
      JSON.stringify([
        {
          id: 'legacy-first',
          name: 'First Template',
          title: 'First title',
          description: '',
          priority: 'medium',
          labels: '',
          epicId: '',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
        {
          id: 'legacy-second',
          name: 'Second Template',
          title: 'Second title',
          description: '',
          priority: 'high',
          labels: '',
          epicId: '',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ]),
    );
    (api.getCardTemplates as any).mockResolvedValue([]);
    (api.createCardTemplate as any)
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('temporary failure'));

    const { rerender } = render(
      <KanbanCardTemplatesView
        projectId="p1"
        project={{ id: 'p1', name: 'Project 1' }}
        onBackToBoard={vi.fn()}
        refreshKey={0}
      />,
    );

    await waitFor(() => expect(api.createCardTemplate).toHaveBeenCalledTimes(2));
    expect(localStorage.getItem(kanbanCardTemplatesKey('p1'))).not.toBeNull();

    (api.getCardTemplates as any).mockResolvedValue([
      {
        id: 'server-first',
        name: 'First Template',
        title: 'First title',
        description: '',
        priority: 'medium',
        labels: '',
        epicId: '',
        updatedAt: '2026-01-02T00:00:00.000Z',
      },
    ]);
    (api.createCardTemplate as any).mockResolvedValue({});

    rerender(
      <KanbanCardTemplatesView
        projectId="p1"
        project={{ id: 'p1', name: 'Project 1' }}
        onBackToBoard={vi.fn()}
        refreshKey={1}
      />,
    );

    await waitFor(() => expect(api.createCardTemplate).toHaveBeenCalledTimes(3));
    expect(api.createCardTemplate).toHaveBeenLastCalledWith(
      'p1',
      expect.objectContaining({ name: 'Second Template' }),
    );
    expect(localStorage.getItem(kanbanCardTemplatesKey('p1'))).toBeNull();
  });

  it('ignores stale template loads after the project changes', async () => {
    let resolveP1: ((rows: any[]) => void) | undefined;
    let resolveP2: ((rows: any[]) => void) | undefined;
    (api.getCardTemplates as any).mockImplementation(
      (projectId: string) =>
        new Promise((resolve) => {
          if (projectId === 'p1') resolveP1 = resolve;
          else if (projectId === 'p2') resolveP2 = resolve;
          else resolve([]);
        }),
    );

    const { rerender } = render(
      <KanbanCardTemplatesView
        projectId="p1"
        project={{ id: 'p1', name: 'Project 1' }}
        onBackToBoard={vi.fn()}
      />,
    );

    rerender(
      <KanbanCardTemplatesView
        projectId="p2"
        project={{ id: 'p2', name: 'Project 2' }}
        onBackToBoard={vi.fn()}
      />,
    );

    await waitFor(() => expect(resolveP2).toBeDefined());
    await act(async () => {
      resolveP2?.([
        {
          id: 'p2-template',
          name: 'P2 Template',
          title: 'P2 title',
          description: '',
          priority: 'medium',
          labels: '',
          epicId: '',
          updatedAt: '2026-01-02T00:00:00.000Z',
        },
      ]);
    });

    await waitFor(() => expect(screen.getByText('P2 Template')).toBeInTheDocument());

    await waitFor(() => expect(resolveP1).toBeDefined());
    await act(async () => {
      resolveP1?.([
        {
          id: 'p1-template',
          name: 'P1 Template',
          title: 'P1 title',
          description: '',
          priority: 'high',
          labels: '',
          epicId: '',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ]);
    });

    expect(screen.getByText('P2 Template')).toBeInTheDocument();
    expect(screen.queryByText('P1 Template')).not.toBeInTheDocument();
  });
});
