import { useCallback, useEffect, useState } from 'react';
import {
  Copy,
  Eye,
  EyeOff,
  Key,
  Loader2,
  LogOut,
  Mail,
  Mic,
  Plus,
  Send,
  ShieldOff,
  Sparkles,
  SquareKanban,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import RoleBadge from './RoleBadge';
import MyClaudeAuthSection from './MyClaudeAuthSection';
import MySingleKeyAuthSection from './MySingleKeyAuthSection';
import MyCursorAuthSection from './MyCursorAuthSection';
import MyCodexAuthSection from './MyCodexAuthSection';
import MyGrokAuthSection from './MyGrokAuthSection';
import MySkillCredentialSection from './MySkillCredentialSection';
import GoogleConnectionSection from './GoogleConnectionSection';
import GoogleOAuthConfigSection from './GoogleOAuthConfigSection';
import MfaSettingsPanel from './MfaSettingsPanel';
import { api } from '../utils/api';
import { getAuthHeaders, getApiBase } from '../utils/connection';
import { hasRole, getUserRole, logout } from '../utils/auth';
import { formatDate, parseDate } from '../utils/time';

const ALL_ROLES = ['Owner', 'Admin', 'User'];

function isValidEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function displayEmail(user: any) {
  return user?.email || user?.username || 'Account';
}

/**
 * Returns the list of roles a caller is allowed to assign when creating a new
 * user. Owner can assign any role; Admin can create Admin + User but not
 * Owner; lower roles can't create users at all. The server enforces the same
 * gate (Owner-only) — this helper exists so the UI mirrors the rule and
 * tests can pin it down.
 *
 * @param {string|null|undefined} callerRole
 * @returns {Array<'Owner' | 'Admin' | 'User'>}
 */
export function roleOptionsFor(callerRole: any) {
  if (callerRole === 'Owner') return ['Owner', 'Admin', 'User'];
  if (callerRole === 'Admin') return ['Admin', 'User'];
  return [];
}

export function inviteRoleOptionsFor(callerRole: any) {
  if (callerRole === 'Owner' || callerRole === 'Admin') return ['Admin', 'User'];
  return [];
}

/**
 * Account tab — surfaces the current user's role and, for Admin+ callers,
 * the roster of configured users with create / change-role / remove
 * controls.
 */
export default function AccountSection() {
  const [me, setMe] = useState<any>(null);
  const [users, setUsers] = useState<any>(null);
  const [invites, setInvites] = useState<any>(null);
  const [inviteEmailStatus, setInviteEmailStatus] = useState({ smtpConfigured: false });
  const [error, setError] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [rowErrors, setRowErrors] = useState<Record<string, any>>({});
  const [loggingOut, setLoggingOut] = useState(false);

  const handleLogout = useCallback(async () => {
    if (loggingOut) return;
    setLoggingOut(true);
    try {
      await logout({ baseUrl: getApiBase() });
    } catch {
      /* logout is best-effort; the local token is dropped regardless */
    }
    // Reload so the AuthGate re-evaluates and surfaces the login screen.
    if (typeof window !== 'undefined' && window.location?.reload) {
      window.location.reload();
    }
  }, [loggingOut]);

  const loadUsers = useCallback(async () => {
    const usersRes = await fetch(`${getApiBase()}/auth/users`, {
      headers: getAuthHeaders(),
    });
    if (usersRes.ok) {
      const body = await usersRes.json();
      setUsers(body.users || []);
    } else if (usersRes.status !== 403) {
      setError(`GET /auth/users → ${usersRes.status}`);
    }
  }, []);

  const loadInvites = useCallback(async () => {
    try {
      const body = await api.getInvites();
      setInvites(body.invites || []);
      setInviteEmailStatus(body.emailDelivery || { smtpConfigured: false });
    } catch (err: any) {
      setError(err.message || String(err));
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const meRes = await fetch(`${getApiBase()}/auth/me`, { headers: getAuthHeaders() });
        if (!meRes.ok) throw new Error(`GET /auth/me → ${meRes.status}`);
        const meBody = await meRes.json();
        if (cancelled) return;
        setMe(meBody.user || null);

        // Only Admin+ can fetch the users roster — the server enforces
        // this; we skip the request otherwise to avoid noisy 403s.
        if (hasRole('Admin') || meBody.user?.role === 'Owner' || meBody.user?.role === 'Admin') {
          await loadUsers();
          await loadInvites();
        }
      } catch (err: any) {
        if (!cancelled) setError(err.message || String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadInvites, loadUsers]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-gray-400">
        <Loader2 size={14} className="animate-spin" />
        Loading account…
      </div>
    );
  }

  const currentRole = me?.role || getUserRole();
  const isOwner = currentRole === 'Owner';
  const isAdminPlus = currentRole === 'Owner' || currentRole === 'Admin';

  const setRowError = (id: any, msg: any) =>
    setRowErrors((prev: any) => {
      const next = { ...prev };
      if (msg) next[id] = msg;
      else delete next[id];
      return next;
    });

  const handleRoleChange = async (user: any, nextRole: any) => {
    if (!user.id || nextRole === user.role) return;
    setRowError(user.id, null);
    try {
      const res = await fetch(`${getApiBase()}/auth/users/${user.id}/role`, {
        method: 'PUT',
        headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: nextRole }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setRowError(user.id, body.error || `PUT /auth/users → ${res.status}`);
        return;
      }
      await loadUsers();
    } catch (err: any) {
      setRowError(user.id, err.message || String(err));
    }
  };

  const handleRemove = async (user: any) => {
    if (!user.id) return;
    if (!window.confirm(`Remove ${displayEmail(user)}? This can't be undone.`)) return;
    setRowError(user.id, null);
    try {
      const res = await fetch(`${getApiBase()}/auth/users/${user.id}`, {
        method: 'DELETE',
        headers: getAuthHeaders(),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setRowError(user.id, body.error || `DELETE /auth/users → ${res.status}`);
        return;
      }
      await loadUsers();
    } catch (err: any) {
      setRowError(user.id, err.message || String(err));
    }
  };

  const handleMfaChanged = (enabled: boolean) => {
    setMe((prev: any) => (prev ? { ...prev, mfaEnabled: enabled } : prev));
    void loadUsers();
  };

  const handleResetMfa = async (user: any) => {
    if (!user.id) return;
    if (
      !window.confirm(
        `Clear MFA for ${displayEmail(user)}? They will be able to sign in with password only.`,
      )
    ) {
      return;
    }
    setRowError(user.id, null);
    try {
      await api.resetUserMfa(user.id);
      setUsers((prev: any) =>
        Array.isArray(prev)
          ? prev.map((item: any) => (item.id === user.id ? { ...item, mfaEnabled: false } : item))
          : prev,
      );
      if (me?.id === user.id) setMe((prev: any) => (prev ? { ...prev, mfaEnabled: false } : prev));
    } catch (err: any) {
      setRowError(user.id, err.message || String(err));
    }
  };

  const ownerCount = Array.isArray(users)
    ? users.filter((u: any) => u?.role === 'Owner').length
    : 0;

  return (
    <div className="space-y-6">
      <div className="bg-gray-800 rounded-xl p-4">
        <div className="flex items-start justify-between gap-3 mb-3">
          <h4 className="text-sm font-medium text-gray-300">Your account</h4>
          {me && (
            <button
              type="button"
              onClick={handleLogout}
              disabled={loggingOut}
              className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded border border-gray-700 text-gray-300 hover:bg-gray-700 hover:text-white disabled:opacity-50"
              aria-label="Log out"
            >
              {loggingOut ? <Loader2 size={12} className="animate-spin" /> : <LogOut size={12} />}
              Log out
            </button>
          )}
        </div>
        {me ? (
          <div className="flex items-center gap-3">
            <span className="font-mono text-sm text-white">{displayEmail(me)}</span>
            <RoleBadge role={currentRole} />
          </div>
        ) : (
          <p className="text-xs text-gray-500">Not authenticated.</p>
        )}
        <p className="text-[11px] text-gray-500 mt-3 leading-relaxed">
          Roles are hierarchical: <span className="text-emerald-300">Owner</span> {'>'}{' '}
          <span className="text-indigo-300">Admin</span> {'>'}{' '}
          <span className="text-gray-300">User</span>. Owner has full control and cannot be demoted
          while they&apos;re the only one.
        </p>
      </div>

      {me && <MyClaudeAuthSection />}

      {me && <MfaSettingsPanel mfaEnabled={!!me.mfaEnabled} onMfaChanged={handleMfaChanged} />}

      {me && <MyCursorAuthSection />}

      {me && (
        <MySingleKeyAuthSection
          engineLabel="Gemini"
          Icon={Sparkles}
          placeholder="AIza..."
          hostSettingHint="Settings → Gemini Auth"
          getter={() => api.getMyGeminiAuth()}
          setter={(body: any) => api.putMyGeminiAuth(body)}
        />
      )}

      {me && <MyCodexAuthSection />}

      {me && <MyGrokAuthSection />}

      {me && (
        <MySkillCredentialSection
          skillId="linear"
          keyName="LINEAR_API_KEY"
          label="Linear API key"
          placeholder="lin_api_..."
          Icon={SquareKanban}
          docsUrl="https://linear.app/settings/api"
          description={
            <>
              Personal API key from Linear (Settings → API → Personal API keys). When set, sessions
              you own will have <code>LINEAR_API_KEY</code> injected so the Linear skill can query
              your workspace.
            </>
          }
        />
      )}

      {me && <GoogleConnectionSection />}

      {me && isAdminPlus && <GoogleOAuthConfigSection />}

      {me && isAdminPlus && <PluginApiKeysSection />}

      {me && <ApiKeysSection />}

      {users !== null && (
        <div className="bg-gray-800 rounded-xl p-4">
          <div className="flex items-center justify-between mb-3">
            <h4 className="text-sm font-medium text-gray-300 flex items-center gap-2">
              <Users size={14} /> Configured users
            </h4>
            {isOwner && (
              <button
                type="button"
                onClick={() => setShowAddModal(true)}
                className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded bg-indigo-600 hover:bg-indigo-500 text-white"
                aria-label="Add user"
              >
                <Plus size={12} /> Add user
              </button>
            )}
          </div>
          {users.length === 0 ? (
            <p className="text-xs text-gray-500">No users configured.</p>
          ) : (
            <ul className="space-y-2">
              {users.map((u: any) => {
                const rowError = u.id ? rowErrors[u.id] : null;
                return (
                  <li
                    key={u.id || u.email || u.username}
                    className="border border-gray-700 rounded px-3 py-2"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <span className="font-mono text-sm text-white">{displayEmail(u)}</span>
                        <div
                          className={`text-[11px] ${u.mfaEnabled ? 'text-emerald-300' : 'text-gray-500'}`}
                        >
                          MFA {u.mfaEnabled ? 'on' : 'off'}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        {isAdminPlus && u.id ? (
                          <select
                            aria-label={`Role for ${displayEmail(u)}`}
                            value={u.role}
                            onChange={(e: any) => handleRoleChange(u, e.target.value)}
                            className="bg-gray-900 border border-gray-700 rounded text-xs text-gray-200 px-2 py-1"
                          >
                            {ALL_ROLES.map((r: any) => (
                              <option key={r} value={r} disabled={r === 'Owner' && !isOwner}>
                                {r}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <RoleBadge role={u.role} />
                        )}
                        {isOwner && u.id && (
                          <button
                            type="button"
                            onClick={() => handleRemove(u)}
                            className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded border border-red-500/40 text-red-300 hover:bg-red-500/10"
                            aria-label={`Remove ${displayEmail(u)}`}
                          >
                            <Trash2 size={12} />
                          </button>
                        )}
                        {isAdminPlus && u.id && u.mfaEnabled && (
                          <button
                            type="button"
                            onClick={() => handleResetMfa(u)}
                            className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded border border-amber-500/40 text-amber-200 hover:bg-amber-500/10"
                            aria-label={`Clear MFA for ${displayEmail(u)}`}
                          >
                            <ShieldOff size={12} />
                          </button>
                        )}
                      </div>
                    </div>
                    {rowError && (
                      <div
                        role="alert"
                        className="mt-2 text-[11px] text-red-300 bg-red-500/10 border border-red-500/30 rounded px-2 py-1"
                      >
                        {rowError}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {ownerCount === 1 && (
            <div className="mt-3 text-[11px] text-amber-200 bg-amber-500/10 border border-amber-500/30 rounded px-3 py-2">
              Sole-Owner guard is active. Add or promote another Owner before removing or demoting
              the current Owner.
            </div>
          )}
        </div>
      )}

      {me && isAdminPlus && (
        <InvitesSection
          callerRole={currentRole}
          invites={invites}
          emailDelivery={inviteEmailStatus}
          onChanged={loadInvites}
        />
      )}

      {error && (
        <div className="text-xs text-red-300 bg-red-500/10 border border-red-500/30 rounded p-2">
          {error}
        </div>
      )}

      {showAddModal && (
        <AddUserModal
          callerRole={currentRole}
          onClose={() => setShowAddModal(false)}
          onCreated={async () => {
            setShowAddModal(false);
            await loadUsers();
          }}
        />
      )}
    </div>
  );
}

const PLUGIN_API_KEYS = [
  {
    id: 'xai',
    label: 'xAI API key',
    placeholder: 'xai-...',
    description:
      'Host-wide xAI key: powers voice transcription (the default provider) and is the fallback for the Grok (grok-cli) agent engine when a user has no key of their own (set yours under Personal Grok credentials above).',
    loadConfigured: (body: any) => !!body.xaiApiKeySet || !!body.xaiApiKey,
    load: () => api.getConfig(),
    save: (value: any) => api.updateConfig({ xaiApiKey: value }),
    clear: () => api.updateConfig({ xaiApiKey: '' }),
    savedConfigured: (body: any) => !!body?.updated?.xaiApiKey,
  },
  {
    id: 'gemini',
    label: 'Gemini API key',
    placeholder: 'AIza...',
    description: 'Used for voice transcription and wiki RAG.',
    loadConfigured: (body: any) => !!body?.apiKey?.configured,
    load: () => api.getGeminiAuth(),
    save: (value: any) => api.setGeminiApiKey(value),
    clear: () => api.logoutGemini(),
    savedConfigured: (body: any) => !!body?.configured,
  },
  {
    id: 'openai',
    label: 'OpenAI API key',
    placeholder: 'sk-...',
    description: 'Plugin use: voice transcription only. Also used for generated session titles.',
    loadConfigured: (body: any) => !!body.openaiApiKeySet || !!body.openaiApiKey,
    load: () => api.getConfig(),
    save: (value: any) => api.updateConfig({ openaiApiKey: value }),
    clear: () => api.updateConfig({ openaiApiKey: '' }),
    savedConfigured: (body: any) => !!body?.updated?.openaiApiKey,
  },
];

function PluginApiKeyRow({ item }: any) {
  const [loading, setLoading] = useState(true);
  const [configured, setConfigured] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<any>(null);

  const load = useCallback(async () => {
    setStatus(null);
    try {
      const body = await item.load();
      setConfigured(item.loadConfigured(body));
    } catch (err: any) {
      setStatus({ type: 'error', msg: err.message || String(err) });
    } finally {
      setLoading(false);
    }
  }, [item]);

  useEffect(() => {
    load();
  }, [load]);

  const save = async (value: any) => {
    setSaving(true);
    setStatus(null);
    try {
      const body = value ? await item.save(value) : await item.clear();
      const nextConfigured = item.savedConfigured(body);
      setConfigured(nextConfigured);
      setApiKeyInput('');
      setStatus({ type: 'success', msg: nextConfigured ? 'Saved' : 'Cleared' });
    } catch (err: any) {
      setStatus({ type: 'error', msg: err.message || String(err) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="border border-gray-700 rounded-lg p-3 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h5 className="text-sm font-medium text-gray-300">{item.label}</h5>
          <p className="text-[11px] text-gray-500 mt-1 leading-relaxed">{item.description}</p>
        </div>
        {!loading && (
          <span
            className={`text-[11px] mt-0.5 ${configured ? 'text-emerald-300' : 'text-gray-500'}`}
          >
            {configured ? 'Configured' : 'Not configured'}
          </span>
        )}
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <Loader2 size={12} className="animate-spin" /> Loading key status…
        </div>
      ) : (
        <>
          <div className="relative">
            <input
              type={showApiKey ? 'text' : 'password'}
              value={apiKeyInput}
              onChange={(e: any) => {
                setApiKeyInput(e.target.value);
                setStatus(null);
              }}
              className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 pr-10 text-xs text-gray-100 focus:outline-none focus:border-gray-600 font-mono"
              autoComplete="off"
              data-1p-ignore
              data-lpignore="true"
              aria-label={item.label}
              placeholder={item.placeholder}
            />
            <button
              type="button"
              onClick={() => setShowApiKey((value: any) => !value)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 p-1"
              aria-label={showApiKey ? `Hide ${item.label}` : `Show ${item.label}`}
            >
              {showApiKey ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => save(apiKeyInput.trim())}
              disabled={!apiKeyInput.trim() || saving}
              className="inline-flex items-center gap-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-xs px-3 py-1.5 rounded-lg"
            >
              {saving ? <Loader2 size={12} className="animate-spin" /> : null}
              {saving ? 'Saving…' : 'Save API key'}
            </button>
            {configured && (
              <button
                type="button"
                onClick={() => save('')}
                disabled={saving}
                className="text-xs text-red-400 hover:text-red-300 disabled:opacity-50"
                aria-label={`Clear ${item.label}`}
              >
                Clear
              </button>
            )}
          </div>
        </>
      )}

      {status && (
        <div
          role={status.type === 'success' ? 'status' : 'alert'}
          className={`text-xs ${status.type === 'success' ? 'text-emerald-400' : 'text-red-400'}`}
        >
          {status.msg}
        </div>
      )}
    </div>
  );
}

const TRANSCRIPTION_PROVIDERS = [
  {
    id: 'xai',
    label: 'xAI Grok',
    description:
      'Uses the xAI Grok speech-to-text model. xAI does not accept WebM (what Chrome/Electron record), so those recordings fall back to OpenAI Whisper when an OpenAI key is set. Recommended (default).',
    keyField: 'xaiApiKeySet',
    keyLabel: 'xAI API key',
  },
  {
    id: 'openai',
    label: 'OpenAI Whisper',
    description: 'Works in every browser and for all recorded formats.',
    keyField: 'openaiApiKeySet',
    keyLabel: 'OpenAI API key',
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    description:
      'Uses the Gemini audio model. Requires OGG / MP3 / WAV / FLAC audio (Chrome records WebM, which Gemini cannot read).',
    keyField: 'geminiApiKeySet',
    keyLabel: 'Gemini API key',
  },
];

/** Recognized transcription provider ids; anything else falls back to the default. */
const KNOWN_TRANSCRIPTION_PROVIDERS = TRANSCRIPTION_PROVIDERS.map((p: any) => p.id);
const DEFAULT_TRANSCRIPTION_PROVIDER = 'xai';

const DEFAULT_SMTP_FORM = {
  enabled: false,
  host: '',
  port: 587,
  tlsMode: 'starttls',
  username: '',
  password: '',
  from: '',
};

export function smtpFormFromSettings(settings: any) {
  const smtp = settings?.smtp || {};
  return {
    enabled: !!smtp.enabled,
    host: smtp.host || '',
    port: smtp.port || 587,
    tlsMode: smtp.tlsMode || 'starttls',
    username: smtp.username || '',
    password: '',
    from: smtp.from || '',
  };
}

export function buildSmtpPatch(form: any, original: any, clearPassword = false) {
  const smtp = original?.smtp || {};
  const patch: Record<string, any> = {
    enabled: !!form.enabled,
    host: form.host.trim(),
    port: Number(form.port),
    tlsMode: form.tlsMode,
    username: form.username.trim() || null,
    from: form.from.trim(),
  };
  if (clearPassword) {
    patch.password = null;
  } else if (form.password) {
    patch.password = form.password;
  } else if (!smtp.passwordSet) {
    patch.password = null;
  }
  return patch;
}

export function smtpConfiguredLabel(settings: any) {
  return settings?.smtp?.configured ? 'Configured' : 'Not configured';
}

export function SmtpSettingsPanel() {
  const [settings, setSettings] = useState<any>(null);
  const [form, setForm] = useState<any>(DEFAULT_SMTP_FORM);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [status, setStatus] = useState<any>(null);
  const [testTo, setTestTo] = useState('');
  const [clearPassword, setClearPassword] = useState(false);

  const load = useCallback(async () => {
    setStatus(null);
    try {
      const body = await api.getSmtpSettings();
      setSettings(body);
      setForm(smtpFormFromSettings(body));
      setClearPassword(false);
    } catch (err: any) {
      setStatus({ type: 'error', msg: err.message || String(err) });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const setField = (key: any, value: any) => {
    setForm((prev: any) => ({ ...prev, [key]: value }));
    setStatus(null);
    if (key === 'password') setClearPassword(false);
  };

  const save = async () => {
    setSaving(true);
    setStatus(null);
    try {
      const body = await api.updateSmtpSettings(buildSmtpPatch(form, settings, clearPassword));
      setSettings(body);
      setForm(smtpFormFromSettings(body));
      setClearPassword(false);
      setStatus({ type: 'success', msg: 'Saved SMTP settings.' });
    } catch (err: any) {
      setStatus({ type: 'error', msg: err.message || String(err) });
    } finally {
      setSaving(false);
    }
  };

  const testSend = async () => {
    setTesting(true);
    setStatus(null);
    try {
      const body = await api.testSmtpSettings(testTo.trim() ? { to: testTo.trim() } : {});
      setStatus({ type: 'success', msg: `Test email sent to ${body.to}.` });
    } catch (err: any) {
      setStatus({ type: 'error', msg: err.message || String(err) });
    } finally {
      setTesting(false);
    }
  };

  const configured = settings?.smtp?.configured;
  const passwordSet = settings?.smtp?.passwordSet && !clearPassword;

  return (
    <div className="border border-gray-700 rounded-lg p-3 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h5 className="text-sm font-medium text-gray-300 flex items-center gap-2">
            <Mail size={13} /> SMTP email delivery
          </h5>
          <p className="text-[11px] text-gray-500 mt-1 leading-relaxed">
            Sends auth email such as invite links and password-reset messages.
          </p>
        </div>
        {!loading && (
          <span
            className={`text-[11px] mt-0.5 ${configured ? 'text-emerald-300' : 'text-gray-500'}`}
          >
            {smtpConfiguredLabel(settings)}
          </span>
        )}
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <Loader2 size={12} className="animate-spin" /> Loading SMTP settings…
        </div>
      ) : (
        <>
          <label className="flex items-center gap-2 text-xs text-gray-300">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e: any) => setField('enabled', e.target.checked)}
              className="rounded border-gray-700 bg-gray-900"
            />
            Enabled
          </label>

          <div className="grid grid-cols-1 md:grid-cols-[1fr_7rem_9rem] gap-2">
            <input
              value={form.host}
              onChange={(e: any) => setField('host', e.target.value)}
              className="bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-xs text-gray-100 focus:outline-none focus:border-gray-600"
              placeholder="smtp.example.com"
              aria-label="SMTP host"
            />
            <input
              value={form.port}
              onChange={(e: any) => setField('port', e.target.value)}
              className="bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-xs text-gray-100 focus:outline-none focus:border-gray-600"
              inputMode="numeric"
              aria-label="SMTP port"
            />
            <select
              value={form.tlsMode}
              onChange={(e: any) => setField('tlsMode', e.target.value)}
              className="bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-xs text-gray-100 focus:outline-none focus:border-gray-600"
              aria-label="SMTP TLS mode"
            >
              <option value="none">No TLS</option>
              <option value="starttls">STARTTLS</option>
              <option value="ssl">SSL/TLS</option>
            </select>
          </div>

          <input
            value={form.from}
            onChange={(e: any) => setField('from', e.target.value)}
            className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-xs text-gray-100 focus:outline-none focus:border-gray-600"
            placeholder="agenthub@example.com"
            aria-label="SMTP from address"
          />

          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            <input
              value={form.username}
              onChange={(e: any) => setField('username', e.target.value)}
              className="bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-xs text-gray-100 focus:outline-none focus:border-gray-600"
              autoComplete="off"
              placeholder="Username"
              aria-label="SMTP username"
            />
            <input
              type="password"
              value={form.password}
              onChange={(e: any) => setField('password', e.target.value)}
              className="bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-xs text-gray-100 focus:outline-none focus:border-gray-600"
              autoComplete="new-password"
              data-1p-ignore
              data-lpignore="true"
              placeholder={passwordSet ? 'Password configured' : 'Password'}
              aria-label="SMTP password"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={save}
              disabled={saving}
              className="inline-flex items-center gap-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-xs px-3 py-1.5 rounded-lg"
            >
              {saving ? <Loader2 size={12} className="animate-spin" /> : null}
              {saving ? 'Saving…' : 'Save SMTP'}
            </button>
            {settings?.smtp?.passwordSet && (
              <button
                type="button"
                onClick={() => {
                  setClearPassword(true);
                  setForm((prev: any) => ({ ...prev, password: '' }));
                  setStatus({ type: 'success', msg: 'Password will be cleared on save.' });
                }}
                disabled={saving}
                className="text-xs text-red-400 hover:text-red-300 disabled:opacity-50"
              >
                Clear password
              </button>
            )}
          </div>

          <div className="flex flex-col sm:flex-row gap-2 border-t border-gray-700/70 pt-3">
            <input
              value={testTo}
              onChange={(e: any) => setTestTo(e.target.value)}
              className="flex-1 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-xs text-gray-100 focus:outline-none focus:border-gray-600"
              placeholder="Test recipient"
              aria-label="SMTP test recipient"
            />
            <button
              type="button"
              onClick={testSend}
              disabled={testing || !configured}
              className="inline-flex justify-center items-center gap-1.5 bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-white text-xs px-3 py-1.5 rounded-lg"
            >
              {testing ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}
              {testing ? 'Sending…' : 'Send test'}
            </button>
          </div>
        </>
      )}

      {status && (
        <div
          role={status.type === 'success' ? 'status' : 'alert'}
          className={`text-xs ${status.type === 'success' ? 'text-emerald-400' : 'text-red-400'}`}
        >
          {status.msg}
        </div>
      )}
    </div>
  );
}

/**
 * Lets an admin choose which provider /api/transcribe uses for chat voice
 * transcription. Persists to host config via PATCH /api/config and warns when
 * the selected provider's API key is not configured.
 */
export function TranscriptionProviderRow() {
  const [loading, setLoading] = useState(true);
  const [provider, setProvider] = useState(DEFAULT_TRANSCRIPTION_PROVIDER);
  const [keyStatus, setKeyStatus] = useState({
    xaiApiKeySet: false,
    openaiApiKeySet: false,
    geminiApiKeySet: false,
  });
  const [saving, setSaving] = useState<any>(null);
  const [status, setStatus] = useState<any>(null);

  const load = useCallback(async () => {
    setStatus(null);
    try {
      const cfg = await api.getConfig();
      setProvider(
        KNOWN_TRANSCRIPTION_PROVIDERS.includes(cfg?.transcriptionProvider)
          ? cfg.transcriptionProvider
          : DEFAULT_TRANSCRIPTION_PROVIDER,
      );
      setKeyStatus({
        xaiApiKeySet: !!cfg?.xaiApiKeySet || !!cfg?.xaiApiKey,
        openaiApiKeySet: !!cfg?.openaiApiKeySet || !!cfg?.openaiApiKey,
        geminiApiKeySet: !!cfg?.geminiApiKeySet,
      });
    } catch (err: any) {
      setStatus({ type: 'error', msg: err.message || String(err) });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const choose = async (next: any) => {
    if (next === provider || saving) return;
    setSaving(next);
    setStatus(null);
    const prev = provider;
    setProvider(next);
    try {
      await api.updateConfig({ transcriptionProvider: next });
      setStatus({ type: 'success', msg: 'Saved' });
    } catch (err: any) {
      setProvider(prev);
      setStatus({ type: 'error', msg: err.message || String(err) });
    } finally {
      setSaving(null);
    }
  };

  return (
    <div className="border border-gray-700 rounded-lg p-3 space-y-3">
      <div>
        <h5 className="text-sm font-medium text-gray-300 flex items-center gap-2">
          <Mic size={13} /> Voice transcription provider
        </h5>
        <p className="text-[11px] text-gray-500 mt-1 leading-relaxed">
          Which provider the chat microphone uses to turn recordings into text. The chosen
          provider&apos;s API key (below) must be configured.
        </p>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <Loader2 size={12} className="animate-spin" /> Loading…
        </div>
      ) : (
        <div className="space-y-2" role="radiogroup" aria-label="Voice transcription provider">
          {TRANSCRIPTION_PROVIDERS.map((opt: any) => {
            const selected = provider === opt.id;
            const keyConfigured = !!(keyStatus as any)[opt.keyField];
            return (
              <button
                key={opt.id}
                type="button"
                role="radio"
                aria-checked={selected}
                // Pin the accessible name to the provider label so it stays
                // stable even when a description mentions another provider.
                aria-label={opt.label}
                disabled={!!saving}
                onClick={() => choose(opt.id)}
                className={`w-full text-left rounded-lg border px-3 py-2 transition-colors disabled:opacity-60 ${
                  selected
                    ? 'border-blue-500 bg-blue-500/10'
                    : 'border-gray-700 hover:border-gray-600'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-gray-200 flex items-center gap-2">
                    <span
                      className={`inline-block w-2.5 h-2.5 rounded-full border ${
                        selected ? 'border-blue-400 bg-blue-400' : 'border-gray-500'
                      }`}
                      aria-hidden="true"
                    />
                    {opt.label}
                    {saving === opt.id && <Loader2 size={11} className="animate-spin" />}
                  </span>
                  <span
                    className={`text-[10px] ${keyConfigured ? 'text-emerald-300' : 'text-amber-300'}`}
                  >
                    {keyConfigured ? `${opt.keyLabel} set` : `${opt.keyLabel} missing`}
                  </span>
                </div>
                <p className="text-[11px] text-gray-500 mt-1 leading-relaxed">{opt.description}</p>
              </button>
            );
          })}
        </div>
      )}

      {status && (
        <div
          role={status.type === 'success' ? 'status' : 'alert'}
          className={`text-xs ${status.type === 'success' ? 'text-emerald-400' : 'text-red-400'}`}
        >
          {status.msg}
        </div>
      )}
    </div>
  );
}

export function PluginApiKeysSection() {
  return (
    <div className="bg-gray-800 rounded-xl p-4 space-y-3">
      <div>
        <h4 className="text-sm font-medium text-gray-300 flex items-center gap-2">
          <Key size={14} /> Plugin API keys
        </h4>
        <p className="text-[11px] text-gray-500 mt-1 leading-relaxed">
          Host keys used by plugin features that call provider APIs directly.
        </p>
      </div>

      <SmtpSettingsPanel />

      <TranscriptionProviderRow />

      {PLUGIN_API_KEYS.map((item: any) => (
        <PluginApiKeyRow key={item.id} item={item} />
      ))}
    </div>
  );
}

export function HostOpenAIKeySection() {
  return <PluginApiKeysSection />;
}

function absoluteInviteUrl(invite: any) {
  const raw = invite?.url || (invite?.token ? `/invite/${invite.token}` : '');
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  if (typeof window === 'undefined') return raw;
  return new URL(raw, window.location.origin).toString();
}

export function InvitesSection({ callerRole, invites, emailDelivery, onChanged }: any) {
  const options = inviteRoleOptionsFor(callerRole);
  const smtpConfigured = !!emailDelivery?.smtpConfigured;
  const [email, setEmail] = useState('');
  const [role, setRole] = useState(options[options.length - 1] || 'User');
  const [busy, setBusy] = useState(false);
  const [sendingToken, setSendingToken] = useState<any>(null);
  const [status, setStatus] = useState<any>(null);
  const [copiedToken, setCopiedToken] = useState<any>(null);

  useEffect(() => {
    if (!options.includes(role)) {
      setRole(options[options.length - 1] || 'User');
    }
  }, [options, role]);

  const copyInviteLink = async (invite: any, successMessage = 'Invite link copied.') => {
    const url = absoluteInviteUrl(invite);
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopiedToken(invite.token);
      setStatus({ type: 'success', msg: successMessage });
    } catch {
      setStatus({ type: 'error', msg: 'Copy failed. Select the invite link manually.' });
    }
  };

  const createInvite = async (event: any) => {
    event.preventDefault();
    const nextEmail = email.trim();
    setStatus(null);
    if (!isValidEmail(nextEmail)) {
      setStatus({ type: 'error', msg: 'Enter a valid email address.' });
      return;
    }
    setBusy(true);
    try {
      const created = await api.createInvite({ email: nextEmail, role });
      setEmail('');
      await onChanged();
      if (created.emailDelivery?.sent) {
        setStatus({ type: 'success', msg: `Invite email sent to ${created.email || nextEmail}.` });
      } else {
        await copyInviteLink(
          created,
          created.emailDelivery?.reason === 'send_failed'
            ? 'Invite email failed. Invite link copied.'
            : 'Invite link created and copied.',
        );
      }
    } catch (err: any) {
      setStatus({ type: 'error', msg: err.message || String(err) });
    } finally {
      setBusy(false);
    }
  };

  const sendInviteEmail = async (invite: any) => {
    setStatus(null);
    setSendingToken(invite.token);
    try {
      await api.sendInviteEmail(invite.token);
      setStatus({ type: 'success', msg: `Invite email sent to ${invite.email}.` });
      await onChanged();
    } catch (err: any) {
      setStatus({
        type: 'error',
        msg: `${err.message || String(err)} Copy the invite link if delivery is blocked.`,
      });
    } finally {
      setSendingToken(null);
    }
  };

  const revokeInvite = async (invite: any) => {
    if (!window.confirm(`Revoke invite for ${invite.email || invite.role}?`)) return;
    setStatus(null);
    try {
      await api.revokeInvite(invite.token);
      setStatus({ type: 'success', msg: 'Invite revoked.' });
      await onChanged();
    } catch (err: any) {
      setStatus({ type: 'error', msg: err.message || String(err) });
    }
  };

  return (
    <div className="bg-gray-800 rounded-xl p-4 space-y-4">
      <div>
        <h4 className="text-sm font-medium text-gray-300 flex items-center gap-2">
          <Users size={14} /> Member invites
        </h4>
        <p className="text-[11px] text-gray-500 mt-1 leading-relaxed">
          Invite links create Admin or User accounts. Promote a member to Owner after they accept.
        </p>
      </div>

      <form
        onSubmit={createInvite}
        className="grid grid-cols-1 md:grid-cols-[1fr_140px_auto] gap-2"
      >
        <input
          type="email"
          value={email}
          onChange={(e: any) => {
            setEmail(e.target.value);
            setStatus(null);
          }}
          placeholder="teammate@example.com"
          autoComplete="email"
          className="bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-gray-600"
          aria-label="Invite email"
        />
        <select
          value={role}
          onChange={(e: any) => setRole(e.target.value)}
          className="bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100"
          aria-label="Invite role"
        >
          {options.map((r: any) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <button
          type="submit"
          disabled={busy || !isValidEmail(email) || options.length === 0}
          className="inline-flex items-center justify-center gap-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm px-3 py-2 rounded-lg"
        >
          {busy ? (
            <Loader2 size={14} className="animate-spin" />
          ) : smtpConfigured ? (
            <Mail size={14} />
          ) : (
            <Plus size={14} />
          )}
          {busy ? 'Inviting…' : smtpConfigured ? 'Send invite email' : 'Create invite link'}
        </button>
      </form>

      {status && (
        <div
          role={status.type === 'success' ? 'status' : 'alert'}
          className={`text-xs rounded px-3 py-2 border ${
            status.type === 'success'
              ? 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30'
              : 'text-red-300 bg-red-500/10 border-red-500/30'
          }`}
        >
          {status.msg}
        </div>
      )}

      {invites === null ? (
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <Loader2 size={12} className="animate-spin" /> Loading invites…
        </div>
      ) : !invites?.length ? (
        <p className="text-xs text-gray-500">No active invites.</p>
      ) : (
        <ul className="space-y-2">
          {invites.map((invite: any) => {
            const url = absoluteInviteUrl(invite);
            return (
              <li key={invite.token} className="border border-gray-700 rounded px-3 py-2">
                <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-sm text-white">
                        {invite.email || 'Open invite'}
                      </span>
                      <RoleBadge role={invite.role} />
                    </div>
                    <div className="text-[11px] text-gray-500 mt-1 flex flex-wrap gap-x-3 gap-y-1">
                      <span>Created {formatDate(invite.createdAt)}</span>
                      <span>Expires {formatDate(invite.expiresAt)}</span>
                    </div>
                    <div className="text-[11px] text-gray-500 font-mono truncate mt-1">{url}</div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {smtpConfigured && invite.email && (
                      <button
                        type="button"
                        onClick={() => sendInviteEmail(invite)}
                        disabled={sendingToken === invite.token}
                        className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded border border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10 disabled:opacity-50"
                      >
                        {sendingToken === invite.token ? (
                          <Loader2 size={12} className="animate-spin" />
                        ) : (
                          <Mail size={12} />
                        )}
                        {sendingToken === invite.token ? 'Sending' : 'Resend email'}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => copyInviteLink(invite)}
                      className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded border border-gray-700 text-gray-300 hover:bg-gray-700"
                    >
                      <Copy size={12} />
                      {copiedToken === invite.token ? 'Copied' : 'Copy invite link'}
                    </button>
                    <button
                      type="button"
                      onClick={() => revokeInvite(invite)}
                      className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded border border-red-500/40 text-red-300 hover:bg-red-500/10"
                    >
                      <Trash2 size={12} /> Revoke
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function AddUserModal({ callerRole, onClose, onCreated }: any) {
  const options = roleOptionsFor(callerRole);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState(options[options.length - 1] || 'User');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<any>(null);

  const handleSubmit = async (e: any) => {
    e.preventDefault();
    setError(null);
    if (!isValidEmail(username)) {
      setError('Enter a valid email address.');
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`${getApiBase()}/auth/users`, {
        method: 'POST',
        headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: username.trim(), username: username.trim(), password, role }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error || `POST /auth/users → ${res.status}`);
        setBusy(false);
        return;
      }
      await onCreated();
    } catch (err: any) {
      setError(err.message || String(err));
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      role="dialog"
      aria-label="Add user"
    >
      <form
        onSubmit={handleSubmit}
        className="bg-gray-900 border border-gray-700 rounded-xl p-5 w-full max-w-sm shadow-xl"
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-medium text-white">Add user</h3>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-200"
            aria-label="Close add-user dialog"
          >
            <X size={16} />
          </button>
        </div>

        <label className="block text-xs text-gray-400 mb-1" htmlFor="add-user-username">
          Email
        </label>
        <input
          id="add-user-username"
          type="email"
          value={username}
          onChange={(e: any) => setUsername(e.target.value)}
          autoComplete="email"
          required
          className="w-full mb-3 px-2 py-1 text-sm bg-gray-800 border border-gray-700 rounded text-white"
        />

        <label className="block text-xs text-gray-400 mb-1" htmlFor="add-user-password">
          Password
        </label>
        <input
          id="add-user-password"
          type="password"
          value={password}
          onChange={(e: any) => setPassword(e.target.value)}
          autoComplete="new-password"
          required
          className="w-full mb-3 px-2 py-1 text-sm bg-gray-800 border border-gray-700 rounded text-white"
        />

        <label className="block text-xs text-gray-400 mb-1" htmlFor="add-user-role">
          Role
        </label>
        <select
          id="add-user-role"
          value={role}
          onChange={(e: any) => setRole(e.target.value)}
          className="w-full mb-3 px-2 py-1 text-sm bg-gray-800 border border-gray-700 rounded text-white"
        >
          {options.map((r: any) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>

        {error && (
          <div
            role="alert"
            className="mb-3 text-xs text-red-300 bg-red-500/10 border border-red-500/30 rounded p-2"
          >
            {error}
          </div>
        )}

        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1 text-xs rounded border border-gray-700 text-gray-300 hover:bg-gray-800"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || !isValidEmail(username) || !password}
            className="inline-flex items-center gap-1 px-3 py-1 text-xs rounded bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-50"
          >
            {busy ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
            Create
          </button>
        </div>
      </form>
    </div>
  );
}

function formatRelative(iso: any) {
  if (!iso) return null;
  // parseDate is UTC-aware: server timestamps are SQLite naive-datetime strings
  // (no TZ marker), and bare `new Date(str)` would read them as local time.
  const d = parseDate(iso);
  const t = d ? d.getTime() : NaN;
  if (!Number.isFinite(t)) return iso;
  const diff = Date.now() - t;
  if (diff < 0) return d!.toLocaleString();
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return d!.toLocaleDateString();
}

/**
 * Per-user API keys panel — exported for direct testing without
 * mounting the whole AccountSection tree.
 */
export function ApiKeysSection() {
  const [keys, setKeys] = useState<any>(null);
  const [error, setError] = useState<any>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [rowErrors, setRowErrors] = useState<Record<string, any>>({});

  const loadKeys = useCallback(async () => {
    try {
      const res = await fetch(`${getApiBase()}/auth/keys`, { headers: getAuthHeaders() });
      if (!res.ok) {
        if (res.status === 401) {
          // Not authenticated — caller is using the legacy global apiKey
          // path which has no per-user identity. Just hide the panel.
          setKeys([]);
          return;
        }
        throw new Error(`GET /auth/keys → ${res.status}`);
      }
      const body = await res.json();
      setKeys(body.keys || []);
    } catch (err: any) {
      setError(err.message || String(err));
    }
  }, []);

  useEffect(() => {
    loadKeys();
  }, [loadKeys]);

  const handleRevoke = async (key: any) => {
    if (
      !window.confirm(
        `Revoke API key "${key.name}"? Any client using this key will immediately lose access.`,
      )
    ) {
      return;
    }
    setRowErrors((prev: any) => ({ ...prev, [key.id]: null }));
    try {
      const res = await fetch(`${getApiBase()}/auth/keys/${key.id}`, {
        method: 'DELETE',
        headers: getAuthHeaders(),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setRowErrors((prev: any) => ({
          ...prev,
          [key.id]: body.error || `DELETE /auth/keys → ${res.status}`,
        }));
        return;
      }
      await loadKeys();
    } catch (err: any) {
      setRowErrors((prev: any) => ({ ...prev, [key.id]: err.message || String(err) }));
    }
  };

  // Hide the panel entirely on the legacy global-apiKey auth path
  // (no per-user identity, server returned 401 above and we set [] —
  // distinguishing here would require an extra round-trip to /auth/me
  // which the parent already did, so we just render the section if the
  // parent decided to mount us at all).
  return (
    <div className="bg-gray-800 rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <h4 className="text-sm font-medium text-gray-300 flex items-center gap-2">
          <Key size={14} /> API Keys
        </h4>
        <button
          type="button"
          onClick={() => setShowCreateModal(true)}
          className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded bg-indigo-600 hover:bg-indigo-500 text-white"
          aria-label="Generate API key"
        >
          <Plus size={12} /> Generate
        </button>
      </div>
      {error && (
        <div
          role="alert"
          className="mb-3 text-[11px] text-red-300 bg-red-500/10 border border-red-500/30 rounded px-2 py-1"
        >
          {error}
        </div>
      )}
      {keys === null ? (
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <Loader2 size={12} className="animate-spin" /> Loading keys…
        </div>
      ) : keys.length === 0 ? (
        <p className="text-xs text-gray-500">
          No API keys yet. Generate one to use Agent Hub from scripts, CI, or remote Electron
          clients.
        </p>
      ) : (
        <ul className="space-y-2">
          {keys.map((k: any) => {
            const rowError = rowErrors[k.id];
            return (
              <li key={k.id} className="border border-gray-700 rounded px-3 py-2">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-white truncate">{k.name}</div>
                    <div className="text-[11px] text-gray-500 font-mono">{k.prefix}…</div>
                    <div className="text-[11px] text-gray-500 mt-1 flex flex-wrap gap-x-3">
                      <span>Created {formatRelative(k.createdAt)}</span>
                      <span>Last used {k.lastUsedAt ? formatRelative(k.lastUsedAt) : 'never'}</span>
                      {k.expiresAt && <span>Expires {formatDate(k.expiresAt)}</span>}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleRevoke(k)}
                    className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded border border-red-500/40 text-red-300 hover:bg-red-500/10"
                    aria-label={`Revoke ${k.name}`}
                  >
                    <Trash2 size={12} /> Revoke
                  </button>
                </div>
                {rowError && (
                  <div
                    role="alert"
                    className="mt-2 text-[11px] text-red-300 bg-red-500/10 border border-red-500/30 rounded px-2 py-1"
                  >
                    {rowError}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <p className="text-[11px] text-gray-500 mt-3 leading-relaxed">
        API keys grant your full access to this org. Use{' '}
        <code className="text-gray-400">Authorization: Bearer ahub_…</code> on REST calls or{' '}
        <code className="text-gray-400">?apiKey=ahub_…</code> on WebSocket handshakes.
      </p>

      {showCreateModal && (
        <CreateApiKeyModal
          onClose={() => setShowCreateModal(false)}
          onCreated={async () => {
            await loadKeys();
          }}
        />
      )}
    </div>
  );
}

function CreateApiKeyModal({ onClose, onCreated }: any) {
  const [name, setName] = useState('');
  const [expiresInDays, setExpiresInDays] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<any>(null);
  const [created, setCreated] = useState<any>(null);
  const [copied, setCopied] = useState(false);

  const handleSubmit = async (e: any) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const body: Record<string, any> = { name: name.trim() };
      if (expiresInDays.trim()) {
        body.expiresInDays = Number(expiresInDays);
      }
      const res = await fetch(`${getApiBase()}/auth/keys`, {
        method: 'POST',
        headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        setError(errBody.error || `POST /auth/keys → ${res.status}`);
        setBusy(false);
        return;
      }
      const responseBody = await res.json();
      setCreated(responseBody);
      setBusy(false);
      // Refresh parent list so the new key shows immediately on close.
      await onCreated();
    } catch (err: any) {
      setError(err.message || String(err));
      setBusy(false);
    }
  };

  const handleCopy = async () => {
    if (!created?.token) return;
    try {
      await navigator.clipboard.writeText(created.token);
      setCopied(true);
    } catch {
      setError('Copy failed — select the token manually.');
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      role="dialog"
      aria-label={created ? 'API key created' : 'Generate API key'}
    >
      <div className="bg-gray-900 border border-gray-700 rounded-xl p-5 w-full max-w-md shadow-xl">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-medium text-white">
            {created ? 'API key created' : 'Generate API key'}
          </h3>
          {!created && (
            <button
              type="button"
              onClick={onClose}
              className="text-gray-400 hover:text-gray-200"
              aria-label="Close generate-key dialog"
            >
              <X size={16} />
            </button>
          )}
        </div>

        {created ? (
          <div className="space-y-3">
            <div className="text-xs text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded p-2">
              This token will only be shown once. Copy it now and store it somewhere safe.
            </div>
            <div className="font-mono text-xs text-white bg-gray-800 border border-gray-700 rounded p-2 break-all select-all">
              {created.token}
            </div>
            <div className="flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={handleCopy}
                className="inline-flex items-center gap-1 px-3 py-1 text-xs rounded bg-indigo-600 hover:bg-indigo-500 text-white"
              >
                <Copy size={12} /> {copied ? 'Copied!' : 'Copy token'}
              </button>
              <button
                type="button"
                onClick={onClose}
                className="px-3 py-1 text-xs rounded border border-gray-700 text-gray-300 hover:bg-gray-800"
              >
                I&apos;ve copied it
              </button>
            </div>
            {error && (
              <div
                role="alert"
                className="text-xs text-red-300 bg-red-500/10 border border-red-500/30 rounded p-2"
              >
                {error}
              </div>
            )}
          </div>
        ) : (
          <form onSubmit={handleSubmit}>
            <label className="block text-xs text-gray-400 mb-1" htmlFor="apikey-name">
              Name
            </label>
            <input
              id="apikey-name"
              type="text"
              value={name}
              onChange={(e: any) => setName(e.target.value)}
              placeholder="My CI server"
              maxLength={100}
              required
              autoComplete="off"
              className="w-full mb-3 px-2 py-1 text-sm bg-gray-800 border border-gray-700 rounded text-white"
            />

            <label className="block text-xs text-gray-400 mb-1" htmlFor="apikey-expires">
              Expires in (days, optional)
            </label>
            <input
              id="apikey-expires"
              type="number"
              min="1"
              max="3650"
              value={expiresInDays}
              onChange={(e: any) => setExpiresInDays(e.target.value)}
              placeholder="Leave blank for no expiry"
              className="w-full mb-3 px-2 py-1 text-sm bg-gray-800 border border-gray-700 rounded text-white"
            />

            {error && (
              <div
                role="alert"
                className="mb-3 text-xs text-red-300 bg-red-500/10 border border-red-500/30 rounded p-2"
              >
                {error}
              </div>
            )}

            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="px-3 py-1 text-xs rounded border border-gray-700 text-gray-300 hover:bg-gray-800"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={busy || !name.trim()}
                className="inline-flex items-center gap-1 px-3 py-1 text-xs rounded bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-50"
              >
                {busy ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
                Generate
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
