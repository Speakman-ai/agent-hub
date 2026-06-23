import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { api } from '../utils/api';
import { ScanEye, FileText, Pencil, PenLine, Save, Loader2 } from 'lucide-react';
import PerUserModelSelect from './PerUserModelSelect';

// Per-project page for editing the reviewer agent's markdown context files
// (served by the existing GET/PUT /api/agents/:agentId/context endpoints).
export default function ReviewerPage({ projectId, projects = [], onAgentsChange }: any) {
  const project = useMemo(
    () => projects.find((p: any) => p.id === projectId) || null,
    [projects, projectId],
  );

  const reviewerAgent = useMemo(() => {
    const agents = project && Array.isArray(project.agents) ? project.agents : [];
    return agents.find((a: any) => a.role === 'reviewer') || null;
  }, [project]);

  const reviewerAgentId = reviewerAgent ? reviewerAgent.id : null;

  const [context, setContext] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<any>(null);
  const [modelConfig, setModelConfig] = useState<any>(null);
  const [modelConfigError, setModelConfigError] = useState<any>(null);
  const [reviewerDraft, setReviewerDraft] = useState({ engine: 'claude-code', model: '' });
  const [savingModel, setSavingModel] = useState(false);
  const [modelSaveStatus, setModelSaveStatus] = useState<any>(null);
  // Per-user, per-agent default-model picks (`{ [agentId]: modelId }`). The
  // reviewer Model dropdown writes the caller's own pick here — it only
  // changes the model the current user's reviewer sessions spawn under.
  const [modelOverrides, setModelOverrides] = useState<Record<string, any>>({});
  const [modelOverrideSaving, setModelOverrideSaving] = useState(false);
  const [modelOverrideSaved, setModelOverrideSaved] = useState(false);
  // Serialize this page's reviewer-model writes so rapid changes land in order.
  const modelSaveChain = useRef(Promise.resolve());

  useEffect(() => {
    let cancelled = false;
    setModelConfigError(null);
    api
      .getModelConfig()
      .then((cfg: any) => {
        if (!cancelled) setModelConfig(cfg || null);
      })
      .catch((err: any) => {
        if (!cancelled) {
          setModelConfigError(err && err.message ? err.message : 'Failed to load models');
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setReviewerDraft({
      engine: reviewerAgent?.engine || 'claude-code',
      model: reviewerAgent?.model || '',
    });
    setModelSaveStatus(null);
  }, [reviewerAgent?.id, reviewerAgent?.engine, reviewerAgent?.model]);

  useEffect(() => {
    let cancelled = false;
    api
      .getMyAgentModelOverrides()
      .then((body: any) => {
        if (cancelled) return;
        const map =
          body?.agentModelOverrides && typeof body.agentModelOverrides === 'object'
            ? body.agentModelOverrides
            : {};
        setModelOverrides(map);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!reviewerAgentId) {
      setContext(null);
      setError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .getContext(reviewerAgentId)
      .then((data: any) => {
        if (cancelled) return;
        setContext(data || {});
      })
      .catch((err: any) => {
        if (cancelled) return;
        setError(err && err.message ? err.message : 'Failed to load reviewer files');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reviewerAgentId]);

  const handleSaved = useCallback((filename: any, newContent: any) => {
    setContext((prev: any) => ({ ...(prev || {}), [filename]: newContent }));
  }, []);

  const fileEntries = context ? Object.entries(context) : [];
  const reviewerEngine = reviewerDraft.engine || reviewerAgent?.engine || 'claude-code';
  const engineChoices = useMemo(() => {
    if (!modelConfig?.engineValidModels) return [];
    return Object.keys(modelConfig.engineValidModels).filter(
      (engine: any) => (modelConfig.engineValidModels[engine]?.length ?? 0) > 0,
    );
  }, [modelConfig]);
  const engineDirty =
    reviewerAgent && reviewerDraft.engine !== (reviewerAgent.engine || 'claude-code');

  // Engine is a shared/admin setting — saved on the reviewer agent row.
  const handleEngineSave = async () => {
    if (!reviewerAgentId) return;
    setSavingModel(true);
    setModelSaveStatus(null);
    try {
      const updated = await api.updateAgent(reviewerAgentId, {
        engine: reviewerDraft.engine || 'claude-code',
      });
      setReviewerDraft((draft: any) => ({
        ...draft,
        engine: updated?.engine || reviewerDraft.engine || 'claude-code',
      }));
      setModelSaveStatus('saved');
      if (onAgentsChange) onAgentsChange();
    } catch (err: any) {
      setModelSaveStatus(err && err.message ? err.message : 'Save failed');
    } finally {
      setSavingModel(false);
    }
  };

  // Model is per-user — persisted to the caller's own preferences, never the
  // shared reviewer row. `''` clears the pick (falls back to engine default).
  // Uses the per-AGENT merge endpoint so a save only ever touches the reviewer
  // agent's own key: it can't clobber model picks made on the Settings page or
  // in another tab the way a whole-map PUT from a stale snapshot would.
  const saveReviewerModelOverride = (model: any) => {
    if (!reviewerAgentId) return;
    setModelOverrides((m: any) => {
      const n = { ...m };
      if (model) n[reviewerAgentId] = model;
      else delete n[reviewerAgentId];
      return n;
    });
    setModelOverrideSaving(true);
    setModelOverrideSaved(false);
    modelSaveChain.current = modelSaveChain.current
      .catch(() => {})
      .then(async () => {
        try {
          const body = model
            ? await api.putMyAgentModelOverride(reviewerAgentId, { model })
            : await api.deleteMyAgentModelOverride(reviewerAgentId);
          // Reconcile from the server's full merged map (reflects edits from
          // elsewhere that landed in the meantime).
          if (body?.agentModelOverrides && typeof body.agentModelOverrides === 'object') {
            setModelOverrides(body.agentModelOverrides);
          }
          setModelOverrideSaved(true);
          setTimeout(() => setModelOverrideSaved(false), 2000);
        } catch (err: any) {
          // Refetch rather than roll back to a stale snapshot.
          try {
            const fresh = await api.getMyAgentModelOverrides();
            if (fresh?.agentModelOverrides && typeof fresh.agentModelOverrides === 'object') {
              setModelOverrides(fresh.agentModelOverrides);
            }
          } catch {
            /* leave optimistic state; status line surfaces the failure */
          }
          setModelSaveStatus(err && err.message ? err.message : 'Save failed');
        } finally {
          setModelOverrideSaving(false);
        }
      });
  };

  return (
    <div className="h-full overflow-y-auto bg-gray-900 text-gray-100">
      <div className="max-w-3xl mx-auto px-4 py-6">
        <div className="flex items-center gap-2.5 mb-1">
          <ScanEye size={22} className="text-emerald-400" />
          <h1 className="text-xl font-semibold">Reviewer</h1>
        </div>
        <p className="text-sm text-gray-400 mb-6">
          {project ? (
            <>
              Markdown files that shape the <span className="text-gray-300">{project.name}</span>{' '}
              reviewer. Edits are saved to the reviewer agent&apos;s workspace and take effect on
              its next review.
            </>
          ) : (
            'Select a project to view its reviewer files.'
          )}
        </p>

        {!project ? (
          <EmptyState message="Project not found." />
        ) : !reviewerAgent ? (
          <EmptyState message="This project has no reviewer yet. The reviewer agent is created automatically once the project has GitHub integration (a connected repo or Agent Hub git hosting)." />
        ) : (
          <div className="space-y-4">
            <div className="bg-gray-800 rounded-lg border border-gray-700 p-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label
                    htmlFor="reviewer-engine-select"
                    className="block text-xs text-gray-400 mb-1"
                  >
                    Engine
                  </label>
                  <select
                    id="reviewer-engine-select"
                    data-testid="reviewer-engine-select"
                    value={reviewerEngine}
                    disabled={!modelConfig || savingModel}
                    onChange={(e: any) =>
                      setReviewerDraft({
                        engine: e.target.value,
                        model: '',
                      })
                    }
                    className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-gray-600 disabled:opacity-60"
                  >
                    {engineChoices.length === 0 ? (
                      <option value={reviewerEngine}>{reviewerEngine}</option>
                    ) : (
                      engineChoices.map((engine: any) => (
                        <option key={engine} value={engine}>
                          {engine}
                        </option>
                      ))
                    )}
                  </select>
                </div>
                <PerUserModelSelect
                  label="Model (only for me)"
                  engine={reviewerEngine}
                  modelConfig={modelConfig}
                  value={reviewerAgentId ? modelOverrides[reviewerAgentId] || '' : ''}
                  onSelect={saveReviewerModelOverride}
                  saving={modelOverrideSaving}
                  saved={modelOverrideSaved}
                  disabled={!reviewerAgentId}
                />
              </div>
              <div className="flex items-center gap-2 mt-3">
                <button
                  type="button"
                  onClick={handleEngineSave}
                  disabled={!engineDirty || savingModel}
                  className="text-xs bg-emerald-800/50 text-emerald-400 hover:bg-emerald-800 px-2.5 py-1 rounded-md transition-colors disabled:opacity-50 flex items-center gap-1"
                >
                  {savingModel ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <Save size={12} />
                  )}
                  Save engine
                </button>
                {modelConfigError && (
                  <span className="text-xs text-red-400">{modelConfigError}</span>
                )}
                {modelSaveStatus === 'saved' && (
                  <span className="text-xs text-emerald-400">Saved</span>
                )}
                {modelSaveStatus && modelSaveStatus !== 'saved' && (
                  <span className="text-xs text-red-400">{modelSaveStatus}</span>
                )}
              </div>
            </div>

            {loading ? (
              <div className="flex items-center gap-2 text-sm text-gray-400 py-8">
                <Loader2 size={16} className="animate-spin" /> Loading reviewer files…
              </div>
            ) : error ? (
              <EmptyState message={`Could not load reviewer files: ${error}`} />
            ) : fileEntries.length === 0 ? (
              <EmptyState message="No markdown files found for this reviewer." />
            ) : (
              <div className="space-y-2">
                {fileEntries.map(([filename, content]: any) => (
                  <ReviewerFilePanel
                    key={filename}
                    filename={filename}
                    content={content}
                    agentId={reviewerAgentId}
                    onSaved={handleSaved}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function EmptyState({ message }: any) {
  return (
    <div className="bg-gray-800/60 border border-gray-700 rounded-xl p-6 text-sm text-gray-400">
      {message}
    </div>
  );
}

function ReviewerFilePanel({ filename, content, agentId, onSaved }: any) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState(content || '');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<any>(null);

  useEffect(() => {
    setEditContent(content || '');
  }, [content]);

  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      await api.saveContext(agentId, filename, editContent);
      setEditing(false);
      if (onSaved) onSaved(filename, editContent);
    } catch (err: any) {
      setSaveError(err && err.message ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  if (content === null || content === undefined) return null;

  return (
    <div className="bg-gray-800 rounded-xl overflow-hidden">
      <div
        className="p-3 cursor-pointer hover:bg-gray-750 transition-colors flex items-center justify-between"
        onClick={() => setExpanded(!expanded)}
      >
        <span className="text-sm font-medium text-gray-300 flex items-center gap-1.5">
          <FileText size={14} /> {filename}
        </span>
        <span className="text-gray-500 text-2xl leading-none flex items-center">
          {expanded ? '▲' : '▼'}
        </span>
      </div>
      {expanded && (
        <div className="border-t border-gray-700 p-4">
          <div className="flex items-center gap-2 mb-3">
            <button
              onClick={(e: any) => {
                e.stopPropagation();
                setEditing(!editing);
              }}
              className={`text-xs px-2.5 py-1 rounded-md transition-colors ${
                editing
                  ? 'bg-blue-800/50 text-blue-400'
                  : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
              }`}
            >
              <span className="flex items-center gap-1">
                {editing ? (
                  <>
                    <PenLine size={12} /> Editing
                  </>
                ) : (
                  <>
                    <Pencil size={12} /> Edit
                  </>
                )}
              </span>
            </button>
            {editing && (
              <>
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="text-xs bg-emerald-800/50 text-emerald-400 hover:bg-emerald-800 px-2.5 py-1 rounded-md transition-colors disabled:opacity-50"
                >
                  <span className="flex items-center gap-1">
                    {saving ? (
                      <>
                        <Loader2 size={12} className="animate-spin" /> Saving...
                      </>
                    ) : (
                      <>
                        <Save size={12} /> Save
                      </>
                    )}
                  </span>
                </button>
                <button
                  onClick={() => {
                    setEditContent(content || '');
                    setSaveError(null);
                    setEditing(false);
                  }}
                  disabled={saving}
                  className="text-xs bg-gray-700 text-gray-400 hover:bg-gray-600 px-2.5 py-1 rounded-md transition-colors disabled:opacity-50"
                >
                  Cancel
                </button>
              </>
            )}
            {saveError && <span className="text-xs text-red-400">{saveError}</span>}
          </div>
          {editing ? (
            <textarea
              value={editContent}
              onChange={(e: any) => setEditContent(e.target.value)}
              className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-xs text-gray-100 font-mono focus:outline-none focus:border-gray-600 resize-y min-h-[200px]"
              rows={15}
            />
          ) : (
            <div className="prose prose-invert prose-sm max-w-none text-xs max-h-96 overflow-y-auto">
              <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                {content || '*(empty)*'}
              </ReactMarkdown>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
