import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ChevronRight, LayoutGrid, Plus, Trash2, Zap } from 'lucide-react';
import { api } from '../utils/api.js';
import { epicFormToCreateBody, epicFormToUpdateBody } from '../utils/epics.js';
import EpicDetailsPanel, { EMPTY_EPIC_FORM } from './EpicDetailsPanel.jsx';
import EpicAutonomousPanel, {
  EMPTY_AUTONOMOUS_FORM,
  epicToAutonomousForm,
} from './EpicAutonomousPanel.jsx';

const PRIORITIES = ['urgent', 'high', 'medium', 'low'];

const PRIORITY_STYLES = {
  urgent: 'bg-red-500/10 text-red-300 ring-1 ring-inset ring-red-500/25',
  high: 'bg-orange-500/10 text-orange-300 ring-1 ring-inset ring-orange-500/25',
  medium: 'bg-sky-500/10 text-sky-300 ring-1 ring-inset ring-sky-500/25',
  low: 'bg-gray-500/10 text-gray-400 ring-1 ring-inset ring-gray-500/20',
};

function SectionCard({ title, description, children, action }) {
  return (
    <section className="rounded-xl border border-white/[0.08] bg-white/[0.02] overflow-hidden">
      <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-white/[0.06]">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-gray-100">{title}</h2>
          {description ? <p className="text-xs text-gray-500 mt-0.5">{description}</p> : null}
        </div>
        {action}
      </div>
      <div className="px-5 py-5">{children}</div>
    </section>
  );
}

/**
 * Dedicated epic management screen — list epics, edit settings inline, and add tickets
 * linked to an epic without modal popups.
 */
export default function EpicView({
  projectId,
  epicId,
  project,
  refreshKey,
  onBackToBoard,
  onOpenEpic,
  onOpenEpicsList,
}) {
  const [columns, setColumns] = useState([]);
  const [cards, setCards] = useState([]);
  const [epics, setEpics] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [modelConfig, setModelConfig] = useState(null);

  const [detailsForm, setDetailsForm] = useState({ ...EMPTY_EPIC_FORM });
  const [autonomousForm, setAutonomousForm] = useState({ ...EMPTY_AUTONOMOUS_FORM });
  const [detailsSaving, setDetailsSaving] = useState(false);
  const [autonomousSaving, setAutonomousSaving] = useState(false);
  const [creatingEpic, setCreatingEpic] = useState(false);
  const [newEpicForm, setNewEpicForm] = useState({ ...EMPTY_EPIC_FORM });

  const [newTicketTitle, setNewTicketTitle] = useState('');
  const [newTicketPriority, setNewTicketPriority] = useState('medium');
  const [addingTicket, setAddingTicket] = useState(false);
  const ticketInputRef = useRef(null);

  const epic = epicId ? epics.find((e) => e.id === epicId) : null;

  const fetchBoard = useCallback(async () => {
    if (!projectId) return;
    try {
      const data = await api.getBoard(projectId);
      setColumns(data.columns || []);
      setCards(data.cards || []);
      setEpics(data.epics || []);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    if (typeof api.getModelConfig !== 'function') return;
    api
      .getModelConfig()
      .then(setModelConfig)
      .catch(() => setModelConfig(null));
  }, []);

  useEffect(() => {
    setLoading(true);
    fetchBoard();
  }, [fetchBoard, projectId]);

  const isFirstRefresh = useRef(true);
  useEffect(() => {
    if (isFirstRefresh.current) {
      isFirstRefresh.current = false;
      return;
    }
    if (!projectId) return;
    fetchBoard();
  }, [refreshKey, projectId, fetchBoard]);

  useEffect(() => {
    if (!epic) {
      setDetailsForm({ ...EMPTY_EPIC_FORM });
      setAutonomousForm({ ...EMPTY_AUTONOMOUS_FORM });
      return;
    }
    setDetailsForm({
      name: epic.name,
      description: epic.description || '',
      color: epic.color || EMPTY_EPIC_FORM.color,
    });
    setAutonomousForm(epicToAutonomousForm(epic));
  }, [epic?.id, epic?.name, epic?.description, epic?.color, epic?.autonomous]);

  const doneColumnIds = useMemo(
    () => new Set(columns.filter((c) => c.name.toLowerCase() === 'done').map((c) => c.id)),
    [columns],
  );

  const epicCardCount = (id) =>
    cards.filter((c) => c.epic_id === id && !doneColumnIds.has(c.column_id)).length;

  const epicTickets = useMemo(() => {
    if (!epicId) return [];
    return cards
      .filter((c) => c.epic_id === epicId)
      .sort((a, b) => {
        const colA = columns.find((c) => c.id === a.column_id);
        const colB = columns.find((c) => c.id === b.column_id);
        const posA = colA?.position ?? 0;
        const posB = colB?.position ?? 0;
        if (posA !== posB) return posA - posB;
        return (a.position ?? 0) - (b.position ?? 0);
      });
  }, [cards, columns, epicId]);

  const defaultColumnId = useMemo(() => {
    const backlog = columns.find((c) => c.name.toLowerCase() === 'backlog');
    return backlog?.id || columns[0]?.id || null;
  }, [columns]);

  const columnName = (columnId) => columns.find((c) => c.id === columnId)?.name || 'Unknown';

  const handleCreateEpic = async () => {
    if (!newEpicForm.name.trim() || creatingEpic) return;
    setCreatingEpic(true);
    try {
      const created = await api.createEpic(projectId, epicFormToCreateBody(newEpicForm));
      setNewEpicForm({ ...EMPTY_EPIC_FORM });
      await fetchBoard();
      if (created?.id) onOpenEpic(created.id);
    } catch (err) {
      console.error('Failed to create epic:', err);
    } finally {
      setCreatingEpic(false);
    }
  };

  const handleSaveDetails = async () => {
    if (!epic || !detailsForm.name.trim() || detailsSaving) return;
    setDetailsSaving(true);
    try {
      await api.updateEpic(
        projectId,
        epic.id,
        epicFormToUpdateBody({
          ...detailsForm,
          ...epicToAutonomousForm(epic),
        }),
      );
      await fetchBoard();
    } catch (err) {
      console.error('Failed to save epic:', err);
    } finally {
      setDetailsSaving(false);
    }
  };

  const handleSaveAutonomous = async () => {
    if (!epic || autonomousSaving) return;
    setAutonomousSaving(true);
    try {
      await api.updateEpic(
        projectId,
        epic.id,
        epicFormToUpdateBody({
          name: epic.name,
          description: epic.description || '',
          color: epic.color || EMPTY_EPIC_FORM.color,
          ...autonomousForm,
        }),
      );
      await fetchBoard();
    } catch (err) {
      console.error('Failed to save autonomous settings:', err);
    } finally {
      setAutonomousSaving(false);
    }
  };

  const handleDeleteEpic = async () => {
    if (!epic || detailsSaving || autonomousSaving) return;
    if (!window.confirm(`Delete epic "${epic.name}"? Cards will be unlinked.`)) return;
    setDetailsSaving(true);
    try {
      await api.deleteEpic(projectId, epic.id);
      onOpenEpicsList();
      await fetchBoard();
    } catch (err) {
      console.error('Failed to delete epic:', err);
    } finally {
      setDetailsSaving(false);
    }
  };

  const handleAddTicket = async (e) => {
    e?.preventDefault();
    if (!epicId || !newTicketTitle.trim() || !defaultColumnId || addingTicket) return;
    setAddingTicket(true);
    try {
      await api.createCard(projectId, {
        title: newTicketTitle.trim(),
        priority: newTicketPriority,
        columnId: defaultColumnId,
        epicId,
        createdBy: 'user',
      });
      setNewTicketTitle('');
      setNewTicketPriority('medium');
      await fetchBoard();
      ticketInputRef.current?.focus();
    } catch (err) {
      console.error('Failed to create ticket:', err);
    } finally {
      setAddingTicket(false);
    }
  };

  if (loading) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 bg-gray-950 text-gray-500">
        <div className="h-8 w-8 rounded-full border-2 border-gray-700 border-t-indigo-500 animate-spin" />
        <p className="text-sm">Loading epics…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center bg-gray-950 text-gray-400">
        <div className="text-center max-w-sm px-6">
          <p className="mb-1 text-base font-medium text-gray-200">Failed to load epics</p>
          <p className="text-sm text-gray-500">{error}</p>
        </div>
      </div>
    );
  }

  if (epicId && !epic) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4 bg-gray-950 text-gray-400">
        <p>Epic not found.</p>
        <button
          type="button"
          onClick={onOpenEpicsList}
          className="px-4 py-2 text-sm text-gray-200 bg-white/[0.06] hover:bg-white/[0.1] rounded-lg"
        >
          Back to epics
        </button>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col bg-gray-950 min-h-0">
      <div className="flex items-center justify-between gap-3 px-5 py-3.5 border-b border-white/[0.06] bg-gray-950/90 backdrop-blur-sm">
        <div className="flex items-center gap-2 min-w-0">
          <button
            type="button"
            onClick={epicId ? onOpenEpicsList : onBackToBoard}
            className="flex items-center gap-1.5 h-9 px-2.5 rounded-lg text-xs font-medium text-gray-400 hover:text-gray-200 hover:bg-white/[0.06] transition-colors"
          >
            <ArrowLeft size={14} />
            {epicId ? 'All epics' : 'Board'}
          </button>
          {project?.color && (
            <span
              className="w-2 h-2 rounded-full ring-2 ring-white/10"
              style={{ backgroundColor: project.color }}
            />
          )}
          <div className="min-w-0">
            <h1 className="text-base font-semibold text-gray-100 truncate">
              {epicId ? epic.name : 'Epics'}
            </h1>
            <p className="text-xs text-gray-500 truncate">
              {epicId
                ? `${epicTickets.length} ticket${epicTickets.length !== 1 ? 's' : ''}`
                : `${epics.length} epic${epics.length !== 1 ? 's' : ''} · ${project?.name || 'Project'}`}
            </p>
          </div>
        </div>
        {epicId && epic ? (
          <div className="flex items-center gap-2">
            {epic.autonomous === 1 && (
              <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-300 bg-emerald-500/10 px-2 py-1 rounded-md">
                <Zap size={11} />
                Autonomous
              </span>
            )}
            <span
              className="w-3 h-3 rounded-full ring-1 ring-white/10"
              style={{ backgroundColor: epic.color }}
            />
          </div>
        ) : null}
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-6xl mx-auto p-5 space-y-5">
          {!epicId ? (
            <>
              <SectionCard
                title="New epic"
                description="Create an epic, then add tickets on its detail page."
                action={
                  <button
                    type="button"
                    onClick={handleCreateEpic}
                    disabled={!newEpicForm.name.trim() || creatingEpic}
                    data-testid="epic-create-button"
                    className="px-3 py-1.5 text-xs font-medium bg-indigo-600 hover:bg-indigo-500 disabled:bg-indigo-600/40 text-white rounded-lg transition-colors"
                  >
                    {creatingEpic ? 'Creating…' : 'Create epic'}
                  </button>
                }
              >
                <EpicDetailsPanel
                  form={newEpicForm}
                  onChange={(patch) => setNewEpicForm((f) => ({ ...f, ...patch }))}
                  autoFocusName
                />
              </SectionCard>

              <SectionCard
                title="Your epics"
                description="Open an epic to manage tickets and settings."
              >
                {epics.length === 0 ? (
                  <p className="text-sm text-gray-500">No epics yet. Create one above.</p>
                ) : (
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {epics.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => onOpenEpic(item.id)}
                        data-testid={`epic-list-item-${item.id}`}
                        className="text-left rounded-xl border border-white/[0.08] bg-white/[0.03] hover:bg-white/[0.05] hover:border-white/[0.12] p-4 transition-all"
                      >
                        <div className="flex items-start gap-3">
                          <span
                            className="mt-0.5 w-3 h-3 rounded-full ring-1 ring-white/10 flex-shrink-0"
                            style={{ backgroundColor: item.color }}
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium text-gray-100 truncate">
                                {item.name}
                              </span>
                              {item.autonomous === 1 && (
                                <Zap size={12} className="text-emerald-400 flex-shrink-0" />
                              )}
                            </div>
                            {item.description ? (
                              <p className="text-xs text-gray-500 mt-1 line-clamp-2">
                                {item.description}
                              </p>
                            ) : null}
                            <p className="text-[11px] text-gray-500 mt-2">
                              {epicCardCount(item.id)} active ticket
                              {epicCardCount(item.id) !== 1 ? 's' : ''}
                            </p>
                          </div>
                          <ChevronRight size={16} className="text-gray-600 flex-shrink-0 mt-0.5" />
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </SectionCard>
            </>
          ) : (
            <>
              <SectionCard
                title="Tickets"
                description="Add cards directly to this epic. New tickets land in Backlog."
                action={
                  <button
                    type="button"
                    onClick={onBackToBoard}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-gray-400 hover:text-gray-200 hover:bg-white/[0.06] rounded-lg transition-colors"
                  >
                    <LayoutGrid size={12} />
                    View board
                  </button>
                }
              >
                <form onSubmit={handleAddTicket} className="flex flex-wrap items-end gap-2 mb-5">
                  <div className="flex-1 min-w-[220px]">
                    <label htmlFor="new-ticket-title" className="sr-only">
                      Ticket title
                    </label>
                    <input
                      ref={ticketInputRef}
                      id="new-ticket-title"
                      type="text"
                      value={newTicketTitle}
                      onChange={(e) => setNewTicketTitle(e.target.value)}
                      placeholder="Ticket title…"
                      data-testid="epic-add-ticket-input"
                      className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2.5 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-indigo-500/40 focus:border-indigo-500/40"
                    />
                  </div>
                  <select
                    value={newTicketPriority}
                    onChange={(e) => setNewTicketPriority(e.target.value)}
                    className="h-[42px] bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 text-sm text-gray-200 focus:outline-none"
                  >
                    {PRIORITIES.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                  <button
                    type="submit"
                    disabled={!newTicketTitle.trim() || addingTicket || !defaultColumnId}
                    data-testid="epic-add-ticket-button"
                    className="inline-flex items-center gap-1.5 h-[42px] px-4 text-sm font-medium bg-indigo-600 hover:bg-indigo-500 disabled:bg-indigo-600/40 text-white rounded-lg transition-colors"
                  >
                    <Plus size={14} />
                    {addingTicket ? 'Adding…' : 'Add ticket'}
                  </button>
                </form>

                {epicTickets.length === 0 ? (
                  <p className="text-sm text-gray-500">No tickets in this epic yet.</p>
                ) : (
                  <ul className="space-y-2">
                    {epicTickets.map((ticket) => (
                      <li
                        key={ticket.id}
                        className="flex items-center gap-3 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2.5"
                        data-testid={`epic-ticket-${ticket.id}`}
                      >
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium text-gray-100 truncate">
                            {ticket.title}
                          </p>
                          <p className="text-xs text-gray-500 mt-0.5">
                            {columnName(ticket.column_id)}
                          </p>
                        </div>
                        {ticket.priority && (
                          <span
                            className={`text-[10px] font-medium uppercase tracking-wide px-1.5 py-0.5 rounded-md ${
                              PRIORITY_STYLES[ticket.priority] || PRIORITY_STYLES.medium
                            }`}
                          >
                            {ticket.priority}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </SectionCard>

              <div className="grid gap-5 lg:grid-cols-2">
                <SectionCard
                  title="Epic details"
                  description="Name, description, and color."
                  action={
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={handleDeleteEpic}
                        disabled={detailsSaving || autonomousSaving}
                        data-testid="epic-delete-button"
                        className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-red-400 hover:bg-red-500/10 rounded-lg transition-colors disabled:opacity-50"
                      >
                        <Trash2 size={12} />
                        Delete
                      </button>
                      <button
                        type="button"
                        onClick={handleSaveDetails}
                        disabled={!detailsForm.name.trim() || detailsSaving}
                        data-testid="epic-save-button"
                        className="px-3 py-1.5 text-xs font-medium bg-indigo-600 hover:bg-indigo-500 disabled:bg-indigo-600/40 text-white rounded-lg transition-colors"
                      >
                        {detailsSaving ? 'Saving…' : 'Save'}
                      </button>
                    </div>
                  }
                >
                  <EpicDetailsPanel
                    form={detailsForm}
                    onChange={(patch) => setDetailsForm((f) => ({ ...f, ...patch }))}
                  />
                </SectionCard>

                <SectionCard
                  title="Autonomous dispatch"
                  description="PR base branch, auto-assign, concurrency, and Auto Merge."
                  action={
                    <button
                      type="button"
                      onClick={handleSaveAutonomous}
                      disabled={autonomousSaving}
                      data-testid="autonomous-save-button"
                      className="px-3 py-1.5 text-xs font-medium bg-emerald-600 hover:bg-emerald-500 disabled:bg-emerald-600/40 text-white rounded-lg transition-colors"
                    >
                      {autonomousSaving ? 'Saving…' : 'Save'}
                    </button>
                  }
                >
                  <EpicAutonomousPanel
                    form={autonomousForm}
                    onChange={(patch) => setAutonomousForm((f) => ({ ...f, ...patch }))}
                    modelConfig={modelConfig}
                  />
                </SectionCard>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
