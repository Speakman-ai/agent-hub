import { useState, useEffect, useCallback, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { api } from '../utils/api';
import { safeHttpHref } from '../utils/safeHttpUrl';
import { formatDateTime } from '../utils/time';
import { hasRole, isLocalBundledDeployment } from '../utils/auth';
import {
  BookOpen,
  Loader2,
  Save,
  Puzzle,
  ClipboardList,
  FileText,
  Pencil,
  PenLine,
  ToggleLeft,
  ToggleRight,
  X,
  Trash2,
  AlertTriangle,
  RefreshCw,
  Sparkles,
  Globe,
  Shield,
  ExternalLink,
  Zap,
  Check,
  MessageSquare,
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
export function SkillEditor({
  projectId,
  agentId,
  skill,
  onClose,
  onSaved,
  globalOnly = false,
}: any) {
  const isEdit = !!skill;
  const editScope = globalOnly || (isEdit && skill.source === 'global') ? 'global' : 'project';
  const [scope, setScope] = useState(globalOnly ? 'global' : 'project');
  const effectiveScope = isEdit ? editScope : scope;
  const [content, setContent] = useState(isEdit ? '' : NEW_SKILL_TEMPLATE);
  const [loading, setLoading] = useState(isEdit);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<any>(null);

  useEffect(() => {
    if (!isEdit) return undefined;
    let cancelled = false;
    setLoading(true);
    // Read from the tier the skill actually lives in:
    //   - global  → the global tier directly (the agent-scoped read searches
    //     project → default and would miss a user-authored global skill);
    //   - project → the PROJECT-owned read, so editing works even when the page
    //     has no reference agent (agentless project with existing skills) —
    //     the agent-scoped read would hit `/agents/null/skills/:id` and fail;
    //   - otherwise (default/built-in) → the agent-scoped merged read.
    const fetchSkill =
      globalOnly || skill.source === 'global'
        ? api.getGlobalSkill(skill.id)
        : skill.source === 'project' && projectId
          ? api.getProjectSkill(projectId, skill.id)
          : api.getSkill(agentId, skill.id);
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
  }, [isEdit, agentId, skill, projectId, globalOnly]);

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
          effectiveScope === 'global' || globalOnly
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
          {!isEdit && !globalOnly && (
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

/**
 * Review queue for agent-suggested skill lessons (<agenthub:skill-improvement>).
 *
 * Security-relevant rendering choices, deliberate and load-bearing:
 *   - `entry` is UNTRUSTED agent output — rendered as plain text, never
 *     markdown/HTML.
 *   - The provenance line (agent, timestamp, session deep link) is the
 *     reviewer's tool for telling a legitimate lesson from injected
 *     instructions the agent merely *read* during its session.
 *   - Approve/reject is Admin+ (server-enforced; the client gate is a UX
 *     hint). There is deliberately no bulk-approve: friction is the feature
 *     when promoting text into standing instructions.
 */
export function PendingLessonsSection({ projectId, improvements, onReviewed, onOpenSession }: any) {
  const canReview = hasRole('Admin') || isLocalBundledDeployment();
  const [busyId, setBusyId] = useState<any>(null);
  const [error, setError] = useState<any>(null);
  const [rejectingId, setRejectingId] = useState<any>(null);
  const [rejectReason, setRejectReason] = useState('');

  const review = useCallback(
    async (imp: any, action: any) => {
      setBusyId(imp.id);
      setError(null);
      try {
        if (action === 'approve') {
          await api.approveSkillImprovement(projectId, imp.skillId, imp.id);
        } else {
          await api.rejectSkillImprovement(
            projectId,
            imp.skillId,
            imp.id,
            rejectReason.trim() || undefined,
          );
        }
        setRejectingId(null);
        setRejectReason('');
        if (onReviewed) onReviewed();
      } catch (err: any) {
        setError(err?.message || String(err));
      } finally {
        setBusyId(null);
      }
    },
    [projectId, rejectReason, onReviewed],
  );

  if (!improvements?.length) return null;
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div
      className="mb-4 rounded-xl border border-amber-800/40 bg-amber-950/10"
      data-testid="pending-lessons-section"
    >
      <div className="px-4 pt-3 pb-2 flex items-center gap-2">
        <Zap size={14} className="text-amber-400" />
        <h4 className="text-sm font-medium text-amber-200">
          Pending lessons{' '}
          <span className="text-amber-400/70 font-normal">({improvements.length})</span>
        </h4>
      </div>
      <p className="px-4 pb-2 text-[11px] text-gray-500 leading-relaxed">
        Agents suggested these skill lessons. Approving appends the dated bullet below to the
        skill&apos;s <code className="bg-gray-900 px-1 rounded">## Learned Lessons</code> — it
        becomes standing instructions for every future session, so check the source session before
        promoting.
      </p>
      {error && (
        <p role="alert" className="px-4 pb-2 text-xs text-red-400 break-words">
          {error}
        </p>
      )}
      <div className="divide-y divide-amber-900/30">
        {improvements.map((imp: any) => (
          <div key={imp.id} className="px-4 py-3" data-testid={`pending-lesson-${imp.id}`}>
            <div className="flex items-center gap-2 mb-1.5">
              <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-gray-700/60 text-gray-300 font-mono">
                {imp.skillName || imp.skillId}
              </span>
              {imp.source === 'global' && (
                <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-sky-900/40 text-sky-400 inline-flex items-center gap-0.5">
                  <Globe size={9} /> shared
                </span>
              )}
            </div>
            {/* Untrusted agent output — plain text on purpose. */}
            <p className="text-xs text-gray-200 whitespace-pre-wrap break-words">{imp.entry}</p>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-gray-500">
              {imp.agentId ? <span>🤖 {imp.agentId}</span> : null}
              <span>
                {formatDateTime(imp.createdAt, { dateStyle: 'short', timeStyle: 'short' })}
              </span>
              {imp.sessionId && onOpenSession ? (
                <button
                  type="button"
                  onClick={() => onOpenSession({ sessionId: imp.sessionId, agentId: imp.agentId })}
                  className="inline-flex items-center gap-1 text-indigo-400 hover:text-indigo-300"
                  title="Open the session where this lesson was suggested"
                >
                  <MessageSquare size={10} /> view source session
                </button>
              ) : null}
            </div>
            <div className="mt-2 rounded-md bg-gray-900/70 border border-gray-800 px-2 py-1.5">
              <p className="text-[10px] text-gray-500 mb-0.5">
                Will append as (date stamped at approval):
              </p>
              <code className="text-[11px] text-emerald-300/90 break-words">
                - {today}: {imp.entry}
              </code>
            </div>
            {canReview ? (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={busyId === imp.id}
                  onClick={() => review(imp, 'approve')}
                  className="inline-flex items-center gap-1 rounded-md bg-emerald-700/80 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-emerald-600 disabled:opacity-40"
                  data-testid={`approve-lesson-${imp.id}`}
                >
                  {busyId === imp.id ? (
                    <Loader2 size={11} className="animate-spin" />
                  ) : (
                    <Check size={11} />
                  )}
                  Approve
                </button>
                {rejectingId === imp.id ? (
                  <>
                    <input
                      type="text"
                      value={rejectReason}
                      onChange={(e: any) => setRejectReason(e.target.value)}
                      placeholder="Reason (optional, kept for audit)"
                      className="min-w-[180px] flex-1 rounded-md border border-gray-700 bg-gray-900 px-2 py-1 text-[11px] text-gray-100 placeholder:text-gray-600 focus:border-red-500/60 focus:outline-none"
                    />
                    <button
                      type="button"
                      disabled={busyId === imp.id}
                      onClick={() => review(imp, 'reject')}
                      className="inline-flex items-center gap-1 rounded-md bg-red-800/70 px-2.5 py-1 text-[11px] font-medium text-red-100 hover:bg-red-700 disabled:opacity-40"
                      data-testid={`reject-lesson-${imp.id}`}
                    >
                      <X size={11} /> Confirm reject
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setRejectingId(null);
                        setRejectReason('');
                      }}
                      className="text-[11px] text-gray-500 hover:text-gray-300"
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => setRejectingId(imp.id)}
                    className="inline-flex items-center gap-1 rounded-md border border-gray-700 px-2.5 py-1 text-[11px] text-gray-300 hover:bg-gray-800"
                  >
                    <X size={11} /> Reject
                  </button>
                )}
              </div>
            ) : (
              <p className="mt-2 text-[10px] text-gray-600">
                Approving requires the Admin role — ask an operator to review.
              </p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export function SkillCard({
  skill,
  agentId,
  projectId,
  overrides,
  onToggle,
  onUninstall,
  onEdit,
  isInstalled,
  pendingCount = 0,
}: any) {
  const [expanded, setExpanded] = useState(false);
  const [fullContent, setFullContent] = useState(skill.content || null);
  const [loading, setLoading] = useState(false);
  const [schemaLoaded, setSchemaLoaded] = useState(false);
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

  // Load the per-user saved credential rows once the schema is known and the
  // card is expanded. Keyed on the schema so it refetches if the schema changes.
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
    // Fetch content + credential schema on first expand. `schemaLoaded` guards
    // the refetch (content alone may be seeded from `skill.content`, but the
    // credential schema only comes from the read). Read from the tier the skill
    // lives in:
    //   - global  → the global tier directly (the agent-scoped read searches
    //     project → default and would miss a user-authored global skill);
    //   - project → the PROJECT-owned read, so inspect/credential-schema work
    //     even when no reference agent exists (agentless project) — the
    //     agent-scoped read would hit `/agents/null/skills/:id`;
    //   - otherwise (default/built-in) → the agent-scoped merged read.
    const canReadProject = skill.source === 'project' && projectId;
    if (
      (agentId || skill.source === 'global' || canReadProject) &&
      (!fullContent || !schemaLoaded)
    ) {
      setLoading(true);
      try {
        const data =
          skill.source === 'global'
            ? await api.getGlobalSkill(skill.id)
            : canReadProject
              ? await api.getProjectSkill(projectId, skill.id)
              : await api.getSkill(agentId, skill.id);
        setFullContent(data.content);
        setCredentialSchema(Array.isArray(data.credentials) ? data.credentials : []);
        setSchemaLoaded(true);
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
              {pendingCount > 0 && (
                <span
                  className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-amber-900/40 text-amber-400 inline-flex items-center gap-0.5"
                  title={`${pendingCount} pending lesson${pendingCount === 1 ? '' : 's'} awaiting review`}
                  data-testid={`skill-pending-badge-${skill.id}`}
                >
                  <Zap size={9} /> {pendingCount}
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
                              {formatDateTime(row.last_used_at, {
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

export default function SkillsPage({
  agents,
  projects,
  onStartSkillBuilderMode,
  initialProjectId = null,
  onOpenSession,
}: any) {
  const activeProjectId = initialProjectId;
  const [skills, setSkills] = useState<any[]>([]);
  const [improvements, setImprovements] = useState<any[]>([]);
  const [context, setContext] = useState<Record<string, any>>({});
  const [overrides, setOverrides] = useState<any[]>([]);
  const [loadingSkills, setLoadingSkills] = useState(false);
  const [loadingContext, setLoadingContext] = useState(false);
  const [skillsError, setSkillsError] = useState<any>(null);
  const [contextError, setContextError] = useState<any>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // null = follow the default reference agent; otherwise the user-picked agent
  // whose overrides + context this page is currently inspecting.
  const [selectedAgentId, setSelectedAgentId] = useState<any>(null);

  const currentProject = (projects || []).find((p: any) => p.id === activeProjectId) || null;

  // Every active agent in this project, in a stable order. Per-agent skill
  // overrides and context files are inspected/edited one agent at a time, so a
  // multi-agent project needs a selector (below) to reach the others.
  const projectAgents = useMemo(
    () => (agents || []).filter((a: any) => a.projectId === activeProjectId && a.active !== false),
    [agents, activeProjectId],
  );

  // The default pick: a non-helper agent (skill-builder/reviewer/docs run their
  // own allowlists), else the first agent in the project.
  const referenceAgent = useMemo(() => {
    if (!activeProjectId) return null;
    return (
      projectAgents.find(
        (a: any) => a.role !== 'skill-builder' && a.role !== 'reviewer' && a.role !== 'docs',
      ) ||
      projectAgents[0] ||
      null
    );
  }, [projectAgents, activeProjectId]);

  // Skill Builder is a dev-agent mode; the "Build a skill" affordance is only
  // valid when the project has a non-helper agent to run it on (mirrors the
  // guard in App.handleStartSkillBuilderMode).
  const hasDevAgent = useMemo(
    () =>
      projectAgents.some(
        (a: any) => a.role !== 'skill-builder' && a.role !== 'reviewer' && a.role !== 'docs',
      ),
    [projectAgents],
  );

  // The agent currently in focus: the explicit selection when it still belongs
  // to this project, otherwise the default reference agent. Keeps a stale
  // selection from a previously-viewed project from leaking through.
  const activeAgent = useMemo(() => {
    if (selectedAgentId) {
      const picked = projectAgents.find((a: any) => a.id === selectedAgentId);
      if (picked) return picked;
    }
    return referenceAgent;
  }, [selectedAgentId, projectAgents, referenceAgent]);

  const referenceAgentId = activeAgent?.id || null;

  // Reset the selection whenever the project changes so the selector starts on
  // that project's default agent rather than a carried-over id.
  useEffect(() => {
    setSelectedAgentId(null);
  }, [activeProjectId]);

  // Load project skills + per-agent overrides + context for the reference agent.
  useEffect(() => {
    if (!activeProjectId) return;
    setLoadingSkills(true);
    setSkillsError(null);

    api
      .getProjectSkills(activeProjectId)
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

    if (!referenceAgentId) {
      setOverrides([]);
      setContext({});
      setLoadingContext(false);
      return;
    }

    setLoadingContext(true);
    setContextError(null);
    api
      .getContext(referenceAgentId)
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
      .getSkillOverrides(referenceAgentId)
      .then(setOverrides)
      .catch((err: any) => {
        setOverrides([]);
        console.error('Failed to load skill overrides:', err);
      });
  }, [activeProjectId, referenceAgentId, reloadKey]);

  const retryInstalledLoad = useCallback(() => setReloadKey((k: any) => k + 1), []);

  // Pending skill-improvement suggestions (agent-proposed Learned Lessons).
  // Non-fatal on error: the review queue is an overlay on the skills page,
  // not a prerequisite for it.
  const loadImprovements = useCallback(() => {
    if (!activeProjectId) return;
    api
      .getSkillImprovements(activeProjectId)
      .then((data: any) => setImprovements(data?.improvements || []))
      .catch((err: any) => {
        setImprovements([]);
        console.error('Failed to load skill improvements:', err);
      });
  }, [activeProjectId]);

  useEffect(() => {
    loadImprovements();
  }, [loadImprovements, reloadKey]);

  // Live badge/queue refresh — App re-dispatches the `skill_improvement_update`
  // WebSocket event as a window event (same pattern as wiki_update).
  useEffect(() => {
    const handler = (e: any) => {
      const projectId = e?.detail?.projectId;
      if (!projectId || projectId === activeProjectId) loadImprovements();
    };
    window.addEventListener('skill_improvement_update', handler);
    return () => window.removeEventListener('skill_improvement_update', handler);
  }, [activeProjectId, loadImprovements]);

  const pendingCountBySkill = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const imp of improvements) {
      counts[imp.skillId] = (counts[imp.skillId] || 0) + 1;
    }
    return counts;
  }, [improvements]);

  const [actionError, setActionError] = useState<any>(null);
  useEffect(() => {
    if (!actionError) return undefined;
    const t = setTimeout(() => setActionError(null), 6000);
    return () => clearTimeout(t);
  }, [actionError]);

  const handleToggle = useCallback(
    async (skillId: any, enabled: any) => {
      try {
        await api.toggleSkill(referenceAgentId, skillId, enabled);
        setOverrides((prev: any) => {
          const existing = prev.findIndex((o: any) => o.skill_id === skillId);
          if (existing >= 0) {
            const updated = [...prev];
            updated[existing] = { ...updated[existing], enabled: enabled ? 1 : 0 };
            return updated;
          }
          return [
            ...prev,
            { agent_id: referenceAgentId, skill_id: skillId, enabled: enabled ? 1 : 0 },
          ];
        });
      } catch (err: any) {
        console.error('Failed to toggle skill:', err);
        setActionError(`Failed to toggle skill ${skillId}: ${err?.message || 'unknown error'}`);
      }
    },
    [referenceAgentId],
  );

  const handleUninstall = useCallback(
    async (skillId: any, source: any) => {
      if (source !== 'project') return;
      try {
        if (!activeProjectId) return;
        await api.uninstallSkill(activeProjectId, skillId);
        setSkills((prev: any) => prev.filter((s: any) => s.id !== skillId));
      } catch (err: any) {
        console.error('Failed to uninstall:', err);
        setActionError(`Failed to uninstall skill ${skillId}: ${err?.message || 'unknown error'}`);
      }
    },
    [activeProjectId],
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
        <h2 className="text-2xl font-bold mb-2 flex items-center gap-2">
          <BookOpen size={20} /> Skills & Context
        </h2>
        {currentProject ? (
          <p className="text-sm text-gray-500 mb-6" data-testid="skills-project-label">
            {currentProject.name || currentProject.id}
          </p>
        ) : (
          <div className="mb-6" />
        )}

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

        {activeProjectId && (
          <>
            <div className="mb-8">
              <div className="flex items-center justify-between mb-4 gap-2">
                <h3 className="text-lg font-semibold flex items-center gap-2">
                  <Puzzle size={18} /> Skills
                  <span className="text-xs text-gray-500 font-normal">({skills.length} total)</span>
                </h3>
                <div className="flex items-center gap-2">
                  {onStartSkillBuilderMode && hasDevAgent ? (
                    <button
                      type="button"
                      onClick={() => onStartSkillBuilderMode(activeProjectId)}
                      className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-md bg-indigo-600 text-white hover:bg-indigo-500 transition-colors"
                      data-testid="skills-build-skill"
                      title="Open chat in Skill Builder mode to create a skill"
                    >
                      <Sparkles size={13} /> Build a skill
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => setEditorState({ skill: null })}
                    className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-md border border-gray-700 text-gray-300 hover:bg-gray-800 transition-colors"
                    title="Write a skill's SKILL.md directly"
                  >
                    <PenLine size={13} /> Write raw
                  </button>
                </div>
              </div>
              {projectAgents.length > 1 ? (
                <div
                  className="mb-3 flex flex-wrap items-center gap-1.5"
                  data-testid="skills-agent-selector"
                  role="tablist"
                  aria-label="Inspect skill overrides for agent"
                >
                  <span className="text-[11px] text-gray-500 mr-1">Overrides for:</span>
                  {projectAgents.map((agent: any) => {
                    const selected = agent.id === referenceAgentId;
                    return (
                      <button
                        key={agent.id}
                        type="button"
                        role="tab"
                        aria-selected={selected}
                        onClick={() => setSelectedAgentId(agent.id)}
                        className={`inline-flex items-center gap-1.5 text-[11px] px-2 py-1 rounded-md border transition-colors ${
                          selected
                            ? 'border-indigo-500 bg-indigo-600/20 text-indigo-200'
                            : 'border-gray-700 text-gray-400 hover:bg-gray-800'
                        }`}
                      >
                        <span
                          className="inline-block w-2 h-2 rounded-full"
                          style={{ backgroundColor: agent.color || '#6b7280' }}
                        />
                        {agent.name}
                      </button>
                    );
                  })}
                </div>
              ) : null}
              {referenceAgent ? (
                <p className="text-[11px] text-gray-500 mb-3">
                  Per-agent enable toggles apply to{' '}
                  <span className="text-gray-400">{activeAgent?.name}</span>. Change allowlists in
                  Settings → Agents.
                </p>
              ) : null}
              <PendingLessonsSection
                projectId={activeProjectId}
                improvements={improvements}
                onReviewed={loadImprovements}
                onOpenSession={onOpenSession}
              />
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
                  <p className="text-gray-500 text-sm">No skills found for this project</p>
                  <p className="text-gray-600 text-xs mt-1">
                    Use <strong className="text-gray-400">Build a skill</strong> to create one.
                  </p>
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-2" data-testid="skills-library">
                  {skills.map((skill: any) => (
                    <SkillCard
                      key={skill.id}
                      skill={skill}
                      agentId={referenceAgentId}
                      projectId={activeProjectId}
                      overrides={overrides}
                      onToggle={referenceAgentId ? handleToggle : undefined}
                      onUninstall={handleUninstall}
                      onEdit={(s: any) => setEditorState({ skill: s })}
                      isInstalled
                      pendingCount={pendingCountBySkill[skill.id] || 0}
                    />
                  ))}
                </div>
              )}
            </div>

            {activeAgent ? (
              <div>
                <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
                  <ClipboardList size={18} /> Context Files
                  <span className="text-xs text-gray-500 font-normal">(workspace identity)</span>
                </h3>
                {projectAgents.length > 1 ? (
                  <p className="text-[11px] text-gray-500 -mt-2 mb-3">
                    Showing <span className="text-gray-400">{activeAgent.name}</span>&apos;s
                    workspace files — use the agent selector above to switch.
                  </p>
                ) : null}
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
                        agentId={referenceAgentId}
                        onSaved={handleContextSaved}
                      />
                    ))}
                  </div>
                )}
              </div>
            ) : null}
          </>
        )}

        {editorState && activeProjectId && (
          <SkillEditor
            projectId={activeProjectId}
            agentId={referenceAgentId}
            skill={editorState.skill}
            onClose={() => setEditorState(null)}
            onSaved={handleSkillSaved}
          />
        )}
      </div>
    </div>
  );
}
