import { useState, useEffect, useCallback, useRef } from 'react';
import {
  GitBranch,
  Globe,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Loader2,
  RefreshCw,
  Info,
  KeyRound,
} from 'lucide-react';
import { api } from '../utils/api.js';
import { buildPrEnvSavePayload, validatePrEnvForm } from '../utils/prEnvPayload.js';

const EMPTY_FORM = {
  enabled: false,
  repoFullName: '',
  previewHost: '',
  previewBaseUrl: '',
  certRenewalLive: false,
  portRangeMin: '',
  portRangeMax: '',
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
  };
}

const CHECK_LABELS = {
  docker: 'Docker daemon',
  nginx: 'Nginx running + base vhost',
  cert: 'Wildcard TLS certificate',
  'github-app': 'Reviewer GitHub App',
  route53: 'Route 53 IAM',
  webhook: 'Webhook installed on a repo',
};

/**
 * Default required-check set the UI gates Save against. The server is
 * the source of truth — when the validate response includes a `required`
 * array, we use that; this constant is the fallback for older servers
 * (and for tests that stub the API).
 */
const DEFAULT_REQUIRED_CHECKS = ['cert', 'nginx', 'github-app', 'route53', 'webhook'];

/** Per-check remediation hint shown next to a failing row. */
const CHECK_REMEDIATION = {
  cert: 'Run `certbot certonly --dns-route53 -d "*.<previewHost>"` (or rerun the TF cert workflow), then re-validate.',
  nginx:
    'Ensure nginx is running (`systemctl start nginx`) and that the base vhost file exists at the configured path.',
  'github-app': 'Click "Register Reviewer App" below to walk the GitHub App manifest flow.',
  route53:
    'Attach the `route53:ListHostedZones`/`GetHostedZone` policy to the EC2 instance role, or set explicit AWS keys.',
  webhook:
    'Open a project, then Settings → GitHub Webhook → Install. PR-env dispatch fires off webhook deliveries.',
  docker:
    'Start the Docker daemon (`systemctl start docker`) — required for PR-env container builds.',
};

/**
 * PR environments settings UI.
 *
 * Covers Tier 1 (general) settings only. GitHub App credentials are
 * inherited from the registered Reviewer App (`config.githubApp`); Route 53
 * credentials come from the AWS SDK default credential chain (IAM Role via
 * IMDSv2 on EC2). Both are infrastructure-managed (Terraform), so neither
 * is editable here — see `ops/terraform/locals-agent-hub.tf` for the
 * Tier-3 `prEnv` block written into `<dataDir>/config.json` at first
 * boot, and `ops/terraform/ssm-iam.tf` for the Route 53 IAM policy
 * attached to the EC2 instance role.
 *
 * Tier 3 (host paths — nginx dirs, prodDbPath, hostedZoneId) likewise
 * stays in `<dataDir>/config.json` by design.
 *
 * Behaviors:
 * - Validate hits `/api/settings/pr-env/validate` and renders the 4
 *   per-check results (docker / nginx / github-app / route53). The
 *   github-app + route53 checks use the inherited credentials when the
 *   PR-env-specific fields are blank.
 * - Enable toggle is gated: disabled until either (a) a prior save succeeded
 *   AND validation passes, or (b) the user explicitly overrides via the
 *   "Enable without validation" checkbox (rare — surfaces a warning).
 */
export default function PrEnvironmentsSection() {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [, setServer] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState(null); // 'saved' | 'error' | null
  const [saveError, setSaveError] = useState(null);
  const [validating, setValidating] = useState(false);
  const [validateResult, setValidateResult] = useState(null); // { ok, checks: [...] } | null
  const [validateError, setValidateError] = useState(null);
  const [overrideGate, setOverrideGate] = useState(false);
  // Tracks the previous `enabled` value so we can fire validation only on
  // the off→on transition (not on the initial render).
  const prevEnabledRef = useRef(false);

  const load = useCallback(async () => {
    try {
      setLoadError(null);
      const data = await api.getPrEnvSettings();
      setServer(data);
      setForm(hydrateForm(data));
      prevEnabledRef.current = !!data?.enabled;
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

  // Required-check set: prefer the server-provided list (forwards-compatible
  // when we add new prereqs server-side) and fall back to the constant.
  const requiredChecks =
    Array.isArray(validateResult?.required) && validateResult.required.length > 0
      ? validateResult.required
      : DEFAULT_REQUIRED_CHECKS;
  const failingRequired = (validateResult?.checks || []).filter(
    (c) => requiredChecks.includes(c.name) && !c.pass,
  );
  const githubAppFailing = (validateResult?.checks || []).some(
    (c) => c.name === 'github-app' && !c.pass,
  );

  const setField = (k, v) => setForm((prev) => ({ ...prev, [k]: v }));

  const handleSave = async () => {
    if (clientErrors.length > 0) return;
    setSaving(true);
    setSaveError(null);
    try {
      const payload = buildPrEnvSavePayload(form);
      const updated = await api.updatePrEnvSettings(payload);
      setServer(updated);
      setForm(hydrateForm(updated));
      setSaveStatus('saved');
      // Any save invalidates the last validation result — settings may have changed.
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

  const handleValidate = useCallback(async () => {
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
  }, [form]);

  // Auto-validate when the operator flips Enabled on. Only fires on the
  // off→on transition so we don't spam the endpoint on every render.
  useEffect(() => {
    if (loading) return;
    const prev = prevEnabledRef.current;
    prevEnabledRef.current = form.enabled;
    if (form.enabled && !prev) {
      handleValidate();
    }
  }, [form.enabled, loading, handleValidate]);

  // Handle return from the GitHub App manifest flow. The callback redirects to
  // `/#/settings?githubApp=ready` (hash routing); refresh the panel + run
  // validation, then strip the param so a hard-refresh doesn't re-trigger.
  useEffect(() => {
    if (loading) return;
    if (typeof window === 'undefined') return;
    const hash = window.location.hash;
    const match = hash.match(/[?&]githubApp=(ready|created)/);
    if (!match) return;
    handleValidate();
    const cleanHash = hash.replace(/[?&]githubApp=[^&]*(&message=[^&]*)?/, '').replace(/\?$/, '');
    window.history.replaceState({}, '', window.location.pathname + cleanHash);
    // Intentionally only depend on `loading` — running once after first load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  const handleRegisterReviewerApp = () => {
    // The /register route returns an auto-submitting HTML form that POSTs the
    // manifest to GitHub; navigating there handles the whole manifest flow.
    window.location.href = '/api/github-app/register';
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

      {/* Inherited-credentials notice. PR Envs reuses infrastructure-managed
          credentials — nothing to enter here. */}
      <div
        className="bg-blue-500/10 border border-blue-500/20 rounded-xl p-4"
        data-testid="prenv-inherited-creds-notice"
      >
        <div className="flex items-start gap-3">
          <Info size={18} className="text-blue-400 shrink-0 mt-0.5" />
          <div className="text-xs text-blue-100/90 space-y-1.5">
            <p className="font-medium text-blue-300">Credentials come from infrastructure</p>
            <p>
              GitHub App credentials are inherited from the registered Reviewer App, and Route 53
              access is provided by the EC2 instance role (IMDSv2). Both are managed by Terraform —
              see <code className="text-blue-200">ops/terraform/locals-agent-hub.tf</code> and{' '}
              <code className="text-blue-200">ops/terraform/ssm-iam.tf</code>. Neither needs to be
              entered here.
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

      {/* ── Register Reviewer App CTA ────────────────────────────────────── */}
      {githubAppFailing && (
        <div
          className="bg-blue-600/10 border border-blue-500/30 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3"
          data-testid="prenv-register-app-cta"
        >
          <div className="min-w-0">
            <h4 className="text-sm font-medium text-blue-200 flex items-center gap-2">
              <KeyRound size={14} /> Reviewer GitHub App not registered
            </h4>
            <p className="text-xs text-blue-100/80 mt-1 max-w-xl">
              Register the App so PR webhooks can authenticate as the bot identity. You'll be
              redirected to GitHub to confirm the manifest, then sent back here automatically.
            </p>
          </div>
          <button
            type="button"
            onClick={handleRegisterReviewerApp}
            data-testid="prenv-register-app-button"
            className="bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors flex items-center gap-1.5"
          >
            <KeyRound size={14} /> Register Reviewer App
          </button>
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
          {failingRequired.length > 0 && (
            <button
              type="button"
              onClick={() => {
                const first = failingRequired[0];
                if (!first) return;
                const el = document.querySelector(`[data-testid="prenv-check-${first.name}"]`);
                if (el && typeof el.scrollIntoView === 'function') {
                  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
              }}
              data-testid="prenv-failing-required-link"
              className="text-amber-400 hover:text-amber-300 underline-offset-2 hover:underline"
            >
              Fix: {CHECK_LABELS[failingRequired[0].name] || failingRequired[0].name}
            </button>
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
            disabled={
              saving ||
              clientErrors.length > 0 ||
              validateResult === null ||
              failingRequired.length > 0
            }
            data-testid="prenv-save-button"
            title={
              failingRequired.length > 0
                ? `Fix failing prerequisites first: ${failingRequired
                    .map((c) => CHECK_LABELS[c.name] || c.name)
                    .join(', ')}`
                : ''
            }
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
                  {!check.pass && CHECK_REMEDIATION[check.name] && (
                    <p
                      className="text-[11px] opacity-70 mt-1 italic"
                      data-testid={`prenv-check-${check.name}-remediation`}
                    >
                      → {CHECK_REMEDIATION[check.name]}
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
