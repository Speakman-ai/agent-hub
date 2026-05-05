/**
 * Settings → Integrations panel.
 *
 * Replaces the deleted Nango-based integrations page with a per-user MCP
 * (Model Context Protocol) server registry. Each row gets injected into
 * Claude Code spawns via `.claude/settings.json::mcpServers` so the agent
 * can talk to upstream services (Linear, Notion, GitHub, custom).
 *
 * Backed by /api/mcp-servers + /api/mcp-catalog. Secrets round-trip masked
 * (`••••••••`) so the user can save partial edits without re-typing.
 */
import { useEffect, useMemo, useState } from 'react';
import { api } from '../utils/api.js';

const MASK = '••••••••';

const EMPTY_DRAFT = {
  id: null,
  name: '',
  catalogId: null,
  transport: 'stdio',
  command: '',
  args: [],
  url: '',
  env: {},
  headers: {},
  enabled: true,
};

function isMasked(value) {
  return typeof value === 'string' && value === MASK;
}

function entriesFromMap(map) {
  return Object.entries(map || {}).map(([k, v]) => ({ key: k, value: v }));
}

function mapFromEntries(entries) {
  const out = {};
  for (const { key, value } of entries) {
    if (!key.trim()) continue;
    out[key] = value;
  }
  return out;
}

export default function McpServersSection() {
  const [servers, setServers] = useState([]);
  const [catalog, setCatalog] = useState([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState(null); // null = no form open
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const [{ servers: rows }, { entries }] = await Promise.all([
        api.listUserMcpServers(),
        api.getMcpCatalog(),
      ]);
      setServers(rows);
      setCatalog(entries);
    } catch (e) {
      setError(e.message || 'Failed to load MCP servers');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  function startCustomDraft() {
    setDraft({ ...EMPTY_DRAFT });
  }

  function startCatalogDraft(entry) {
    const env = {};
    for (const f of entry.env || []) env[f.key] = f.default ?? '';
    const headers = {};
    for (const f of entry.headers || []) headers[f.key] = f.default ?? '';
    setDraft({
      id: null,
      name: entry.name,
      catalogId: entry.id,
      transport: entry.transport,
      command: entry.command || '',
      args: entry.args || [],
      url: entry.url || '',
      env,
      headers,
      enabled: true,
    });
  }

  function startEditDraft(server) {
    setDraft({
      id: server.id,
      name: server.name,
      catalogId: server.catalogId,
      transport: server.transport,
      command: server.command || '',
      args: server.args || [],
      url: server.url || '',
      env: server.env || {},
      headers: server.headers || {},
      enabled: server.enabled,
    });
  }

  async function handleSave() {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      const payload = {
        name: draft.name,
        catalogId: draft.catalogId,
        transport: draft.transport,
        command: draft.command,
        args: draft.args,
        url: draft.url,
        env: draft.env,
        headers: draft.headers,
        enabled: draft.enabled,
      };
      if (draft.id) {
        await api.updateUserMcpServer(draft.id, payload);
      } else {
        await api.createUserMcpServer(payload);
      }
      setDraft(null);
      await refresh();
    } catch (e) {
      setError(e.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id) {
    if (!confirm('Delete this MCP server?')) return;
    try {
      await api.deleteUserMcpServer(id);
      await refresh();
    } catch (e) {
      setError(e.message || 'Delete failed');
    }
  }

  async function toggleEnabled(server) {
    try {
      await api.updateUserMcpServer(server.id, { enabled: !server.enabled });
      await refresh();
    } catch (e) {
      setError(e.message || 'Toggle failed');
    }
  }

  const installedCatalogIds = useMemo(
    () => new Set(servers.map((s) => s.catalogId).filter(Boolean)),
    [servers],
  );

  if (loading) {
    return <div className="text-zinc-400">Loading MCP servers…</div>;
  }

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-xl font-semibold text-zinc-100">MCP Servers</h2>
        <p className="mt-1 text-sm text-zinc-400">
          Connect Claude Code to upstream services via the Model Context Protocol. Each server is
          private to your account and gets injected into your sessions automatically.
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-red-700/50 bg-red-900/20 p-3 text-sm text-red-200">
          {error}
        </div>
      )}

      {!draft && (
        <>
          <section>
            <h3 className="mb-3 text-sm font-medium text-zinc-200">Your servers</h3>
            {servers.length === 0 ? (
              <p className="text-sm text-zinc-500">No MCP servers yet. Add one below.</p>
            ) : (
              <ul className="divide-y divide-zinc-800 rounded-lg border border-zinc-800">
                {servers.map((s) => (
                  <li key={s.id} className="flex items-center justify-between gap-4 p-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-zinc-100">{s.name}</span>
                        <span className="rounded bg-zinc-800 px-2 py-0.5 text-xs text-zinc-400">
                          {s.transport}
                        </span>
                        {s.catalogId && (
                          <span className="rounded bg-blue-900/40 px-2 py-0.5 text-xs text-blue-200">
                            {s.catalogId}
                          </span>
                        )}
                        {!s.enabled && (
                          <span className="rounded bg-amber-900/40 px-2 py-0.5 text-xs text-amber-200">
                            disabled
                          </span>
                        )}
                      </div>
                      <div className="mt-1 truncate text-xs text-zinc-500">
                        {s.transport === 'stdio'
                          ? `${s.command} ${(s.args || []).join(' ')}`.trim()
                          : s.url}
                      </div>
                    </div>
                    <div className="flex shrink-0 gap-2">
                      <button
                        type="button"
                        onClick={() => toggleEnabled(s)}
                        className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
                      >
                        {s.enabled ? 'Disable' : 'Enable'}
                      </button>
                      <button
                        type="button"
                        onClick={() => startEditDraft(s)}
                        className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDelete(s.id)}
                        className="rounded border border-red-700/50 px-2 py-1 text-xs text-red-300 hover:bg-red-900/30"
                      >
                        Delete
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <h3 className="mb-3 text-sm font-medium text-zinc-200">Add from catalog</h3>
            <div className="grid gap-3 md:grid-cols-3">
              {catalog.map((entry) => {
                const installed = installedCatalogIds.has(entry.id);
                return (
                  <button
                    key={entry.id}
                    type="button"
                    onClick={() => startCatalogDraft(entry)}
                    disabled={installed}
                    className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 text-left hover:border-zinc-700 disabled:opacity-50"
                  >
                    <div className="font-medium text-zinc-100">{entry.name}</div>
                    <div className="mt-1 text-xs text-zinc-400">{entry.description}</div>
                    {installed && (
                      <div className="mt-2 text-xs text-emerald-400">Already added</div>
                    )}
                  </button>
                );
              })}
            </div>
          </section>

          <section>
            <button
              type="button"
              onClick={startCustomDraft}
              className="rounded border border-zinc-700 px-3 py-2 text-sm text-zinc-200 hover:bg-zinc-800"
            >
              + Add custom MCP server
            </button>
          </section>
        </>
      )}

      {draft && (
        <McpServerForm
          draft={draft}
          onChange={setDraft}
          onCancel={() => setDraft(null)}
          onSave={handleSave}
          saving={saving}
        />
      )}
    </div>
  );
}

function McpServerForm({ draft, onChange, onCancel, onSave, saving }) {
  const envEntries = entriesFromMap(draft.env);
  const headerEntries = entriesFromMap(draft.headers);

  function setField(field, value) {
    onChange({ ...draft, [field]: value });
  }

  function setEnvEntry(idx, patch) {
    const next = [...envEntries];
    next[idx] = { ...next[idx], ...patch };
    onChange({ ...draft, env: mapFromEntries(next) });
  }

  function addEnvEntry() {
    const next = [...envEntries, { key: '', value: '' }];
    onChange({ ...draft, env: mapFromEntries(next) });
  }

  function removeEnvEntry(idx) {
    const next = envEntries.filter((_, i) => i !== idx);
    onChange({ ...draft, env: mapFromEntries(next) });
  }

  function setHeaderEntry(idx, patch) {
    const next = [...headerEntries];
    next[idx] = { ...next[idx], ...patch };
    onChange({ ...draft, headers: mapFromEntries(next) });
  }

  function addHeaderEntry() {
    const next = [...headerEntries, { key: '', value: '' }];
    onChange({ ...draft, headers: mapFromEntries(next) });
  }

  function removeHeaderEntry(idx) {
    const next = headerEntries.filter((_, i) => i !== idx);
    onChange({ ...draft, headers: mapFromEntries(next) });
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSave();
      }}
      className="space-y-5 rounded-lg border border-zinc-800 bg-zinc-900/30 p-5"
    >
      <h3 className="text-sm font-medium text-zinc-200">
        {draft.id ? 'Edit MCP server' : 'New MCP server'}
      </h3>

      <label className="block">
        <span className="text-xs text-zinc-400">Name</span>
        <input
          required
          value={draft.name}
          onChange={(e) => setField('name', e.target.value)}
          className="mt-1 w-full rounded border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100"
        />
      </label>

      <label className="block">
        <span className="text-xs text-zinc-400">Transport</span>
        <select
          value={draft.transport}
          onChange={(e) => setField('transport', e.target.value)}
          className="mt-1 w-full rounded border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100"
        >
          <option value="stdio">stdio (local process)</option>
          <option value="http">http (remote URL)</option>
        </select>
      </label>

      {draft.transport === 'stdio' && (
        <>
          <label className="block">
            <span className="text-xs text-zinc-400">Command</span>
            <input
              value={draft.command}
              onChange={(e) => setField('command', e.target.value)}
              placeholder="npx"
              className="mt-1 w-full rounded border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100"
            />
          </label>
          <label className="block">
            <span className="text-xs text-zinc-400">Args (comma-separated)</span>
            <input
              value={(draft.args || []).join(', ')}
              onChange={(e) =>
                setField(
                  'args',
                  e.target.value
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean),
                )
              }
              placeholder="-y, @notionhq/notion-mcp-server"
              className="mt-1 w-full rounded border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100"
            />
          </label>
        </>
      )}

      {draft.transport === 'http' && (
        <label className="block">
          <span className="text-xs text-zinc-400">URL</span>
          <input
            value={draft.url}
            onChange={(e) => setField('url', e.target.value)}
            placeholder="https://mcp.example.com/sse"
            className="mt-1 w-full rounded border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100"
          />
        </label>
      )}

      <KeyValueEditor
        title={draft.transport === 'stdio' ? 'Environment variables' : 'Headers'}
        helpText={
          draft.transport === 'stdio'
            ? 'Passed as environment variables to the spawned process. Values are encrypted at rest.'
            : 'Sent as request headers. Values are encrypted at rest.'
        }
        entries={draft.transport === 'stdio' ? envEntries : headerEntries}
        onAdd={draft.transport === 'stdio' ? addEnvEntry : addHeaderEntry}
        onRemove={draft.transport === 'stdio' ? removeEnvEntry : removeHeaderEntry}
        onChange={draft.transport === 'stdio' ? setEnvEntry : setHeaderEntry}
      />

      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={draft.enabled}
          onChange={(e) => setField('enabled', e.target.checked)}
        />
        <span className="text-sm text-zinc-300">Enabled</span>
      </label>

      <div className="flex gap-3">
        <button
          type="submit"
          disabled={saving}
          className="rounded bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-500 disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded border border-zinc-700 px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-800"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

function KeyValueEditor({ title, helpText, entries, onAdd, onRemove, onChange }) {
  return (
    <div>
      <div className="mb-1 text-xs text-zinc-400">{title}</div>
      <div className="mb-2 text-xs text-zinc-500">{helpText}</div>
      <div className="space-y-2">
        {entries.map((entry, idx) => (
          <div key={idx} className="flex gap-2">
            <input
              value={entry.key}
              onChange={(e) => onChange(idx, { key: e.target.value })}
              placeholder="key"
              className="w-1/3 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-100"
            />
            <input
              type={isMasked(entry.value) ? 'text' : 'password'}
              value={entry.value}
              onChange={(e) => onChange(idx, { value: e.target.value })}
              placeholder="value"
              className="flex-1 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-100"
            />
            <button
              type="button"
              onClick={() => onRemove(idx)}
              className="rounded border border-red-700/50 px-2 py-1 text-xs text-red-300 hover:bg-red-900/30"
            >
              ✕
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={onAdd}
          className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
        >
          + Add
        </button>
      </div>
    </div>
  );
}
