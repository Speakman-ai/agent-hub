import { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Eye,
  EyeOff,
  Key,
  Loader2,
  Plus,
  Save,
  Trash2,
} from 'lucide-react';
import { api } from '../utils/api';

const MASK = '••••••••';

function emptyRow() {
  return { key: '', value: '', kind: 'secret', isNew: true, hadSecret: false };
}

/**
 * Per-project env secrets editor (Settings → Projects).
 * Secret-kind values are masked on load; saving sends MASK for unchanged rows.
 */
export default function ProjectSecretsEditor({ projectId, hint }: any) {
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<any>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [importBlob, setImportBlob] = useState('');
  const [importing, setImporting] = useState(false);
  const [revealKeys, setRevealKeys] = useState<Record<string, any>>({});

  const inputClass =
    'w-full bg-gray-900 border border-gray-700 rounded-lg px-2 py-1.5 text-xs text-gray-100 focus:outline-none focus:border-gray-600 font-mono';
  const labelClass = 'block text-xs text-gray-400 mb-1';

  const load = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const body = await api.getProjectSecrets(projectId);
      const secrets = body?.secrets || [];
      setRows(
        secrets.map((s: any) => ({
          key: s.key,
          value: s.kind === 'secret' ? '' : s.value || '',
          kind: s.kind === 'plain' ? 'plain' : 'secret',
          hadSecret: s.kind === 'secret',
          isNew: false,
        })),
      );
      setRevealKeys({});
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
      const payload = rows
        .filter((r: any) => r.key.trim())
        .map((r: any) => {
          const key = r.key.trim();
          const kind = r.kind === 'plain' ? 'plain' : 'secret';
          if (kind === 'secret' && r.hadSecret && !r.isNew && !r.value.trim()) {
            return { key, value: MASK, kind };
          }
          return { key, value: r.value, kind };
        });
      await api.putProjectSecrets(projectId, payload);
      await load();
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleImport = async () => {
    if (!importBlob.trim()) return;
    setImporting(true);
    setError(null);
    try {
      await api.importProjectSecrets(projectId, importBlob, { mode: 'merge' });
      setImportBlob('');
      await load();
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally {
      setImporting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-xs text-gray-400 py-2">
        <Loader2 size={12} className="animate-spin" />
        Loading project secrets…
      </div>
    );
  }

  return (
    <div className="space-y-3" data-testid={`project-secrets-${projectId}`}>
      <div>
        <h5 className="text-xs font-medium text-gray-300 flex items-center gap-1.5 mb-1">
          <Key size={12} /> Project secrets
        </h5>
        <p className="text-xs text-gray-500">
          {hint ??
            'Encrypted key/value pairs merged into every session spawn for this project (chat, cron, preview). Values marked secret are never returned in clear — leave blank when editing to keep the stored value. Keys in the '}
          {!hint && (
            <>
              <code className="font-mono">AGENT_HUB_*</code> namespace are rejected.
            </>
          )}
        </p>
      </div>

      {error && (
        <p className="text-xs text-red-400 flex items-center gap-1">
          <AlertCircle size={12} />
          {error}
        </p>
      )}

      <div className="space-y-2">
        {rows.length === 0 && (
          <p className="text-xs text-gray-600 italic">No secrets configured for this project.</p>
        )}
        {rows.map((row: any, idx: any) => (
          <div key={`${row.key}-${idx}`} className="flex flex-wrap gap-2 items-end">
            <div className="flex-1 min-w-[120px]">
              {idx === 0 && <label className={labelClass}>Key</label>}
              <input
                value={row.key}
                onChange={(e: any) =>
                  setRows((prev: any) =>
                    prev.map((r: any, i: any) => (i === idx ? { ...r, key: e.target.value } : r)),
                  )
                }
                className={inputClass}
                placeholder="API_KEY"
                data-testid={`secret-key-${idx}`}
              />
            </div>
            <div className="flex-[2] min-w-[160px]">
              {idx === 0 && <label className={labelClass}>Value</label>}
              <div className="flex gap-1">
                <input
                  type={
                    row.kind === 'secret' && !revealKeys[idx] && !row.isNew ? 'password' : 'text'
                  }
                  value={row.value}
                  onChange={(e: any) =>
                    setRows((prev: any) =>
                      prev.map((r: any, i: any) =>
                        i === idx ? { ...r, value: e.target.value } : r,
                      ),
                    )
                  }
                  className={inputClass}
                  placeholder={
                    row.hadSecret && row.kind === 'secret' ? 'unchanged (masked)' : 'value'
                  }
                  data-testid={`secret-value-${idx}`}
                />
                {row.kind === 'secret' && (
                  <button
                    type="button"
                    className="px-2 text-gray-400 hover:text-gray-200"
                    onClick={() => setRevealKeys((p: any) => ({ ...p, [idx]: !p[idx] }))}
                    aria-label={revealKeys[idx] ? 'Hide value' : 'Show value'}
                  >
                    {revealKeys[idx] ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                )}
              </div>
            </div>
            <div className="w-24">
              {idx === 0 && <label className={labelClass}>Kind</label>}
              <select
                value={row.kind}
                onChange={(e: any) =>
                  setRows((prev: any) =>
                    prev.map((r: any, i: any) =>
                      i === idx ? { ...r, kind: e.target.value, value: '', hadSecret: false } : r,
                    ),
                  )
                }
                className={inputClass}
              >
                <option value="secret">secret</option>
                <option value="plain">plain</option>
              </select>
            </div>
            <button
              type="button"
              className="text-gray-500 hover:text-red-400 p-1.5"
              onClick={() => setRows((prev: any) => prev.filter((_: any, i: any) => i !== idx))}
              aria-label="Remove row"
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => setRows((prev: any) => [...prev, emptyRow()])}
          className="text-xs text-gray-300 hover:text-white flex items-center gap-1 px-2 py-1 rounded border border-gray-700"
        >
          <Plus size={12} /> Add key
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="text-xs bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white px-3 py-1 rounded-lg flex items-center gap-1"
          data-testid="project-secrets-save"
        >
          {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
          Save secrets
        </button>
        {saved && (
          <span className="text-xs text-emerald-400 flex items-center gap-1">
            <CheckCircle2 size={12} /> Saved
          </span>
        )}
      </div>

      <div className="border-t border-gray-800 pt-3 space-y-2">
        <label className={labelClass}>Import .env (merge)</label>
        <textarea
          value={importBlob}
          onChange={(e: any) => setImportBlob(e.target.value)}
          rows={3}
          className={inputClass + ' resize-y'}
          placeholder={'API_KEY=sk-...\nFEATURE_X=on'}
        />
        <button
          type="button"
          onClick={handleImport}
          disabled={importing || !importBlob.trim()}
          className="text-xs bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-white px-3 py-1 rounded-lg"
        >
          {importing ? 'Importing…' : 'Import merge'}
        </button>
      </div>
    </div>
  );
}
