import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, Eye, EyeOff, Key, Loader2, RefreshCw } from 'lucide-react';
import { api } from '../utils/api';

/**
 * Per-user personal credential for a **bundled default skill**
 * (e.g. Linear's `LINEAR_API_KEY`, GitHub's `GH_TOKEN`).
 *
 * Stored in the same `user_skill_credentials` table as the SkillsPage
 * credential editor, and injected into spawned sessions the same way via
 * `mergeSkillCredentialSpawnEnv`. The difference is purely surfacing:
 * here on the Account page the schema-source is bundled defaults (no
 * per-project workspace context), so the PUT omits `agent_id`.
 *
 * Designed to live next to the engine auth sections (Cursor / Gemini /
 * Codex) — visually matches `MySingleKeyAuthSection`.
 */
export default function MySkillCredentialSection({
  skillId,
  keyName,
  label,
  description,
  placeholder,
  Icon,
  docsUrl,
}: any) {
  const [maskedRow, setMaskedRow] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<any>(null);
  const [unauthenticated, setUnauthenticated] = useState(false);

  const [keyInput, setKeyInput] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<any>(null);

  const inputClass =
    'w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-gray-600 font-mono';

  const load = useCallback(async () => {
    setError(null);
    try {
      const body = await api.getSkillCredentials(skillId);
      const row = (body?.credentials || []).find((r: any) => r.key_name === keyName) || null;
      setMaskedRow(row);
      setUnauthenticated(false);
    } catch (err: any) {
      const msg = err?.message || String(err);
      if (/^401[:\s]/.test(msg) || /authentication required/i.test(msg)) {
        setUnauthenticated(true);
        setMaskedRow(null);
      } else {
        setError(msg);
        setMaskedRow(null);
      }
    } finally {
      setLoading(false);
    }
  }, [skillId, keyName]);

  useEffect(() => {
    load();
  }, [load]);

  const handleSave = async () => {
    setSaving(true);
    setStatus(null);
    try {
      await api.putSkillCredential({
        skill_id: skillId,
        key_name: keyName,
        value: keyInput.trim(),
      });
      await load();
      setKeyInput('');
      setStatus({ type: 'success', msg: 'Saved' });
    } catch (err: any) {
      setStatus({ type: 'error', msg: err.message || String(err) });
    } finally {
      setSaving(false);
    }
  };

  const handleClear = async () => {
    setSaving(true);
    setStatus(null);
    try {
      await api.putSkillCredential({
        skill_id: skillId,
        key_name: keyName,
        value: '',
      });
      await load();
      setKeyInput('');
      setStatus({ type: 'success', msg: 'Cleared' });
    } catch (err: any) {
      setStatus({ type: 'error', msg: err.message || String(err) });
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="bg-gray-800 rounded-xl p-4">
        <div className="flex items-center gap-2 text-sm text-gray-400">
          <Loader2 size={14} className="animate-spin" />
          Loading your {label} credential…
        </div>
      </div>
    );
  }

  if (unauthenticated) {
    return (
      <div className="bg-gray-800 rounded-xl p-4">
        <h4 className="text-sm font-medium text-gray-300 flex items-center gap-2 mb-2">
          {Icon ? <Icon size={14} /> : <Key size={14} />} Personal {label}
        </h4>
        <p className="text-xs text-gray-500">
          Sign in as a user (instead of the legacy global API key) to attach your own {label}.
          Spawned sessions you own will have it injected as <code>{keyName}</code>.
        </p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4">
        <div className="flex items-center gap-2 text-red-400 text-sm mb-2">
          <AlertCircle size={14} />
          <span className="font-medium">Failed to load your {label}</span>
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

  const masked = maskedRow?.masked_preview || null;

  return (
    <div className="bg-gray-800 rounded-xl p-4 space-y-4">
      <div>
        <h4 className="text-sm font-medium text-gray-300 flex items-center gap-2">
          {Icon ? <Icon size={14} /> : <Key size={14} />} Personal {label}
        </h4>
        <p className="text-[11px] text-gray-500 mt-1 leading-relaxed">
          {description || (
            <>
              When set, sessions you own will have <code>{keyName}</code> injected into the
              environment. Skill scripts and CLI agents pick it up automatically.
            </>
          )}
          {docsUrl ? (
            <>
              {' '}
              <a
                href={docsUrl}
                target="_blank"
                rel="noreferrer"
                className="text-indigo-300 hover:text-indigo-200 underline"
              >
                Get a key
              </a>
              .
            </>
          ) : null}
        </p>
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h5 className="text-xs font-medium text-gray-300 flex items-center gap-2">
            <Key size={12} /> {keyName}
          </h5>
          {masked ? (
            <span className="text-[11px] text-emerald-300 bg-emerald-500/10 border border-emerald-500/20 rounded px-2 py-0.5">
              Set
            </span>
          ) : (
            <span className="text-[11px] text-gray-400 bg-gray-700/40 border border-gray-700 rounded px-2 py-0.5">
              Not set
            </span>
          )}
        </div>
        {masked && (
          <div className="flex items-center justify-between bg-gray-900 rounded-lg p-3">
            <div className="flex items-center gap-2 text-sm">
              <CheckCircle2 size={14} className="text-emerald-400" />
              <span className="text-gray-300 font-mono">{masked}</span>
            </div>
            <button
              type="button"
              onClick={handleClear}
              disabled={saving}
              className="text-xs text-red-400 hover:text-red-300 disabled:opacity-50"
              aria-label={`Clear my ${label}`}
            >
              {saving ? '…' : `Clear my ${label}`}
            </button>
          </div>
        )}
        <div className="relative">
          <input
            type={showKey ? 'text' : 'password'}
            value={keyInput}
            onChange={(e: any) => {
              setKeyInput(e.target.value);
              setStatus(null);
            }}
            className={`${inputClass} pr-10 text-xs`}
            placeholder={placeholder || ''}
            autoComplete="off"
            data-1p-ignore
            data-lpignore="true"
            aria-label={label}
          />
          <button
            type="button"
            onClick={() => setShowKey(!showKey)}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 p-1"
            aria-label={showKey ? `Hide ${label}` : `Show ${label}`}
          >
            {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={handleSave}
            disabled={!keyInput.trim() || saving}
            className="inline-flex items-center gap-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-xs px-3 py-1.5 rounded-lg"
          >
            {saving ? <Loader2 size={12} className="animate-spin" /> : null}
            {saving ? 'Saving…' : `Save ${label}`}
          </button>
        </div>
        {status && (
          <div
            role={status.type === 'success' ? 'status' : 'alert'}
            className={`flex items-center gap-2 text-xs ${
              status.type === 'success' ? 'text-emerald-400' : 'text-red-400'
            }`}
          >
            {status.type === 'success' ? <CheckCircle2 size={12} /> : <AlertCircle size={12} />}
            <span>{status.msg}</span>
          </div>
        )}
      </div>
    </div>
  );
}
