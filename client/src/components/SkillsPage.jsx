import { useState, useEffect, useCallback, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { api } from '../utils/api.js';
import { safeHttpHref } from '../utils/safeHttpUrl.js';
import {
  BookOpen,
  Loader2,
  Save,
  Puzzle,
  ClipboardList,
  FileText,
  Pencil,
  PenLine,
  ExternalLink,
  ToggleLeft,
  ToggleRight,
  X,
  Shield,
  Trash2,
  AlertTriangle,
  RefreshCw,
} from 'lucide-react';

function SkillsLoadError({ section, message, onRetry }) {
  return (
    <div
      role="alert"
      data-testid={`skills-load-error-${section}`}
      className="bg-red-900/20 border border-red-800/50 rounded-xl p-4 flex items-start gap-3"
    >
      <AlertTriangle size={18} className="text-red-400 flex-shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-red-300">Failed to load {section}</p>
        <p className="text-xs text-red-400/80 mt-1 break-words">{message}</p>
        {onRetry && (
          <button
            onClick={onRetry}
            className="mt-2 inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-md bg-red-800/40 text-red-200 hover:bg-red-800/60 transition-colors"
          >
            <RefreshCw size={12} /> Retry
          </button>
        )}
      </div>
    </div>
  );
}

const CATEGORY_COLORS = {
  platform: 'bg-indigo-900/40 text-indigo-400',
  development: 'bg-blue-900/40 text-blue-400',
  documentation: 'bg-emerald-900/40 text-emerald-400',
  automation: 'bg-amber-900/40 text-amber-400',
  git: 'bg-purple-900/40 text-purple-400',
  monitoring: 'bg-rose-900/40 text-rose-400',
  general: 'bg-gray-700/40 text-gray-400',
};

function CategoryBadge({ category }) {
  const cls = CATEGORY_COLORS[category] || CATEGORY_COLORS.general;
  return <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${cls}`}>{category}</span>;
}

function SkillCard({ skill, agentId, overrides, onToggle, onUninstall, isInstalled }) {
  const [expanded, setExpanded] = useState(false);
  const [fullContent, setFullContent] = useState(skill.content || null);
  const [loading, setLoading] = useState(false);
  const [credentialSchema, setCredentialSchema] = useState([]);
  const [credentialRows, setCredentialRows] = useState([]);
  const [credLoading, setCredLoading] = useState(false);
  const [credError, setCredError] = useState(null);
  const [credSaving, setCredSaving] = useState(null);
  const [credentialInputs, setCredentialInputs] = useState({});

  const override = overrides?.find((o) => o.skill_id === skill.id);
  const isEnabled = override ? !!override.enabled : true;

  const credentialSchemaKey = useMemo(
    () => JSON.stringify(credentialSchema ?? []),
    [credentialSchema],
  );

  useEffect(() => {
    if (!expanded || credentialSchemaKey === '[]' || !agentId) return;
    let cancelled = false;
    (async () => {
      setCredLoading(true);
      setCredError(null);
      try {
        const pack = await api.getSkillCredentials(skill.id);
        if (!cancelled) setCredentialRows(pack.credentials || []);
      } catch (err) {
        if (!cancelled) {
          setCredError(err?.message || String(err));
          setCredentialRows([]);
        }
      } finally {
        if (!cancelled) setCredLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [expanded, skill.id, agentId, credentialSchemaKey]);

  const rowForKey = useCallback(
    (keyName) => credentialRows.find((r) => r.key_name === keyName),
    [credentialRows],
  );

  const saveCredential = useCallback(
    async (spec) => {
      const val = credentialInputs[spec.name] ?? '';
      if (spec.required && !String(val).trim()) {
        setCredError('This credential is required — enter a value before saving.');
        return;
      }
      setCredSaving(spec.name);
      setCredError(null);
      try {
        await api.putSkillCredential({
          skill_id: skill.id,
          key_name: spec.name,
          value: String(val),
          agent_id: agentId,
        });
        const pack = await api.getSkillCredentials(skill.id);
        setCredentialRows(pack.credentials || []);
        setCredentialInputs((prev) => ({ ...prev, [spec.name]: '' }));
      } catch (err) {
        setCredError(err?.message || String(err));
      } finally {
        setCredSaving(null);
      }
    },
    [credentialInputs, skill.id, agentId],
  );

  const deleteCredential = useCallback(
    async (spec) => {
      const row = rowForKey(spec.name);
      if (!row?.id) return;
      setCredSaving(spec.name);
      setCredError(null);
      try {
        await api.deleteSkillCredential(row.id);
        const pack = await api.getSkillCredentials(skill.id);
        setCredentialRows(pack.credentials || []);
      } catch (err) {
        setCredError(err?.message || String(err));
      } finally {
        setCredSaving(null);
      }
    },
    [rowForKey, skill.id],
  );

  const handleExpand = async () => {
    if (expanded) {
      setExpanded(false);
      return;
    }
    if (agentId) {
      setLoading(true);
      try {
        const data = await api.getSkill(agentId, skill.id);
        setFullContent(data.content);
        setCredentialSchema(Array.isArray(data.credentials) ? data.credentials : []);
      } catch (err) {
        const detail = err?.message ? `: ${err.message}` : '.';
        setFullContent(`Failed to load skill content${detail}`);
        setCredentialSchema([]);
        console.error('Failed to load skill content:', err);
      } finally {
        setLoading(false);
      }
    }
    setExpanded(true);
  };

  return (
    <div className={`bg-gray-800 rounded-xl overflow-hidden ${!isEnabled ? 'opacity-50' : ''}`}>
      <div
        className="p-4 cursor-pointer hover:bg-gray-750 transition-colors"
        onClick={handleExpand}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h4 className="font-medium text-sm text-gray-100">{skill.name}</h4>
              <CategoryBadge category={skill.category || 'general'} />
              {skill.source === 'default' && (
                <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-gray-700/50 text-gray-500">
                  built-in
                </span>
              )}
            </div>
            {skill.description && (
              <p className="text-xs text-gray-400 mt-1 line-clamp-2">{skill.description}</p>
            )}
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {onToggle && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onToggle(skill.id, !isEnabled);
                }}
                className="text-gray-400 hover:text-white transition-colors"
                title={isEnabled ? 'Disable for this agent' : 'Enable for this agent'}
              >
                {isEnabled ? (
                  <ToggleRight size={20} className="text-emerald-400" />
                ) : (
                  <ToggleLeft size={20} />
                )}
              </button>
            )}
            {onUninstall && isInstalled && skill.source !== 'default' && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onUninstall(skill.id);
                }}
                className="text-gray-500 hover:text-red-400 transition-colors"
                title="Uninstall"
              >
                <Trash2 size={14} />
              </button>
            )}
            <span className="text-gray-500 text-2xl leading-none flex items-center">
              {expanded ? '▲' : '▼'}
            </span>
          </div>
        </div>
      </div>
      {expanded && (
        <div className="border-t border-gray-700 p-4 max-h-96 overflow-y-auto">
          {loading ? (
            <p className="text-xs text-gray-500">Loading...</p>
          ) : (
            <>
              <div className="prose prose-invert prose-sm max-w-none text-xs">
                <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                  {fullContent || ''}
                </ReactMarkdown>
              </div>
              {credentialSchema.length > 0 && agentId && (
                <div className="mt-5 rounded-lg border border-gray-700/80 bg-gray-900/35 p-3">
                  <div className="mb-3 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <Shield size={14} className="flex-shrink-0 text-amber-400" />
                      <span className="text-xs font-medium text-gray-200">Credentials</span>
                    </div>
                    <p className="text-[10px] text-gray-500 leading-relaxed pl-0 sm:pl-6">
                      Stored per signed-in user, merged into CLI spawns for enabled skills. GitHub
                      sign-in under Settings wins over same-named skill vars (GH_TOKEN /
                      GITHUB_TOKEN).
                    </p>
                    <p className="text-[10px] text-gray-500/90 leading-relaxed pl-0 sm:pl-6">
                      Multi-user orgs: interactive chat, session summarize/rewind, and delegation
                      use the session owner&apos;s saved keys when known. Conference rooms and
                      Design Studio use the authenticated connection when present, otherwise the org
                      owner. Scheduled work (heartbeats, crons, workflows), Slack, and room
                      summarize use the org owner&apos;s vault.
                    </p>
                  </div>
                  {credLoading ? (
                    <p className="text-xs text-gray-500">Loading saved values…</p>
                  ) : credError ? (
                    <p className="text-xs text-amber-300/95">{credError}</p>
                  ) : (
                    credentialSchema.map((spec) => {
                      const row = rowForKey(spec.name);
                      const docsHref = safeHttpHref(spec.docs_url);
                      const inputType =
                        spec.type === 'secret' || spec.type === 'json' ? 'password' : 'text';
                      return (
                        <div
                          key={spec.name}
                          className="mb-4 border-b border-gray-800 pb-4 last:mb-0 last:border-b-0 last:pb-0"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="min-w-0">
                              <div className="text-xs font-medium text-gray-200">{spec.label}</div>
                              <div className="font-mono text-[10px] text-gray-500">{spec.name}</div>
                              {spec.description ? (
                                <p className="mt-1 text-[11px] text-gray-400">{spec.description}</p>
                              ) : null}
                              {docsHref ? (
                                <a
                                  href={docsHref}
                                  target="_blank"
                                  rel="noreferrer noopener"
                                  className="mt-1 inline-flex items-center gap-1 text-[11px] text-indigo-400 hover:text-indigo-300"
                                >
                                  Documentation <ExternalLink size={11} />
                                </a>
                              ) : null}
                            </div>
                            {row?.masked_preview ? (
                              <span className="text-[10px] text-gray-500">
                                Saved:{' '}
                                <span className="font-mono text-gray-300">
                                  {row.masked_preview}
                                </span>
                              </span>
                            ) : null}
                          </div>
                          <div className="mt-2 flex flex-wrap items-center gap-2">
                            <input
                              type={inputType}
                              autoComplete="off"
                              spellCheck={false}
                              placeholder={spec.required ? 'Required' : 'Optional — paste to set'}
                              value={credentialInputs[spec.name] ?? ''}
                              onChange={(e) =>
                                setCredentialInputs((p) => ({ ...p, [spec.name]: e.target.value }))
                              }
                              className="min-w-[160px] flex-1 rounded-md border border-gray-600 bg-gray-900 px-2 py-1.5 text-xs text-gray-100 placeholder:text-gray-600 focus:border-indigo-500 focus:outline-none"
                            />
                            <button
                              type="button"
                              disabled={credSaving === spec.name}
                              onClick={() => saveCredential(spec)}
                              className="rounded-md bg-indigo-600 px-2.5 py-1.5 text-[11px] font-medium text-white hover:bg-indigo-500 disabled:opacity-40"
                            >
                              {credSaving === spec.name ? 'Saving…' : 'Save'}
                            </button>
                            {row?.id ? (
                              <button
                                type="button"
                                disabled={credSaving === spec.name}
                                onClick={() => deleteCredential(spec)}
                                className="rounded-md border border-gray-600 px-2.5 py-1.5 text-[11px] text-gray-300 hover:bg-gray-750 disabled:opacity-40"
                              >
                                Revoke
                              </button>
                            ) : null}
                          </div>
                          {row?.last_used_at ? (
                            <p className="mt-1 text-[10px] text-gray-600">
                              Last used:{' '}
                              {new Date(row.last_used_at).toLocaleString(undefined, {
                                dateStyle: 'short',
                                timeStyle: 'short',
                              })}
                            </p>
                          ) : null}
                        </div>
                      );
                    })
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function ContextFilePanel({ filename, content, agentId, onSaved }) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState(content || '');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setEditContent(content || '');
  }, [content]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await api.saveContext(agentId, filename, editContent);
      setEditing(false);
      if (onSaved) onSaved(filename, editContent);
    } catch (err) {
      console.error('Failed to save:', err);
    } finally {
      setSaving(false);
    }
  };

  if (!content && content !== '') return null;

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
              onClick={(e) => {
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
            )}
          </div>
          {editing ? (
            <textarea
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
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

export default function SkillsPage({ agents, projects }) {
  const [activeAgentId, setActiveAgentId] = useState(agents[0]?.id || null);
  const [skills, setSkills] = useState([]);
  const [context, setContext] = useState({});
  const [overrides, setOverrides] = useState([]);
  const [loadingSkills, setLoadingSkills] = useState(false);
  const [loadingContext, setLoadingContext] = useState(false);
  const [skillsError, setSkillsError] = useState(null);
  const [contextError, setContextError] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);

  const activeAgent = agents.find((a) => a.id === activeAgentId);
  // Derive the project from the active agent
  const currentProjectId = (() => {
    if (!activeAgent || !projects) return null;
    const proj = projects.find((p) => p.agents?.some((a) => a.id === activeAgentId));
    return proj?.id || projects[0]?.id || null;
  })();

  // Load installed skills + overrides + context
  useEffect(() => {
    if (!activeAgentId) return;
    setLoadingSkills(true);
    setLoadingContext(true);
    setSkillsError(null);
    setContextError(null);

    api
      .getSkills(activeAgentId)
      .then((data) => {
        setSkills(data);
        setSkillsError(null);
      })
      .catch((err) => {
        setSkills([]);
        setSkillsError(err?.message || 'Unknown error loading skills');
        console.error('Failed to load skills:', err);
      })
      .finally(() => setLoadingSkills(false));
    api
      .getContext(activeAgentId)
      .then((data) => {
        setContext(data);
        setContextError(null);
      })
      .catch((err) => {
        setContext({});
        setContextError(err?.message || 'Unknown error loading context files');
        console.error('Failed to load context:', err);
      })
      .finally(() => setLoadingContext(false));
    api
      .getSkillOverrides(activeAgentId)
      .then(setOverrides)
      .catch((err) => {
        setOverrides([]);
        console.error('Failed to load skill overrides:', err);
      });
  }, [activeAgentId, reloadKey]);

  const retryInstalledLoad = useCallback(() => setReloadKey((k) => k + 1), []);

  const [actionError, setActionError] = useState(null);
  useEffect(() => {
    if (!actionError) return undefined;
    const t = setTimeout(() => setActionError(null), 6000);
    return () => clearTimeout(t);
  }, [actionError]);

  const handleToggle = useCallback(
    async (skillId, enabled) => {
      try {
        await api.toggleSkill(activeAgentId, skillId, enabled);
        setOverrides((prev) => {
          const existing = prev.findIndex((o) => o.skill_id === skillId);
          if (existing >= 0) {
            const updated = [...prev];
            updated[existing] = { ...updated[existing], enabled: enabled ? 1 : 0 };
            return updated;
          }
          return [
            ...prev,
            { agent_id: activeAgentId, skill_id: skillId, enabled: enabled ? 1 : 0 },
          ];
        });
      } catch (err) {
        console.error('Failed to toggle skill:', err);
        setActionError(`Failed to toggle skill ${skillId}: ${err?.message || 'unknown error'}`);
      }
    },
    [activeAgentId],
  );

  const handleUninstall = useCallback(
    async (skillId) => {
      if (!currentProjectId) return;
      try {
        await api.uninstallSkill(currentProjectId, skillId);
        setSkills((prev) => prev.filter((s) => s.id !== skillId));
      } catch (err) {
        console.error('Failed to uninstall:', err);
        setActionError(`Failed to uninstall skill ${skillId}: ${err?.message || 'unknown error'}`);
      }
    },
    [currentProjectId],
  );

  const handleContextSaved = (filename, newContent) => {
    setContext((prev) => ({ ...prev, [filename]: newContent }));
  };

  return (
    <div className="flex-1 overflow-y-auto p-4 md:p-6">
      <div className="max-w-4xl mx-auto">
        <h2 className="text-2xl font-bold mb-6 flex items-center gap-2">
          <BookOpen size={20} /> Skills & Context
        </h2>

        {actionError && (
          <div
            role="alert"
            data-testid="skills-action-error"
            className="mb-4 bg-red-900/30 border border-red-800/60 rounded-lg px-4 py-2.5 flex items-start justify-between gap-3"
          >
            <div className="flex items-start gap-2">
              <AlertTriangle size={16} className="text-red-400 flex-shrink-0 mt-0.5" />
              <p className="text-sm text-red-300 break-words">{actionError}</p>
            </div>
            <button
              onClick={() => setActionError(null)}
              className="text-red-400 hover:text-red-200 flex-shrink-0"
              aria-label="Dismiss"
            >
              <X size={14} />
            </button>
          </div>
        )}

        {/* Agent tabs */}
        <div className="flex gap-1.5 sm:gap-2 mb-6 overflow-x-auto pb-1 -mx-1 px-1">
          {agents.map((agent) => (
            <button
              key={agent.id}
              onClick={() => setActiveAgentId(agent.id)}
              className={`px-3 sm:px-4 py-2.5 rounded-lg text-sm font-medium whitespace-nowrap transition-colors flex items-center gap-2 min-h-[44px] ${
                activeAgentId === agent.id
                  ? 'bg-gray-800 text-white'
                  : 'text-gray-400 hover:text-white hover:bg-gray-800/50'
              }`}
            >
              <span
                className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                style={{ backgroundColor: agent.color }}
              />
              {agent.name}
            </button>
          ))}
        </div>

        {activeAgent && (
          <>
            {/* Skills Section */}
            <div className="mb-8">
              <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
                <Puzzle size={18} /> Skills
                <span className="text-xs text-gray-500 font-normal">({skills.length} total)</span>
              </h3>
              {loadingSkills ? (
                <p className="text-sm text-gray-500">Loading skills...</p>
              ) : skillsError ? (
                <SkillsLoadError
                  section="skills"
                  message={skillsError}
                  onRetry={retryInstalledLoad}
                />
              ) : skills.length === 0 ? (
                <div className="bg-gray-800 rounded-xl p-6 text-center">
                  <p className="text-gray-500 text-sm">No skills installed</p>
                  <p className="text-gray-600 text-xs mt-1">
                    Add skills to{' '}
                    <code className="bg-gray-900 px-1 rounded">
                      {activeAgent.workspace}/skills/
                    </code>
                  </p>
                </div>
              ) : (
                <div className="space-y-2">
                  {skills.map((skill) => (
                    <SkillCard
                      key={skill.id}
                      skill={skill}
                      agentId={activeAgentId}
                      overrides={overrides}
                      onToggle={handleToggle}
                      onUninstall={handleUninstall}
                      isInstalled
                    />
                  ))}
                </div>
              )}
            </div>

            {/* Context Files Section */}
            <div>
              <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
                <ClipboardList size={18} /> Context Files
                <span className="text-xs text-gray-500 font-normal">(workspace identity)</span>
              </h3>
              {loadingContext ? (
                <p className="text-sm text-gray-500">Loading context files...</p>
              ) : contextError ? (
                <SkillsLoadError
                  section="context files"
                  message={contextError}
                  onRetry={retryInstalledLoad}
                />
              ) : Object.keys(context).length === 0 ? (
                <div className="bg-gray-800 rounded-xl p-6 text-center">
                  <p className="text-gray-500 text-sm">No context files found</p>
                  <p className="text-gray-600 text-xs mt-1">
                    Add .md files to{' '}
                    <code className="bg-gray-900 px-1 rounded">{activeAgent.workspace}/</code>
                  </p>
                </div>
              ) : (
                <div className="space-y-2">
                  {Object.entries(context).map(([filename, content]) => (
                    <ContextFilePanel
                      key={filename}
                      filename={filename}
                      content={content}
                      agentId={activeAgentId}
                      onSaved={handleContextSaved}
                    />
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
