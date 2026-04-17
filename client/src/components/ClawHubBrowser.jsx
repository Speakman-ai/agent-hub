import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Search,
  Loader2,
  Download,
  Cloud,
  CloudOff,
  Check,
  ChevronDown,
  ChevronRight,
  AlertTriangle,
} from 'lucide-react';
import { api } from '../utils/api.js';

/**
 * ClawHubBrowser — search the public ClawHub registry and install skills
 * into either the current agent's workspace or the global skills directory.
 *
 * Backend endpoints live under /api/clawhub/*; see server/routes/clawhub.ts.
 */
export default function ClawHubBrowser({ activeAgent, installedSlugs, onInstalled }) {
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [expandedSlug, setExpandedSlug] = useState(null);

  // Debounce the search input (~250ms).
  useEffect(() => {
    const id = setTimeout(() => setDebouncedQuery(query.trim()), 250);
    return () => clearTimeout(id);
  }, [query]);

  // Fetch results whenever the debounced query changes.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const fetcher = debouncedQuery
      ? api.clawhubSearch(debouncedQuery, 50)
      : api.clawhubListSkills(50);

    fetcher
      .then((data) => {
        if (cancelled) return;
        setResults(normalizeList(data));
      })
      .catch((err) => {
        if (cancelled) return;
        setResults([]);
        setError(friendlyError(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [debouncedQuery]);

  return (
    <div>
      <div className="flex flex-col sm:flex-row gap-3 mb-6">
        <div className="relative flex-1">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search ClawHub registry..."
            className="w-full bg-gray-800 border border-gray-700 rounded-lg pl-9 pr-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-indigo-500"
            aria-label="Search ClawHub registry"
          />
        </div>
        <div className="flex items-center px-3 text-xs text-gray-500">
          <Cloud size={14} className="mr-1.5" />
          {results.length} {results.length === 1 ? 'skill' : 'skills'}
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 size={20} className="animate-spin text-gray-500" />
        </div>
      ) : error ? (
        <div className="bg-gray-800 rounded-xl p-6 text-center">
          <CloudOff size={24} className="text-amber-400 mx-auto mb-2" />
          <p className="text-amber-300 text-sm">{error}</p>
          <p className="text-gray-500 text-xs mt-1">
            Try again in a moment, or check that the server can reach clawhub.ai.
          </p>
        </div>
      ) : results.length === 0 ? (
        <div className="bg-gray-800 rounded-xl p-8 text-center">
          <p className="text-gray-500 text-sm">No skills found</p>
          <p className="text-gray-600 text-xs mt-1">Try a different search term.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3">
          {results.map((skill) => (
            <ClawHubCard
              key={skill.slug}
              skill={skill}
              activeAgent={activeAgent}
              installedSlugs={installedSlugs}
              expanded={expandedSlug === skill.slug}
              onExpand={() => setExpandedSlug((prev) => (prev === skill.slug ? null : skill.slug))}
              onInstalled={onInstalled}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ClawHubCard({ skill, activeAgent, installedSlugs, expanded, onExpand, onInstalled }) {
  const [versions, setVersions] = useState(null);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [selectedVersion, setSelectedVersion] = useState('');
  const [installing, setInstalling] = useState(null); // 'agent' | 'global' | null
  const [installResult, setInstallResult] = useState(null);
  const [installError, setInstallError] = useState(null);
  const [showStderr, setShowStderr] = useState(false);
  const versionsLoadedRef = useRef(false);

  const isAlreadyInstalled = installedSlugs?.has(skill.slug);

  // Lazy-load versions when the card expands for the first time.
  useEffect(() => {
    if (!expanded || versionsLoadedRef.current) return;
    versionsLoadedRef.current = true;
    setVersionsLoading(true);
    api
      .clawhubGetVersions(skill.slug)
      .then((data) => {
        const list = normalizeVersions(data);
        setVersions(list);
        if (list[0]?.version) setSelectedVersion(list[0].version);
      })
      .catch(() => setVersions([]))
      .finally(() => setVersionsLoading(false));
  }, [expanded, skill.slug]);

  const handleInstall = useCallback(
    async (target) => {
      setInstalling(target);
      setInstallError(null);
      setInstallResult(null);
      setShowStderr(false);
      try {
        const body = {
          slug: skill.slug,
          target,
          version: selectedVersion || undefined,
        };
        if (target === 'agent') body.agentId = activeAgent?.id;
        const result = await api.clawhubInstall(body);
        setInstallResult(result);
        if (onInstalled) onInstalled(result);
      } catch (err) {
        setInstallError(parseInstallError(err));
      } finally {
        setInstalling(null);
      }
    },
    [skill.slug, selectedVersion, activeAgent, onInstalled],
  );

  const agentInstallDisabled = !activeAgent?.id || installing !== null;
  const globalInstallDisabled = installing !== null;

  return (
    <div className="bg-gray-800 rounded-xl overflow-hidden">
      <div className="p-4 cursor-pointer hover:bg-gray-750 transition-colors" onClick={onExpand}>
        <div className="flex items-center justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h4 className="font-medium text-sm text-gray-100">{skill.name || skill.slug}</h4>
              {skill.category && (
                <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-indigo-900/40 text-indigo-300">
                  {skill.category}
                </span>
              )}
              {skill.latest_version && (
                <span className="text-[10px] text-gray-500">v{skill.latest_version}</span>
              )}
              {isAlreadyInstalled && (
                <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-emerald-900/40 text-emerald-300 flex items-center gap-1">
                  <Check size={10} /> installed
                </span>
              )}
            </div>
            {skill.description && (
              <p className="text-xs text-gray-400 mt-1 line-clamp-2">{skill.description}</p>
            )}
            <p className="text-[11px] text-gray-500 mt-1 font-mono">{skill.slug}</p>
          </div>
          <span className="text-gray-500 flex items-center">
            {expanded ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
          </span>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-gray-700 p-4 space-y-4">
          {/* Version picker */}
          <div className="flex items-center gap-2">
            <label className="text-xs text-gray-400" htmlFor={`v-${skill.slug}`}>
              Version
            </label>
            {versionsLoading ? (
              <Loader2 size={12} className="animate-spin text-gray-500" />
            ) : (
              <select
                id={`v-${skill.slug}`}
                value={selectedVersion}
                onChange={(e) => setSelectedVersion(e.target.value)}
                className="bg-gray-900 border border-gray-700 rounded-md px-2 py-1 text-xs text-gray-100 focus:outline-none focus:border-indigo-500"
              >
                <option value="">latest</option>
                {(versions || []).map((v) => (
                  <option key={v.version} value={v.version}>
                    {v.version}
                  </option>
                ))}
              </select>
            )}
          </div>

          {/* Install actions */}
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => handleInstall('agent')}
              disabled={agentInstallDisabled}
              title={
                !activeAgent?.id ? 'Select an agent first' : "Install into this agent's workspace"
              }
              className="text-xs px-3 py-1.5 rounded-md bg-indigo-600 text-white hover:bg-indigo-500 transition-colors disabled:bg-gray-700 disabled:text-gray-500 disabled:cursor-not-allowed flex items-center gap-1"
            >
              {installing === 'agent' ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <Download size={12} />
              )}
              {activeAgent
                ? `Install for ${activeAgent.name || activeAgent.id}`
                : 'Install for this agent'}
            </button>
            <button
              onClick={() => handleInstall('global')}
              disabled={globalInstallDisabled}
              className="text-xs px-3 py-1.5 rounded-md bg-gray-700 text-gray-100 hover:bg-gray-600 transition-colors disabled:bg-gray-800 disabled:text-gray-500 disabled:cursor-not-allowed flex items-center gap-1"
            >
              {installing === 'global' ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <Download size={12} />
              )}
              Install globally
            </button>
          </div>

          {installResult && (
            <div className="rounded-md bg-emerald-900/30 border border-emerald-800/50 px-3 py-2">
              <p className="text-xs text-emerald-300 flex items-center gap-1.5">
                <Check size={12} /> Installed{' '}
                <span className="font-mono">{installResult.slug}</span>
              </p>
              {installResult.path && (
                <p className="text-[11px] text-emerald-400/80 mt-1 font-mono break-all">
                  {installResult.path}
                </p>
              )}
            </div>
          )}

          {installError && (
            <div className="rounded-md bg-red-950/40 border border-red-900/60 px-3 py-2">
              <p className="text-xs text-red-300 flex items-start gap-1.5">
                <AlertTriangle size={12} className="mt-0.5 flex-shrink-0" />
                <span>{installError.message}</span>
              </p>
              {installError.stderrTail && (
                <div className="mt-2">
                  <button
                    onClick={() => setShowStderr((v) => !v)}
                    className="text-[11px] text-red-400 hover:underline"
                  >
                    {showStderr ? 'Hide' : 'Show'} install log
                  </button>
                  {showStderr && (
                    <pre className="mt-1 bg-black/40 rounded p-2 text-[10px] text-red-200 max-h-48 overflow-auto whitespace-pre-wrap">
                      {installError.stderrTail}
                    </pre>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Helpers ───────────────────────────────────────────────────────

/**
 * The ClawHub backend is a thin proxy — the upstream shape isn't fully
 * locked down, so accept either a bare array or a `{ skills: [...] }`/
 * `{ results: [...] }` envelope and normalize.
 */
function normalizeList(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.skills)) return data.skills;
  if (Array.isArray(data?.results)) return data.results;
  return [];
}

function normalizeVersions(data) {
  const list = Array.isArray(data) ? data : Array.isArray(data?.versions) ? data.versions : [];
  return list
    .map((v) => (typeof v === 'string' ? { version: v } : v))
    .filter((v) => v && typeof v.version === 'string');
}

function friendlyError(err) {
  const msg = err?.message || String(err);
  if (msg.includes('502') || msg.includes('504')) {
    return 'ClawHub registry unreachable.';
  }
  return msg;
}

/**
 * The install endpoint returns `{ error, stderrTail }` on 500. The api
 * helper throws an Error whose message is `"<status>: <error>"`, so we
 * try to fetch the stderrTail by re-invoking once via a lightweight
 * extraction — but in practice the helper only carries the error string.
 * Keep the surface simple: return whatever we can.
 */
function parseInstallError(err) {
  const message = err?.message || String(err);
  // The api helper concats body.error or body.message; if the server sent
  // a stderrTail it gets dropped. Surface what we have plus a hint.
  return { message, stderrTail: err?.stderrTail || null };
}
