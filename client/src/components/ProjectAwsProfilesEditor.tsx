import { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Cloud,
  ExternalLink,
  Loader2,
  Plus,
  Save,
  Trash2,
} from 'lucide-react';
import { api } from '../utils/api';

const SSO_FIELDS = [
  { key: 'sso_account_id', label: 'Account ID', placeholder: '123456789012' },
  { key: 'sso_start_url', label: 'SSO start URL', placeholder: 'https://….awsapps.com/start' },
  { key: 'sso_region', label: 'SSO region', placeholder: 'us-east-2' },
  { key: 'sso_role_name', label: 'Role name', placeholder: 'AdministratorAccess' },
  { key: 'region', label: 'Default region', placeholder: 'us-east-2' },
];

const STATIC_FIELDS = [
  { key: 'aws_access_key_id', label: 'Access key ID', placeholder: 'AKIA…' },
  { key: 'aws_secret_access_key', label: 'Secret access key', placeholder: 'secret' },
  { key: 'aws_session_token', label: 'Session token', placeholder: 'optional' },
  { key: 'region', label: 'Default region', placeholder: 'us-east-2' },
];

export function emptyProfile() {
  return {
    type: 'sso',
    name: '',
    sso_account_id: '',
    sso_start_url: '',
    sso_region: 'us-east-2',
    sso_role_name: 'AdministratorAccess',
    aws_access_key_id: '',
    aws_secret_access_key: '',
    aws_session_token: '',
    region: 'us-east-2',
  };
}

function trimmed(value: any) {
  return typeof value === 'string' ? value.trim() : '';
}

function profilesToRows(profiles: any) {
  return Object.entries(profiles || {})
    .sort(([a]: any, [b]: any) => a.localeCompare(b))
    .map(([name, p]: any) => ({
      name,
      type: p.type === 'static' ? 'static' : 'sso',
      sso_account_id: p.sso_account_id || '',
      sso_start_url: p.sso_start_url || '',
      sso_region: p.sso_region || '',
      sso_role_name: p.sso_role_name || '',
      aws_access_key_id: p.aws_access_key_id || '',
      aws_secret_access_key: p.aws_secret_access_key || '',
      aws_session_token: p.aws_session_token || '',
      region: p.region || '',
    }));
}

export function rowsToProfiles(rows: any) {
  const out: Record<string, any> = {};
  for (const row of rows) {
    const name = trimmed(row.name);
    if (!name) continue;
    if (row.type === 'static') {
      const sessionToken = trimmed(row.aws_session_token);
      out[name] = {
        type: 'static',
        aws_access_key_id: trimmed(row.aws_access_key_id),
        aws_secret_access_key: trimmed(row.aws_secret_access_key),
        region: trimmed(row.region),
      };
      if (sessionToken) {
        out[name].aws_session_token = sessionToken;
      }
    } else {
      out[name] = {
        type: 'sso',
        sso_account_id: trimmed(row.sso_account_id),
        sso_start_url: trimmed(row.sso_start_url),
        sso_region: trimmed(row.sso_region),
        sso_role_name: trimmed(row.sso_role_name),
        region: trimmed(row.region),
      };
    }
  }
  return out;
}

/**
 * Per-project AWS profile editor.
 */
export default function ProjectAwsProfilesEditor({ projectId }: any) {
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<any>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [loginState, setLoginState] = useState<Record<string, any>>({});
  const [statusState, setStatusState] = useState<Record<string, any>>({});

  const inputClass =
    'w-full bg-gray-900 border border-gray-700 rounded-lg px-2 py-1.5 text-xs text-gray-100 focus:outline-none focus:border-gray-600 font-mono';
  const labelClass = 'block text-xs text-gray-400 mb-1';

  const load = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const body = await api.getProjectAwsProfiles(projectId);
      setRows(profilesToRows(body?.profiles));
    } catch (err: any) {
      setError(err?.message || String(err));
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    load();
  }, [load]);

  const handleSave = async () => {
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      await api.putProjectAwsProfiles(projectId, rowsToProfiles(rows));
      await load();
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally {
      setSaving(false);
    }
  };

  const checkStatus = async (profileName: any) => {
    if (!profileName.trim()) return;
    setStatusState((s: any) => ({ ...s, [profileName]: { loading: true } }));
    try {
      const st = await api.getProjectAwsSsoStatus(projectId, profileName.trim());
      setStatusState((s: any) => ({ ...s, [profileName]: { loading: false, data: st } }));
    } catch (err: any) {
      setStatusState((s: any) => ({
        ...s,
        [profileName]: { loading: false, error: err?.message || String(err) },
      }));
    }
  };

  const startLogin = async (profileName: any) => {
    if (!profileName.trim()) return;
    setLoginState((s: any) => ({ ...s, [profileName]: { loading: true } }));
    setError(null);
    try {
      const data = await api.startProjectAwsSsoLogin(projectId, profileName.trim());
      setLoginState((s: any) => ({
        ...s,
        [profileName]: { loading: false, loginUrl: data.loginUrl, completed: data.completed },
      }));
      if (data.loginUrl) {
        window.open(data.loginUrl, '_blank');
      }
      if (data.completed) {
        await checkStatus(profileName);
      }
    } catch (err: any) {
      setLoginState((s: any) => ({
        ...s,
        [profileName]: { loading: false, error: err?.message || String(err) },
      }));
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-xs text-gray-400 py-2">
        <Loader2 size={12} className="animate-spin" />
        Loading AWS profiles…
      </div>
    );
  }

  return (
    <div className="space-y-3" data-testid={`project-aws-profiles-${projectId}`}>
      <div>
        <h5 className="text-xs font-medium text-gray-300 flex items-center gap-1.5 mb-1">
          <Cloud size={12} /> AWS profiles
        </h5>
        <p className="text-xs text-gray-500">
          IAM Identity Center or static profiles for this project. Spawned sessions and the session
          Terminal receive project-scoped AWS config and credentials files, so profiles stay
          isolated to this project. In the Terminal, IAM Identity Center profiles need their own{' '}
          <code className="text-gray-400">aws sso login --profile &lt;name&gt;</code>.
        </p>
      </div>

      {error && (
        <p className="text-xs text-red-400 flex items-center gap-1">
          <AlertCircle size={12} />
          {error}
        </p>
      )}

      <div className="space-y-4">
        {rows.length === 0 && (
          <p className="text-xs text-gray-600 italic">No AWS profiles configured.</p>
        )}
        {rows.map((row: any, idx: any) => {
          const profileName = row.name.trim();
          const st = statusState[profileName];
          const lg = loginState[profileName];
          const isStatic = row.type === 'static';
          const fields = isStatic ? STATIC_FIELDS : SSO_FIELDS;
          return (
            <div
              key={idx}
              className="border border-gray-800 rounded-lg p-3 space-y-2 bg-gray-950/40"
            >
              <div className="flex flex-wrap gap-2 items-end">
                <div className="flex-1 min-w-[100px]">
                  <label className={labelClass}>Profile name</label>
                  <input
                    value={row.name}
                    onChange={(e: any) =>
                      setRows((prev: any) =>
                        prev.map((r: any, i: any) =>
                          i === idx ? { ...r, name: e.target.value } : r,
                        ),
                      )
                    }
                    className={inputClass}
                    placeholder="dev"
                  />
                </div>
                <div className="min-w-[120px]">
                  <label className={labelClass}>Type</label>
                  <select
                    value={row.type}
                    onChange={(e: any) =>
                      setRows((prev: any) =>
                        prev.map((r: any, i: any) =>
                          i === idx ? { ...r, type: e.target.value } : r,
                        ),
                      )
                    }
                    className={inputClass}
                  >
                    <option value="sso">SSO</option>
                    <option value="static">Static</option>
                  </select>
                </div>
                <button
                  type="button"
                  disabled={!profileName}
                  onClick={() => checkStatus(profileName)}
                  className="text-xs px-2 py-1.5 rounded border border-gray-700 text-gray-300 hover:bg-gray-800 disabled:opacity-40"
                >
                  {isStatic ? 'Check credentials' : 'Check login'}
                </button>
                {!isStatic && (
                  <button
                    type="button"
                    disabled={!profileName || lg?.loading}
                    onClick={() => startLogin(profileName)}
                    className="text-xs px-2 py-1.5 rounded bg-amber-700/80 hover:bg-amber-600 text-white disabled:opacity-40 flex items-center gap-1"
                  >
                    {lg?.loading ? <Loader2 size={12} className="animate-spin" /> : null}
                    SSO login
                  </button>
                )}
                <button
                  type="button"
                  className="text-gray-500 hover:text-red-400 p-1.5"
                  onClick={() => setRows((prev: any) => prev.filter((_: any, i: any) => i !== idx))}
                  aria-label="Remove profile"
                >
                  <Trash2 size={14} />
                </button>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                {fields.map((f: any) => (
                  <div key={f.key}>
                    <label className={labelClass}>{f.label}</label>
                    <input
                      value={row[f.key]}
                      onChange={(e: any) =>
                        setRows((prev: any) =>
                          prev.map((r: any, i: any) =>
                            i === idx ? { ...r, [f.key]: e.target.value } : r,
                          ),
                        )
                      }
                      className={inputClass}
                      placeholder={f.placeholder}
                    />
                  </div>
                ))}
              </div>
              {st?.data && (
                <p
                  className={`text-xs ${st.data.loggedIn ? 'text-emerald-400' : 'text-amber-400'}`}
                >
                  {st.data.loggedIn
                    ? `${isStatic ? 'Credentials valid' : 'Logged in'}: account ${st.data.account}`
                    : `${isStatic ? 'Credentials invalid' : 'Not logged in'}${st.data.error ? `: ${st.data.error}` : ''}`}
                </p>
              )}
              {lg?.loginUrl && (
                <p className="text-xs text-gray-400 flex items-center gap-1 flex-wrap">
                  Open SSO link:
                  <a
                    href={lg.loginUrl}
                    target="_blank"
                    rel="noreferrer"
                    title={lg.loginUrl}
                    className="text-blue-400 hover:underline inline-flex items-center gap-0.5 break-all max-w-full"
                  >
                    {lg.loginUrl.length > 72 ? `${lg.loginUrl.slice(0, 72)}…` : lg.loginUrl}
                    <ExternalLink size={10} className="shrink-0" />
                  </a>
                </p>
              )}
            </div>
          );
        })}
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => setRows((prev: any) => [...prev, emptyProfile()])}
          className="text-xs text-gray-300 hover:text-white flex items-center gap-1 px-2 py-1 rounded border border-gray-700"
        >
          <Plus size={12} /> Add profile
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="text-xs bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white px-3 py-1 rounded-lg flex items-center gap-1"
          data-testid="project-aws-profiles-save"
        >
          {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
          Save profiles
        </button>
        {saved && (
          <span className="text-xs text-emerald-400 flex items-center gap-1">
            <CheckCircle2 size={12} /> Saved
          </span>
        )}
      </div>
    </div>
  );
}
