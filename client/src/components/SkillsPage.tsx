import { useState, useEffect, useCallback, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { api } from '../utils/api';
import { safeHttpHref } from '../utils/safeHttpUrl';
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
  Sparkles,
  Globe,
} from 'lucide-react';

function SkillsLoadError({ section, message, onRetry }: any) {
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
} as Record<string, any>;

function CategoryBadge({ category }: any) {
  const cls = CATEGORY_COLORS[category] || CATEGORY_COLORS.general;
  return <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${cls}`}>{category}</span>;
}

const SKILL_SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

const NEW_SKILL_TEMPLATE = `---
name: my-skill
description: >-
  What this skill does and WHEN to use it. The description is the trigger —
  state what + when, because models under-trigger.
category: general
---

# My Skill

Write the instructions here. Explain the *why* of rules so the skill
generalizes. Keep it under ~500 lines.
`;

/**
 * Minimal create/edit editor for a project skill (Skill Builder, Phase 1).
 * Edits the raw SKILL.md (frontmatter + body) in one textarea; the server
 * validates the frontmatter and returns a clear error on failure. For an
 * existing skill we fetch its current SKILL.md and seed the textarea.
 */
function SkillEditor({ projectId, agentId, skill, onClose, onSaved }: any) {
  const isEdit = !!skill;
  // On edit, the scope is fixed by where the skill already lives (its source).
  // On create, the author chooses: project-only vs shared across all projects.
  const editScope = isEdit && skill.source === 'global' ? 'global' : 'project';
  const [scope, setScope] = useState('project');
  const effectiveScope = isEdit ? editScope : scope;
  const [content, setContent] = useState(isEdit ? '' : NEW_SKILL_TEMPLATE);
  const [loading, setLoading] = useState(isEdit);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<any>(null);

  useEffect(() => {
    if (!isEdit) return undefined;
    let cancelled = false;
    setLoading(true);
    // A global skill isn't found by the agent-scoped read (it searches project →
    // default), so fetch it from the global tier directly.
    const fetchSkill =
      skill.source === 'global' ? api.getGlobalSkill(skill.id) : api.getSkill(agentId, skill.id);
    fetchSkill
      .then((data: any) => {
        if (!cancelled) setContent(data.content || '');
      })
      .catch((err: any) => {
        if (!cancelled) setError(err?.message || 'Failed to load skill');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isEdit, agentId, skill]);

  // Light client-side validation; the server is the source of truth.
  const clientError = (() => {
    const m = /^---\s*\n([\s\S]*?)\n---/.exec(content);
    if (!m) return 'SKILL.md must start with a YAML frontmatter block (--- ... ---).';
    const fm = m[1];
    const nameMatch = /^name:\s*(.+)$/m.exec(fm);
    const name = nameMatch ? nameMatch[1].trim().replace(/^["']|["']$/g, '') : '';
    if (!name) return 'Frontmatter is missing a "name" field.';
    if (!isEdit && !SKILL_SLUG_RE.test(name))
      return `name "${name}" must be a slug (lowercase letters, digits, hyphens).`;
    if (isEdit && name !== skill.id)
      return `name must stay "${skill.id}" — rename is not supported.`;
    if (!/^description:\s*\S/m.test(fm) && !/^description:\s*[>|]/m.test(fm))
      return 'Frontmatter is missing a "description" field.';
    return null;
  })();

  const handleSave = async () => {
    if (clientError) {
      setError(clientError);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      let saved: any;
      if (isEdit) {
        saved =
          effectiveScope === 'global'
            ? await api.updateGlobalSkill(skill.id, { name: skill.id, content })
            : await api.updateProjectSkill(projectId, skill.id, { name: skill.id, content });
      } else {
        saved =
          scope === 'global'
            ? await api.createGlobalSkill({ content })
            : await api.createProjectSkill(projectId, { content });
      }
      onSaved(saved, isEdit);
    } catch (err: any) {
      setError(err?.message || 'Failed to save skill');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-2xl max-h-[90vh] flex flex-col overflow-hidden"
        onClick={(e: any) => e.stopPropagation()}
        role="dialog"
        aria-label={isEdit ? 'Edit skill' : 'New skill'}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
          <h3 className="text-sm font-semibold text-gray-100 flex items-center gap-2">
            <PenLine size={16} /> {isEdit ? `Edit skill: ${skill.id}` : 'New skill'}
            {isEdit && effectiveScope === 'global' && (
              <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-sky-900/40 text-sky-300 inline-flex items-center gap-0.5">
                <Globe size={9} /> shared
              </span>
            )}
          </h3>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white"
            aria-label="Close editor"
          >
            <X size={16} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          <p className="text-xs text-gray-500 mb-2">
            Edit the SKILL.md frontmatter and Markdown body. The{' '}
            <code className="bg-gray-800 px-1 rounded">name</code> in the frontmatter is the slug
            you load with <code className="bg-gray-800 px-1 rounded">&lt;agenthub:skill&gt;</code>.
          </p>
          {!isEdit && (
            <div className="mb-3">
              <span className="block text-[11px] font-medium text-gray-400 mb-1.5">
                Where should this skill live?
              </span>
              <div className="inline-flex rounded-lg border border-gray-700 overflow-hidden text-xs">
                <button
                  type="button"
                  onClick={() => setScope('project')}
                  className={`px-3 py-1.5 transition-colors ${
                    scope === 'project'
                      ? 'bg-indigo-600 text-white'
                      : 'text-gray-300 hover:bg-gray-800'
                  }`}
                >
                  This project only
                </button>
                <button
                  type="button"
                  onClick={() => setScope('global')}
                  className={`px-3 py-1.5 inline-flex items-center gap-1 transition-colors ${
                    scope === 'global'
                      ? 'bg-indigo-600 text-white'
                      : 'text-gray-300 hover:bg-gray-800'
                  }`}
                >
                  <Globe size={12} /> Shared (all projects)
                </button>
              </div>
              <p className="text-[10px] text-gray-500 mt-1.5">
                {scope === 'global'
                  ? 'Shared skills are stored globally and available to every agent in every project.'
                  : "Project skills are only available to this project's agents."}
              </p>
            </div>
          )}
          {loading ? (
            <p className="text-sm text-gray-500">Loading…</p>
          ) : (
            <textarea
              value={content}
              onChange={(e: any) => setContent(e.target.value)}
              spellCheck={false}
              className="w-full h-80 font-mono text-xs bg-gray-950 border border-gray-700 rounded-lg p-3 text-gray-100 focus:border-indigo-500 focus:outline-none resize-y"
            />
          )}
          {(error || (clientError && !loading)) && (
            <div className="mt-3 flex items-start gap-2 text-xs text-red-300 bg-red-900/20 border border-red-800/50 rounded-lg px-3 py-2">
              <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
              <span className="break-words">{error || clientError}</span>
            </div>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-gray-700">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-xs rounded-md text-gray-300 hover:bg-gray-800"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving || loading || !!clientError}
            className="px-3 py-1.5 text-xs rounded-md bg-indigo-600 text-white hover:bg-indigo-500 disabled:opacity-40 inline-flex items-center gap-1.5"
          >
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
            {isEdit ? 'Save changes' : 'Create skill'}
          </button>
        </div>
      </div>
    </div>
  );
}

function SkillCard({ skill, agentId, overrides, onToggle, onUninstall, onEdit, isInstalled }: any) {
  const [expanded, setExpanded] = useState(false);
  const [fullContent, setFullContent] = useState(skill.content || null);
  const [loading, setLoading] = useState(false);
  const [credentialSchema, setCredentialSchema] = useState<any[]>([]);
  const [credentialRows, setCredentialRows] = useState<any[]>([]);
  const [credLoading, setCredLoading] = useState(false);
  const [credError, setCredError] = useState<any>(null);
  const [credSaving, setCredSaving] = useState<any>(null);
  const [credentialInputs, setCredentialInputs] = useState<Record<string, any>>({});

  const override = overrides?.find((o: any) => o.skill_id === skill.id);
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
      } catch (err: any) {
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
    (keyName: any) => credentialRows.find((r: any) => r.key_name === keyName),
    [credentialRows],
  );

  const saveCredential = useCallback(
    async (spec: any) => {
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
        setCredentialInputs((prev: any) => ({ ...prev, [spec.name]: '' }));
      } catch (err: any) {
        setCredError(err?.message || String(err));
      } finally {
        setCredSaving(null);
      }
    },
    [credentialInputs, skill.id, agentId],
  );

  const deleteCredential = useCallback(
    async (spec: any) => {
      const row = rowForKey(spec.name);
      if (!row?.id) return;
      setCredSaving(spec.name);
      setCredError(null);
      try {
        await api.deleteSkillCredential(row.id);
        const pack = await api.getSkillCredentials(skill.id);
        setCredentialRows(pack.credentials || []);
      } catch (err: any) {
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
      } catch (err: any) {
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
              {skill.source === 'global' && (
                <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-sky-900/40 text-sky-400 inline-flex items-center gap-0.5">
                  <Globe size={9} /> shared
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
                onClick={(e: any) => {
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
            {onEdit && skill.source !== 'default' && (
              <button
                onClick={(e: any) => {
                  e.stopPropagation();
                  onEdit(skill);
                }}
                className="text-gray-500 hover:text-indigo-400 transition-colors"
                title="Edit skill"
              >
                <Pencil size={14} />
              </button>
            )}
            {onUninstall && isInstalled && skill.source !== 'default' && (
              <button
                onClick={(e: any) => {
                  e.stopPropagation();
                  onUninstall(skill.id, skill.source);
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
                    credentialSchema.map((spec: any) => {
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
                              onChange={(e: any) =>
                                setCredentialInputs((p: any) => ({
                                  ...p,
                                  [spec.name]: e.target.value,
                                }))
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

function ContextFilePanel({ filename, content, agentId, onSaved }: any) {
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
    } catch (err: any) {
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

export default function SkillsPage({ agents, projects, onStartCoachSession }: any) {
  const [activeAgentId, setActiveAgentId] = useState(agents[0]?.id || null);
  const [skills, setSkills] = useState<any[]>([]);
  const [context, setContext] = useState<Record<string, any>>({});
  const [overrides, setOverrides] = useState<any[]>([]);
  const [loadingSkills, setLoadingSkills] = useState(false);
  const [loadingContext, setLoadingContext] = useState(false);
  const [skillsError, setSkillsError] = useState<any>(null);
  const [contextError, setContextError] = useState<any>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const activeAgent = agents.find((a: any) => a.id === activeAgentId);
  // Derive the project from the active agent
  const currentProjectId = (() => {
    if (!activeAgent || !projects) return null;
    const proj = projects.find((p: any) => p.agents?.some((a: any) => a.id === activeAgentId));
    return proj?.id || projects[0]?.id || null;
  })();

  // The project's seeded Skill Builder coach (role 'skill-builder'). Resolved
  // from the canonical flat `agents` list filtered by `projectId` — NOT from
  // embedded `project.agents`, which the projects payload may not hydrate
  // (that would hide the entry point even when the seeded coach exists). Older
  // projects created before the coach was seeded won't have one — in that case
  // the conversational entry point is hidden and the raw editor is the primary
  // action.
  const coachAgent =
    agents.find((a: any) => a.role === 'skill-builder' && a.projectId === currentProjectId) || null;
  const canCoach = !!(coachAgent && onStartCoachSession);

  // Load installed skills + overrides + context
  useEffect(() => {
    if (!activeAgentId) return;
    setLoadingSkills(true);
    setLoadingContext(true);
    setSkillsError(null);
    setContextError(null);

    api
      .getSkills(activeAgentId)
      .then((data: any) => {
        setSkills(data);
        setSkillsError(null);
      })
      .catch((err: any) => {
        setSkills([]);
        setSkillsError(err?.message || 'Unknown error loading skills');
        console.error('Failed to load skills:', err);
      })
      .finally(() => setLoadingSkills(false));
    api
      .getContext(activeAgentId)
      .then((data: any) => {
        setContext(data);
        setContextError(null);
      })
      .catch((err: any) => {
        setContext({});
        setContextError(err?.message || 'Unknown error loading context files');
        console.error('Failed to load context:', err);
      })
      .finally(() => setLoadingContext(false));
    api
      .getSkillOverrides(activeAgentId)
      .then(setOverrides)
      .catch((err: any) => {
        setOverrides([]);
        console.error('Failed to load skill overrides:', err);
      });
  }, [activeAgentId, reloadKey]);

  const retryInstalledLoad = useCallback(() => setReloadKey((k: any) => k + 1), []);

  const [actionError, setActionError] = useState<any>(null);
  useEffect(() => {
    if (!actionError) return undefined;
    const t = setTimeout(() => setActionError(null), 6000);
    return () => clearTimeout(t);
  }, [actionError]);

  const handleToggle = useCallback(
    async (skillId: any, enabled: any) => {
      try {
        await api.toggleSkill(activeAgentId, skillId, enabled);
        setOverrides((prev: any) => {
          const existing = prev.findIndex((o: any) => o.skill_id === skillId);
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
      } catch (err: any) {
        console.error('Failed to toggle skill:', err);
        setActionError(`Failed to toggle skill ${skillId}: ${err?.message || 'unknown error'}`);
      }
    },
    [activeAgentId],
  );

  const handleUninstall = useCallback(
    async (skillId: any, source: any) => {
      // Global skills are shared across EVERY project — deleting one is a
      // cross-project, irreversible action, so gate it behind an explicit
      // confirmation that spells out the blast radius. Project skills only
      // affect the current project, so they delete without a prompt (unchanged).
      if (source === 'global') {
        const confirmed = window.confirm(
          `Delete the shared skill "${skillId}" for ALL projects?\n\n` +
            'This is a shared (global) skill. Removing it deletes it for every agent ' +
            'in every project — not just this one — and cannot be undone.',
        );
        if (!confirmed) return;
      }
      try {
        if (source === 'global') {
          await api.deleteGlobalSkill(skillId);
        } else {
          if (!currentProjectId) return;
          await api.uninstallSkill(currentProjectId, skillId);
        }
        setSkills((prev: any) => prev.filter((s: any) => s.id !== skillId));
      } catch (err: any) {
        console.error('Failed to uninstall:', err);
        setActionError(`Failed to uninstall skill ${skillId}: ${err?.message || 'unknown error'}`);
      }
    },
    [currentProjectId],
  );

  const handleContextSaved = (filename: any, newContent: any) => {
    setContext((prev: any) => ({ ...prev, [filename]: newContent }));
  };

  // null = closed; { skill: null } = create; { skill } = edit existing.
  const [editorState, setEditorState] = useState<any>(null);
  const handleSkillSaved = useCallback(() => {
    setEditorState(null);
    setReloadKey((k: any) => k + 1);
  }, []);

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
          {agents.map((agent: any) => (
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
              <div className="flex items-center justify-between mb-4 gap-2">
                <h3 className="text-lg font-semibold flex items-center gap-2">
                  <Puzzle size={18} /> Skills
                  <span className="text-xs text-gray-500 font-normal">({skills.length} total)</span>
                </h3>
                {currentProjectId && (
                  <div className="flex items-center gap-2">
                    {canCoach && (
                      <button
                        onClick={() => onStartCoachSession(coachAgent.id)}
                        className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-md bg-indigo-600 text-white hover:bg-indigo-500 transition-colors"
                        title="Chat with the Skill Builder coach to create a skill"
                      >
                        <Sparkles size={13} /> Build a skill
                      </button>
                    )}
                    <button
                      onClick={() => setEditorState({ skill: null })}
                      className={`inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-md transition-colors ${
                        canCoach
                          ? 'border border-gray-700 text-gray-300 hover:bg-gray-800'
                          : 'bg-indigo-600 text-white hover:bg-indigo-500'
                      }`}
                      title="Write a skill's SKILL.md directly"
                    >
                      <PenLine size={13} /> Write raw
                    </button>
                  </div>
                )}
              </div>
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
                  {skills.map((skill: any) => (
                    <SkillCard
                      key={skill.id}
                      skill={skill}
                      agentId={activeAgentId}
                      overrides={overrides}
                      onToggle={handleToggle}
                      onUninstall={handleUninstall}
                      onEdit={(s: any) => setEditorState({ skill: s })}
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
                  {Object.entries(context).map(([filename, content]: any) => (
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

        {editorState && currentProjectId && (
          <SkillEditor
            projectId={currentProjectId}
            agentId={activeAgentId}
            skill={editorState.skill}
            onClose={() => setEditorState(null)}
            onSaved={handleSkillSaved}
          />
        )}
      </div>
    </div>
  );
}
