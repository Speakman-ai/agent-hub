import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, Eye, EyeOff, Key, Loader2, RefreshCw } from 'lucide-react';
import { StatusChip } from './MyClaudeAuthSection.jsx';

/**
 * Per-user single-key credentials panel — generic version of
 * `MyClaudeAuthSection` for engines that only carry one API key
 * (Cursor, Gemini, Codex).
 *
 * Surfaces `GET/PUT /api/auth/me/<engine>-auth` so each Hub user can
 * attach their own engine API key. When set, the session-owner override
 * wins over the host-wide config — see `server/config.ts::buildSpawnEnv`.
 *
 * Engine descriptors are passed in via props so the component can be
 * instantiated once per engine in `AccountSection.jsx`.
 */
export default function MySingleKeyAuthSection({
  engineLabel,
  description,
  placeholder,
  Icon,
  getter,
  setter,
  hostSettingHint,
}) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [unauthenticated, setUnauthenticated] = useState(false);

  const [apiKeyInput, setApiKeyInput] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [apiKeySaving, setApiKeySaving] = useState(false);
  const [apiKeyStatus, setApiKeyStatus] = useState(null);

  const inputClass =
    'w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-gray-600 font-mono';

  const load = useCallback(async () => {
    setError(null);
    try {
      const body = await getter();
      setData(body);
      setUnauthenticated(false);
    } catch (err) {
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
  }, [getter]);

  useEffect(() => {
    load();
  }, [load]);

  const handleSaveApiKey = async () => {
    setApiKeySaving(true);
    setApiKeyStatus(null);
    try {
      const body = await setter({ apiKey: apiKeyInput.trim() });
      setData(body);
      setApiKeyStatus({ type: 'success', msg: body.apiKey ? 'Saved' : 'Cleared' });
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
      const body = await setter({ apiKey: '' });
      setData(body);
      setApiKeyStatus({ type: 'success', msg: 'Cleared' });
      setApiKeyInput('');
    } catch (err) {
      setApiKeyStatus({ type: 'error', msg: err.message || String(err) });
    } finally {
      setApiKeySaving(false);
    }
  };

  if (loading) {
    return (
      <div className="bg-gray-800 rounded-xl p-4">
        <div className="flex items-center gap-2 text-sm text-gray-400">
          <Loader2 size={14} className="animate-spin" />
          Loading your {engineLabel} credentials…
        </div>
      </div>
    );
  }

  if (unauthenticated) {
    // Legacy global apiKey auth has no per-user identity.
    return (
      <div className="bg-gray-800 rounded-xl p-4">
        <h4 className="text-sm font-medium text-gray-300 flex items-center gap-2 mb-2">
          {Icon ? <Icon size={14} /> : <Key size={14} />} Personal {engineLabel} credentials
        </h4>
        <p className="text-xs text-gray-500">
          Sign in as a user (instead of the legacy global API key) to attach your own {engineLabel}{' '}
          API key. Spawned sessions you own will use it instead of the host-wide credential.
        </p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4">
        <div className="flex items-center gap-2 text-red-400 text-sm mb-2">
          <AlertCircle size={14} />
          <span className="font-medium">Failed to load your {engineLabel} credentials</span>
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

  const apiKeyMasked = data?.apiKey || null;
  const apiKeyHostFallback = !!data?.hostConfigFallback?.apiKey;

  return (
    <div className="bg-gray-800 rounded-xl p-4 space-y-4">
      <div>
        <h4 className="text-sm font-medium text-gray-300 flex items-center gap-2">
          {Icon ? <Icon size={14} /> : <Key size={14} />} Personal {engineLabel} credentials
        </h4>
        <p className="text-[11px] text-gray-500 mt-1 leading-relaxed">
          {description || (
            <>
              When set, sessions you own spawn with your {engineLabel} key instead of the host-wide
              configuration. Leave empty to fall back to the host
              {hostSettingHint ? (
                <>
                  {' '}
                  (managed in <span className="text-gray-400">{hostSettingHint}</span>)
                </>
              ) : null}
              .
            </>
          )}
        </p>
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h5 className="text-xs font-medium text-gray-300 flex items-center gap-2">
            <Key size={12} /> {engineLabel} API key
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
              aria-label={`Clear my ${engineLabel} API key`}
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
            placeholder={placeholder || ''}
            autoComplete="off"
            data-1p-ignore
            data-lpignore="true"
            aria-label={`${engineLabel} API key`}
          />
          <button
            type="button"
            onClick={() => setShowApiKey(!showApiKey)}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 p-1"
            aria-label={showApiKey ? `Hide ${engineLabel} API key` : `Show ${engineLabel} API key`}
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
    </div>
  );
}
