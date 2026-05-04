import { useState, useEffect, useCallback } from 'react';
import { Plug, CheckCircle2, XCircle, Loader2, AlertTriangle, Info, Lock } from 'lucide-react';
import { api } from '../utils/api.js';

/**
 * Settings → Admin → Integrations.
 *
 * Owner-only operator-level config: pick between Hub-Shared mode (the
 * cloud build picks up `HUB_SHARED_NANGO_KEY` from the build env) and
 * BYO Nango (operator pastes their own secret).
 *
 * Switching modes is allowed but surfaces a confirm modal warning that
 * existing user `connection_id`s in the other mode become unreachable
 * until each user re-connects — Agent Hub does not migrate connection
 * IDs across Nango projects.
 *
 * Non-Owner users hit the API's 403 guard and see a banner pointing
 * them at Settings → Integrations (per-user "Connect" page; not in
 * scope for this admin component).
 */

const MASK = '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022';

const PROVIDERS = [
  { id: 'nango-cloud', label: 'Nango Cloud (api.nango.dev)' },
  { id: 'nango-selfhosted', label: 'Nango Self-Hosted' },
];

function emptyForm(masked) {
  return {
    mode: masked?.mode || 'shared',
    provider: masked?.provider || 'nango-cloud',
    secretKey: masked?.hasKey ? MASK : '',
    providerBaseUrl: masked?.baseUrl || '',
    webhookSecret: masked?.hasWebhookSecret ? MASK : '',
    enabled: masked?.enabled ?? true,
  };
}

export default function IntegrationProviderSection() {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [server, setServer] = useState(null);
  const [form, setForm] = useState(emptyForm());
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [saveStatus, setSaveStatus] = useState(null);
  const [validating, setValidating] = useState(false);
  const [validateResult, setValidateResult] = useState(null);
  const [pendingModeSwitch, setPendingModeSwitch] = useState(null);
  const [forbidden, setForbidden] = useState(false);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const data = await api.getIntegrationProviderSettings();
      setServer(data);
      setForm(emptyForm(data));
      setForbidden(false);
    } catch (err) {
      if (/\b403\b/.test(err.message)) {
        setForbidden(true);
      } else {
        setLoadError(err.message || 'Failed to load integration provider settings');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const updateField = (key, value) => {
    setForm((f) => ({ ...f, [key]: value }));
    setSaveStatus(null);
    setValidateResult(null);
  };

  const requestModeChange = (nextMode) => {
    if (nextMode === form.mode) return;
    // Switching from a configured mode to a different one is potentially
    // disruptive — surface a confirm step.
    const isDestructive =
      (form.mode === 'byo' && server?.hasKey) ||
      (form.mode === 'shared' && server?.mode === 'shared');
    if (isDestructive) {
      setPendingModeSwitch(nextMode);
      return;
    }
    updateField('mode', nextMode);
  };

  const confirmModeSwitch = () => {
    if (pendingModeSwitch) {
      updateField('mode', pendingModeSwitch);
      setPendingModeSwitch(null);
    }
  };

  const cancelModeSwitch = () => setPendingModeSwitch(null);

  const buildPayload = () => {
    const payload = {
      mode: form.mode,
      provider: form.provider,
      enabled: !!form.enabled,
      providerBaseUrl: form.providerBaseUrl,
    };
    if (form.mode === 'byo') {
      // MASK preserves the stored value server-side; an explicit empty
      // string clears the secret.
      payload.secretKey = form.secretKey;
      payload.webhookSecret = form.webhookSecret;
    }
    return payload;
  };

  const handleValidate = async () => {
    setValidating(true);
    setValidateResult(null);
    try {
      const result = await api.validateIntegrationProviderSettings(buildPayload());
      setValidateResult(result);
    } catch (err) {
      setValidateResult({ ok: false, message: err.message });
    } finally {
      setValidating(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);
    setSaveStatus(null);
    try {
      const data = await api.updateIntegrationProviderSettings(buildPayload());
      setServer(data);
      setForm(emptyForm(data));
      setSaveStatus('saved');
    } catch (err) {
      setSaveError(err.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="text-zinc-400 flex items-center gap-2 text-sm">
        <Loader2 size={14} className="animate-spin" />
        Loading…
      </div>
    );
  }

  if (forbidden) {
    return (
      <div className="rounded border border-amber-700 bg-amber-900/30 p-4 text-sm text-amber-100 flex items-start gap-3">
        <Lock size={18} className="mt-0.5 flex-shrink-0" />
        <div>
          <div className="font-semibold mb-1">Owner-only setting</div>
          <p>
            Integration provider configuration (Nango shared/BYO) requires the Owner role. Visit{' '}
            <span className="font-mono">Settings → Integrations</span> to connect your personal
            Slack / Google / GitHub accounts.
          </p>
        </div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="rounded border border-red-700 bg-red-900/30 p-4 text-sm text-red-100">
        {loadError}
      </div>
    );
  }

  const sharedAvailable = !!server?.sharedAvailable;
  const isShared = form.mode === 'shared';
  const isByo = form.mode === 'byo';
  const cannotSwitchToShared = !sharedAvailable;

  return (
    <div className="space-y-6 max-w-3xl">
      <header>
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <Plug size={18} /> Integration Provider
        </h2>
        <p className="text-sm text-zinc-400 mt-1">
          Operator-level configuration for the OAuth provider that powers per-user{' '}
          <span className="font-mono">Settings → Integrations</span> connections (Slack, Google,
          GitHub via user). Defaults to <strong>Hub-Shared</strong> for cloud installs (no operator
          action required) and <strong>BYO</strong> for self-hosted.
        </p>
      </header>

      {/* Mode toggle (top-level control) */}
      <fieldset className="space-y-3">
        <legend className="text-sm font-medium">Mode</legend>
        <label
          className={`flex items-start gap-3 rounded border p-3 cursor-pointer ${
            isShared ? 'border-blue-500 bg-blue-900/20' : 'border-zinc-700 hover:border-zinc-500'
          } ${cannotSwitchToShared && !isShared ? 'opacity-60' : ''}`}
        >
          <input
            type="radio"
            name="mode"
            value="shared"
            checked={isShared}
            disabled={cannotSwitchToShared && !isShared}
            onChange={() => requestModeChange('shared')}
            className="mt-1"
          />
          <div className="flex-1">
            <div className="font-medium">Hub-Shared</div>
            <div className="text-xs text-zinc-400 mt-1">
              Use the Agent Hub Cloud shared Nango account.{' '}
              <span className="font-mono">HUB_SHARED_NANGO_KEY</span> is read from the server
              environment — operator does nothing.
            </div>
            {cannotSwitchToShared && !isShared && (
              <div className="text-xs text-amber-300 mt-2 flex items-center gap-1">
                <AlertTriangle size={12} /> Not available — server has no{' '}
                <span className="font-mono">HUB_SHARED_NANGO_KEY</span> set.
              </div>
            )}
          </div>
        </label>
        <label
          className={`flex items-start gap-3 rounded border p-3 cursor-pointer ${
            isByo ? 'border-blue-500 bg-blue-900/20' : 'border-zinc-700 hover:border-zinc-500'
          }`}
        >
          <input
            type="radio"
            name="mode"
            value="byo"
            checked={isByo}
            onChange={() => requestModeChange('byo')}
            className="mt-1"
          />
          <div className="flex-1">
            <div className="font-medium">BYO Nango</div>
            <div className="text-xs text-zinc-400 mt-1">
              Paste your own Nango secret key. Use this for self-hosted installs and any cloud
              install that wants its own Nango environment.
            </div>
          </div>
        </label>
      </fieldset>

      {/* Shared mode banner */}
      {isShared && (
        <div className="rounded border border-blue-700 bg-blue-900/30 p-3 text-sm text-blue-100 flex items-start gap-2">
          <Info size={16} className="mt-0.5 flex-shrink-0" />
          <div>
            {sharedAvailable
              ? 'Connected to Agent Hub Shared. Users can connect Slack / Google / GitHub immediately from Settings → Integrations.'
              : 'Shared mode selected, but the server has no HUB_SHARED_NANGO_KEY. Provision the key in the deploy pipeline or switch to BYO.'}
          </div>
        </div>
      )}

      {/* BYO mode form */}
      {isByo && (
        <fieldset className="space-y-3">
          <legend className="text-sm font-medium">Provider</legend>
          <select
            value={form.provider}
            onChange={(e) => updateField('provider', e.target.value)}
            className="w-full rounded border border-zinc-700 bg-zinc-900 p-2 text-sm"
          >
            {PROVIDERS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>

          <label className="block text-sm font-medium mt-3">Secret key</label>
          <input
            type="password"
            value={form.secretKey}
            onChange={(e) => updateField('secretKey', e.target.value)}
            placeholder="nango_…"
            className="w-full rounded border border-zinc-700 bg-zinc-900 p-2 text-sm font-mono"
          />
          <div className="text-xs text-zinc-500">
            Stored encrypted at rest (AES-256-GCM). The mask sentinel{' '}
            <span className="font-mono">{MASK}</span> preserves the stored value if you don&apos;t
            change this field.
          </div>

          <label className="block text-sm font-medium mt-3">Provider base URL</label>
          <input
            type="text"
            value={form.providerBaseUrl}
            onChange={(e) => updateField('providerBaseUrl', e.target.value)}
            placeholder="https://api.nango.dev"
            className="w-full rounded border border-zinc-700 bg-zinc-900 p-2 text-sm font-mono"
          />
          <div className="text-xs text-zinc-500">
            Leave blank to use the default (<span className="font-mono">https://api.nango.dev</span>
            ). Override only for self-hosted Nango.
          </div>

          <label className="block text-sm font-medium mt-3">
            Webhook signing secret <span className="text-zinc-500 font-normal">(optional)</span>
          </label>
          <input
            type="password"
            value={form.webhookSecret}
            onChange={(e) => updateField('webhookSecret', e.target.value)}
            placeholder=""
            className="w-full rounded border border-zinc-700 bg-zinc-900 p-2 text-sm font-mono"
          />
        </fieldset>
      )}

      {/* Enabled toggle */}
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={!!form.enabled}
          onChange={(e) => updateField('enabled', e.target.checked)}
        />
        <span>Enabled</span>
        <span className="text-xs text-zinc-500">
          (when off, all per-user Connect buttons are disabled)
        </span>
      </label>

      {/* Action row */}
      <div className="flex flex-wrap items-center gap-3 pt-2 border-t border-zinc-800">
        <button
          type="button"
          onClick={handleValidate}
          disabled={validating || saving}
          className="inline-flex items-center gap-2 rounded bg-zinc-700 hover:bg-zinc-600 px-3 py-1.5 text-sm disabled:opacity-50"
        >
          {validating ? <Loader2 size={14} className="animate-spin" /> : null}
          Validate
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={saving || validating}
          className="inline-flex items-center gap-2 rounded bg-blue-600 hover:bg-blue-500 px-3 py-1.5 text-sm disabled:opacity-50"
        >
          {saving ? <Loader2 size={14} className="animate-spin" /> : null}
          Save
        </button>
        {saveStatus === 'saved' && (
          <span className="text-emerald-400 text-sm flex items-center gap-1">
            <CheckCircle2 size={14} /> Saved
          </span>
        )}
        {saveError && (
          <span className="text-red-400 text-sm flex items-center gap-1">
            <XCircle size={14} /> {saveError}
          </span>
        )}
      </div>

      {/* Validate result */}
      {validateResult && (
        <div
          className={`rounded border p-3 text-sm flex items-start gap-2 ${
            validateResult.ok
              ? 'border-emerald-700 bg-emerald-900/30 text-emerald-100'
              : 'border-red-700 bg-red-900/30 text-red-100'
          }`}
        >
          {validateResult.ok ? (
            <CheckCircle2 size={16} className="mt-0.5 flex-shrink-0" />
          ) : (
            <XCircle size={16} className="mt-0.5 flex-shrink-0" />
          )}
          <div>
            <div className="font-medium">
              {validateResult.ok ? 'Validation passed' : 'Validation failed'}
            </div>
            {validateResult.message && <div className="text-xs mt-1">{validateResult.message}</div>}
            {validateResult.environment?.name && (
              <div className="text-xs mt-1">
                Connected to environment:{' '}
                <span className="font-mono">{validateResult.environment.name}</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Mode-switch confirmation modal */}
      {pendingModeSwitch && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="bg-zinc-900 border border-zinc-700 rounded-lg max-w-md w-full p-5 space-y-3">
            <h3 className="font-semibold flex items-center gap-2 text-amber-300">
              <AlertTriangle size={18} /> Switch integration provider mode?
            </h3>
            <p className="text-sm text-zinc-300">
              Switching from <strong>{form.mode === 'shared' ? 'Hub-Shared' : 'BYO'}</strong> to{' '}
              <strong>{pendingModeSwitch === 'shared' ? 'Hub-Shared' : 'BYO'}</strong> will leave
              existing user connections unreachable until each user re-connects. Agent Hub does{' '}
              <em>not</em> migrate connection IDs across Nango projects.
            </p>
            <div className="flex gap-2 justify-end pt-2">
              <button
                type="button"
                onClick={cancelModeSwitch}
                className="rounded bg-zinc-700 hover:bg-zinc-600 px-3 py-1.5 text-sm"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmModeSwitch}
                className="rounded bg-amber-600 hover:bg-amber-500 px-3 py-1.5 text-sm"
              >
                Switch mode
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
