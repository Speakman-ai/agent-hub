import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  ArrowLeft,
  Loader2,
  ChevronUp,
  ChevronDown,
  Plus,
  Trash2,
  Save,
  RotateCcw,
  ListOrdered,
  BookOpen,
  Copy,
} from 'lucide-react';
import { api } from '../utils/api.js';
import { toWorkflowEditView } from '../utils/workflowEditView.js';
import {
  workflowFromApi,
  workflowDraftSnapshot,
  draftToPutBody,
  WORKFLOW_CRON_PRESET_LABELS,
  WORKFLOW_CRON_MODES_ORDER,
} from '../utils/workflowDraft.js';

const WORKFLOW_WS = 'agenthub-workflow-ws';
const WORKFLOW_WS_DEBOUNCE_MS = 450;

function emptyDraft() {
  return {
    name: 'New workflow',
    trigger_type: 'manual',
    default_payload_str: '{\n  \n}',
    steps: [],
    cron_mode: 'off',
    cron_expr: '',
    webhook_enabled: false,
  };
}

function cloneDraft(d) {
  return JSON.parse(JSON.stringify(d));
}

function newStepRow(agentId) {
  return {
    id: crypto.randomUUID(),
    agent_id: agentId || '',
    title: 'Step',
    role_prompt:
      'Describe what this agent should do. Use {{trigger.payload}} and prior {{steps.<id>.output}} as needed.',
    step_order: 0,
    timeout_ms: null,
    on_failure: 'abort',
  };
}

export default function ProjectWorkflowBuilder({
  projectId,
  workflowId,
  project,
  agents,
  onNavigate,
  showToast,
}) {
  const isNew = workflowId === 'new';
  const [tab, setTab] = useState('steps');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState(null);
  const [baselineDraft, setBaselineDraft] = useState(null);
  const [serverWorkflowId, setServerWorkflowId] = useState(isNew ? null : workflowId);
  const [webhookSecretFlash, setWebhookSecretFlash] = useState('');
  const [wfMeta, setWfMeta] = useState(null);

  const dirtyRef = useRef(false);
  const dirty =
    baselineDraft != null &&
    draft != null &&
    workflowDraftSnapshot(draft) !== workflowDraftSnapshot(baselineDraft);
  dirtyRef.current = dirty;

  const projectAgents = useMemo(() => {
    const list = Array.isArray(agents) ? agents : [];
    return list.filter((a) => a && a.projectId === projectId && a.active !== false);
  }, [agents, projectId]);

  const defaultAgentId = projectAgents[0]?.id || '';

  const applyLoaded = useCallback((apiRow) => {
    const w = workflowFromApi(apiRow);
    setDraft(w);
    setBaselineDraft(cloneDraft(w));
    setServerWorkflowId(String(apiRow.id));
    setWfMeta({
      webhook_url: apiRow.webhook_url || null,
      cron_next_run_preview: apiRow.cron_next_run_preview || null,
      cron_next_run_at: apiRow.cron_next_run_at || null,
      cron_valid: apiRow.cron_valid !== false,
    });
  }, []);

  useEffect(() => {
    if (!isNew) setServerWorkflowId(workflowId);
  }, [workflowId, isNew]);

  /** Bumps on each load start so stale HTTP completions cannot apply or clear loading. */
  const loadGenRef = useRef(0);

  const load = useCallback(async () => {
    const myGen = ++loadGenRef.current;
    if (!projectId) return;
    if (isNew) {
      const w = emptyDraft();
      if (myGen !== loadGenRef.current) return;
      setDraft(w);
      setBaselineDraft(cloneDraft(w));
      setWfMeta(null);
      setError('');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const row = await api.getProjectWorkflow(projectId, workflowId);
      if (myGen !== loadGenRef.current) return;
      let whFlash = '';
      try {
        const k = `ah_wf_wh_${row.id}`;
        whFlash = sessionStorage.getItem(k) || '';
        if (whFlash) sessionStorage.removeItem(k);
      } catch (_) {
        /* ignore */
      }
      applyLoaded(row);
      if (whFlash) setWebhookSecretFlash(whFlash);
    } catch (e) {
      if (myGen !== loadGenRef.current) return;
      setError(String(e.message || e));
    } finally {
      if (myGen === loadGenRef.current) setLoading(false);
    }
  }, [projectId, workflowId, isNew, applyLoaded]);

  useEffect(() => {
    void load();
  }, [load]);

  const wsDebounceTimerRef = useRef(null);
  const loadRef = useRef(load);
  loadRef.current = load;

  const scheduleWsReload = useCallback(() => {
    if (wsDebounceTimerRef.current) clearTimeout(wsDebounceTimerRef.current);
    wsDebounceTimerRef.current = setTimeout(() => {
      wsDebounceTimerRef.current = null;
      if (dirtyRef.current || isNew) return;
      void loadRef.current();
    }, WORKFLOW_WS_DEBOUNCE_MS);
  }, [isNew]);

  useEffect(() => {
    const fn = (ev) => {
      const d = ev.detail;
      if (!d || d.projectId !== projectId) return;
      scheduleWsReload();
    };
    window.addEventListener(WORKFLOW_WS, fn);
    return () => {
      window.removeEventListener(WORKFLOW_WS, fn);
      if (wsDebounceTimerRef.current) {
        clearTimeout(wsDebounceTimerRef.current);
        wsDebounceTimerRef.current = null;
      }
    };
  }, [projectId, scheduleWsReload]);

  useEffect(() => {
    const before = (e) => {
      if (dirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', before);
    return () => window.removeEventListener('beforeunload', before);
  }, [dirty]);

  const goBack = () => {
    if (dirty) {
      const ok = window.confirm('Discard unsaved changes and leave the workflow builder?');
      if (!ok) return;
    }
    onNavigate(`workflows:${projectId}`);
  };

  const copyToClipboard = async (text, label) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      if (showToast) showToast(`${label} copied.`, 'success', 2000);
    } catch {
      if (showToast) showToast('Copy failed — select and copy manually.', 'error', 3000);
    }
  };

  const rotateWebhookSecret = async () => {
    if (!serverWorkflowId) return;
    setError('');
    try {
      const r = await api.rotateWorkflowWebhookSecret(projectId, serverWorkflowId);
      if (r?.webhook_signing_secret) {
        setWebhookSecretFlash(String(r.webhook_signing_secret));
      }
      if (showToast) {
        showToast(
          'New signing secret issued — copy it now. It is not shown again.',
          'success',
          5000,
        );
      }
    } catch (e) {
      setError(String(e.message || e));
    }
  };

  const handleDiscard = () => {
    if (!baselineDraft) return;
    if (!dirty) {
      if (showToast) showToast('No changes to discard.', 'info', 2500);
      return;
    }
    setDraft(cloneDraft(baselineDraft));
    if (showToast) showToast('Restored last saved version.', 'success', 2500);
  };

  const updateStep = (index, patch) => {
    setDraft((prev) => {
      const steps = [...prev.steps];
      const cur = { ...steps[index], ...patch };
      steps[index] = cur;
      return { ...prev, steps };
    });
  };

  const moveStep = (index, dir) => {
    setDraft((prev) => {
      const steps = [...prev.steps];
      const j = index + dir;
      if (j < 0 || j >= steps.length) return prev;
      const t = steps[index];
      steps[index] = steps[j];
      steps[j] = t;
      return {
        ...prev,
        steps: steps.map((s, i) => ({ ...s, step_order: i })),
      };
    });
  };

  const removeStep = (index) => {
    setDraft((prev) => ({
      ...prev,
      steps: prev.steps.filter((_, i) => i !== index).map((s, i) => ({ ...s, step_order: i })),
    }));
  };

  const addStep = () => {
    const aid = defaultAgentId;
    setDraft((prev) => {
      const row = newStepRow(aid);
      row.step_order = prev.steps.length;
      return { ...prev, steps: [...prev.steps, row] };
    });
  };

  const handleSave = async () => {
    if (!draft) return;
    if (!String(draft.name || '').trim()) {
      if (showToast) showToast('Workflow name is required.', 'error', 4000);
      return;
    }
    let parsedDefault;
    try {
      parsedDefault = JSON.parse(draft.default_payload_str || '{}');
      if (
        parsedDefault !== null &&
        typeof parsedDefault === 'object' &&
        !Array.isArray(parsedDefault)
      ) {
        /* ok */
      } else {
        throw new Error('Default trigger JSON must be a JSON object.');
      }
    } catch (e) {
      if (showToast) showToast(String(e.message || e), 'error', 5000);
      setTab('triggers');
      return;
    }
    void parsedDefault;

    for (let i = 0; i < draft.steps.length; i += 1) {
      const s = draft.steps[i];
      if (!String(s.agent_id || '').trim()) {
        if (showToast) showToast(`Step ${i + 1}: pick an agent.`, 'error', 5000);
        setTab('steps');
        return;
      }
      if (!String(s.title || '').trim()) {
        if (showToast) showToast(`Step ${i + 1}: title is required.`, 'error', 5000);
        setTab('steps');
        return;
      }
      if (!String(s.role_prompt || '').length) {
        if (showToast) showToast(`Step ${i + 1}: role prompt is required.`, 'error', 5000);
        setTab('steps');
        return;
      }
    }

    const body = draftToPutBody(draft);
    setSaving(true);
    setError('');
    setWebhookSecretFlash('');
    try {
      if (isNew || !serverWorkflowId) {
        const created = await api.createProjectWorkflow(projectId, body);
        if (created?.webhook_signing_secret) {
          try {
            // Ephemeral bridge across client navigation; XSS on this origin could read it until load clears the key.
            sessionStorage.setItem(
              `ah_wf_wh_${created.id}`,
              String(created.webhook_signing_secret),
            );
          } catch (_) {
            /* ignore */
          }
        }
        if (showToast) showToast('Workflow created.', 'success', 3000);
        onNavigate(toWorkflowEditView(projectId, String(created.id)));
        return;
      }
      const updated = await api.updateProjectWorkflow(projectId, serverWorkflowId, body);
      if (updated?.webhook_signing_secret) {
        setWebhookSecretFlash(String(updated.webhook_signing_secret));
      }
      applyLoaded(updated);
      if (showToast) showToast('Workflow saved.', 'success', 3000);
    } catch (e) {
      const msg = String(e.message || e);
      setError(msg);
      if (showToast) showToast(msg, 'error', 6000);
    } finally {
      setSaving(false);
    }
  };

  const projectName = project?.name || 'Project';
  const projectColor = project?.color || '#6366f1';

  const refLines = useMemo(() => {
    const lines = [
      '{{trigger.payload}} — merged default + per-run payload (JSON object).',
      '{{trigger.payload.someKey}} — dot path into the merged object.',
    ];
    const steps = draft?.steps || [];
    for (const s of steps) {
      if (s.id)
        lines.push(`{{steps.${s.id}.output}} — prior step output (after that step succeeds).`);
    }
    return lines;
  }, [draft]);

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden bg-gray-950 text-gray-100">
      <div className="flex-shrink-0 border-b border-gray-800 px-4 py-3 md:px-6 flex flex-wrap items-center gap-2 gap-y-2">
        <button
          type="button"
          onClick={goBack}
          className="flex items-center gap-1.5 text-sm text-blue-400 hover:text-blue-300 transition-colors"
        >
          <ArrowLeft size={16} />
          Workflows
        </button>
        <span
          className="w-2.5 h-2.5 rounded-sm flex-shrink-0"
          style={{ backgroundColor: projectColor }}
        />
        <h1 className="text-lg font-semibold text-white truncate flex items-center gap-2 min-w-0">
          <ListOrdered size={18} className="text-violet-400 flex-shrink-0" />
          <span className="truncate">{projectName}</span>
          <span className="text-gray-500 font-normal text-sm flex-shrink-0">· Builder</span>
          {dirty && (
            <span className="text-amber-400 text-xs font-normal whitespace-nowrap">
              Unsaved changes
            </span>
          )}
        </h1>
        <span className="flex-1 min-w-[8px]" />
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={!dirty || saving}
            onClick={handleDiscard}
            className="inline-flex items-center gap-1.5 bg-gray-800 hover:bg-gray-700 disabled:opacity-40 text-white text-xs px-3 py-1.5 rounded-lg border border-gray-700"
          >
            <RotateCcw size={14} />
            Discard
          </button>
          <button
            type="button"
            disabled={saving || loading || draft == null}
            onClick={handleSave}
            className="inline-flex items-center gap-1.5 bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 text-white text-xs px-3 py-1.5 rounded-lg"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            Save
          </button>
        </div>
      </div>

      <div className="flex-shrink-0 border-b border-gray-800 px-4 md:px-6 flex gap-1">
        <button
          type="button"
          onClick={() => setTab('steps')}
          className={`px-3 py-2 text-sm rounded-t-md border-b-2 -mb-px transition-colors ${
            tab === 'steps'
              ? 'border-violet-500 text-white bg-gray-900/50'
              : 'border-transparent text-gray-400 hover:text-gray-200'
          }`}
        >
          Steps
        </button>
        <button
          type="button"
          onClick={() => setTab('triggers')}
          className={`px-3 py-2 text-sm rounded-t-md border-b-2 -mb-px transition-colors ${
            tab === 'triggers'
              ? 'border-violet-500 text-white bg-gray-900/50'
              : 'border-transparent text-gray-400 hover:text-gray-200'
          }`}
        >
          Triggers
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 md:p-6">
        <div className="max-w-3xl mx-auto space-y-4">
          {error && !loading && (
            <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200">
              {error}
            </div>
          )}

          {loading || draft == null ? (
            <div className="flex items-center gap-2 text-gray-400 text-sm py-12 justify-center">
              <Loader2 size={18} className="animate-spin" />
              Loading workflow…
            </div>
          ) : (
            <>
              <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-4">
                <label className="block text-xs font-medium text-gray-400 mb-1">
                  Workflow name
                </label>
                <input
                  type="text"
                  value={draft.name}
                  onChange={(e) => setDraft((p) => ({ ...p, name: e.target.value }))}
                  className="w-full rounded-lg bg-gray-950 border border-gray-700 px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-violet-500"
                  placeholder="Name"
                />
              </div>

              {tab === 'triggers' && (
                <div className="space-y-4">
                  <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-4 space-y-3">
                    <div>
                      <div className="text-xs font-medium text-gray-400 mb-1">Manual runs</div>
                      <p className="text-sm text-gray-300">
                        You can always start a run from the Workflows list or run history. The
                        default JSON below is merged with any per-run or automated payload.
                      </p>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-400 mb-1">
                        Default JSON payload
                      </label>
                      <p className="text-xs text-gray-500 mb-2">
                        Merged with per-run and trigger payloads. Must be a JSON object.
                      </p>
                      <textarea
                        value={draft.default_payload_str}
                        onChange={(e) =>
                          setDraft((p) => ({ ...p, default_payload_str: e.target.value }))
                        }
                        spellCheck={false}
                        rows={8}
                        className="w-full font-mono text-xs rounded-lg bg-gray-950 border border-gray-700 px-3 py-2 text-gray-100 focus:outline-none focus:ring-1 focus:ring-violet-500"
                      />
                    </div>
                  </div>

                  <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-4 space-y-3">
                    <div className="text-xs font-medium text-amber-200/90">
                      Schedule (cron · UTC)
                    </div>
                    <p className="text-xs text-gray-500">
                      Uses the same <code className="text-gray-400">node-cron</code> engine as
                      heartbeats. Leave off and rely on manual runs only, or pick a preset / custom
                      5-field expression.
                    </p>
                    <div>
                      <label className="block text-xs font-medium text-gray-400 mb-1">Preset</label>
                      <select
                        value={draft.cron_mode === 'custom' ? 'custom' : draft.cron_mode}
                        onChange={(e) => {
                          const v = e.target.value;
                          if (v === 'custom') {
                            setDraft((p) => ({ ...p, cron_mode: 'custom' }));
                            return;
                          }
                          setDraft((p) => ({ ...p, cron_mode: v, cron_expr: '' }));
                        }}
                        className="w-full max-w-md rounded-lg bg-gray-950 border border-gray-700 px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-violet-500"
                      >
                        {WORKFLOW_CRON_MODES_ORDER.map((k) => (
                          <option key={k} value={k}>
                            {WORKFLOW_CRON_PRESET_LABELS[k]}
                          </option>
                        ))}
                      </select>
                    </div>
                    {draft.cron_mode === 'custom' && (
                      <div>
                        <label className="block text-xs font-medium text-gray-400 mb-1">
                          Cron expression
                        </label>
                        <input
                          type="text"
                          value={draft.cron_expr}
                          onChange={(e) => setDraft((p) => ({ ...p, cron_expr: e.target.value }))}
                          placeholder="0 * * * *"
                          className="w-full max-w-md font-mono text-sm rounded-lg bg-gray-950 border border-gray-700 px-3 py-2 text-white focus:outline-none focus:ring-1 focus:ring-violet-500"
                        />
                        <p className="text-xs text-gray-500 mt-1">
                          Five fields: minute hour day month weekday
                        </p>
                      </div>
                    )}
                    {wfMeta && draft.cron_mode !== 'off' && (
                      <div className="text-xs text-gray-400 space-y-1">
                        {wfMeta.cron_valid === false && (
                          <p className="text-amber-400">
                            Current expression is invalid on the server.
                          </p>
                        )}
                        {(wfMeta.cron_next_run_at || wfMeta.cron_next_run_preview) && (
                          <p>
                            Next run (server):{' '}
                            <span className="text-gray-200 font-mono">
                              {wfMeta.cron_next_run_at || wfMeta.cron_next_run_preview}
                            </span>
                          </p>
                        )}
                      </div>
                    )}
                  </div>

                  <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-4 space-y-3">
                    <div className="text-xs font-medium text-sky-200/90">HTTP webhook</div>
                    <p className="text-xs text-gray-500">
                      <code className="text-gray-400">POST</code> with JSON body. The body is merged
                      into <code className="text-gray-400">trigger.payload</code> (with{' '}
                      <code className="text-gray-400">source: &quot;webhook&quot;</code>). Sign with
                      HMAC-SHA256 using your signing secret; send header{' '}
                      <code className="text-gray-400">
                        X-Agent-Hub-Signature: sha256=&lt;hex&gt;
                      </code>
                      (hex of HMAC over the raw request body).
                    </p>
                    <label className="flex items-center gap-2 text-sm text-gray-200">
                      <input
                        type="checkbox"
                        className="rounded border-gray-600"
                        checked={!!draft.webhook_enabled}
                        onChange={(e) =>
                          setDraft((p) => ({ ...p, webhook_enabled: e.target.checked }))
                        }
                      />
                      Enable signed webhook
                    </label>
                    {wfMeta?.webhook_url && (
                      <div>
                        <div className="text-xs text-gray-400 mb-1">Endpoint URL</div>
                        <div className="flex flex-wrap items-center gap-2">
                          <code className="text-xs text-gray-200 break-all font-mono bg-gray-950/80 border border-gray-800 rounded px-2 py-1.5 flex-1 min-w-0">
                            {wfMeta.webhook_url}
                          </code>
                          <button
                            type="button"
                            onClick={() => copyToClipboard(wfMeta.webhook_url, 'URL')}
                            className="inline-flex items-center gap-1 text-xs text-sky-300 border border-sky-800/60 rounded-lg px-2 py-1.5 hover:bg-sky-500/10"
                          >
                            <Copy size={14} />
                            Copy
                          </button>
                        </div>
                      </div>
                    )}
                    {webhookSecretFlash && (
                      <div className="rounded-lg border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
                        <div className="font-medium text-amber-200 mb-1">
                          Signing secret (copy now)
                        </div>
                        <code className="block break-all font-mono text-amber-50/95">
                          {webhookSecretFlash}
                        </code>
                        <button
                          type="button"
                          onClick={() => copyToClipboard(webhookSecretFlash, 'Secret')}
                          className="mt-2 text-sky-300 hover:text-sky-200"
                        >
                          Copy secret
                        </button>
                      </div>
                    )}
                    {serverWorkflowId && !isNew && draft.webhook_enabled && (
                      <button
                        type="button"
                        onClick={rotateWebhookSecret}
                        className="text-xs text-gray-300 border border-gray-600 rounded-lg px-3 py-1.5 hover:bg-gray-800"
                      >
                        Rotate signing secret
                      </button>
                    )}
                  </div>
                </div>
              )}

              {tab === 'steps' && (
                <div className="space-y-4">
                  <div className="rounded-xl border border-violet-500/30 bg-violet-500/5 p-4">
                    <div className="flex items-center gap-2 text-violet-200 text-sm font-medium mb-2">
                      <BookOpen size={16} />
                      Available template references
                    </div>
                    <ul className="text-xs text-gray-300 space-y-1.5 font-mono">
                      {refLines.map((line) => (
                        <li key={line}>{line}</li>
                      ))}
                    </ul>
                  </div>

                  {draft.steps.length === 0 ? (
                    <div className="rounded-xl border border-dashed border-gray-700 bg-gray-900/30 p-8 text-center text-gray-400 text-sm">
                      No steps yet. Add a step to define the agent sequence.
                    </div>
                  ) : (
                    <ul className="space-y-3">
                      {draft.steps.map((step, index) => (
                        <li
                          key={step.id || `idx-${index}`}
                          className="rounded-xl border border-gray-800 bg-gray-900/50 p-4 space-y-3"
                        >
                          <div className="flex flex-wrap items-center gap-2 justify-between">
                            <span className="text-xs text-gray-500 font-mono">
                              Step {index + 1}
                              {step.id ? ` · id ${step.id}` : ''}
                            </span>
                            <div className="flex items-center gap-1">
                              <button
                                type="button"
                                title="Move up"
                                disabled={index === 0}
                                onClick={() => moveStep(index, -1)}
                                className="p-1.5 rounded-md border border-gray-700 text-gray-300 hover:bg-gray-800 disabled:opacity-30"
                              >
                                <ChevronUp size={16} />
                              </button>
                              <button
                                type="button"
                                title="Move down"
                                disabled={index === draft.steps.length - 1}
                                onClick={() => moveStep(index, 1)}
                                className="p-1.5 rounded-md border border-gray-700 text-gray-300 hover:bg-gray-800 disabled:opacity-30"
                              >
                                <ChevronDown size={16} />
                              </button>
                              <button
                                type="button"
                                title="Remove step"
                                onClick={() => removeStep(index)}
                                className="p-1.5 rounded-md border border-red-900/50 text-red-300 hover:bg-red-950/40"
                              >
                                <Trash2 size={16} />
                              </button>
                            </div>
                          </div>

                          <div className="grid gap-3 sm:grid-cols-2">
                            <div className="sm:col-span-2">
                              <label className="block text-xs font-medium text-gray-400 mb-1">
                                Agent
                              </label>
                              <select
                                value={step.agent_id}
                                onChange={(e) => updateStep(index, { agent_id: e.target.value })}
                                className="w-full rounded-lg bg-gray-950 border border-gray-700 px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-violet-500"
                              >
                                <option value="">Select agent…</option>
                                {projectAgents.map((a) => (
                                  <option key={a.id} value={a.id}>
                                    {a.name || a.id}
                                  </option>
                                ))}
                              </select>
                              {projectAgents.length === 0 && (
                                <p className="text-xs text-amber-400 mt-1">
                                  No active agents in this project. Add an agent in Settings first.
                                </p>
                              )}
                            </div>
                            <div className="sm:col-span-2">
                              <label className="block text-xs font-medium text-gray-400 mb-1">
                                Step title
                              </label>
                              <input
                                type="text"
                                value={step.title}
                                onChange={(e) => updateStep(index, { title: e.target.value })}
                                className="w-full rounded-lg bg-gray-950 border border-gray-700 px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-violet-500"
                              />
                            </div>
                            <div className="sm:col-span-2">
                              <label className="block text-xs font-medium text-gray-400 mb-1">
                                Role prompt
                              </label>
                              <textarea
                                value={step.role_prompt}
                                onChange={(e) => updateStep(index, { role_prompt: e.target.value })}
                                rows={5}
                                className="w-full rounded-lg bg-gray-950 border border-gray-700 px-3 py-2 text-sm text-gray-100 focus:outline-none focus:ring-1 focus:ring-violet-500"
                              />
                            </div>
                            <div>
                              <label className="block text-xs font-medium text-gray-400 mb-1">
                                Timeout (ms)
                              </label>
                              <input
                                type="number"
                                min={0}
                                value={step.timeout_ms == null ? '' : String(step.timeout_ms)}
                                onChange={(e) => {
                                  const v = e.target.value;
                                  updateStep(index, {
                                    timeout_ms: v === '' ? null : Math.max(0, parseInt(v, 10) || 0),
                                  });
                                }}
                                placeholder="Default engine timeout"
                                className="w-full rounded-lg bg-gray-950 border border-gray-700 px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-violet-500"
                              />
                            </div>
                            <div>
                              <label className="block text-xs font-medium text-gray-400 mb-1">
                                On failure
                              </label>
                              <select
                                value={step.on_failure || 'abort'}
                                onChange={(e) => updateStep(index, { on_failure: e.target.value })}
                                className="w-full rounded-lg bg-gray-950 border border-gray-700 px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-violet-500"
                              >
                                <option value="abort">Abort workflow</option>
                                <option value="continue">Continue to next step</option>
                                <option value="retry">Retry step</option>
                              </select>
                            </div>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}

                  <button
                    type="button"
                    onClick={addStep}
                    className="inline-flex items-center gap-2 text-sm text-violet-300 hover:text-violet-200 border border-dashed border-violet-600/50 rounded-xl px-4 py-3 w-full justify-center hover:bg-violet-500/10"
                  >
                    <Plus size={16} />
                    Add step
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
