import { useEffect, useState, useCallback } from 'react';
import { Loader2, ShieldCheck, ExternalLink, CheckCircle2, Plus, X } from 'lucide-react';
import { getAuthHeaders, getApiBase } from '../utils/connection';

/**
 * GithubAppConfigSection — server-global GitHub *App* credentials.
 *
 * Admin/Owner-only. This is the GitHub App whose installation token the
 * Hub → GitHub mirror push uses as the branch-protection / ruleset **bypass
 * identity** (an operator adds this App to the repo ruleset's bypass list so
 * the mirror can push a protected default branch). Server-global, distinct
 * from the personal GitHub connection and the "Sign in with GitHub" OAuth App.
 *
 * The PEM private key is write-only: it is sent on save but never returned by
 * the server (GET reports `hasPrivateKey` only). Editing the App id or
 * installations without re-pasting the key is supported — leave the key blank.
 *
 * Calls:
 *   GET    /api/config/github-app  — { configured, appId, installationId, installations, hasPrivateKey }
 *   PUT    /api/config/github-app  — { appId, privateKey?, installationId?, installations? }
 *   DELETE /api/config/github-app  — clear
 */
type InstallationRow = { account: string; id: string };

// A GitHub numeric id (App id / installation id) is a positive integer; the
// negative lookahead rejects "0"/"00" too. Mirrors the server's validation.
const POSITIVE_INT_ID = /^(?!0+$)\d+$/;

export default function GithubAppConfigSection() {
  const [status, setStatus] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<any>(null);
  const [showForm, setShowForm] = useState(false);
  const [appId, setAppId] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [installationId, setInstallationId] = useState('');
  const [installations, setInstallations] = useState<InstallationRow[]>([]);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${getApiBase()}/config/github-app`, {
        headers: getAuthHeaders(),
      });
      if (!res.ok) throw new Error(`GET /config/github-app → ${res.status}`);
      setStatus(await res.json());
    } catch (err: any) {
      setError(err.message || String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Seed the edit form from the current status (the private key can never be
  // read back, so its field always starts blank).
  const openForm = () => {
    setAppId(status?.appId != null ? String(status.appId) : '');
    setInstallationId(status?.installationId != null ? String(status.installationId) : '');
    setInstallations(
      Array.isArray(status?.installations)
        ? status.installations.map((i: any) => ({
            account: i?.account ? String(i.account) : '',
            id: i?.id != null ? String(i.id) : '',
          }))
        : [],
    );
    setPrivateKey('');
    setShowForm(true);
    setError(null);
  };

  const handleSave = async () => {
    const trimmedAppId = appId.trim();
    if (!trimmedAppId) return;
    // A GitHub App id is a positive integer (the JWT `iss`); catch a typo or a
    // zero value before the PUT. The lookahead rejects "0"/"00" too.
    if (!POSITIVE_INT_ID.test(trimmedAppId)) {
      setError('App ID must be a positive number.');
      return;
    }
    // Installation ids (default + per-owner) are positive integers too.
    if (installationId.trim() && !POSITIVE_INT_ID.test(installationId.trim())) {
      setError('Installation ID must be a positive number.');
      return;
    }
    if (installations.some((i) => i.id.trim() && !POSITIVE_INT_ID.test(i.id.trim()))) {
      setError('Each installation ID must be a positive number.');
      return;
    }
    // First-time config must include the key; edits may omit it to keep the stored one.
    if (!status?.hasPrivateKey && !privateKey.trim()) {
      setError('A private key is required the first time you configure the App.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const payload: Record<string, unknown> = { appId: trimmedAppId };
      if (privateKey.trim()) payload.privateKey = privateKey;
      if (installationId.trim()) payload.installationId = installationId.trim();
      const cleanedInstalls = installations
        .filter((i) => i.id.trim())
        .map((i) =>
          i.account.trim() ? { account: i.account.trim(), id: i.id.trim() } : { id: i.id.trim() },
        );
      payload.installations = cleanedInstalls;

      const res = await fetch(`${getApiBase()}/config/github-app`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `PUT /config/github-app → ${res.status}`);
      }
      setPrivateKey('');
      setShowForm(false);
      await load();
    } catch (err: any) {
      setError(err.message || String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleClear = async () => {
    if (
      !window.confirm(
        'Remove the GitHub App credentials? Hub → GitHub mirror pushes will fall back to the per-user token and can no longer bypass branch protection.',
      )
    )
      return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`${getApiBase()}/config/github-app`, {
        method: 'DELETE',
        headers: getAuthHeaders(),
      });
      if (!res.ok) throw new Error(`DELETE /config/github-app → ${res.status}`);
      await load();
    } catch (err: any) {
      setError(err.message || String(err));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="bg-gray-800 rounded-xl p-4">
        <div className="flex items-center gap-2 text-sm text-gray-400">
          <Loader2 size={14} className="animate-spin" />
          Loading GitHub App status…
        </div>
      </div>
    );
  }

  const configured = !!status?.configured;

  return (
    <div className="bg-gray-800 rounded-xl p-4 space-y-4">
      <div>
        <h4 className="text-sm font-medium text-gray-300 flex items-center gap-2">
          <ShieldCheck size={14} /> GitHub App (mirror-push bypass)
        </h4>
        <p className="text-xs text-gray-500 mt-1 leading-relaxed">
          Server-wide GitHub App whose <strong>installation token</strong> the Hub &rarr; GitHub
          mirror push uses as the branch-protection <strong>bypass identity</strong>. Add this App
          to the target repo&rsquo;s ruleset bypass list so the mirror can push a protected default
          branch. Register one at{' '}
          <a
            href="https://github.com/settings/apps"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-gray-300"
          >
            github.com/settings/apps
          </a>
          . When unset, the mirror falls back to the per-user token (no bypass).
        </p>
      </div>

      {configured && !showForm ? (
        <div className="flex items-center gap-2 flex-wrap">
          <CheckCircle2 size={14} className="text-emerald-400" />
          <span className="text-sm text-emerald-400">
            Configured — App ID{' '}
            <code className="bg-gray-900/50 px-1 rounded font-mono text-[11px]">
              {String(status.appId)}
            </code>
          </span>
          <div className="flex items-center gap-3 ml-auto">
            <button
              onClick={openForm}
              disabled={saving}
              className="text-xs text-blue-400 hover:text-blue-300 disabled:opacity-50"
            >
              Edit
            </button>
            <button
              onClick={handleClear}
              disabled={saving}
              className="text-xs text-red-400 hover:text-red-300 disabled:opacity-50"
            >
              Remove
            </button>
          </div>
        </div>
      ) : showForm ? (
        <div className="bg-gray-900/50 rounded-lg p-3 space-y-3">
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1">App ID</label>
            <input
              value={appId}
              onChange={(e: any) => setAppId(e.target.value)}
              placeholder="123456"
              inputMode="numeric"
              autoComplete="off"
              data-testid="github-app-app-id"
              className="w-full bg-gray-900 border border-gray-600 rounded-lg px-3 py-2 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-emerald-500 font-mono"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1">
              Private key (PEM){' '}
              {status?.hasPrivateKey && (
                <span className="text-gray-500 font-normal">— stored; leave blank to keep it</span>
              )}
            </label>
            <textarea
              value={privateKey}
              onChange={(e: any) => setPrivateKey(e.target.value)}
              placeholder={
                status?.hasPrivateKey
                  ? '•••••••••• (unchanged)'
                  : '-----BEGIN RSA PRIVATE KEY-----\n…\n-----END RSA PRIVATE KEY-----'
              }
              rows={4}
              autoComplete="off"
              data-1p-ignore
              data-lpignore="true"
              data-testid="github-app-private-key"
              className="w-full bg-gray-900 border border-gray-600 rounded-lg px-3 py-2 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-emerald-500 font-mono resize-y"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1">
              Default installation ID <span className="text-gray-500 font-normal">— optional</span>
            </label>
            <input
              value={installationId}
              onChange={(e: any) => setInstallationId(e.target.value)}
              placeholder="87654321"
              autoComplete="off"
              data-testid="github-app-installation-id"
              className="w-full bg-gray-900 border border-gray-600 rounded-lg px-3 py-2 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-emerald-500 font-mono"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1">
              Per-owner installations{' '}
              <span className="text-gray-500 font-normal">
                — optional; one App serving several orgs
              </span>
            </label>
            <div className="space-y-2">
              {installations.map((row, idx) => (
                <div key={idx} className="flex gap-2 items-center">
                  <input
                    value={row.account}
                    onChange={(e: any) =>
                      setInstallations((rows) =>
                        rows.map((r, i) => (i === idx ? { ...r, account: e.target.value } : r)),
                      )
                    }
                    placeholder="org-login"
                    autoComplete="off"
                    data-testid={`github-app-install-account-${idx}`}
                    className="flex-1 bg-gray-900 border border-gray-600 rounded-lg px-3 py-1.5 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-emerald-500 font-mono"
                  />
                  <input
                    value={row.id}
                    onChange={(e: any) =>
                      setInstallations((rows) =>
                        rows.map((r, i) => (i === idx ? { ...r, id: e.target.value } : r)),
                      )
                    }
                    placeholder="installation id"
                    autoComplete="off"
                    data-testid={`github-app-install-id-${idx}`}
                    className="flex-1 bg-gray-900 border border-gray-600 rounded-lg px-3 py-1.5 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-emerald-500 font-mono"
                  />
                  <button
                    type="button"
                    onClick={() => setInstallations((rows) => rows.filter((_, i) => i !== idx))}
                    className="text-gray-500 hover:text-red-400 p-1"
                    aria-label="Remove installation"
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={() => setInstallations((rows) => [...rows, { account: '', id: '' }])}
                className="flex items-center gap-1 text-[11px] text-gray-400 hover:text-gray-200"
              >
                <Plus size={12} /> Add installation
              </button>
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleSave}
              disabled={!appId.trim() || saving}
              className="flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-xs px-3 py-1.5 rounded-lg transition-colors"
            >
              {saving && <Loader2 size={12} className="animate-spin" />}
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button
              onClick={() => {
                setShowForm(false);
                setPrivateKey('');
                setError(null);
              }}
              disabled={saving}
              className="text-xs bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-gray-200 px-3 py-1.5 rounded-lg transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={openForm}
          className="flex items-center gap-2 text-sm bg-blue-600 hover:bg-blue-500 text-white px-3 py-1.5 rounded-lg transition-colors"
        >
          <ExternalLink size={14} />
          Configure GitHub App
        </button>
      )}

      {error && (
        <div className="text-xs text-red-300 bg-red-500/10 border border-red-500/30 rounded p-2">
          {error}
        </div>
      )}
    </div>
  );
}
