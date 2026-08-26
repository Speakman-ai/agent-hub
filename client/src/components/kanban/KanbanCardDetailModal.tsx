import {
  X,
  MessageSquare,
  ExternalLink,
  Trash2,
  AlertTriangle,
  PlayCircle,
  Plus,
} from 'lucide-react';
import { api } from '../../utils/api';
import { cardOriginLabel, cardOriginDeepLink } from '@shared/utils/captureCard';
import { hasUnresolvedBlockers } from '../../utils/blockers';
import { MarkdownContent } from '../MarkdownRenderer';
import ReplayPlayerModal from '../ReplayPlayerModal';
import LinkedTodosPanel from './LinkedTodosPanel';
import type { KanbanCardDetailState } from '../../hooks/useKanbanCardDetail';

import EpicLeadUserField from '../EpicLeadUserField';
import type { AssignableUser } from '../../utils/kanbanUserFilter';

const PRIORITIES = ['urgent', 'high', 'medium', 'low'];

type Props = {
  detail: KanbanCardDetailState;
  agents: any[];
  assignableUsers?: AssignableUser[];
  onOpenEpic?: (epicId: string) => void;
};

export default function KanbanCardDetailModal({
  detail,
  agents,
  assignableUsers = [],
  onOpenEpic,
}: Props) {
  const {
    selectedCard,
    setSelectedCard,
    closeDetail,
    detailForm,
    setDetailForm,
    comments,
    cardReplay,
    watchingReplay,
    setWatchingReplay,
    newComment,
    setNewComment,
    saving,
    setSaving,
    confirmDelete,
    setConfirmDelete,
    assigning,
    setAssigning,
    showReassign,
    setShowReassign,
    unassigning,
    setUnassigning,
    showBlockerPicker,
    setShowBlockerPicker,
    blockerPickerQuery,
    setBlockerPickerQuery,
    blockerError,
    setBlockerError,
    descriptionEditing,
    setDescriptionEditing,
    modelConfig,
    projectAgents,
    epics,
    cards,
    handleSaveDetail,
    handleDeleteCard,
    handleAddComment,
    handleAddBlocker,
    handleRemoveBlocker,
    handleLinkCardEpic,
    openDetail,
    isCreating,
    cardTemplates,
    applyCardTemplate,
    onRefresh,
    onNavigateToSession,
    projectId,
    columns = [],
  } = detail;

  return (
    <>
      {selectedCard && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          data-testid="card-detail-modal"
        >
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/70 backdrop-blur-sm"
            onClick={() => closeDetail()}
          />
          {/* Panel */}
          <div className="relative w-full max-w-6xl h-[85vh] bg-gray-950 border border-white/10 rounded-2xl flex flex-col overflow-hidden shadow-2xl shadow-black/50">
            {/* Header */}
            <div className="shrink-0 flex items-center justify-between px-6 py-3.5 border-b border-white/[0.06] bg-gray-950/95">
              <div className="flex items-center gap-2 text-xs text-gray-500">
                <span className="font-medium uppercase tracking-wide">
                  {isCreating ? 'New card' : 'Card'}
                </span>
                {!isCreating && selectedCard?.id && (
                  <span className="font-mono text-gray-600 bg-white/[0.04] px-1.5 py-0.5 rounded">
                    #{String(selectedCard.id).slice(0, 8)}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={handleSaveDetail}
                  disabled={saving || !detailForm.title?.trim()}
                  className="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:bg-indigo-600/50 text-white rounded-lg text-sm font-medium transition-colors"
                >
                  {saving ? 'Saving…' : isCreating ? 'Create' : 'Save'}
                </button>
                <button
                  onClick={() => closeDetail()}
                  className="p-1.5 text-gray-500 hover:text-gray-200 hover:bg-white/[0.06] rounded-lg transition-colors"
                  aria-label="Close"
                >
                  <X size={18} />
                </button>
              </div>
            </div>
            {/* Body — two-column on lg+, stacked on smaller screens */}
            <div className="flex-1 overflow-y-auto">
              {hasUnresolvedBlockers(selectedCard) && (
                <div
                  className="mx-6 mt-4 flex items-start gap-2 rounded-lg border border-red-800 bg-red-900/30 px-3 py-2 text-sm text-red-300"
                  data-testid="blocker-banner"
                >
                  <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
                  <span>
                    This card is blocked by{' '}
                    {selectedCard.blockers.filter((b: any) => !b.done).length} unresolved card(s).
                    Starting work may cause issues.
                  </span>
                </div>
              )}
              <div className="grid grid-cols-1 lg:grid-cols-[1fr_300px] gap-6 p-6">
                {/* Main column: title + description */}
                <div className="min-w-0 flex flex-col gap-4">
                  <input
                    type="text"
                    value={detailForm.title}
                    onChange={(e: any) =>
                      setDetailForm((f: any) => ({ ...f, title: e.target.value }))
                    }
                    placeholder="Card title"
                    className="w-full bg-transparent border-0 border-b border-transparent hover:border-gray-800 focus:border-gray-700 px-0 py-1 text-2xl font-semibold text-white placeholder-gray-600 focus:outline-none"
                  />
                  <div>
                    <div className="flex items-center justify-between gap-2 mb-2">
                      <label className="text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Description
                      </label>
                      {descriptionEditing ? (
                        <button
                          type="button"
                          onClick={() => setDescriptionEditing(false)}
                          className="shrink-0 text-xs font-medium text-indigo-400 hover:text-indigo-300"
                        >
                          Preview
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setDescriptionEditing(true)}
                          className="shrink-0 text-xs font-medium text-indigo-400 hover:text-indigo-300"
                        >
                          Edit
                        </button>
                      )}
                    </div>
                    {descriptionEditing ? (
                      <textarea
                        data-testid="card-description-editor"
                        value={detailForm.description}
                        onChange={(e: any) =>
                          setDetailForm((f: any) => ({ ...f, description: e.target.value }))
                        }
                        rows={18}
                        placeholder="Add a description — problem, acceptance criteria, context..."
                        className="w-full bg-gray-950/60 border border-gray-800 rounded-lg px-4 py-3 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-gray-600 resize-y min-h-[320px] leading-relaxed font-sans"
                      />
                    ) : (
                      <div
                        data-testid="card-description-preview"
                        className="w-full min-h-[200px] max-h-[min(480px,55vh)] overflow-y-auto rounded-lg border border-gray-800 bg-gray-950/60 px-4 py-3 text-sm text-gray-200 leading-relaxed"
                      >
                        {detailForm.description?.trim() ? (
                          <div className="markdown-content">
                            <MarkdownContent content={detailForm.description} />
                          </div>
                        ) : (
                          <p className="text-gray-500 italic">No description yet.</p>
                        )}
                      </div>
                    )}
                  </div>
                </div>
                {/* Sidebar: metadata */}
                <aside className="flex flex-col gap-5 lg:border-l lg:border-white/[0.06] lg:pl-6">
                  {isCreating && cardTemplates.length > 0 ? (
                    <div>
                      <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">
                        Template
                      </label>
                      <select
                        defaultValue=""
                        data-testid="card-create-template"
                        onChange={(e: any) => {
                          const template = cardTemplates.find((t: any) => t.id === e.target.value);
                          if (template) applyCardTemplate(template);
                          e.target.value = '';
                        }}
                        className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-gray-500"
                      >
                        <option value="">Apply a template…</option>
                        {cardTemplates.map((template: any) => (
                          <option key={template.id} value={template.id}>
                            {template.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  ) : null}
                  {isCreating && columns.length > 0 ? (
                    <div>
                      <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">
                        Column
                      </label>
                      <select
                        value={selectedCard.column_id || ''}
                        onChange={(e: any) =>
                          setSelectedCard((c: any) => ({ ...c, column_id: e.target.value }))
                        }
                        data-testid="card-create-column"
                        className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-gray-500"
                      >
                        {columns.map((col: any) => (
                          <option key={col.id} value={col.id}>
                            {col.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  ) : null}
                  {/* Session replay (carried over from a converted bug ticket) */}
                  {!isCreating && cardReplay?.replayId ? (
                    <div>
                      <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">
                        Session replay
                      </label>
                      <button
                        type="button"
                        onClick={() => setWatchingReplay(true)}
                        data-testid="card-watch-replay-button"
                        className="inline-flex items-center gap-1.5 w-full justify-center text-xs bg-blue-600/90 hover:bg-blue-500 text-white px-3 py-1.5 rounded-lg transition-colors"
                      >
                        <PlayCircle size={13} />
                        Watch replay
                      </button>
                    </div>
                  ) : null}
                  {/* Origin — capture provenance (promoted from a todo, or
                      captured from a Gmail message / Calendar event). */}
                  {!isCreating && cardOriginLabel(selectedCard) ? (
                    <div>
                      <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">
                        Origin
                      </label>
                      {(() => {
                        const label = cardOriginLabel(selectedCard);
                        const link = cardOriginDeepLink(selectedCard);
                        const cls =
                          'inline-flex items-center gap-1 px-2 py-0.5 rounded border border-sky-800 bg-sky-900/30 text-sky-300 text-xs font-medium';
                        return link ? (
                          <a
                            href={link}
                            target="_blank"
                            rel="noreferrer"
                            data-testid="card-origin"
                            className={`${cls} hover:bg-sky-900/50`}
                          >
                            {label}
                            <ExternalLink size={11} />
                          </a>
                        ) : (
                          <span data-testid="card-origin" className={cls}>
                            {label}
                          </span>
                        );
                      })()}
                    </div>
                  ) : null}
                  {/* Linked-from todos — the caller's own personal todos that
                      point at this card (reverse of the todo's link badge). */}
                  {!isCreating ? (
                    <LinkedTodosPanel
                      targetType="card"
                      entity={selectedCard}
                      projectId={projectId}
                    />
                  ) : null}
                  {/* Priority */}
                  <div>
                    <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">
                      Priority
                    </label>
                    <select
                      value={detailForm.priority}
                      onChange={(e: any) =>
                        setDetailForm((f: any) => ({ ...f, priority: e.target.value }))
                      }
                      className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-gray-500"
                    >
                      {PRIORITIES.map((p: any) => (
                        <option key={p} value={p}>
                          {p}
                        </option>
                      ))}
                    </select>
                  </div>
                  {/* Agent */}
                  <div>
                    <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">
                      Agent
                    </label>
                    {selectedCard?.session_id && !showReassign ? (
                      <div>
                        <div className="flex items-center gap-2 mb-2 flex-wrap">
                          <span className="text-sm text-white">
                            {detailForm.assignee || 'Assigned'}
                          </span>
                          <span className="text-xs bg-emerald-900/40 text-emerald-400 px-2 py-0.5 rounded">
                            Session active
                          </span>
                        </div>
                        {/* Engine + model override display/edit for assigned cards.
                      The engine selector lists every engine the user is
                      authed for (modelConfig.engineValidModels keys
                      with non-empty model lists). When unset, the
                      spawn falls back to the assignee agent's shared
                      engine — same behaviour as before this picker
                      shipped. Changing the engine clears the model
                      selection so we can't save a model that's not
                      valid for the chosen engine. */}
                        {modelConfig &&
                          (() => {
                            const selAgent = agents.find(
                              (a: any) => a.name === (selectedCard.assignee || detailForm.assignee),
                            );
                            const agentEng = selAgent?.engine || 'claude-code';
                            const engineEntries = Object.entries(
                              modelConfig.engineValidModels || {},
                            ).filter(([, models]: any) => (models?.length ?? 0) > 0);
                            const effectiveEngine =
                              (detailForm.assign_engine && detailForm.assign_engine.trim()) ||
                              agentEng;
                            const modelOpts =
                              modelConfig.engineValidModels?.[effectiveEngine] || [];
                            if (engineEntries.length === 0 && modelOpts.length === 0) return null;
                            const engineChanged =
                              (detailForm.assign_engine || '') !==
                              (selectedCard.assign_engine || '');
                            const modelChanged =
                              (detailForm.assign_model || '') !== (selectedCard.assign_model || '');
                            return (
                              <div className="mb-3 space-y-2">
                                {engineEntries.length > 0 && (
                                  <div>
                                    <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-1">
                                      Session engine
                                    </label>
                                    <select
                                      data-testid="card-engine-select"
                                      value={detailForm.assign_engine || ''}
                                      onChange={(e: any) =>
                                        setDetailForm((f: any) => ({
                                          ...f,
                                          assign_engine: e.target.value,
                                          // Reset the model whenever the
                                          // engine changes — a saved
                                          // claude-code model is invalid
                                          // under codex-cli.
                                          assign_model: '',
                                        }))
                                      }
                                      className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-gray-500"
                                    >
                                      <option value="">Agent default ({agentEng})</option>
                                      {engineEntries.map(([eng]: any) => (
                                        <option key={eng} value={eng}>
                                          {eng}
                                        </option>
                                      ))}
                                    </select>
                                  </div>
                                )}
                                {modelOpts.length > 0 && (
                                  <div>
                                    <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-1">
                                      Session model
                                    </label>
                                    <select
                                      data-testid="card-model-select"
                                      value={detailForm.assign_model || ''}
                                      onChange={(e: any) =>
                                        setDetailForm((f: any) => ({
                                          ...f,
                                          assign_model: e.target.value,
                                        }))
                                      }
                                      className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-gray-500"
                                    >
                                      <option value="">Engine default</option>
                                      {modelOpts.map((m: any) => (
                                        <option key={m} value={m}>
                                          {m}
                                        </option>
                                      ))}
                                    </select>
                                  </div>
                                )}
                                {(engineChanged || modelChanged) && (
                                  <button
                                    onClick={async () => {
                                      setSaving(true);
                                      try {
                                        await api.updateCard(projectId, selectedCard.id, {
                                          assign_engine: detailForm.assign_engine || null,
                                          assign_model: detailForm.assign_model || null,
                                        });
                                        setSelectedCard((c: any) => ({
                                          ...c,
                                          assign_engine: detailForm.assign_engine || null,
                                          assign_model: detailForm.assign_model || null,
                                        }));
                                        onRefresh?.();
                                      } catch (err: any) {
                                        console.error(
                                          'Failed to update engine/model override:',
                                          err,
                                        );
                                      } finally {
                                        setSaving(false);
                                      }
                                    }}
                                    disabled={saving}
                                    className="w-full text-xs bg-indigo-700 hover:bg-indigo-600 text-white px-3 py-1 rounded-lg transition-colors disabled:opacity-50"
                                  >
                                    {saving ? 'Saving…' : 'Save override'}
                                  </button>
                                )}
                              </div>
                            );
                          })()}
                        <button
                          onClick={() => {
                            const agent = agents.find((a: any) => a.name === selectedCard.assignee);
                            if (agent && onNavigateToSession) {
                              onNavigateToSession(agent.id, selectedCard.session_id);
                            }
                          }}
                          className="w-full text-xs bg-indigo-600 hover:bg-indigo-500 text-white px-3 py-1.5 rounded-lg transition-colors"
                        >
                          Open Session
                        </button>
                        <button
                          onClick={() => {
                            setShowReassign(true);
                            setDetailForm((f: any) => ({
                              ...f,
                              assign_model: selectedCard.assign_model || '',
                              assign_engine: selectedCard.assign_engine || '',
                              assignee: selectedCard.assignee || f.assignee,
                            }));
                          }}
                          className="mt-2 w-full text-xs bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-200 px-3 py-1.5 rounded-lg transition-colors"
                        >
                          Reassign
                        </button>
                        <button
                          onClick={async () => {
                            if (!selectedCard) return;
                            setUnassigning(true);
                            try {
                              const updated = await api.unassignCard(projectId, selectedCard.id);
                              setSelectedCard(updated);
                              setDetailForm((f: any) => ({
                                ...f,
                                assignee: '',
                                assign_model: '',
                                assign_engine: '',
                              }));
                              setShowReassign(false);
                              onRefresh?.();
                            } catch (err: any) {
                              console.error('Failed to unassign card:', err);
                            } finally {
                              setUnassigning(false);
                            }
                          }}
                          disabled={unassigning}
                          className="mt-2 w-full text-xs bg-transparent hover:bg-red-900/30 border border-red-900/60 text-red-400 px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50"
                        >
                          {unassigning ? 'Unassigning...' : 'Unassign'}
                        </button>
                      </div>
                    ) : (
                      <div className="flex flex-col gap-2">
                        <select
                          value={detailForm.assignee}
                          onChange={(e: any) =>
                            setDetailForm((f: any) => ({
                              ...f,
                              assignee: e.target.value,
                              assign_model: '',
                              assign_engine: '',
                            }))
                          }
                          className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-gray-500"
                        >
                          <option value="">Unassigned</option>
                          {projectAgents.map((a: any) => (
                            <option key={a.id} value={a.name}>
                              {a.name}
                            </option>
                          ))}
                        </select>
                        {detailForm.assignee &&
                          modelConfig &&
                          (() => {
                            const selAgent = agents.find(
                              (a: any) => a.name === detailForm.assignee,
                            );
                            const agentEng = selAgent?.engine || 'claude-code';
                            const engineEntries = Object.entries(
                              modelConfig.engineValidModels || {},
                            ).filter(([, models]: any) => (models?.length ?? 0) > 0);
                            const effectiveEngine =
                              (detailForm.assign_engine && detailForm.assign_engine.trim()) ||
                              agentEng;
                            const modelOpts =
                              modelConfig.engineValidModels?.[effectiveEngine] || [];
                            if (engineEntries.length === 0 && modelOpts.length === 0) return null;
                            return (
                              <>
                                {engineEntries.length > 0 && (
                                  <div className="mt-2">
                                    <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">
                                      Session engine
                                    </label>
                                    <select
                                      data-testid="card-engine-select-new"
                                      value={detailForm.assign_engine || ''}
                                      onChange={(e: any) =>
                                        setDetailForm((f: any) => ({
                                          ...f,
                                          assign_engine: e.target.value,
                                          assign_model: '',
                                        }))
                                      }
                                      className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-gray-500"
                                    >
                                      <option value="">Agent default ({agentEng})</option>
                                      {engineEntries.map(([eng]: any) => (
                                        <option key={eng} value={eng}>
                                          {eng}
                                        </option>
                                      ))}
                                    </select>
                                  </div>
                                )}
                                {modelOpts.length > 0 && (
                                  <div className="mt-2">
                                    <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">
                                      Session model
                                    </label>
                                    <select
                                      data-testid="card-model-select-new"
                                      value={detailForm.assign_model || ''}
                                      onChange={(e: any) =>
                                        setDetailForm((f: any) => ({
                                          ...f,
                                          assign_model: e.target.value,
                                        }))
                                      }
                                      className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-gray-500"
                                    >
                                      <option value="">Engine default</option>
                                      {modelOpts.map((m: any) => (
                                        <option key={m} value={m}>
                                          {m}
                                        </option>
                                      ))}
                                    </select>
                                  </div>
                                )}
                              </>
                            );
                          })()}
                        {detailForm.assignee && (
                          <label
                            className="mt-2 inline-flex items-center gap-2 text-xs text-gray-300 cursor-pointer select-none"
                            title="Leave as-is to use the project's auto-merge default. Check to run the spawned session at Auto Merge — build, review, test, push, and auto-merge once gates pass."
                          >
                            <input
                              type="checkbox"
                              checked={!!detailForm.auto_merge}
                              onChange={(e) =>
                                setDetailForm((f) => ({
                                  ...f,
                                  auto_merge: e.target.checked,
                                  auto_merge_touched: true,
                                }))
                              }
                              data-testid="card-auto-merge-new"
                              className="h-3.5 w-3.5 rounded border-gray-600 bg-gray-800 accent-indigo-500"
                            />
                            Auto-merge
                          </label>
                        )}
                        {detailForm.assignee && (
                          <textarea
                            value={detailForm.assign_comment || ''}
                            onChange={(e) =>
                              setDetailForm((f) => ({ ...f, assign_comment: e.target.value }))
                            }
                            rows={2}
                            maxLength={4000}
                            placeholder="Comments / instructions for the agent (optional)"
                            aria-label="Comments for the assignee"
                            data-testid="card-assign-comment"
                            className="w-full text-xs bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white placeholder-gray-500 focus:outline-none focus:border-gray-500 resize-y"
                          />
                        )}
                        {detailForm.assignee && (
                          <button
                            onClick={async () => {
                              const agent = agents.find((a: any) => a.name === detailForm.assignee);
                              if (!agent) return;
                              setAssigning(true);
                              try {
                                const assignOpts: Record<string, any> = {};
                                if (detailForm.auto_merge_touched)
                                  assignOpts.autoMerge = !!detailForm.auto_merge;
                                if (detailForm.assign_model?.trim())
                                  assignOpts.model = detailForm.assign_model.trim();
                                if (detailForm.assign_engine?.trim())
                                  assignOpts.engine = detailForm.assign_engine.trim();
                                if (detailForm.assign_comment?.trim())
                                  assignOpts.comment = detailForm.assign_comment.trim();

                                let cardId = selectedCard?.id;
                                if (isCreating) {
                                  if (!detailForm.title?.trim() || !selectedCard?.column_id) return;
                                  const created = await api.createCard(projectId, {
                                    title: detailForm.title.trim(),
                                    description: detailForm.description || null,
                                    priority: detailForm.priority,
                                    labels: detailForm.labels || null,
                                    columnId: selectedCard.column_id,
                                    createdBy: 'user',
                                    epicId: detailForm.epic_id || null,
                                    githubIssueUrl: detailForm.github_issue_url || null,
                                    assignedUserId: detailForm.assigned_user_id || null,
                                  });
                                  cardId = created.id;
                                  const persistedCard = { ...selectedCard, ...created };
                                  delete persistedCard.__draft;
                                  setSelectedCard(persistedCard);
                                }

                                const prUrl = detailForm.pr_url?.trim();
                                if (cardId && prUrl && selectedCard?.pr_url !== prUrl) {
                                  const updated = await api.updateCard(projectId, cardId, {
                                    prUrl,
                                  });
                                  setSelectedCard((current: any) =>
                                    current?.id === cardId
                                      ? {
                                          ...current,
                                          ...(updated || {}),
                                          pr_url: updated?.pr_url ?? prUrl,
                                        }
                                      : current,
                                  );
                                }

                                const result = await api.assignCard(
                                  projectId,
                                  cardId,
                                  agent.id,
                                  assignOpts,
                                );
                                closeDetail();
                                setShowReassign(false);
                                onRefresh?.();
                                if (onNavigateToSession) {
                                  onNavigateToSession(agent.id, result.sessionId);
                                }
                              } catch (err: any) {
                                console.error('Failed to assign card:', err);
                              } finally {
                                setAssigning(false);
                              }
                            }}
                            disabled={assigning || (isCreating && !detailForm.title?.trim())}
                            className="w-full text-xs bg-indigo-600 hover:bg-indigo-500 text-white px-3 py-1.5 rounded-lg transition-colors whitespace-nowrap disabled:opacity-50"
                          >
                            {assigning
                              ? 'Starting...'
                              : isCreating
                                ? 'Create & Start'
                                : selectedCard?.session_id
                                  ? 'Reassign & Start'
                                  : 'Assign & Start'}
                          </button>
                        )}
                        {selectedCard?.session_id && (
                          <button
                            onClick={() => setShowReassign(false)}
                            className="w-full text-xs bg-transparent hover:bg-gray-800 border border-gray-700 text-gray-400 px-3 py-1.5 rounded-lg transition-colors"
                          >
                            Cancel
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                  {assignableUsers.length > 0 ? (
                    <EpicLeadUserField
                      users={assignableUsers}
                      value={detailForm.assigned_user_id || ''}
                      onChange={(assigned_user_id) =>
                        setDetailForm((f: any) => ({ ...f, assigned_user_id }))
                      }
                    />
                  ) : null}
                  {/* Epic */}
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Epic
                      </label>
                      {detailForm.epic_id && onOpenEpic ? (
                        <button
                          type="button"
                          onClick={() => onOpenEpic(detailForm.epic_id)}
                          className="inline-flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300"
                        >
                          Open epic
                          <ExternalLink size={12} />
                        </button>
                      ) : null}
                    </div>
                    <select
                      value={detailForm.epic_id}
                      onChange={(e: any) => handleLinkCardEpic(e.target.value)}
                      className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-gray-500"
                    >
                      <option value="">None</option>
                      {epics.map((e: any) => (
                        <option key={e.id} value={e.id}>
                          {e.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  {/* Labels */}
                  <div>
                    <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">
                      Labels
                    </label>
                    <input
                      type="text"
                      value={detailForm.labels}
                      onChange={(e: any) =>
                        setDetailForm((f: any) => ({ ...f, labels: e.target.value }))
                      }
                      placeholder="bug, feature, docs"
                      className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-gray-500"
                    />
                  </div>
                  {/* Blockers */}
                  <div data-testid="blockers-section">
                    <div className="flex items-center justify-between mb-2">
                      <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Blocked by
                      </label>
                      {!isCreating ? (
                        <button
                          type="button"
                          onClick={() => {
                            setShowBlockerPicker((v: any) => !v);
                            setBlockerPickerQuery('');
                            setBlockerError(null);
                          }}
                          className="text-xs text-gray-500 hover:text-gray-300 flex items-center gap-1"
                        >
                          <Plus size={12} />
                          Add
                        </button>
                      ) : null}
                    </div>
                    {isCreating ? (
                      <p className="text-xs text-gray-600">Save the card to add blockers.</p>
                    ) : selectedCard?.blockers && selectedCard.blockers.length > 0 ? (
                      <ul className="space-y-1">
                        {selectedCard.blockers.map((b: any) => (
                          <li
                            key={b.id}
                            className={`group flex items-center gap-2 rounded px-2 py-1.5 text-xs border-l-2 ${
                              b.done
                                ? 'bg-gray-800/50 text-gray-500 border-emerald-800'
                                : 'bg-gray-800 text-gray-300 border-red-700'
                            }`}
                          >
                            <button
                              type="button"
                              onClick={() => {
                                const target = cards.find((c: any) => c.id === b.id);
                                if (target) openDetail(target);
                              }}
                              className="flex-1 min-w-0 text-left truncate hover:underline"
                              title={b.title}
                            >
                              {b.done ? '✓ ' : ''}
                              {b.title}
                            </button>
                            <button
                              type="button"
                              onClick={() => handleRemoveBlocker(b.id)}
                              className="opacity-0 group-hover:opacity-100 text-gray-500 hover:text-red-400 transition-opacity"
                              aria-label="Remove blocker"
                            >
                              <X size={12} />
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-xs text-gray-600">No blockers</p>
                    )}
                    {showBlockerPicker && (
                      <div className="mt-2 rounded-lg border border-gray-700 bg-gray-900 p-2">
                        <input
                          type="text"
                          value={blockerPickerQuery}
                          onChange={(e: any) => setBlockerPickerQuery(e.target.value)}
                          placeholder="Search cards..."
                          autoFocus
                          className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-white placeholder-gray-600 focus:outline-none focus:border-gray-500 mb-2"
                        />
                        <div className="max-h-40 overflow-y-auto space-y-1">
                          {(() => {
                            const q = blockerPickerQuery.toLowerCase().trim();
                            const excluded = new Set([
                              selectedCard.id,
                              ...(selectedCard.blockers || []).map((b: any) => b.id),
                            ]);
                            const options = cards
                              .filter((c: any) => !excluded.has(c.id))
                              .filter((c: any) => !q || c.title.toLowerCase().includes(q))
                              .slice(0, 20);
                            if (options.length === 0) {
                              return (
                                <p className="text-xs text-gray-600 px-1 py-1">No matching cards</p>
                              );
                            }
                            return options.map((c: any) => (
                              <button
                                key={c.id}
                                type="button"
                                onClick={() => handleAddBlocker(c.id)}
                                className="w-full text-left text-xs text-gray-300 hover:bg-gray-800 rounded px-2 py-1 truncate"
                              >
                                {c.title}
                              </button>
                            ));
                          })()}
                        </div>
                      </div>
                    )}
                    {blockerError && <p className="mt-1 text-xs text-red-400">{blockerError}</p>}
                  </div>
                  {/* Blocks (inverse) */}
                  {selectedCard?.blocks && selectedCard.blocks.length > 0 && (
                    <div data-testid="blocks-section">
                      <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">
                        Blocks
                      </label>
                      <ul className="space-y-1">
                        {selectedCard.blocks.map((b: any) => (
                          <li
                            key={b.id}
                            className="bg-gray-800/60 text-gray-400 text-xs rounded px-2 py-1.5"
                          >
                            <button
                              type="button"
                              onClick={() => {
                                const target = cards.find((c: any) => c.id === b.id);
                                if (target) openDetail(target);
                              }}
                              className="w-full text-left truncate hover:underline"
                              title={b.title}
                            >
                              {b.title}
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {/* GitHub Issue URL */}
                  <div>
                    <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">
                      GitHub Issue URL
                    </label>
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        value={detailForm.github_issue_url}
                        onChange={(e: any) =>
                          setDetailForm((f: any) => ({ ...f, github_issue_url: e.target.value }))
                        }
                        placeholder="https://github.com/..."
                        className="flex-1 min-w-0 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-gray-500"
                      />
                      {detailForm.github_issue_url && (
                        <a
                          href={detailForm.github_issue_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-gray-500 hover:text-gray-300 shrink-0"
                        >
                          <ExternalLink size={16} />
                        </a>
                      )}
                    </div>
                  </div>
                  {/* PR URL */}
                  <div>
                    <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">
                      Pull Request
                    </label>
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        value={detailForm.pr_url}
                        onChange={(e: any) =>
                          setDetailForm((f: any) => ({ ...f, pr_url: e.target.value }))
                        }
                        placeholder="https://github.com/.../pull/123"
                        className="flex-1 min-w-0 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-gray-500"
                      />
                      {detailForm.pr_url && (
                        <a
                          href={detailForm.pr_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-gray-500 hover:text-gray-300 shrink-0"
                        >
                          <ExternalLink size={16} />
                        </a>
                      )}
                    </div>
                  </div>
                  {/* Timestamps */}
                  {(selectedCard?.created_at || selectedCard?.updated_at) && (
                    <div className="text-xs text-gray-600 space-y-1 pt-1">
                      {selectedCard?.created_at && (
                        <div>
                          <span className="text-gray-500">Created:</span>{' '}
                          {new Date(selectedCard.created_at).toLocaleString()}
                        </div>
                      )}
                      {selectedCard?.updated_at && (
                        <div>
                          <span className="text-gray-500">Updated:</span>{' '}
                          {new Date(selectedCard.updated_at).toLocaleString()}
                        </div>
                      )}
                    </div>
                  )}
                  {/* Delete */}
                  {!isCreating ? (
                    <div className="border-t border-gray-800 pt-4 mt-auto">
                      {confirmDelete ? (
                        <div className="flex flex-col gap-2">
                          <span className="text-sm text-red-400">Delete this card?</span>
                          <div className="flex items-center gap-2">
                            <button
                              onClick={handleDeleteCard}
                              className="px-3 py-1.5 bg-red-600 hover:bg-red-500 text-white rounded text-xs transition-colors"
                            >
                              Confirm
                            </button>
                            <button
                              onClick={() => setConfirmDelete(false)}
                              className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-400 rounded text-xs transition-colors"
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <button
                          onClick={() => setConfirmDelete(true)}
                          className="flex items-center gap-1.5 text-sm text-gray-600 hover:text-red-400 transition-colors"
                        >
                          <Trash2 size={14} />
                          Delete card
                        </button>
                      )}
                    </div>
                  ) : null}
                </aside>
              </div>
            </div>
            {/* Comments — full-width footer */}
            <div className="shrink-0 border-t border-gray-800 bg-gray-950/40 px-6 py-4 max-h-[40%] overflow-y-auto">
              <div className="flex items-center gap-2 mb-3">
                <MessageSquare size={14} className="text-gray-500" />
                <span className="text-sm font-medium text-gray-400">
                  Comments ({comments.length})
                </span>
              </div>
              <div className="space-y-3 mb-4">
                {comments.map((c: any) => (
                  <div key={c.id} className="bg-gray-800 rounded-lg p-3">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-xs font-medium text-gray-300">{c.author}</span>
                      <span className="text-xs text-gray-600">
                        {new Date(c.created_at).toLocaleString()}
                      </span>
                    </div>
                    <p className="text-sm text-gray-400 whitespace-pre-wrap">{c.content}</p>
                  </div>
                ))}
              </div>
              {isCreating ? (
                <p className="text-xs text-gray-600">Save the card to add comments.</p>
              ) : (
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={newComment}
                    onChange={(e: any) => setNewComment(e.target.value)}
                    onKeyDown={(e: any) => {
                      if (e.key === 'Enter') handleAddComment();
                    }}
                    placeholder="Add a comment..."
                    className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-gray-500"
                  />
                  <button
                    onClick={handleAddComment}
                    className="px-3 py-2 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg text-sm transition-colors"
                  >
                    Send
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {watchingReplay && cardReplay?.replayId && (
        <ReplayPlayerModal
          replayId={cardReplay.replayId}
          title={selectedCard ? `Replay · ${selectedCard.title}` : 'Session replay'}
          onClose={() => setWatchingReplay(false)}
        />
      )}
    </>
  );
}
