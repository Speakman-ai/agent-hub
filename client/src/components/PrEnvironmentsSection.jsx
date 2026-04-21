import { useState, useEffect, useCallback } from 'react';
import {
  GitBranch,
  Globe,
  Key,
  Cloud,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Loader2,
  RefreshCw,
  Eye,
  EyeOff,
  ShieldAlert,
} from 'lucide-react';
import { api } from '../utils/api.js';
import {
  MASK,
  SECRET_FIELDS,
  buildPrEnvSavePayload,
  validatePrEnvForm,
  isMaskValue,
} from '../utils/prEnvPayload.js';

const EMPTY_FORM = {
  enabled: false,
  repoFullName: '',
  previewHost: '',
  previewBaseUrl: '',
  certRenewalLive: false,
  portRangeMin: '',
  portRangeMax: '',
  githubAppId: '',
  githubInstallationId: '',
  githubPrivateKey: '',
  route53AccessKeyId: '',
  route53SecretAccessKey: '',
  route53HostedZoneId: '',
};

/** Map masked server state into form state (null/undefined → '' for controlled inputs). */
function hydrateForm(server) {
  if (!server) return { ...EMPTY_FORM };
  return {
    enabled: !!server.enabled,
    repoFullName: server.repoFullName ?? '',
    previewHost: server.previewHost ?? '',
    previewBaseUrl: server.previewBaseUrl ?? '',
    certRenewalLive: !!server.certRenewalLive,
    portRangeMin: server.portRangeMin ?? '',
    portRangeMax: server.portRangeMax ?? '',
    githubAppId: server.githubAppId ?? '',
    githubInstallationId: server.githubInstallationId ?? '',
    githubPrivateKey: server.githubPrivateKey ?? '', // '' or MASK
    route53AccessKeyId: server.route53AccessKeyId ?? '',
    route53SecretAccessKey: server.route53SecretAccessKey ?? '', // '' or MASK
    route53HostedZoneId: server.route53HostedZoneId ?? '',
  };
}

const CHECK_LABELS = {
  docker: 'Docker daemon',
  nginx: 'Nginx sites dirs',
  'github-app': 'GitHub App',
  route53: 'Route53 hosted zone',
};

/**
 * PR environments settings UI.
 *
 * Covers Tier 1 (general) and Tier 2 (credentials) fields from
 * `server/pr-env-schema.ts`. Tier 3 (host paths — nginx dirs, prodDbPath, etc.)
 * stays in `~/.agent-hub/data/config.json` by design.
 *
 * Behaviors:
 * - GET returns secrets as the mask sentinel `••••••••` when set, '' when unset.
 *   The UI displays a locked read-only input for masked secrets with an "Edit"
 *   button that clears the field so the user can type a new value. Save skips
 *   masked secrets so the server preserves them.
 * - Validate hits `/api/settings/pr-env/validate` and renders the 4 per-check
 *   results (docker / nginx / github-app / route53). The saved DB row is the
 *   source of truth server-side, plus any transient edits in the current form.
 * - Enable toggle is gated: disabled until either (a) a prior save succeeded
 *   AND validation passes, or (b) the user explicitly overrides via the
 *   "Enable without validation" checkbox (rare — surfaces a warning).
 */
export default function PrEnvironmentsSection() {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [server, setServer] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState(null); // 'saved' | 'error' | null
  const [saveError, setSaveError] = useState(null);
  const [validating, setValidating] = useState(false);
  const [validateResult, setValidateResult] = useState(null); // { ok, checks: [...] } | null
  const [validateError, setValidateError] = useState(null);
  const [editingSecret, setEditingSecret] = useState({}); // { [fieldName]: true }
  const [showSecret, setShowSecret] = useState({});
  const [overrideGate, setOverrideGate] = useState(false);

  const load = useCallback(async () => {
    try {
      setLoadError(null);
      const data = await api.getPrEnvSettings();
      setServer(data);
      setForm(hydrateForm(data));
      setEditingSecret({});
    } catch (err) {
      setLoadError(err.message || 'Failed to load PR-env settings');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const clientErrors = validatePrEnvForm(form);
  const validationPassed = validateResult?.ok === true;
  const enableGated = !overrideGate && !validationPassed;

  const setField = (k, v) => setForm((prev) => ({ ...prev, [k]: v }));

  const startEditSecret = (field) => {
    // Clear the masked value so the user can type a fresh secret.
    setEditingSecret((prev) => ({ ...prev, [field]: true }));
    setField(field, '');
  };

  const cancelEditSecret = (field) => {
    // Restore to server-provided masked/empty value.
    setEditingSecret((prev) => {
      const next = { ...prev };
      delete next[field];
      return next;
    });
    setField(field, server?.[field] ?? '');
  };

  const handleSave = async () => {
    if (clientErrors.length > 0) return;
    setSaving(true);
    setSaveError(null);
    try {
      const payload = buildPrEnvSavePayload(form);
      const updated = await api.updatePrEnvSettings(payload);
      setServer(updated);
      setForm(hydrateForm(updated));
      setEditingSecret({});
      setSaveStatus('saved');
      // Any save invalidates the last validation result — creds may have changed.
      setValidateResult(null);
      setTimeout(() => setSaveStatus(null), 2500);
    } catch (err) {
      setSaveStatus('error');
      setSaveError(err.message || 'Save failed');
      setTimeout(() => setSaveStatus(null), 4000);
    } finally {
      setSaving(false);
    }
  };

  const handleValidate = async () => {
    setValidating(true);
    setValidateError(null);
    setValidateResult(null);
    try {
      // Send only currently edited fields so unsaved edits are validated,
      // but masked secrets drop out (server falls back to stored value).
      const payload = buildPrEnvSavePayload(form);
      const result = await api.validatePrEnvSettings(payload);
      setValidateResult(result);
    } catch (err) {
      setValidateError(err.message || 'Validation failed');
    } finally {
      setValidating(false);
    }
  };

  if (loading) {
    return (
      <p className="text-sm text-gray-500 flex items-center gap-2">
        <Loader2 size={14} className="animate-spin" />
        Loading PR environment settings…
      </p>
    );
  }
  if (loadError) {
    return (
      <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4">
        <p className="text-red-400 text-sm font-medium mb-1">Failed to load</p>
        <p className="text-xs text-gray-400 mb-3">{loadError}</p>
        <button
          onClick={load}
          className="flex items-center gap-1.5 bg-gray-700 hover:bg-gray-600 text-white text-xs px-3 py-1.5 rounded-lg"
        >
          <RefreshCw size={12} />
          Retry
        </button>
      </div>
    );
  }

  const inputClass =
    'w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-gray-600 font-mono disabled:opacity-60';
  const labelClass = 'block text-xs text-gray-400 mb-1';

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h3 className="text-lg font-semibold text-white flex items-center gap-2">
          <GitBranch size={18} className="text-blue-400" />
          PR Environments
        </h3>
        <p className="text-xs text-gray-400 mt-1 max-w-2xl">
          Configure ephemeral per-PR preview environments. Tier 1 (general) and Tier 2 (credentials)
          are edited here; Tier 3 (host paths such as nginx dirs) stays in
          <code className="text-gray-300 mx-1">~/.agent-hub/data/config.json</code>
          by design.
        </p>
      </div>

      {/* Backup warning — loss of the key file = loss of all stored secrets. */}
      <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl p-4">
        <div className="flex items-start gap-3">
          <ShieldAlert size={18} className="text-amber-400 shrink-0 mt-0.5" />
          <div className="text-xs text-amber-100/90 space-y-1.5">
            <p className="font-medium text-amber-300">Back up the secret key</p>
            <p>
              Credentials are AES-256-GCM encrypted at rest using
              <code className="mx-1 text-amber-200">&lt;dataDir&gt;/pr-env-secret.key</code>. If
              that file is lost, every stored secret becomes unrecoverable and must be re-entered.
              Include it in your backup routine alongside the SQLite DB.
            </p>
          </div>
        </div>
      </div>

      {/* ── Enable toggle ─────────────────────────────────────────────────── */}
      <div className="bg-gray-800 rounded-xl p-4 space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h4 className="text-sm font-medium text-gray-200">Feature enabled</h4>
            <p className="text-xs text-gray-500 mt-0.5">
              When enabled, PR webhooks will trigger preview environment builds using the configured
              GitHub App and Route53 credentials.
            </p>
          </div>
          <label className="flex items-center gap-2 cursor-pointer shrink-0">
            <input
              type="checkbox"
              checked={form.enabled}
              disabled={enableGated && !form.enabled}
              onChange={(e) => setField('enabled', e.target.checked)}
              className="w-4 h-4"
              aria-label="PR environments enabled"
            />
            <span className="text-sm text-gray-300">{form.enabled ? 'On' : 'Off'}</span>
          </label>
        </div>
        {enableGated && !form.enabled && (
          <div className="text-[11px] text-amber-300/90 bg-amber-500/10 border border-amber-500/20 rounded-lg p-2.5 flex items-start gap-2">
            <AlertTriangle size={13} className="shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p>Validation must pass before enabling. Run "Validate" below, or:</p>
              <label className="flex items-center gap-1.5 text-amber-200/80">
                <input
                  type="checkbox"
                  checked={overrideGate}
                  onChange={(e) => setOverrideGate(e.target.checked)}
                  className="w-3.5 h-3.5"
                />
                Enable without validation (not recommended)
              </label>
            </div>
          </div>
        )}
      </div>

      {/* ── Tier 1 — General ──────────────────────────────────────────────── */}
      <div className="bg-gray-800 rounded-xl p-4 space-y-4">
        <div className="flex items-center gap-2">
          <Globe size={14} className="text-gray-400" />
          <h4 className="text-sm font-medium text-gray-200">General</h4>
        </div>

        <div>
          <label className={labelClass} htmlFor="prenv-repo">
            Repo (owner/name)
          </label>
          <input
            id="prenv-repo"
            value={form.repoFullName}
            onChange={(e) => setField('repoFullName', e.target.value)}
            className={inputClass}
            placeholder="acme/widgets"
          />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className={labelClass} htmlFor="prenv-preview-host">
              Preview host
            </label>
            <input
              id="prenv-preview-host"
              value={form.previewHost}
              onChange={(e) => setField('previewHost', e.target.value)}
              className={inputClass}
              placeholder="*.preview.example.com"
            />
            <p className="text-[11px] text-gray-600 mt-1">
              Wildcard DNS target for preview envs (Route53).
            </p>
          </div>
          <div>
            <label className={labelClass} htmlFor="prenv-preview-base-url">
              Preview base URL
            </label>
            <input
              id="prenv-preview-base-url"
              value={form.previewBaseUrl}
              onChange={(e) => setField('previewBaseUrl', e.target.value)}
              className={inputClass}
              placeholder="https://pr-{{number}}.preview.example.com"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className={labelClass} htmlFor="prenv-port-min">
              Port range min
            </label>
            <input
              id="prenv-port-min"
              type="number"
              min={1}
              value={form.portRangeMin}
              onChange={(e) => setField('portRangeMin', e.target.value)}
              className={inputClass}
              placeholder="8000"
            />
          </div>
          <div>
            <label className={labelClass} htmlFor="prenv-port-max">
              Port range max
            </label>
            <input
              id="prenv-port-max"
              type="number"
              min={1}
              value={form.portRangeMax}
              onChange={(e) => setField('portRangeMax', e.target.value)}
              className={inputClass}
              placeholder="8999"
            />
          </div>
        </div>

        <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
          <input
            type="checkbox"
            checked={form.certRenewalLive}
            onChange={(e) => setField('certRenewalLive', e.target.checked)}
            className="w-4 h-4"
          />
          Request live certificates (disable for Let's Encrypt staging)
        </label>
      </div>

      {/* ── Tier 2 — GitHub App ───────────────────────────────────────────── */}
      <div className="bg-gray-800 rounded-xl p-4 space-y-4">
        <div className="flex items-center gap-2">
          <Key size={14} className="text-gray-400" />
          <h4 className="text-sm font-medium text-gray-200">GitHub App credentials</h4>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className={labelClass} htmlFor="prenv-gh-app-id">
              App ID
            </label>
            <input
              id="prenv-gh-app-id"
              value={form.githubAppId}
              onChange={(e) => setField('githubAppId', e.target.value)}
              className={inputClass}
              placeholder="123456"
            />
          </div>
          <div>
            <label className={labelClass} htmlFor="prenv-gh-installation-id">
              Installation ID
            </label>
            <input
              id="prenv-gh-installation-id"
              value={form.githubInstallationId}
              onChange={(e) => setField('githubInstallationId', e.target.value)}
              className={inputClass}
              placeholder="7890123"
            />
          </div>
        </div>

        <SecretField
          label="Private key (PEM)"
          id="prenv-gh-private-key"
          field="githubPrivateKey"
          value={form.githubPrivateKey}
          serverValue={server?.githubPrivateKey ?? ''}
          editing={!!editingSecret.githubPrivateKey}
          showPlain={!!showSecret.githubPrivateKey}
          onChange={(v) => setField('githubPrivateKey', v)}
          onStartEdit={() => startEditSecret('githubPrivateKey')}
          onCancelEdit={() => cancelEditSecret('githubPrivateKey')}
          onToggleShow={() =>
            setShowSecret((prev) => ({
              ...prev,
              githubPrivateKey: !prev.githubPrivateKey,
            }))
          }
          multiline
          placeholder={'-----BEGIN RSA PRIVATE KEY-----\n…'}
        />
      </div>

      {/* ── Tier 2 — Route53 ──────────────────────────────────────────────── */}
      <div className="bg-gray-800 rounded-xl p-4 space-y-4">
        <div className="flex items-center gap-2">
          <Cloud size={14} className="text-gray-400" />
          <h4 className="text-sm font-medium text-gray-200">Route53 credentials</h4>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className={labelClass} htmlFor="prenv-r53-access-key">
              Access key ID
            </label>
            <input
              id="prenv-r53-access-key"
              value={form.route53AccessKeyId}
              onChange={(e) => setField('route53AccessKeyId', e.target.value)}
              className={inputClass}
              placeholder="AKIA…"
            />
          </div>
          <div>
            <label className={labelClass} htmlFor="prenv-r53-zone">
              Hosted zone ID
            </label>
            <input
              id="prenv-r53-zone"
              value={form.route53HostedZoneId}
              onChange={(e) => setField('route53HostedZoneId', e.target.value)}
              className={inputClass}
              placeholder="Z0123456789ABCDEFGHIJ"
            />
          </div>
        </div>

        <SecretField
          label="Secret access key"
          id="prenv-r53-secret-access-key"
          field="route53SecretAccessKey"
          value={form.route53SecretAccessKey}
          serverValue={server?.route53SecretAccessKey ?? ''}
          editing={!!editingSecret.route53SecretAccessKey}
          showPlain={!!showSecret.route53SecretAccessKey}
          onChange={(v) => setField('route53SecretAccessKey', v)}
          onStartEdit={() => startEditSecret('route53SecretAccessKey')}
          onCancelEdit={() => cancelEditSecret('route53SecretAccessKey')}
          onToggleShow={() =>
            setShowSecret((prev) => ({
              ...prev,
              route53SecretAccessKey: !prev.route53SecretAccessKey,
            }))
          }
        />
      </div>

      {/* ── Client-side errors ────────────────────────────────────────────── */}
      {clientErrors.length > 0 && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-3 text-xs text-red-300 space-y-1">
          {clientErrors.map((err) => (
            <p key={err} className="flex items-center gap-1.5">
              <AlertTriangle size={12} /> {err}
            </p>
          ))}
        </div>
      )}

      {/* ── Save + Validate actions ───────────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-xs">
          {saveStatus === 'saved' && (
            <span className="text-emerald-400 flex items-center gap-1">
              <CheckCircle2 size={13} /> Saved
            </span>
          )}
          {saveStatus === 'error' && (
            <span className="text-red-400 flex items-center gap-1">
              <XCircle size={13} /> {saveError || 'Save failed'}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleValidate}
            disabled={validating}
            className="flex items-center gap-1.5 bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-white text-sm px-4 py-2 rounded-lg transition-colors"
          >
            {validating ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            Validate
          </button>
          <button
            onClick={handleSave}
            disabled={saving || clientErrors.length > 0}
            className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm px-4 py-2 rounded-lg transition-colors"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>

      {/* ── Validate results panel ────────────────────────────────────────── */}
      {(validateResult || validateError) && (
        <ValidateResults
          result={validateResult}
          error={validateError}
          onDismiss={() => {
            setValidateResult(null);
            setValidateError(null);
          }}
        />
      )}
    </div>
  );
}

/**
 * A text field that respects the mask-preservation convention:
 *   - If `serverValue` is the mask sentinel and the user hasn't clicked Edit,
 *     render a read-only masked value with an "Edit" button.
 *   - Once editing, render a normal input (with show/hide for the plaintext)
 *     and a "Cancel" button that restores the mask.
 * This is the main place the "don't re-send ••••••••" invariant becomes
 * visible in the UI.
 */
function SecretField({
  label,
  id,
  field,
  value,
  serverValue,
  editing,
  showPlain,
  onChange,
  onStartEdit,
  onCancelEdit,
  onToggleShow,
  multiline = false,
  placeholder = '',
}) {
  const isMasked = isMaskValue(serverValue) && !editing;
  const hasStoredValue = serverValue && serverValue.length > 0;

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <label className="block text-xs text-gray-400" htmlFor={id}>
          {label}
        </label>
        <div className="flex items-center gap-2 text-[11px]">
          {!isMasked && hasStoredValue && editing && (
            <button
              type="button"
              onClick={onCancelEdit}
              className="text-gray-400 hover:text-gray-200"
            >
              Cancel
            </button>
          )}
          {isMasked && (
            <button
              type="button"
              onClick={onStartEdit}
              className="text-blue-400 hover:text-blue-300"
              aria-label={`Edit ${label}`}
            >
              Edit
            </button>
          )}
          {!isMasked && !multiline && value && (
            <button
              type="button"
              onClick={onToggleShow}
              className="text-gray-500 hover:text-gray-300 flex items-center gap-1"
              aria-label={showPlain ? 'Hide secret' : 'Show secret'}
            >
              {showPlain ? <EyeOff size={11} /> : <Eye size={11} />}
              {showPlain ? 'Hide' : 'Show'}
            </button>
          )}
        </div>
      </div>

      {isMasked ? (
        <input
          id={id}
          value={MASK}
          readOnly
          disabled
          className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-400 font-mono opacity-70 cursor-not-allowed"
          aria-readonly="true"
          data-testid={`prenv-secret-masked-${field}`}
        />
      ) : multiline ? (
        <textarea
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={6}
          placeholder={placeholder}
          className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-gray-600 font-mono"
          data-testid={`prenv-secret-input-${field}`}
        />
      ) : (
        <input
          id={id}
          type={showPlain ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-gray-600 font-mono"
          data-testid={`prenv-secret-input-${field}`}
        />
      )}

      {!isMasked && !hasStoredValue && (
        <p className="text-[11px] text-gray-600 mt-1">Not configured.</p>
      )}
    </div>
  );
}

/**
 * Per-check pass/fail panel, driven by the POST /validate response shape:
 *   { ok: boolean, checks: Array<{ name, pass, message }> }
 */
export function ValidateResults({ result, error, onDismiss }) {
  return (
    <div className="bg-gray-800 rounded-xl p-4 space-y-3" data-testid="prenv-validate-results">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-medium text-gray-200">Validation results</h4>
        {onDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            className="text-[11px] text-gray-500 hover:text-gray-300"
          >
            Dismiss
          </button>
        )}
      </div>

      {error && (
        <div className="text-xs text-red-300 flex items-center gap-1.5">
          <XCircle size={13} /> {error}
        </div>
      )}

      {result && (
        <>
          <div
            className={`text-xs flex items-center gap-1.5 ${
              result.ok ? 'text-emerald-400' : 'text-amber-400'
            }`}
          >
            {result.ok ? <CheckCircle2 size={13} /> : <AlertTriangle size={13} />}
            {result.ok ? 'All checks passed.' : 'One or more checks failed.'}
          </div>
          <ul className="space-y-1.5">
            {(result.checks || []).map((check) => (
              <li
                key={check.name}
                data-testid={`prenv-check-${check.name}`}
                className={`flex items-start gap-2 text-xs rounded-lg px-3 py-2 border ${
                  check.pass
                    ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-200'
                    : 'bg-red-500/10 border-red-500/20 text-red-200'
                }`}
              >
                {check.pass ? (
                  <CheckCircle2 size={13} className="shrink-0 mt-0.5" />
                ) : (
                  <XCircle size={13} className="shrink-0 mt-0.5" />
                )}
                <div className="min-w-0">
                  <p className="font-medium">{CHECK_LABELS[check.name] || check.name}</p>
                  <p className="text-[11px] opacity-80 break-words">{check.message}</p>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

// Re-export secret constants for tests that don't want to reach into utils.
export { SECRET_FIELDS, MASK };
