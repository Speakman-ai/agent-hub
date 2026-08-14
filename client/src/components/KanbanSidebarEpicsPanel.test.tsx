import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import KanbanSidebarEpicsPanel from './KanbanSidebarEpicsPanel';
import { readFilterSets, saveFilterSet } from '../utils/kanbanFilterSets';

vi.mock('../utils/api.js', () => ({
  api: {
    getEpics: vi.fn(),
  },
}));

import { api } from '../utils/api';

describe('KanbanSidebarEpicsPanel', () => {
  beforeEach(() => {
    localStorage.clear();
    (api.getEpics as any).mockReset();
    (api.getEpics as any).mockResolvedValue([
      { id: 'e1', name: 'Platform', color: '#6366F1', autonomous: 0 },
      { id: 'e2', name: 'Mobile', color: '#22C55E', autonomous: 1 },
    ]);
  });

  it('toggles label multi-select', () => {
    const onSelectedLabelsChange = vi.fn();
    render(
      <KanbanSidebarEpicsPanel
        projectId="p1"
        searchQuery=""
        onSearchChange={vi.fn()}
        selectedEpicIds={new Set()}
        onSelectedEpicIdsChange={vi.fn()}
        availableLabels={['bug', 'feature']}
        selectedLabels={new Set()}
        onSelectedLabelsChange={onSelectedLabelsChange}
      />,
    );

    fireEvent.click(screen.getByTestId('kanban-sidebar-label-bug'));
    expect(onSelectedLabelsChange).toHaveBeenCalled();
    const next = onSelectedLabelsChange.mock.calls[0][0] as Set<string>;
    expect(next.has('bug')).toBe(true);
  });

  it('renders the epic filter with the sidebar filters', async () => {
    const onSelectedEpicIdsChange = vi.fn();
    (api.getEpics as any).mockResolvedValueOnce([
      { id: 'e1', name: 'Platform', color: '#6366F1', autonomous: 0 },
    ]);

    render(
      <KanbanSidebarEpicsPanel
        projectId="p1"
        searchQuery=""
        onSearchChange={vi.fn()}
        selectedEpicIds={new Set()}
        onSelectedEpicIdsChange={onSelectedEpicIdsChange}
        availableLabels={['bug']}
        selectedLabels={new Set()}
        onSelectedLabelsChange={vi.fn()}
      />,
    );

    const panel = screen.getByTestId('kanban-sidebar-epics-panel');
    await waitFor(() =>
      expect(within(panel).getByTestId('kanban-sidebar-epic-list')).toBeInTheDocument(),
    );

    fireEvent.click(within(panel).getByTestId('kanban-sidebar-epic-e1'));
    expect(onSelectedEpicIdsChange).toHaveBeenCalled();
    const next = onSelectedEpicIdsChange.mock.calls[0][0] as Set<string>;
    expect(next.has('e1')).toBe(true);
    expect(within(panel).getByTestId('kanban-sidebar-label-list')).toBeInTheDocument();
  });

  it('toggles the "No epic" pseudo-selection with the sentinel id', () => {
    const onSelectedEpicIdsChange = vi.fn();
    render(
      <KanbanSidebarEpicsPanel
        projectId="p1"
        searchQuery=""
        onSearchChange={vi.fn()}
        selectedEpicIds={new Set()}
        onSelectedEpicIdsChange={onSelectedEpicIdsChange}
      />,
    );

    fireEvent.click(screen.getByTestId('kanban-sidebar-epic-none'));
    expect(onSelectedEpicIdsChange).toHaveBeenCalled();
    const next = onSelectedEpicIdsChange.mock.calls[0][0] as Set<string>;
    expect(next.has('__no_epic__')).toBe(true);
  });

  it('offers the "No epic" toggle even when the board has no epics', async () => {
    (api.getEpics as any).mockResolvedValueOnce([]);
    render(
      <KanbanSidebarEpicsPanel
        projectId="p1"
        searchQuery=""
        onSearchChange={vi.fn()}
        selectedEpicIds={new Set()}
        onSelectedEpicIdsChange={vi.fn()}
      />,
    );

    const panel = screen.getByTestId('kanban-sidebar-epics-panel');
    await waitFor(() =>
      expect(within(panel).getByText('No epics on the board yet.')).toBeInTheDocument(),
    );
    expect(within(panel).getByTestId('kanban-sidebar-epic-none')).toBeInTheDocument();
  });

  it('hides done epics from the filter list but keeps selected done epics', async () => {
    (api.getEpics as any).mockResolvedValueOnce([
      { id: 'e1', name: 'Platform', color: '#6366F1', autonomous: 0, state: 'in_progress' },
      { id: 'e2', name: 'Mobile', color: '#22C55E', autonomous: 1, state: 'done' },
      { id: 'e3', name: 'Shipped', color: '#EF4444', autonomous: 0, state: 'done' },
    ]);

    render(
      <KanbanSidebarEpicsPanel
        projectId="p1"
        searchQuery=""
        onSearchChange={vi.fn()}
        selectedEpicIds={new Set(['e3'])}
        onSelectedEpicIdsChange={vi.fn()}
        availableLabels={['bug']}
        selectedLabels={new Set()}
        onSelectedLabelsChange={vi.fn()}
      />,
    );

    const panel = screen.getByTestId('kanban-sidebar-epics-panel');
    await waitFor(() =>
      expect(within(panel).getByTestId('kanban-sidebar-epic-e1')).toBeInTheDocument(),
    );

    // Active epic is shown; unselected done epic is hidden; selected done epic stays visible.
    expect(within(panel).getByTestId('kanban-sidebar-epic-e1')).toBeInTheDocument();
    expect(within(panel).queryByTestId('kanban-sidebar-epic-e2')).not.toBeInTheDocument();
    expect(within(panel).getByTestId('kanban-sidebar-epic-e3')).toBeInTheDocument();
  });

  it('shows an "active epics" empty state when every epic is done', async () => {
    (api.getEpics as any).mockResolvedValueOnce([
      { id: 'e1', name: 'Done A', color: '#6366F1', autonomous: 0, state: 'done' },
    ]);

    render(
      <KanbanSidebarEpicsPanel
        projectId="p1"
        searchQuery=""
        onSearchChange={vi.fn()}
        selectedEpicIds={new Set()}
        onSelectedEpicIdsChange={vi.fn()}
        availableLabels={['bug']}
        selectedLabels={new Set()}
        onSelectedLabelsChange={vi.fn()}
      />,
    );

    const panel = screen.getByTestId('kanban-sidebar-epics-panel');
    await waitFor(() =>
      expect(within(panel).getByText('No active epics to filter by.')).toBeInTheDocument(),
    );
    expect(within(panel).queryByTestId('kanban-sidebar-epic-list')).not.toBeInTheDocument();
  });

  it('toggles lead user multi-select', () => {
    const onSelectedUserIdsChange = vi.fn();
    render(
      <KanbanSidebarEpicsPanel
        projectId="p1"
        searchQuery=""
        onSearchChange={vi.fn()}
        selectedEpicIds={new Set()}
        onSelectedEpicIdsChange={vi.fn()}
        assignableUsers={[
          { id: 'u1', username: 'ryan' },
          { id: 'u2', username: 'alex' },
        ]}
        selectedUserIds={new Set()}
        onSelectedUserIdsChange={onSelectedUserIdsChange}
      />,
    );

    fireEvent.click(screen.getByTestId('kanban-sidebar-user-ryan'));
    expect(onSelectedUserIdsChange).toHaveBeenCalled();
    const next = onSelectedUserIdsChange.mock.calls[0][0] as Set<string>;
    expect(next.has('u1')).toBe(true);
  });

  it('saves and applies a named filter set', async () => {
    const onSearchChange = vi.fn();
    const onSelectedEpicIdsChange = vi.fn();
    const onSelectedLabelsChange = vi.fn();
    const onSelectedUserIdsChange = vi.fn();

    render(
      <KanbanSidebarEpicsPanel
        projectId="p1"
        searchQuery="login"
        onSearchChange={onSearchChange}
        selectedEpicIds={new Set(['e1'])}
        onSelectedEpicIdsChange={onSelectedEpicIdsChange}
        availableLabels={['bug']}
        selectedLabels={new Set(['bug'])}
        onSelectedLabelsChange={onSelectedLabelsChange}
        assignableUsers={[{ id: 'u1', username: 'ryan' }]}
        selectedUserIds={new Set(['u1'])}
        onSelectedUserIdsChange={onSelectedUserIdsChange}
      />,
    );

    fireEvent.change(screen.getByTestId('kanban-sidebar-label-search'), {
      target: { value: 'bu' },
    });
    fireEvent.change(screen.getByTestId('kanban-sidebar-user-search'), {
      target: { value: 'ry' },
    });

    fireEvent.click(screen.getByTestId('kanban-sidebar-save-filter'));
    fireEvent.change(screen.getByTestId('kanban-sidebar-save-filter-name'), {
      target: { value: 'Login bugs' },
    });
    fireEvent.click(screen.getByTestId('kanban-sidebar-save-filter-confirm'));

    await waitFor(() => expect(readFilterSets('p1')).toHaveLength(1));
    expect(readFilterSets('p1')[0].labelSearch).toBe('bu');
    expect(readFilterSets('p1')[0].userSearch).toBe('ry');
    expect(readFilterSets('p1')[0].userIds).toEqual(['u1']);

    fireEvent.change(screen.getByTestId('kanban-sidebar-label-search'), {
      target: { value: '' },
    });
    fireEvent.change(screen.getByTestId('kanban-sidebar-user-search'), {
      target: { value: '' },
    });

    const saved = readFilterSets('p1')[0];
    fireEvent.click(screen.getByTestId(`kanban-sidebar-saved-filter-${saved.id}`));

    expect(onSearchChange).toHaveBeenCalledWith('login');
    expect(screen.getByTestId('kanban-sidebar-label-search')).toHaveValue('bu');
    expect(screen.getByTestId('kanban-sidebar-user-search')).toHaveValue('ry');
    expect(onSelectedEpicIdsChange).toHaveBeenCalled();
    expect(onSelectedLabelsChange).toHaveBeenCalled();
    expect(onSelectedUserIdsChange).toHaveBeenCalled();
    const appliedEpics = onSelectedEpicIdsChange.mock.calls.at(-1)?.[0] as Set<string>;
    const appliedLabels = onSelectedLabelsChange.mock.calls.at(-1)?.[0] as Set<string>;
    const appliedUsers = onSelectedUserIdsChange.mock.calls.at(-1)?.[0] as Set<string>;
    expect(appliedEpics.has('e1')).toBe(true);
    expect(appliedLabels.has('bug')).toBe(true);
    expect(appliedUsers.has('u1')).toBe(true);
  });

  it('deletes a saved filter set', async () => {
    saveFilterSet('p1', 'Old filter', {
      searchQuery: 'x',
      epicIds: [],
      labels: [],
      userIds: [],
    });
    const saved = readFilterSets('p1')[0];

    render(
      <KanbanSidebarEpicsPanel
        projectId="p1"
        searchQuery=""
        onSearchChange={vi.fn()}
        selectedEpicIds={new Set()}
        onSelectedEpicIdsChange={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(screen.getByTestId(`kanban-sidebar-saved-filter-${saved.id}`)).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByTestId(`kanban-sidebar-delete-filter-${saved.id}`));
    expect(readFilterSets('p1')).toEqual([]);
  });

  it('restores the collapsed-column layout when a view is applied', async () => {
    saveFilterSet('p1', 'Focus', {
      searchQuery: '',
      epicIds: ['e1'],
      labels: [],
      userIds: [],
      collapsedColumnIds: ['col-done', 'col-review'],
    });
    const saved = readFilterSets('p1')[0];
    const onCollapsedColumnIdsChange = vi.fn();
    const onSelectedEpicIdsChange = vi.fn();

    render(
      <KanbanSidebarEpicsPanel
        projectId="p1"
        searchQuery=""
        onSearchChange={vi.fn()}
        selectedEpicIds={new Set()}
        onSelectedEpicIdsChange={onSelectedEpicIdsChange}
        collapsedColumnIds={new Set()}
        onCollapsedColumnIdsChange={onCollapsedColumnIdsChange}
      />,
    );

    await waitFor(() =>
      expect(screen.getByTestId(`kanban-sidebar-saved-filter-${saved.id}`)).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByTestId(`kanban-sidebar-saved-filter-${saved.id}`));

    expect(onSelectedEpicIdsChange).toHaveBeenCalledWith(new Set(['e1']));
    expect(onCollapsedColumnIdsChange).toHaveBeenCalledWith(new Set(['col-done', 'col-review']));
  });

  it('enables saving a view that only changes the column layout', async () => {
    render(
      <KanbanSidebarEpicsPanel
        projectId="p1"
        searchQuery=""
        onSearchChange={vi.fn()}
        selectedEpicIds={new Set()}
        onSelectedEpicIdsChange={vi.fn()}
        collapsedColumnIds={new Set(['col-done'])}
        onCollapsedColumnIdsChange={vi.fn()}
      />,
    );

    const saveBtn = screen.getByTestId('kanban-sidebar-save-filter') as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(false);

    fireEvent.click(saveBtn);
    fireEvent.change(screen.getByTestId('kanban-sidebar-save-filter-name'), {
      target: { value: 'Hide done' },
    });
    fireEvent.click(screen.getByTestId('kanban-sidebar-save-filter-confirm'));

    await waitFor(() => expect(readFilterSets('p1')).toHaveLength(1));
    expect(readFilterSets('p1')[0].collapsedColumnIds).toEqual(['col-done']);
  });
});
