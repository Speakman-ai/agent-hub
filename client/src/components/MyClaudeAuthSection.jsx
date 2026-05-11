import { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Eye,
  EyeOff,
  Key,
  Loader2,
  RefreshCw,
  Terminal,
  UserCircle2,
} from 'lucide-react';
import { api } from '../utils/api.js';

/**
 * Per-user Claude credentials panel — surfaces `GET/PUT /api/auth/me/claude-auth`
 * so each Hub user can attach their own `ANTHROPIC_API_KEY` and/or
 * `CLAUDE_CODE_OAUTH_TOKEN`. When set, the session-owner override wins over
 * the host-wide config — see `server/config.ts::buildSpawnEnv`.
 *
 * The host-wide `ClaudeAuthSection` (one per server, Admin/Owner) and this
 * component (one per user, anyone authenticated) are intentionally separate:
 *   - host = `~/.agent-hub/data/config.json` → `/api/config/claude-auth`
 *   - user = `users` table row → `/api/auth/me/claude-auth`
 *
 * Rendered inside `AccountSection.jsx` so the per-user view lives next to
 * the rest of the Account tab (API Keys, Log out, role).
 */
export default function MyClaudeAuthSection() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [unauthenticated, setUnauthenticated] = useState(false);

  const [apiKeyInput, setApiKeyInput] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [apiKeySaving, setApiKeySaving] = useState(false);
  const [apiKeyStatus, setApiKeyStatus] = useState(null);

  const [oauthInput, setOauthInput] = useState('');
  const [showOauth, setShowOauth] = useState(false);
  const [oauthSaving, setOauthSaving] = useState(false);
  const [oauthStatus, setOauthStatus] = useState(null);

  const inputClass =
    'w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-gray-600 font-mono';

  const load = useCallback(async () => {
    setError(null);
    try {
      const body = await api.getMyClaudeAuth();
      setData(body);
      setUnauthenticated(false);
    } catch (err) {
      // Legacy global-apiKey installs don't have a per-user identity,
      // so the GET returns 401. Surface a friendly hint instead of an
      // angry error panel — the rest of the Account tab still works.
      const msg = err?.message || String(err);
      if (/^401[:\s]/.test(msg) || /authentication required/i.test(msg)) {
        setUnauthenticated(true);
        setData(null);
      } else {
        setError(msg);
        setData(null);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleSaveApiKey = async () => {
    setApiKeySaving(true);
    setApiKeyStatus(null);
    try {
      const body = await api.putMyClaudeAuth({ anthropicApiKey: apiKeyInput.trim() });
      setData(body);
      setApiKeyStatus({
        type: 'success',
        msg: body.anthropicApiKey ? 'Saved' : 'Cleared',
      });
      setApiKeyInput('');
    } catch (err) {
      setApiKeyStatus({ type: 'error', msg: err.message || String(err) });
    } finally {
      setApiKeySaving(false);
    }
  };

  const handleClearApiKey = async () => {
    setApiKeySaving(true);
    setApiKeyStatus(null);
    try {
      const body = await api.putMyClaudeAuth({ anthropicApiKey: '' });
      setData(body);
      setApiKeyStatus({ type: 'success', msg: 'Cleared' });
      setApiKeyInput('');
    } catch (err) {
      setApiKeyStatus({ type: 'error', msg: err.message || String(err) });
    } finally {
      setApiKeySaving(false);
    }
  };

  const handleSaveOauth = async () => {
    // Terminal-wrapped `claude setup-token` output may contain newlines
    // inside the token. Collapse whitespace before sending so the user
    // can paste straight from the terminal.
    const collapsed = oauthInput.replace(/\s+/g, '');
    setOauthSaving(true);
    setOauthStatus(null);
    try {
      const body = await api.putMyClaudeAuth({ claudeCodeOAuthToken: collapsed });
      setData(body);
      setOauthStatus({
        type: 'success',
        msg: body.claudeCodeOAuthToken ? 'Saved' : 'Cleared',
      });
      setOauthInput('');
    } catch (err) {
      setOauthStatus({ type: 'error', msg: err.message || String(err) });
    } finally {
      setOauthSaving(false);
    }
  };

  const handleClearOauth = async () => {
    setOauthSaving(true);
    setOauthStatus(null);
    try {
      // Clear both the token and the expiry so a stale expiresAt doesn't
      // linger after the user revokes their credential.
      const body = await api.putMyClaudeAuth({
        claudeCodeOAuthToken: '',
        claudeCodeOAuthExpiresAt: '',
      });
      setData(body);
      setOauthStatus({ type: 'success', msg: 'Cleared' });
      setOauthInput('');
    } catch (err) {
      setOauthStatus({ type: 'error', msg: err.message || String(err) });
    } finally {
      setOauthSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="bg-gray-800 rounded-xl p-4">
        <div className="flex items-center gap-2 text-sm text-gray-400">
          <Loader2 size={14} className="animate-spin" />
          Loading your Claude credentials…
        </div>
      </div>
    );
  }

  if (unauthenticated) {
    // Legacy global apiKey auth has no per-user identity — there's nothing
    // useful to render. The host-wide ClaudeAuthSection (Settings → Claude
    // Auth) still applies.
    return (
      <div className="bg-gray-800 rounded-xl p-4">
        <h4 className="text-sm font-medium text-gray-300 flex items-center gap-2 mb-2">
          <UserCircle2 size={14} /> Personal Claude credentials
        </h4>
        <p className="text-xs text-gray-500">
          Sign in as a user (instead of the legacy global API key) to attach your own Anthropic API
          key or Claude Code OAuth token. Spawned sessions you own will use those instead of the
          host-wide credential.
        </p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4">
        <div className="flex items-center gap-2 text-red-400 text-sm mb-2">
          <AlertCircle size={14} />
          <span className="font-medium">Failed to load your Claude credentials</span>
        </div>
        <p className="text-xs text-gray-400 mb-3">{error}</p>
        <button
          type="button"
          onClick={() => {
            setLoading(true);
            load();
          }}
          className="inline-flex items-center gap-1.5 bg-gray-700 hover:bg-gray-600 text-white text-xs px-3 py-1.5 rounded-lg"
        >
          <RefreshCw size={12} /> Retry
        </button>
      </div>
    );
  }

  const apiKeyMasked = data?.anthropicApiKey || null;
  const apiKeyHostFallback = !!data?.hostConfigFallback?.anthropicApiKey;
  const oauthMasked = data?.claudeCodeOAuthToken || null;
  const oauthHostFallback = !!data?.hostConfigFallback?.claudeCodeOAuthToken;
  const oauthExpiresAt = data?.claudeCodeOAuthExpiresAt || null;
  const oauthExpired = !!data?.claudeCodeOAuthExpired;

  return (
    <div className="bg-gray-800 rounded-xl p-4 space-y-6">
      <div>
        <h4 className="text-sm font-medium text-gray-300 flex items-center gap-2">
          <UserCircle2 size={14} /> Personal Claude credentials
        </h4>
        <p className="text-[11px] text-gray-500 mt-1 leading-relaxed">
          When set, sessions you own spawn with your credentials instead of the host-wide
          configuration. Leave empty to fall back to the host (managed in{' '}
          <span className="text-gray-400">Settings → Claude Auth</span>).
        </p>
      </div>

      {/* ── Anthropic API key ───────────────────────────── */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h5 className="text-xs font-medium text-gray-300 flex items-center gap-2">
            <Key size={12} /> Anthropic API key
          </h5>
          <StatusChip kind="api" mine={apiKeyMasked} hostFallback={apiKeyHostFallback} />
        </div>
        {apiKeyMasked && (
          <div className="flex items-center justify-between bg-gray-900 rounded-lg p-3">
            <div className="flex items-center gap-2 text-sm">
              <CheckCircle2 size={14} className="text-emerald-400" />
              <span className="text-gray-300 font-mono">{apiKeyMasked}</span>
            </div>
            <button
              type="button"
              onClick={handleClearApiKey}
              disabled={apiKeySaving}
              className="text-xs text-red-400 hover:text-red-300 disabled:opacity-50"
              aria-label="Clear my API key"
            >
              {apiKeySaving ? '…' : 'Clear my API key'}
            </button>
          </div>
        )}
        <div className="relative">
          <input
            type={showApiKey ? 'text' : 'password'}
            value={apiKeyInput}
            onChange={(e) => {
              setApiKeyInput(e.target.value);
              setApiKeyStatus(null);
            }}
            className={`${inputClass} pr-10 text-xs`}
            placeholder="sk-ant-api03-..."
            autoComplete="off"
            data-1p-ignore
            data-lpignore="true"
            aria-label="Anthropic API key"
          />
          <button
            type="button"
            onClick={() => setShowApiKey(!showApiKey)}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 p-1"
            aria-label={showApiKey ? 'Hide API key' : 'Show API key'}
          >
            {showApiKey ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={handleSaveApiKey}
            disabled={!apiKeyInput.trim() || apiKeySaving}
            className="inline-flex items-center gap-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-xs px-3 py-1.5 rounded-lg"
          >
            {apiKeySaving ? <Loader2 size={12} className="animate-spin" /> : null}
            {apiKeySaving ? 'Saving…' : 'Save API key'}
          </button>
        </div>
        {apiKeyStatus && (
          <div
            role={apiKeyStatus.type === 'success' ? 'status' : 'alert'}
            className={`flex items-center gap-2 text-xs ${
              apiKeyStatus.type === 'success' ? 'text-emerald-400' : 'text-red-400'
            }`}
          >
            {apiKeyStatus.type === 'success' ? (
              <CheckCircle2 size={12} />
            ) : (
              <AlertCircle size={12} />
            )}
            <span>{apiKeyStatus.msg}</span>
          </div>
        )}
      </div>

      <div className="h-px bg-gray-700/50" />

      {/* ── Claude Code OAuth token ─────────────────────── */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h5 className="text-xs font-medium text-gray-300 flex items-center gap-2">
            <Terminal size={12} /> Claude Code OAuth token
          </h5>
          <StatusChip
            kind="oauth"
            mine={oauthMasked}
            hostFallback={oauthHostFallback}
            expired={oauthExpired}
          />
        </div>
        <p className="text-[11px] text-gray-500 leading-relaxed">
          Run <code className="text-gray-400">claude setup-token</code> in your terminal, then paste
          the token here. Multi-line terminal output is joined automatically.
        </p>
        {oauthMasked && (
          <div className="flex items-center justify-between bg-gray-900 rounded-lg p-3">
            <div className="flex items-center gap-2 text-sm">
              <CheckCircle2
                size={14}
                className={oauthExpired ? 'text-red-400' : 'text-emerald-400'}
              />
              <span className="text-gray-300 font-mono">{oauthMasked}</span>
              {oauthExpiresAt && (
                <span
                  className={`text-[11px] font-mono ${
                    oauthExpired ? 'text-red-400' : 'text-gray-500'
                  }`}
                >
                  {oauthExpired ? 'expired' : `expires ${oauthExpiresAt}`}
                </span>
              )}
            </div>
            <button
              type="button"
              onClick={handleClearOauth}
              disabled={oauthSaving}
              className="text-xs text-red-400 hover:text-red-300 disabled:opacity-50"
              aria-label="Clear my OAuth token"
            >
              {oauthSaving ? '…' : 'Clear my OAuth token'}
            </button>
          </div>
        )}
        <div className="relative">
          <input
            type={showOauth ? 'text' : 'password'}
            value={oauthInput}
            onChange={(e) => {
              setOauthInput(e.target.value);
              setOauthStatus(null);
            }}
            className={`${inputClass} pr-10 text-xs`}
            placeholder="sk-ant-oat01-..."
            autoComplete="off"
            data-1p-ignore
            data-lpignore="true"
            aria-label="Claude Code OAuth token"
          />
          <button
            type="button"
            onClick={() => setShowOauth(!showOauth)}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 p-1"
            aria-label={showOauth ? 'Hide OAuth token' : 'Show OAuth token'}
          >
            {showOauth ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={handleSaveOauth}
            disabled={!oauthInput.replace(/\s+/g, '') || oauthSaving}
            className="inline-flex items-center gap-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-xs px-3 py-1.5 rounded-lg"
          >
            {oauthSaving ? <Loader2 size={12} className="animate-spin" /> : null}
            {oauthSaving ? 'Saving…' : 'Save OAuth token'}
          </button>
        </div>
        {oauthStatus && (
          <div
            role={oauthStatus.type === 'success' ? 'status' : 'alert'}
            className={`flex items-center gap-2 text-xs ${
              oauthStatus.type === 'success' ? 'text-emerald-400' : 'text-red-400'
            }`}
          >
            {oauthStatus.type === 'success' ? (
              <CheckCircle2 size={12} />
            ) : (
              <AlertCircle size={12} />
            )}
            <span>{oauthStatus.msg}</span>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Three-state chip indicating which credential will be used on spawn for
 * this user. Exported so AccountSection / tests can re-use the same
 * derivation rules.
 *
 * - "Using yours" (emerald) — the user has set their own credential
 * - "Host fallback" (amber) — empty user field but host has one configured
 * - "Not configured" (red) — neither user nor host has a value
 * - "Yours (expired)" (red) — OAuth-only branch when expiresAt is past
 */
export function StatusChip({ kind, mine, hostFallback, expired }) {
  if (mine && kind === 'oauth' && expired) {
    return (
      <span className="text-[11px] px-2 py-0.5 rounded-full font-medium bg-red-500/15 text-red-400">
        Yours (expired)
      </span>
    );
  }
  if (mine) {
    return (
      <span className="text-[11px] px-2 py-0.5 rounded-full font-medium bg-emerald-500/15 text-emerald-400">
        Using yours
      </span>
    );
  }
  if (hostFallback) {
    return (
      <span className="text-[11px] px-2 py-0.5 rounded-full font-medium bg-amber-500/15 text-amber-400">
        Host fallback
      </span>
    );
  }
  return (
    <span className="text-[11px] px-2 py-0.5 rounded-full font-medium bg-red-500/15 text-red-400">
      Not configured
    </span>
  );
}
