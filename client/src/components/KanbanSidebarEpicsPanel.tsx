import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Bookmark,
  CheckSquare,
  Search,
  Square,
  Tag,
  Target,
  Trash2,
  User,
  X,
  Zap,
} from 'lucide-react';
import KanbanUserFilterChips from './KanbanUserFilterChips';
import { api } from '../utils/api';
import {
  applySnapshot,
  deleteFilterSet,
  findMatchingFilterSet,
  isEmptySnapshot,
  readFilterSets,
  saveFilterSet,
  snapshotFromState,
  type KanbanFilterSet,
} from '../utils/kanbanFilterSets';
import type { AssignableUser } from '../utils/kanbanUserFilter';

type KanbanSidebarEpicsPanelProps = {
  projectId: string;
  projectName?: string;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  selectedEpicIds: Set<string>;
  onSelectedEpicIdsChange: (ids: Set<string>) => void;
  availableLabels?: string[];
  selectedLabels?: Set<string>;
  onSelectedLabelsChange?: (labels: Set<string>) => void;
  assignableUsers?: AssignableUser[];
  selectedUserIds?: Set<string>;
  onSelectedUserIdsChange?: (userIds: Set<string>) => void;
  refreshKey?: number;
};

type SidebarEpic = {
  id: string;
  name: string;
  color?: string;
  autonomous?: number;
};

export default function KanbanSidebarEpicsPanel({
  projectId,
  projectName,
  searchQuery,
  onSearchChange,
  selectedEpicIds,
  onSelectedEpicIdsChange,
  availableLabels = [],
  selectedLabels = new Set(),
  onSelectedLabelsChange,
  assignableUsers = [],
  selectedUserIds = new Set(),
  onSelectedUserIdsChange,
  refreshKey,
}: KanbanSidebarEpicsPanelProps) {
  const [epics, setEpics] = useState<SidebarEpic[]>([]);
  const [labelSearch, setLabelSearch] = useState('');
  const [userSearch, setUserSearch] = useState('');
  const [savedFilters, setSavedFilters] = useState<KanbanFilterSet[]>([]);
  const [saveFilterName, setSaveFilterName] = useState('');
  const [showSaveFilterInput, setShowSaveFilterInput] = useState(false);
  const [saveFilterError, setSaveFilterError] = useState<string | null>(null);

  useEffect(() => {
    setSavedFilters(readFilterSets(projectId));
    setShowSaveFilterInput(false);
    setSaveFilterName('');
    setSaveFilterError(null);
  }, [projectId]);

  useEffect(() => {
    let cancelled = false;
    api
      .getEpics(projectId)
      .then((next: SidebarEpic[]) => {
        if (!cancelled) setEpics(Array.isArray(next) ? next : []);
      })
      .catch((err: unknown) => {
        console.warn('[KanbanSidebarEpicsPanel] getEpics failed:', err);
        if (!cancelled) setEpics([]);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, refreshKey]);

  const filteredLabels = useMemo(() => {
    const q = labelSearch.trim().toLowerCase();
    if (!q) return availableLabels;
    return availableLabels.filter((label) => label.toLowerCase().includes(q));
  }, [availableLabels, labelSearch]);

  const toggleLabel = (label: string) => {
    if (!onSelectedLabelsChange) return;
    const next = new Set(selectedLabels);
    if (next.has(label)) next.delete(label);
    else next.add(label);
    onSelectedLabelsChange(next);
  };

  const clearLabelFilter = () => onSelectedLabelsChange?.(new Set());

  const filteredUsers = useMemo(() => {
    const q = userSearch.trim().toLowerCase();
    if (!q) return assignableUsers;
    return assignableUsers.filter((user) => user.username.toLowerCase().includes(q));
  }, [assignableUsers, userSearch]);

  const toggleUser = (userId: string) => {
    if (!onSelectedUserIdsChange) return;
    const next = new Set(selectedUserIds);
    if (next.has(userId)) next.delete(userId);
    else next.add(userId);
    onSelectedUserIdsChange(next);
  };

  const clearUserFilter = () => onSelectedUserIdsChange?.(new Set());

  const currentSnapshot = useMemo(
    () =>
      snapshotFromState(
        searchQuery,
        labelSearch,
        userSearch,
        selectedEpicIds,
        selectedLabels,
        selectedUserIds,
      ),
    [searchQuery, labelSearch, userSearch, selectedEpicIds, selectedLabels, selectedUserIds],
  );

  const activeSavedFilter = useMemo(
    () => findMatchingFilterSet(savedFilters, currentSnapshot),
    [savedFilters, currentSnapshot],
  );

  const canSaveCurrentFilter = !isEmptySnapshot(currentSnapshot);

  const toggleEpic = (epicId: string) => {
    const next = new Set(selectedEpicIds);
    if (next.has(epicId)) next.delete(epicId);
    else next.add(epicId);
    onSelectedEpicIdsChange(next);
  };

  const clearEpicFilter = () => onSelectedEpicIdsChange(new Set());

  const handleApplySavedFilter = useCallback(
    (filter: KanbanFilterSet) => {
      const next = applySnapshot(filter);
      onSearchChange(next.searchQuery);
      setLabelSearch(next.labelSearch);
      setUserSearch(next.userSearch);
      onSelectedEpicIdsChange(new Set(next.epicIds));
      onSelectedLabelsChange?.(new Set(next.labels));
      onSelectedUserIdsChange?.(new Set(next.userIds));
    },
    [onSearchChange, onSelectedEpicIdsChange, onSelectedLabelsChange, onSelectedUserIdsChange],
  );

  const handleSaveCurrentFilter = () => {
    const name = saveFilterName.trim();
    if (!name) {
      setSaveFilterError('Name is required');
      return;
    }
    setSaveFilterError(null);
    setSavedFilters(saveFilterSet(projectId, name, currentSnapshot));
    setShowSaveFilterInput(false);
    setSaveFilterName('');
  };

  const handleDeleteSavedFilter = (id: string) => {
    setSavedFilters(deleteFilterSet(projectId, id));
  };

  return (
    <div className="flex flex-col mb-4" data-testid="kanban-sidebar-epics-panel">
      <div className="flex items-center gap-2 mb-2 px-2">
        <div className="min-w-0">
          <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Board</div>
          {projectName ? (
            <div className="text-sm font-medium text-gray-200 truncate">{projectName}</div>
          ) : null}
        </div>
      </div>

      <div className="relative mb-3 px-1">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search cards…"
          data-testid="kanban-sidebar-search"
          className="w-full h-9 pl-9 pr-8 rounded-xl bg-white/[0.04] border border-white/[0.06] text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-white/[0.12]"
        />
        {searchQuery ? (
          <button
            type="button"
            onClick={() => onSearchChange('')}
            aria-label="Clear search"
            className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-gray-500 hover:text-gray-300"
          >
            <X size={14} />
          </button>
        ) : null}
      </div>

      {savedFilters.length > 0 ? (
        <div className="mb-4 px-1" data-testid="kanban-sidebar-saved-filters">
          <div className="flex items-center gap-1.5 mb-2 px-1 text-xs font-semibold text-gray-500 uppercase tracking-wider">
            <Bookmark size={12} />
            Saved filters
          </div>
          <ul className="mb-2 max-h-[120px] overflow-y-auto kanban-column-scroll rounded-xl border border-white/[0.06] bg-white/[0.02]">
            {savedFilters.map((filter) => {
              const active = activeSavedFilter?.id === filter.id;
              return (
                <li
                  key={filter.id}
                  className="flex items-center gap-1 border-b border-white/[0.04] last:border-b-0"
                >
                  <button
                    type="button"
                    onClick={() => handleApplySavedFilter(filter)}
                    data-testid={`kanban-sidebar-saved-filter-${filter.id}`}
                    className={`flex-1 min-w-0 text-left px-3 py-2 text-sm transition-colors truncate ${
                      active ? 'text-indigo-200 bg-indigo-500/10' : 'text-gray-200 hover:text-white'
                    }`}
                  >
                    {filter.name}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDeleteSavedFilter(filter.id)}
                    data-testid={`kanban-sidebar-delete-filter-${filter.id}`}
                    aria-label={`Delete saved filter ${filter.name}`}
                    className="p-2 text-gray-500 hover:text-red-300 transition-colors shrink-0"
                  >
                    <Trash2 size={12} />
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      <div className="mb-4 px-1">
        {showSaveFilterInput ? (
          <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3 space-y-2">
            <input
              type="text"
              value={saveFilterName}
              onChange={(e) => setSaveFilterName(e.target.value)}
              placeholder="Filter name"
              data-testid="kanban-sidebar-save-filter-name"
              className="w-full h-8 px-3 rounded-lg bg-gray-900 border border-gray-700 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-gray-500"
            />
            {saveFilterError ? <p className="text-xs text-red-400">{saveFilterError}</p> : null}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleSaveCurrentFilter}
                data-testid="kanban-sidebar-save-filter-confirm"
                className="h-8 px-3 rounded-lg text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-500 transition-colors"
              >
                Save
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowSaveFilterInput(false);
                  setSaveFilterName('');
                  setSaveFilterError(null);
                }}
                data-testid="kanban-sidebar-save-filter-cancel"
                className="h-8 px-3 rounded-lg text-xs font-medium text-gray-400 hover:text-gray-200 hover:bg-white/[0.06] transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setShowSaveFilterInput(true)}
            disabled={!canSaveCurrentFilter}
            data-testid="kanban-sidebar-save-filter"
            title={
              canSaveCurrentFilter
                ? 'Save the current search, epic, label, and lead-user filters'
                : 'Add a search term, epic, label, or lead-user filter before saving'
            }
            className="w-full h-8 rounded-lg text-xs font-medium text-gray-300 hover:text-white bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.06] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            Save current filter…
          </button>
        )}
      </div>

      <div className="flex items-center justify-between gap-2 mb-2 px-2">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-gray-500 uppercase tracking-wider">
          <Target size={12} />
          Epics
        </div>
        {selectedEpicIds.size > 0 ? (
          <button
            type="button"
            onClick={clearEpicFilter}
            data-testid="kanban-sidebar-clear-epics"
            className="text-[11px] text-gray-500 hover:text-gray-300"
          >
            Clear ({selectedEpicIds.size})
          </button>
        ) : null}
      </div>

      {epics.length > 0 ? (
        <div
          className="mb-4 px-1 max-h-[180px] overflow-y-auto kanban-column-scroll rounded-xl border border-white/[0.06] bg-white/[0.02] p-1.5"
          data-testid="kanban-sidebar-epic-list"
        >
          <div className="flex flex-col gap-1">
            {epics.map((epic) => {
              const active = selectedEpicIds.has(epic.id);
              return (
                <button
                  key={epic.id}
                  type="button"
                  onClick={() => toggleEpic(epic.id)}
                  data-testid={`kanban-sidebar-epic-${epic.id}`}
                  className={`flex w-full items-center gap-2.5 px-2.5 py-2 rounded-lg text-left transition-colors ${
                    active ? 'bg-indigo-500/10' : 'hover:bg-white/[0.04]'
                  }`}
                >
                  <span
                    className={`inline-flex items-center justify-center w-4 h-4 rounded flex-shrink-0 ${
                      active ? 'text-indigo-300' : 'text-gray-600'
                    }`}
                  >
                    {active ? <CheckSquare size={14} /> : <Square size={14} />}
                  </span>
                  <span
                    className="w-2 h-2 rounded-full flex-shrink-0"
                    style={{ backgroundColor: epic.color || '#6B7280' }}
                  />
                  <span className="flex-1 min-w-0 truncate text-sm text-gray-200">{epic.name}</span>
                  {epic.autonomous === 1 ? (
                    <Zap size={12} className="text-emerald-400 flex-shrink-0" aria-hidden />
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="mb-4 px-3 py-2 text-xs text-gray-500 rounded-xl border border-white/[0.06] bg-white/[0.02]">
          No epics on the board yet.
        </div>
      )}

      <div className="flex items-center justify-between gap-2 mb-2 px-2">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-gray-500 uppercase tracking-wider">
          <Tag size={12} />
          Labels
        </div>
        {selectedLabels.size > 0 ? (
          <button
            type="button"
            onClick={clearLabelFilter}
            data-testid="kanban-sidebar-clear-labels"
            className="text-[11px] text-gray-500 hover:text-gray-300"
          >
            Clear ({selectedLabels.size})
          </button>
        ) : null}
      </div>

      <div className="relative mb-2 px-1">
        <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-600" />
        <input
          type="text"
          value={labelSearch}
          onChange={(e) => setLabelSearch(e.target.value)}
          placeholder="Filter labels…"
          data-testid="kanban-sidebar-label-search"
          className="w-full h-8 pl-8 pr-3 rounded-lg bg-white/[0.03] border border-white/[0.06] text-xs text-gray-300 placeholder-gray-600 focus:outline-none focus:border-white/[0.12]"
        />
      </div>

      {availableLabels.length > 0 ? (
        <div
          className="mb-4 px-1 max-h-[160px] overflow-y-auto kanban-column-scroll rounded-xl border border-white/[0.06] bg-white/[0.02] p-2.5"
          data-testid="kanban-sidebar-label-list"
        >
          <div className="flex flex-wrap gap-2">
            {filteredLabels.length === 0 ? (
              <p className="text-xs text-gray-500 px-1 py-1">No matching labels.</p>
            ) : (
              filteredLabels.map((label) => {
                const active = selectedLabels.has(label);
                return (
                  <button
                    key={label}
                    type="button"
                    onClick={() => toggleLabel(label)}
                    data-testid={`kanban-sidebar-label-${label}`}
                    className={`rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors ${
                      active
                        ? 'border-indigo-500/40 bg-indigo-500/15 text-indigo-200'
                        : 'border-white/[0.08] bg-white/[0.04] text-gray-400 hover:text-gray-200 hover:bg-white/[0.06]'
                    }`}
                  >
                    {label}
                  </button>
                );
              })
            )}
          </div>
        </div>
      ) : (
        <div className="mb-4 px-3 py-2 text-xs text-gray-500 rounded-xl border border-white/[0.06] bg-white/[0.02]">
          No labels on the board yet.
        </div>
      )}

      {assignableUsers.length > 0 ? (
        <div className="mb-2 px-1">
          <div className="flex items-center justify-between gap-2 mb-2 px-1">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-gray-500 uppercase tracking-wider">
              <User size={12} />
              Lead user
            </div>
            {selectedUserIds.size > 0 ? (
              <button
                type="button"
                onClick={clearUserFilter}
                data-testid="kanban-sidebar-clear-users"
                className="text-[11px] text-gray-500 hover:text-gray-300"
              >
                Clear ({selectedUserIds.size})
              </button>
            ) : null}
          </div>
          <div className="relative mb-2">
            <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-600" />
            <input
              type="text"
              value={userSearch}
              onChange={(e) => setUserSearch(e.target.value)}
              placeholder="Filter users…"
              data-testid="kanban-sidebar-user-search"
              className="w-full h-8 pl-8 pr-3 rounded-lg bg-white/[0.03] border border-white/[0.06] text-xs text-gray-300 placeholder-gray-600 focus:outline-none focus:border-white/[0.12]"
            />
          </div>
          {filteredUsers.length === 0 ? (
            <div className="px-1 py-2 text-xs text-gray-500">No matching users.</div>
          ) : (
            <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-2.5">
              <KanbanUserFilterChips
                users={filteredUsers}
                selectedUserIds={selectedUserIds}
                onToggle={toggleUser}
                onClear={clearUserFilter}
                testIdPrefix="kanban-sidebar-user"
              />
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
