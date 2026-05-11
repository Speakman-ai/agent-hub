import { useEffect, useMemo, useState } from 'react';
import { Check, Edit3, Monitor, X } from 'lucide-react';

/**
 * PreviewConfirm — single-screen confirmation panel for preview defaults
 * detected by the server during clone / scaffold.
 *
 * Renders a summary of the detected `prEnv.preview` config (framework
 * label, startScript, port hint, captureRoutes, idleTTL) with three
 * actions:
 *   - "Looks good"  → onConfirm(form, 'accept')   keeps detected values as-is
 *   - "Edit"        → expands an inline editor; "Save" emits onConfirm(form, 'edit')
 *   - "Skip preview"→ onConfirm({ enabled: false }, 'skip')
 *
 * The component is intentionally stateless about persistence — the
 * parent wizard calls the PATCH endpoint after onboard succeeds. We
 * surface only the user's intent.
 *
 * Empty-detection note: this component must NOT be rendered when the
 * server reports `detected: null`. The caller handles that branch
 * silently (defaults to enabled: false, no UI). See the clone wizard
 * for the gate.
 */
export default function PreviewConfirm({ detected, onConfirm, onSkip }) {
  const initial = useMemo(
    () => ({
      enabled: true,
      startScript: detected?.startScript || 'npm run dev',
      port: typeof detected?.port === 'number' ? detected.port : null,
      captureRoutes:
        Array.isArray(detected?.captureRoutes) && detected.captureRoutes.length > 0
          ? [...detected.captureRoutes]
          : ['/'],
      idleTTL: typeof detected?.idleTTL === 'number' ? detected.idleTTL : 600,
    }),
    [detected],
  );

  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState(initial);
  const [routeDraft, setRouteDraft] = useState('');

  // When the detected payload changes (e.g. a re-detect), reset the form.
  useEffect(() => {
    setForm(initial);
    setEditing(false);
    setRouteDraft('');
  }, [initial]);

  const stackLabel = detected?.stack
    ? detected.stack.charAt(0).toUpperCase() + detected.stack.slice(1)
    : 'Unknown stack';

  const setField = (key, value) => setForm((prev) => ({ ...prev, [key]: value }));

  const addRoute = () => {
    const trimmed = (routeDraft || '').trim();
    if (!trimmed) return;
    if (!trimmed.startsWith('/')) return;
    if (form.captureRoutes.includes(trimmed)) {
      setRouteDraft('');
      return;
    }
    setForm((prev) => ({ ...prev, captureRoutes: [...prev.captureRoutes, trimmed] }));
    setRouteDraft('');
  };

  const removeRoute = (idx) => {
    setForm((prev) => ({
      ...prev,
      captureRoutes: prev.captureRoutes.filter((_, i) => i !== idx),
    }));
  };

  const handleAccept = () => {
    if (typeof onConfirm === 'function') {
      onConfirm({ ...initial, enabled: true }, 'accept');
    }
  };

  const handleSaveEdits = () => {
    if (typeof onConfirm === 'function') {
      onConfirm({ ...form, enabled: true }, 'edit');
    }
  };

  const handleSkip = () => {
    if (typeof onSkip === 'function') {
      onSkip();
    } else if (typeof onConfirm === 'function') {
      onConfirm({ enabled: false }, 'skip');
    }
  };

  return (
    <div
      className="bg-sky-500/5 border border-sky-500/30 rounded-xl p-4 space-y-3"
      data-testid="preview-confirm"
    >
      <div className="flex items-start gap-2">
        <Monitor size={16} className="text-sky-400 shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-sky-200">
            Detected {stackLabel} project — confirm preview defaults
          </p>
          <p className="text-xs text-gray-400 mt-0.5">
            Agent Hub will boot a per-session preview using these settings. You can accept, tweak,
            or skip.
          </p>
        </div>
      </div>

      {!editing ? (
        <ul
          className="text-xs font-mono text-gray-300 space-y-0.5 pl-6"
          data-testid="preview-confirm-summary"
        >
          <li>
            startScript: <span className="text-gray-200">{form.startScript}</span>
          </li>
          {form.port != null && (
            <li>
              port hint: <span className="text-gray-200">{form.port}</span>
            </li>
          )}
          <li>
            captureRoutes:{' '}
            <span className="text-gray-200">
              {form.captureRoutes.length > 0 ? form.captureRoutes.join(', ') : '—'}
            </span>
          </li>
          <li>
            idleTTL: <span className="text-gray-200">{form.idleTTL}s</span>
          </li>
        </ul>
      ) : (
        <div className="space-y-3 pl-6">
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1">Start script</label>
            <input
              type="text"
              value={form.startScript}
              onChange={(e) => setField('startScript', e.target.value)}
              className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-xs font-mono text-gray-200 focus:outline-none focus:border-sky-500"
              data-testid="preview-confirm-startScript"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1">
              Idle TTL (seconds)
            </label>
            <input
              type="number"
              value={form.idleTTL}
              min={60}
              max={86400}
              onChange={(e) =>
                setField('idleTTL', e.target.value === '' ? '' : Number(e.target.value))
              }
              className="w-32 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-xs font-mono text-gray-200 focus:outline-none focus:border-sky-500"
              data-testid="preview-confirm-idleTTL"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1">Capture routes</label>
            <div className="flex flex-wrap gap-1.5 mb-2" data-testid="preview-confirm-routes">
              {form.captureRoutes.map((route, idx) => (
                <span
                  key={`${route}-${idx}`}
                  className="inline-flex items-center gap-1 bg-gray-800 border border-gray-700 rounded-full px-2 py-0.5 text-[11px] font-mono text-gray-200"
                >
                  {route}
                  <button
                    type="button"
                    onClick={() => removeRoute(idx)}
                    aria-label={`Remove route ${route}`}
                    className="text-gray-500 hover:text-red-400"
                  >
                    <X size={10} />
                  </button>
                </span>
              ))}
            </div>
            <div className="flex gap-2">
              <input
                type="text"
                value={routeDraft}
                onChange={(e) => setRouteDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addRoute();
                  }
                }}
                placeholder="/about"
                className="flex-1 bg-gray-900 border border-gray-700 rounded-lg px-3 py-1.5 text-xs font-mono text-gray-200 focus:outline-none focus:border-sky-500"
                data-testid="preview-confirm-route-input"
              />
              <button
                type="button"
                onClick={addRoute}
                className="bg-gray-700 hover:bg-gray-600 text-white text-xs px-2.5 py-1.5 rounded-lg"
              >
                Add
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="flex flex-wrap gap-2 pt-1">
        {!editing ? (
          <>
            <button
              type="button"
              onClick={handleAccept}
              className="flex items-center gap-1.5 bg-sky-600 hover:bg-sky-500 text-white text-xs px-3 py-1.5 rounded-lg"
              data-testid="preview-confirm-accept"
            >
              <Check size={12} /> Looks good
            </button>
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="flex items-center gap-1.5 bg-gray-700 hover:bg-gray-600 text-white text-xs px-3 py-1.5 rounded-lg"
              data-testid="preview-confirm-edit"
            >
              <Edit3 size={12} /> Edit
            </button>
            <button
              type="button"
              onClick={handleSkip}
              className="flex items-center gap-1.5 text-gray-400 hover:text-gray-200 text-xs px-3 py-1.5 rounded-lg"
              data-testid="preview-confirm-skip"
            >
              Skip preview
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={handleSaveEdits}
              className="flex items-center gap-1.5 bg-sky-600 hover:bg-sky-500 text-white text-xs px-3 py-1.5 rounded-lg"
              data-testid="preview-confirm-save-edits"
            >
              <Check size={12} /> Save
            </button>
            <button
              type="button"
              onClick={() => {
                setForm(initial);
                setEditing(false);
              }}
              className="flex items-center gap-1.5 bg-gray-700 hover:bg-gray-600 text-white text-xs px-3 py-1.5 rounded-lg"
              data-testid="preview-confirm-cancel-edits"
            >
              <X size={12} /> Cancel
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Build a PATCH payload for `/api/projects/:id` from a confirmed preview
 * decision. Returns null when the user skipped (caller may then send
 * `{ prEnv: { enabled: false, preview: { enabled: false } } }` or simply
 * not call PATCH at all — the validator accepts the disabled shape too).
 *
 * Exported for tests and for the wizard to reuse without re-implementing.
 */
export function buildPreviewPatch(confirmed) {
  if (!confirmed) return null;
  if (!confirmed.enabled) {
    return {
      prEnv: { enabled: false, preview: { enabled: false } },
    };
  }
  const preview = { enabled: true };
  if (confirmed.startScript) preview.startScript = confirmed.startScript;
  if (Array.isArray(confirmed.captureRoutes) && confirmed.captureRoutes.length > 0) {
    preview.captureRoutes = confirmed.captureRoutes
      .map((r) => (typeof r === 'string' ? r.trim() : ''))
      .filter(Boolean);
  }
  const n = Number(confirmed.idleTTL);
  if (confirmed.idleTTL !== '' && confirmed.idleTTL != null && Number.isInteger(n) && n > 0) {
    preview.idleTTL = n;
  }
  return {
    prEnv: { enabled: false, preview },
  };
}
